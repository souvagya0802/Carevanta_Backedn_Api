import { prisma, type Tx } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { AppError, badRequest, conflict, forbidden, isPgError, notFound, preconditionFailed } from '../../lib/errors.js';
import { randomToken, sha256Hex } from '../../lib/crypto.js';
import { enqueueNotification, maskRecipient } from '../notifications/notifications.service.js';
import { revokeAllSessions } from '../auth/auth.service.js';
import type { AuthContext } from '../../middleware/auth.js';
import type { Prisma, UserStatus } from '../../../generated/prisma/client.js';
import { buildPage, cursorOrderBy, cursorWhere } from '../../lib/pagination.js';
import { iso } from '../../http/dto.js';

export function userDto(u: {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  status: UserStatus;
  emailVerifiedAt: Date | null;
  phoneVerifiedAt: Date | null;
  lastLoginAt: Date | null;
  lockedUntil: Date | null;
  createdAt: Date;
  roles?: { role: { key: string } }[];
}) {
  return {
    id: u.id,
    fullName: u.fullName,
    email: u.email,
    phone: u.phone,
    status: u.status,
    emailVerified: !!u.emailVerifiedAt,
    phoneVerified: !!u.phoneVerifiedAt,
    locked: !!(u.lockedUntil && u.lockedUntil > new Date()),
    lastLoginAt: iso(u.lastLoginAt),
    createdAt: u.createdAt.toISOString(),
    roles: (u.roles ?? []).map((r) => r.role.key),
  };
}

function searchPredicate(raw: string): Prisma.UserWhereInput {
  const q = raw.trim();
  if (q.includes('@')) return { email: { contains: q.toLowerCase() } };
  const digits = q.replace(/[\s\-()+]/g, '');
  if (/^\d{4,}$/.test(digits)) return { phone: { contains: digits } };
  return { fullName: { contains: q, mode: 'insensitive' } };
}

export async function listUsers(q: {
  limit: number;
  cursor?: string;
  q?: string;
  status?: UserStatus;
  role?: string;
}) {
  const where: Prisma.UserWhereInput = {
    ...(q.status ? { status: q.status } : {}),
    ...(q.role ? { roles: { some: { revokedAt: null, role: { key: q.role } } } } : {}),
    // Match on the one field the query looks like, so a name search never
    // scans email/phone (only full_name has a trigram index).
    ...(q.q ? searchPredicate(q.q) : {}),
    ...cursorWhere(q.cursor),
  };
  const rows = await prisma.user.findMany({
    where,
    orderBy: cursorOrderBy(),
    take: q.limit + 1,
    include: { roles: { where: { revokedAt: null }, select: { role: { select: { key: true } } } } },
  });
  const { items, page } = buildPage(rows, q.limit, (u) => u.createdAt);
  return { items: items.map(userDto), page };
}

async function roleWithPermissions(db: Tx | typeof prisma, key: string) {
  const role = await db.role.findUnique({
    where: { key },
    include: { permissions: { include: { permission: true } } },
  });
  if (!role) throw notFound('Role');
  return role;
}

/**
 * Anti-escalation: an actor may only grant a role whose every permission they
 * already hold, may never change their own roles, and only a super-admin can
 * grant SUPER_ADMIN.
 */
export function assertCanGrant(actor: AuthContext, role: { key: string; permissions: { permission: { key: string } }[] }) {
  if (role.key === 'SUPER_ADMIN' && !actor.isSuperAdmin) throw forbidden('Only a super-admin can grant SUPER_ADMIN');
  if (actor.isSuperAdmin) return;
  const missing = role.permissions.map((p) => p.permission.key).filter((k) => !actor.permissions.has(k));
  if (missing.length) throw forbidden('You cannot grant a role with permissions you do not hold');
}

async function assertActorMayManageTarget(actor: AuthContext, targetId: string) {
  if (actor.userId === targetId) throw forbidden('You cannot change your own account this way');
  if (actor.isSuperAdmin) return;
  const isTargetSuper = await prisma.userRole.count({
    where: { userId: targetId, revokedAt: null, role: { key: 'SUPER_ADMIN' } },
  });
  if (isTargetSuper) throw forbidden('Only a super-admin can manage a super-admin account');
}

export async function createUser(
  actor: AuthContext,
  input: { fullName: string; email?: string; phone?: string; roles: string[]; sendInvite: boolean },
) {
  if (!input.email && !input.phone) throw badRequest('Provide an email address or a mobile number');
  const roles = await Promise.all(input.roles.map((k) => roleWithPermissions(prisma, k)));
  roles.forEach((r) => assertCanGrant(actor, r));
  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          fullName: input.fullName,
          email: input.email?.toLowerCase(),
          phone: input.phone,
          status: 'ACTIVE',
          mustChangePassword: true,
          createdById: actor.userId,
        },
      });
      for (const role of roles) {
        await tx.userRole.create({ data: { userId: user.id, roleId: role.id, grantedById: actor.userId } });
      }
      if (input.sendInvite) {
        // The user sets their own password via a one-time token; admins never
        // see or choose passwords.
        const token = randomToken(32);
        await tx.verificationToken.create({
          data: { userId: user.id, purpose: 'PASSWORD_RESET', tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + 72 * 3600_000) },
        });
        await enqueueNotification(tx, {
          userId: user.id,
          channel: input.email ? 'EMAIL' : 'SMS',
          templateKey: 'auth.account_created',
          recipient: (input.email ?? input.phone)!,
          payload: { token },
        });
      }
      await audit(tx, {
        action: 'user.created',
        entityType: 'user',
        entityId: user.id,
        metadata: { roles: input.roles, invite: input.sendInvite },
      });
      return user.id;
    });
  } catch (err) {
    if (isPgError(err, '23505')) throw conflict('A user with this email or mobile number already exists');
    throw err;
  }
}

const RESET_TTL_MIN = 60;

/**
 * Admin-initiated password reset: a one-time token goes to the user's own
 * email (or mobile). The administrator never sees the token or any password.
 */
export async function sendPasswordReset(actor: AuthContext, id: string) {
  const user = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true, phone: true, status: true, roles: { where: { revokedAt: null }, select: { role: { select: { key: true } } } } } });
  if (!user) throw notFound('User');
  if (user.status !== 'ACTIVE' && user.status !== 'PENDING_VERIFICATION') throw preconditionFailed('Only active accounts can receive a reset link');
  const recipient = user.email ?? user.phone;
  if (!recipient) throw preconditionFailed('This account has no email address or mobile number');
  const targetIsSuper = user.roles.some((r) => r.role.key === 'SUPER_ADMIN');
  if (targetIsSuper && !actor.isSuperAdmin) throw forbidden('Only a super-admin can reset a super-admin account');
  const channel: 'EMAIL' | 'SMS' = user.email ? 'EMAIL' : 'SMS';
  await prisma.$transaction(async (tx) => {
    const token = randomToken(32);
    await tx.verificationToken.create({
      data: { userId: user.id, purpose: 'PASSWORD_RESET', tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + RESET_TTL_MIN * 60_000) },
    });
    await enqueueNotification(tx, { userId: user.id, channel, templateKey: 'auth.password_reset', recipient, payload: { token, expiresInMinutes: RESET_TTL_MIN } });
    await audit(tx, { action: 'user.password_reset_sent', entityType: 'user', entityId: user.id, metadata: { channel } });
  });
  return { channel, recipient: maskRecipient(recipient), expiresInMinutes: RESET_TTL_MIN };
}

export async function getUser(id: string) {
  const u = await prisma.user.findUnique({
    where: { id },
    include: {
      roles: {
        orderBy: { grantedAt: 'desc' },
        include: { role: { select: { key: true, name: true } } },
      },
      providerMemberships: { include: { provider: { select: { id: true, displayName: true, type: true } } } },
      patientProfiles: { select: { id: true, relationship: true, isActive: true } },
      doctorProfile: { select: { providerId: true } },
    },
  });
  if (!u) throw notFound('User');
  return {
    ...userDto({ ...u, roles: u.roles.filter((r) => !r.revokedAt) }),
    mustChangePassword: u.mustChangePassword,
    statusReason: u.statusReason,
    failedLoginCount: u.failedLoginCount,
    lockedUntil: iso(u.lockedUntil),
    preferredLanguage: u.preferredLanguage,
    updatedAt: u.updatedAt.toISOString(),
    roleHistory: u.roles.map((r) => ({
      roleKey: r.role.key,
      roleName: r.role.name,
      grantedAt: r.grantedAt.toISOString(),
      grantedById: r.grantedById,
      revokedAt: iso(r.revokedAt),
      revokedById: r.revokedById,
    })),
    providerMemberships: u.providerMemberships.map((m) => ({
      providerId: m.providerId,
      providerName: m.provider.displayName,
      providerType: m.provider.type,
      memberRole: m.memberRole,
      status: m.status,
    })),
    patientProfileCount: u.patientProfiles.length,
    doctorProviderId: u.doctorProfile?.providerId ?? null,
  };
}

export async function updateUser(
  actor: AuthContext,
  id: string,
  input: { fullName?: string; email?: string | null; phone?: string | null; preferredLanguage?: string },
) {
  await assertActorMayManageTarget(actor, id);
  const before = await prisma.user.findUnique({ where: { id } });
  if (!before) throw notFound('User');
  if (before.status === 'ANONYMISED') throw conflict('Anonymised accounts cannot be edited');
  // Addresses are stored lower-case; compare the same way so "Name@x" → "name@x" is not treated as a new, unverified address.
  const nextEmail = input.email === undefined ? before.email : (input.email?.toLowerCase() ?? null);
  const nextPhone = input.phone === undefined ? before.phone : input.phone;
  if (!nextEmail && !nextPhone) throw badRequest('An account needs an email address or a mobile number');
  try {
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: {
          ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
          ...(input.email !== undefined
            ? { email: nextEmail, emailVerifiedAt: nextEmail === before.email ? before.emailVerifiedAt : null }
            : {}),
          ...(input.phone !== undefined
            ? { phone: input.phone, phoneVerifiedAt: input.phone === before.phone ? before.phoneVerifiedAt : null }
            : {}),
          ...(input.preferredLanguage ? { preferredLanguage: input.preferredLanguage } : {}),
        },
      });
      await audit(tx, {
        action: 'user.updated',
        entityType: 'user',
        entityId: id,
        metadata: { fields: Object.keys(input) },
      });
    });
  } catch (err) {
    if (isPgError(err, '23505')) throw conflict('Another account already uses this email or mobile number');
    throw err;
  }
}

const STATUS_TRANSITIONS: Record<UserStatus, UserStatus[]> = {
  PENDING_VERIFICATION: ['ACTIVE', 'SUSPENDED', 'DEACTIVATED'],
  ACTIVE: ['SUSPENDED', 'DEACTIVATED'],
  SUSPENDED: ['ACTIVE', 'DEACTIVATED'],
  DEACTIVATED: ['ACTIVE'],
  ANONYMISED: [],
};

export async function changeUserStatus(actor: AuthContext, id: string, status: UserStatus, reason: string) {
  await assertActorMayManageTarget(actor, id);
  await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id } });
    if (!user) throw notFound('User');
    if (!STATUS_TRANSITIONS[user.status].includes(status)) {
      throw new AppError(409, 'INVALID_STATE_TRANSITION', `User cannot move from ${user.status} to ${status}`);
    }
    if (status !== 'ACTIVE') await assertNotLastSuperAdmin(tx, id);
    const updated = await tx.user.updateMany({ where: { id, status: user.status }, data: { status, statusReason: reason } });
    if (updated.count !== 1) throw conflict('The account changed concurrently; please retry');
    if (status !== 'ACTIVE') await revokeAllSessions(tx, id, `STATUS_${status}`);
    await audit(tx, {
      action: 'user.status_changed',
      entityType: 'user',
      entityId: id,
      metadata: { from: user.status, to: status, reason },
    });
  });
}

async function assertNotLastSuperAdmin(tx: Tx, userId: string) {
  const isSuper = await tx.userRole.count({ where: { userId, revokedAt: null, role: { key: 'SUPER_ADMIN' } } });
  if (!isSuper) return;
  const others = await tx.userRole.count({
    where: { revokedAt: null, role: { key: 'SUPER_ADMIN' }, userId: { not: userId }, user: { status: 'ACTIVE' } },
  });
  if (others === 0) throw preconditionFailed('This is the last active super-admin; add another super-admin first');
}

export async function unlockUser(actor: AuthContext, id: string) {
  await assertActorMayManageTarget(actor, id);
  await prisma.$transaction(async (tx) => {
    const res = await tx.user.updateMany({ where: { id }, data: { lockedUntil: null, failedLoginCount: 0 } });
    if (res.count === 0) throw notFound('User');
    await audit(tx, { action: 'user.unlocked', entityType: 'user', entityId: id });
  });
}

export async function revokeUserSessions(actor: AuthContext, id: string) {
  await assertActorMayManageTarget(actor, id);
  await prisma.$transaction(async (tx) => {
    if (!(await tx.user.findUnique({ where: { id }, select: { id: true } }))) throw notFound('User');
    await revokeAllSessions(tx, id, 'ADMIN_REVOKED');
    await audit(tx, { action: 'user.sessions_revoked', entityType: 'user', entityId: id });
  });
}

export async function assignRole(actor: AuthContext, userId: string, roleKey: string, reason?: string) {
  await assertActorMayManageTarget(actor, userId);
  const role = await roleWithPermissions(prisma, roleKey);
  assertCanGrant(actor, role);
  try {
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw notFound('User');
      if (user.status === 'ANONYMISED' || user.status === 'DEACTIVATED') throw conflict('Cannot grant roles to an inactive account');
      await tx.userRole.create({ data: { userId, roleId: role.id, grantedById: actor.userId, reason } });
      await audit(tx, { action: 'user.role_granted', entityType: 'user', entityId: userId, metadata: { role: roleKey, reason } });
    });
  } catch (err) {
    if (isPgError(err, '23505')) throw conflict('The user already has this role');
    throw err;
  }
}

export async function revokeRole(actor: AuthContext, userId: string, roleKey: string, reason?: string) {
  await assertActorMayManageTarget(actor, userId);
  const role = await roleWithPermissions(prisma, roleKey);
  assertCanGrant(actor, role);
  await prisma.$transaction(async (tx) => {
    if (roleKey === 'SUPER_ADMIN') await assertNotLastSuperAdmin(tx, userId);
    const res = await tx.userRole.updateMany({
      where: { userId, roleId: role.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedById: actor.userId, reason },
    });
    if (res.count === 0) throw notFound('Active role assignment');
    await audit(tx, { action: 'user.role_revoked', entityType: 'user', entityId: userId, metadata: { role: roleKey, reason } });
  });
}

export async function userActivity(id: string, limit: number) {
  const [events, attempts] = await Promise.all([
    prisma.auditEvent.findMany({
      where: { OR: [{ actorUserId: id }, { entityType: 'user', entityId: id }] },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: { id: true, occurredAt: true, action: true, entityType: true, entityId: true, outcome: true, actorUserId: true },
    }),
    prisma.loginAttempt.findMany({
      where: { userId: id },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, createdAt: true, success: true, reason: true, ipAddress: true },
    }),
  ]);
  return {
    auditEvents: events.map((e) => ({ ...e, occurredAt: e.occurredAt.toISOString() })),
    loginAttempts: attempts.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() })),
  };
}

/**
 * Irreversible anonymisation under the retention policy. Blocked while a legal
 * hold exists or while the user owns a doctor profile / provider (those records
 * have professional and financial retention obligations).
 */
export async function anonymiseUser(actor: AuthContext, id: string, reason: string) {
  await assertActorMayManageTarget(actor, id);
  await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id }, include: { doctorProfile: true } });
    if (!user) throw notFound('User');
    if (user.status === 'ANONYMISED') throw conflict('Already anonymised');
    const hold = await tx.legalHold.count({ where: { entityType: 'user', entityId: id, releasedAt: null } });
    if (hold) throw preconditionFailed('A legal hold prevents anonymising this account');
    if (user.doctorProfile) throw preconditionFailed('Doctor accounts must be deactivated, not anonymised (professional records retention)');
    const owner = await tx.providerMember.count({ where: { userId: id, memberRole: 'OWNER', status: 'ACTIVE' } });
    if (owner) throw preconditionFailed('Transfer provider ownership before anonymising this account');
    await assertNotLastSuperAdmin(tx, id);

    await tx.user.update({
      where: { id },
      data: {
        fullName: 'Anonymised user',
        email: null,
        phone: null,
        passwordHash: null,
        status: 'ANONYMISED',
        statusReason: 'Anonymised under retention policy',
        anonymisedAt: new Date(),
        emailVerifiedAt: null,
        phoneVerifiedAt: null,
      },
    });
    await tx.patientProfile.updateMany({
      where: { accountUserId: id },
      data: { fullName: 'Anonymised patient', phone: null, dateOfBirth: null, gender: null, isActive: false },
    });
    await tx.userRole.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date(), revokedById: actor.userId } });
    await tx.providerMember.updateMany({ where: { userId: id, status: { not: 'REMOVED' } }, data: { status: 'REMOVED', removedAt: new Date() } });
    await revokeAllSessions(tx, id, 'ANONYMISED');
    await tx.verificationToken.deleteMany({ where: { userId: id } });
    await audit(tx, { action: 'user.anonymised', entityType: 'user', entityId: id, metadata: { reason } });
  });
}
