import { randomInt, randomUUID } from 'node:crypto';
import { prisma, transactionWithRetry, type Tx } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { AppError, badRequest, conflict, isPgError } from '../../lib/errors.js';
import { randomToken, sha256Hex } from '../../lib/crypto.js';
import { audit } from '../../lib/audit.js';
import { getDummyHash, hashPassword, needsRehash, verifyPassword } from './passwords.js';
import { signAccessToken } from './tokens.js';
import { enqueueNotification } from '../notifications/notifications.service.js';
import type { TokenPurpose, User } from '../../../generated/prisma/client.js';

export interface ClientInfo {
  ipAddress?: string;
  userAgent?: string;
}

export function normaliseIdentifier(identifier: string): { email?: string; phone?: string } {
  const trimmed = identifier.trim();
  if (trimmed.includes('@')) return { email: trimmed.toLowerCase() };
  const digits = trimmed.replace(/[\s\-()]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(digits)) return { phone: digits };
  if (/^[6-9]\d{9}$/.test(digits)) return { phone: `+91${digits}` }; // Indian mobile without country code
  throw badRequest('Identifier must be an email address or a mobile number');
}

async function findUserByIdentifier(identifier: string): Promise<User | null> {
  const { email, phone } = normaliseIdentifier(identifier);
  return prisma.user.findFirst({ where: email ? { email } : { phone } });
}

async function issueSession(tx: Tx, userId: string, client: ClientInfo, familyId?: string) {
  const refreshToken = randomToken(32);
  const session = await tx.session.create({
    data: {
      userId,
      familyId: familyId ?? randomUUID(),
      refreshTokenHash: sha256Hex(refreshToken),
      userAgent: client.userAgent?.slice(0, 300),
      ipAddress: client.ipAddress,
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
    },
  });
  const access = await signAccessToken({ sub: userId, sid: session.id });
  return {
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt.toISOString(),
    refreshToken,
    refreshTokenExpiresAt: session.expiresAt.toISOString(),
    sessionId: session.id,
  };
}

/**
 * Password login with per-account lockout. Error responses are identical for
 * "no such user" and "wrong password", and a dummy hash is verified for
 * unknown identifiers so response timing does not reveal account existence.
 */
export async function login(identifier: string, password: string, client: ClientInfo) {
  const identifierHash = sha256Hex(identifier.trim().toLowerCase());
  const user = await findUserByIdentifier(identifier);
  const now = new Date();

  const recordAttempt = (success: boolean, reason: string, userId?: string) =>
    prisma.loginAttempt.create({
      data: { userId: userId ?? null, identifierHash, ipAddress: client.ipAddress, success, reason },
    });

  if (!user || !user.passwordHash) {
    await verifyPassword(await getDummyHash(), password);
    await recordAttempt(false, user ? 'NO_PASSWORD' : 'UNKNOWN_IDENTIFIER', user?.id);
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
  }

  if (user.lockedUntil && user.lockedUntil > now) {
    await recordAttempt(false, 'LOCKED', user.id);
    throw new AppError(423, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again later or reset your password.', {
      lockedUntil: user.lockedUntil.toISOString(),
    });
  }

  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok) {
    // Atomic increment so concurrent guesses cannot bypass the threshold.
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    if (updated.failedLoginCount >= env.LOGIN_MAX_FAILURES) {
      const lockedUntil = new Date(now.getTime() + env.LOGIN_LOCKOUT_MINUTES * 60_000);
      await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: user.id }, data: { lockedUntil, failedLoginCount: 0 } });
        await audit(tx, {
          action: 'auth.account_locked',
          entityType: 'user',
          entityId: user.id,
          actorType: 'SYSTEM',
          metadata: { lockedUntil },
        });
      });
    }
    await recordAttempt(false, 'BAD_PASSWORD', user.id);
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
  }

  if (user.status !== 'ACTIVE' && user.status !== 'PENDING_VERIFICATION') {
    await recordAttempt(false, `STATUS_${user.status}`, user.id);
    throw new AppError(403, 'ACCOUNT_INACTIVE', 'This account is not active');
  }

  const rehash = needsRehash(user.passwordHash) ? await hashPassword(password) : undefined;
  const tokens = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now, ...(rehash ? { passwordHash: rehash } : {}) },
    });
    const t = await issueSession(tx, user.id, client);
    await audit(tx, { action: 'auth.login', entityType: 'user', entityId: user.id, actorUserId: user.id });
    return t;
  });
  await recordAttempt(true, 'OK', user.id);
  return { ...tokens, mustChangePassword: user.mustChangePassword };
}

/**
 * How long a just-rotated refresh token is still accepted. Real patients hit
 * this: the installed app and a browser tab refreshing together, or a reload
 * landing while a refresh is in flight. Inside the window we issue another
 * token in the same family instead of treating it as theft (the same "reuse
 * interval" idea Auth0 and Okta use). Outside it, reuse still revokes everything.
 */
const REFRESH_REUSE_GRACE_MS = 30_000;

/**
 * Refresh-token rotation. Each refresh token is single-use; presenting a token
 * that was rotated more than REFRESH_REUSE_GRACE_MS ago indicates theft, so
 * the whole session family is revoked.
 */
export async function refresh(refreshToken: string, client: ClientInfo) {
  const hash = sha256Hex(refreshToken);
  const session = await prisma.session.findUnique({ where: { refreshTokenHash: hash }, include: { user: true } });
  if (!session) throw new AppError(401, 'TOKEN_INVALID', 'Invalid refresh token');

  const withinGrace = (at: Date | null) => !!at && Date.now() - at.getTime() < REFRESH_REUSE_GRACE_MS;
  const userUsable = session.user.status === 'ACTIVE' || session.user.status === 'PENDING_VERIFICATION';
  if (session.rotatedAt && !session.revokedAt && withinGrace(session.rotatedAt) && session.expiresAt > new Date() && userUsable) {
    return prisma.$transaction((tx) => issueSession(tx, session.userId, client, session.familyId));
  }

  if (session.rotatedAt) {
    // Reuse of an already-rotated token → assume theft and revoke the whole
    // family. Committed in its own transaction *before* we reject the request.
    await prisma.$transaction(async (tx) => {
      const revoked = await tx.session.updateMany({
        where: { familyId: session.familyId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'REFRESH_TOKEN_REUSE' },
      });
      if (revoked.count > 0) {
        await audit(tx, {
          action: 'auth.refresh_token_reuse_detected',
          entityType: 'user',
          entityId: session.userId,
          actorType: 'SYSTEM',
          metadata: { familyId: session.familyId, sessionsRevoked: revoked.count },
        });
      }
    });
    throw new AppError(401, 'TOKEN_INVALID', 'Refresh token is no longer valid');
  }
  if (session.revokedAt) throw new AppError(401, 'TOKEN_INVALID', 'Refresh token is no longer valid');
  if (session.expiresAt <= new Date()) throw new AppError(401, 'TOKEN_INVALID', 'Refresh token expired');
  if (session.user.status !== 'ACTIVE' && session.user.status !== 'PENDING_VERIFICATION') {
    throw new AppError(403, 'ACCOUNT_INACTIVE', 'This account is not active');
  }

  // Two concurrent refreshes of one token write the same session document; MongoDB aborts the second with a
  // write conflict, and the retry then takes the "lost the race" branch below instead of surfacing a 409.
  return transactionWithRetry(async (tx) => {
    // Conditional update guards against two concurrent refreshes of one token.
    // The rotated session stays un-revoked so its (≤15 min) access token keeps
    // working, but its refresh token can never be used again.
    const rotated = await tx.session.updateMany({
      where: { id: session.id, rotatedAt: null, revokedAt: null },
      data: { rotatedAt: new Date(), lastUsedAt: new Date() },
    });
    if (rotated.count !== 1) {
      // Lost a race with a concurrent refresh of this token a moment ago (two tabs). Same family, fresh token,
      // unless the session was revoked in the meantime (logout, password change).
      const now = await tx.session.findUnique({ where: { id: session.id }, select: { revokedAt: true } });
      if (!now || now.revokedAt) throw new AppError(401, 'TOKEN_INVALID', 'Refresh token is no longer valid');
    }
    return issueSession(tx, session.userId, client, session.familyId);
  });
}

export async function logout(sessionId: string, userId: string, allDevices: boolean) {
  await prisma.$transaction(async (tx) => {
    const where = allDevices ? { userId, revokedAt: null } : { id: sessionId, userId, revokedAt: null };
    await tx.session.updateMany({ where, data: { revokedAt: new Date(), revokedReason: 'LOGOUT' } });
    await audit(tx, { action: allDevices ? 'auth.logout_all' : 'auth.logout', entityType: 'user', entityId: userId });
  });
}

export async function revokeAllSessions(tx: Tx, userId: string, reason: string, exceptSessionId?: string) {
  await tx.session.updateMany({
    where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}

export async function changePassword(userId: string, sessionId: string, currentPassword: string, newPassword: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.passwordHash || !(await verifyPassword(user.passwordHash, currentPassword))) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect');
  }
  if (await verifyPassword(user.passwordHash, newPassword)) {
    throw badRequest('New password must differ from the current password');
  }
  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { passwordHash, passwordChangedAt: new Date(), mustChangePassword: false },
    });
    await revokeAllSessions(tx, userId, 'PASSWORD_CHANGED', sessionId);
    await audit(tx, { action: 'auth.password_changed', entityType: 'user', entityId: userId });
  });
}

const TOKEN_TTL_MIN: Record<TokenPurpose, number> = {
  PASSWORD_RESET: 30,
  EMAIL_VERIFICATION: 24 * 60,
  PHONE_VERIFICATION: 10,
};

async function createVerificationToken(tx: Tx, userId: string, purpose: TokenPurpose) {
  // Invalidate earlier unconsumed tokens of the same purpose.
  await tx.verificationToken.updateMany({
    where: { userId, purpose, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  const raw = purpose === 'PHONE_VERIFICATION' ? String(randomInt(0, 1_000_000)).padStart(6, '0') : randomToken(32);
  // OTPs have low entropy, so bind the hash to the user to prevent cross-user lookup.
  const tokenHash = sha256Hex(purpose === 'PHONE_VERIFICATION' ? `${userId}:${raw}` : raw);
  await tx.verificationToken.create({
    data: { userId, purpose, tokenHash, expiresAt: new Date(Date.now() + TOKEN_TTL_MIN[purpose] * 60_000) },
  });
  return raw;
}

/** Always resolves (202) so the endpoint cannot be used to enumerate accounts. */
export async function requestPasswordReset(identifier: string): Promise<void> {
  let user: User | null = null;
  try {
    user = await findUserByIdentifier(identifier);
  } catch {
    return;
  }
  if (!user || (user.status !== 'ACTIVE' && user.status !== 'PENDING_VERIFICATION')) return;
  const recipient = user.email ?? user.phone;
  if (!recipient) return;
  await prisma.$transaction(async (tx) => {
    const token = await createVerificationToken(tx, user.id, 'PASSWORD_RESET');
    await enqueueNotification(tx, {
      userId: user.id,
      channel: user.email ? 'EMAIL' : 'SMS',
      templateKey: 'auth.password_reset',
      recipient,
      payload: { token, expiresInMinutes: TOKEN_TTL_MIN.PASSWORD_RESET },
    });
    await audit(tx, { action: 'auth.password_reset_requested', entityType: 'user', entityId: user.id, actorType: 'SYSTEM' });
  });
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const tokenHash = sha256Hex(token);
  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction(async (tx) => {
    const record = await tx.verificationToken.findUnique({ where: { tokenHash } });
    if (!record || record.purpose !== 'PASSWORD_RESET' || record.consumedAt || record.expiresAt <= new Date()) {
      throw new AppError(400, 'TOKEN_INVALID', 'This reset link is invalid or has expired');
    }
    const consumed = await tx.verificationToken.updateMany({
      where: { id: record.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) throw new AppError(400, 'TOKEN_INVALID', 'This reset link is invalid or has expired');
    await tx.user.update({
      where: { id: record.userId },
      data: { passwordHash, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null, mustChangePassword: false },
    });
    await revokeAllSessions(tx, record.userId, 'PASSWORD_RESET');
    await audit(tx, { action: 'auth.password_reset', entityType: 'user', entityId: record.userId, actorUserId: record.userId });
  });
}

/** Patient self-registration. Provider and admin accounts are created by admins. */
export async function registerPatient(input: { fullName: string; email?: string; phone?: string; password: string }) {
  if (!input.email && !input.phone) throw badRequest('Provide an email address or a mobile number');
  const email = input.email ? normaliseIdentifier(input.email).email : undefined;
  const phone = input.phone ? normaliseIdentifier(input.phone).phone : undefined;
  const passwordHash = await hashPassword(input.password);
  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { fullName: input.fullName, email, phone, passwordHash, status: 'PENDING_VERIFICATION' },
      });
      await tx.patientProfile.create({ data: { accountUserId: user.id, fullName: input.fullName, relationship: 'SELF', phone } });
      await tx.consentRecord.create({
        data: {
          patientProfileId: (await tx.patientProfile.findFirstOrThrow({ where: { accountUserId: user.id, relationship: 'SELF' } })).id,
          grantedByUserId: user.id,
          scope: 'PLATFORM_DATA_PROCESSING',
          purpose: 'Account creation and booking healthcare services through Carevanta',
          policyVersion: '2026-10-draft',
        },
      });
      const purpose: TokenPurpose = email ? 'EMAIL_VERIFICATION' : 'PHONE_VERIFICATION';
      const token = await createVerificationToken(tx, user.id, purpose);
      await enqueueNotification(tx, {
        userId: user.id,
        channel: email ? 'EMAIL' : 'SMS',
        templateKey: email ? 'auth.verify_email' : 'auth.verify_phone',
        recipient: (email ?? phone)!,
        payload: { token },
      });
      await audit(tx, { action: 'auth.registered', entityType: 'user', entityId: user.id, actorUserId: user.id });
      return { id: user.id, status: user.status };
    });
  } catch (err) {
    // Same message whichever identifier collided, to limit enumeration.
    if (isPgError(err, '23505')) throw conflict('An account with these details already exists');
    throw err;
  }
}

export async function requestContactVerification(userId: string, channel: 'EMAIL' | 'SMS') {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const recipient = channel === 'EMAIL' ? user.email : user.phone;
  if (!recipient) throw badRequest(`No ${channel === 'EMAIL' ? 'email address' : 'mobile number'} on this account`);
  if ((channel === 'EMAIL' && user.emailVerifiedAt) || (channel === 'SMS' && user.phoneVerifiedAt)) {
    throw conflict('Already verified');
  }
  await prisma.$transaction(async (tx) => {
    const purpose: TokenPurpose = channel === 'EMAIL' ? 'EMAIL_VERIFICATION' : 'PHONE_VERIFICATION';
    const token = await createVerificationToken(tx, userId, purpose);
    await enqueueNotification(tx, {
      userId,
      channel,
      templateKey: channel === 'EMAIL' ? 'auth.verify_email' : 'auth.verify_phone',
      recipient,
      payload: { token },
    });
  });
}

export async function confirmContactVerification(input: { token: string; userId?: string }) {
  return prisma.$transaction(async (tx) => {
    const isOtp = /^\d{6}$/.test(input.token);
    if (isOtp && !input.userId) throw badRequest('Sign in to confirm a mobile verification code');
    const tokenHash = sha256Hex(isOtp ? `${input.userId}:${input.token}` : input.token);
    const record = await tx.verificationToken.findUnique({ where: { tokenHash } });
    if (
      !record ||
      record.consumedAt ||
      record.expiresAt <= new Date() ||
      (record.purpose !== 'EMAIL_VERIFICATION' && record.purpose !== 'PHONE_VERIFICATION')
    ) {
      throw new AppError(400, 'TOKEN_INVALID', 'This verification code is invalid or has expired');
    }
    await tx.verificationToken.update({ where: { id: record.id }, data: { consumedAt: new Date() } });
    const user = await tx.user.findUniqueOrThrow({ where: { id: record.userId } });
    const now = new Date();
    const updated = await tx.user.update({
      where: { id: user.id },
      data: {
        ...(record.purpose === 'EMAIL_VERIFICATION' ? { emailVerifiedAt: now } : { phoneVerifiedAt: now }),
        // Patients become ACTIVE once one contact channel is verified.
        ...(user.status === 'PENDING_VERIFICATION' ? { status: 'ACTIVE' as const } : {}),
      },
    });
    await audit(tx, {
      action: record.purpose === 'EMAIL_VERIFICATION' ? 'auth.email_verified' : 'auth.phone_verified',
      entityType: 'user',
      entityId: user.id,
      actorUserId: user.id,
    });
    return { status: updated.status };
  });
}
