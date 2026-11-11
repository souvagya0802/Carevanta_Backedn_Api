import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { resetDatabase } from '../helpers/db.js';
import { api } from '../helpers/factory.js';
import { decryptNotificationPayload } from '../../src/modules/notifications/notifications.service.js';
import { randomToken, sha256Hex } from '../../src/lib/crypto.js';
import { MAX_OTP_ATTEMPTS } from '../../src/modules/auth/auth.service.js';

const V = '/api/v1';
const PASSWORD = 'Patient-Passphrase-1';
let n = 0;

beforeAll(resetDatabase);

async function signUpByEmail() {
  const email = `qa.otp.${Date.now()}.${n++}@test.carevanta.local`;
  const reg = await api().post(`${V}/auth/register`).send({ fullName: 'QA Otp Patient', email, password: PASSWORD });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  return { userId: reg.body.data.id as string, email };
}

async function latestEmailCode(userId: string): Promise<string> {
  const row = await prisma.notification.findFirstOrThrow({ where: { userId, templateKey: 'auth.verify_email', channel: 'EMAIL' }, orderBy: { createdAt: 'desc' } });
  return (decryptNotificationPayload(row.payload) as { token: string }).token;
}

const wrongFor = (code: string, i: number) => String((Number(code) + 1 + i) % 1_000_000).padStart(6, '0');

describe('email sign-up uses a 6-digit code', () => {
  it('sends a 6-digit code that expires in 30 minutes, and the code activates the account', async () => {
    const { userId } = await signUpByEmail();
    const code = await latestEmailCode(userId);
    expect(code).toMatch(/^\d{6}$/);
    const token = await prisma.verificationToken.findFirstOrThrow({ where: { userId, purpose: 'EMAIL_VERIFICATION', consumedAt: null } });
    const ttlMin = (token.expiresAt.getTime() - token.createdAt.getTime()) / 60_000;
    expect(ttlMin).toBeGreaterThan(29);
    expect(ttlMin).toBeLessThanOrEqual(30.1);

    const ok = await api().post(`${V}/auth/verify/confirm`).send({ token: code, userId });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.status).toBe('ACTIVE');
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.emailVerifiedAt).not.toBeNull();
    // Used once only.
    expect((await api().post(`${V}/auth/verify/confirm`).send({ token: code, userId })).status).toBe(400);
  });

  it('needs the account id with a 6-digit code, and another account cannot use it', async () => {
    const a = await signUpByEmail();
    const b = await signUpByEmail();
    const code = await latestEmailCode(a.userId);
    expect((await api().post(`${V}/auth/verify/confirm`).send({ token: code })).status).toBe(400);
    expect((await api().post(`${V}/auth/verify/confirm`).send({ token: code, userId: b.userId })).status).toBe(400);
    expect((await api().post(`${V}/auth/verify/confirm`).send({ token: code, userId: a.userId })).status).toBe(200);
  });

  it(`locks the code after ${MAX_OTP_ATTEMPTS} wrong tries; even the right code then fails until a new one is sent`, async () => {
    const { userId, email } = await signUpByEmail();
    const code = await latestEmailCode(userId);
    for (let i = 0; i < MAX_OTP_ATTEMPTS - 1; i++) {
      const wrong = await api().post(`${V}/auth/verify/confirm`).send({ token: wrongFor(code, i), userId });
      expect(wrong.status).toBe(400);
      expect(wrong.body.error.code).toBe('TOKEN_INVALID');
    }
    const last = await api().post(`${V}/auth/verify/confirm`).send({ token: wrongFor(code, MAX_OTP_ATTEMPTS), userId });
    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe('TOO_MANY_ATTEMPTS');
    expect(last.body.error.message).toContain('Send a new code');
    expect((await api().post(`${V}/auth/verify/confirm`).send({ token: code, userId })).status).toBe(400);

    // A resend issues a fresh 6-digit code that works.
    const login = await api().post(`${V}/auth/login`).send({ identifier: email, password: PASSWORD });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    const resend = await api().post(`${V}/auth/verify/request`).set('Authorization', `Bearer ${login.body.data.accessToken}`).send({ channel: 'EMAIL' });
    expect(resend.status, JSON.stringify(resend.body)).toBeLessThan(300);
    const fresh = await latestEmailCode(userId);
    expect(fresh).toMatch(/^\d{6}$/);
    const ok = await api().post(`${V}/auth/verify/confirm`).send({ token: fresh, userId });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.status).toBe('ACTIVE');
  });

  it('the right code after a few wrong ones still works and is not counted as a failure', async () => {
    const { userId } = await signUpByEmail();
    const code = await latestEmailCode(userId);
    for (let i = 0; i < 2; i++) expect((await api().post(`${V}/auth/verify/confirm`).send({ token: wrongFor(code, i), userId })).status).toBe(400);
    expect((await prisma.verificationToken.findFirstOrThrow({ where: { userId, purpose: 'EMAIL_VERIFICATION', consumedAt: null } })).attempts).toBe(2);
    expect((await api().post(`${V}/auth/verify/confirm`).send({ token: code, userId })).status).toBe(200);
  });

  it('still accepts an older long email link token until it expires', async () => {
    const { userId } = await signUpByEmail();
    const legacy = randomToken(32);
    await prisma.verificationToken.create({
      data: { userId, purpose: 'EMAIL_VERIFICATION', tokenHash: sha256Hex(legacy), expiresAt: new Date(Date.now() + 60 * 60_000) },
    });
    const ok = await api().post(`${V}/auth/verify/confirm`).send({ token: legacy });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.status).toBe('ACTIVE');
  });

  it('password reset still sends a long link token, not a 6-digit code', async () => {
    const { userId, email } = await signUpByEmail();
    expect((await api().post(`${V}/auth/password/forgot`).send({ identifier: email })).status).toBeLessThan(300);
    const row = await prisma.notification.findFirstOrThrow({ where: { userId, templateKey: 'auth.password_reset' }, orderBy: { createdAt: 'desc' } });
    const { token } = decryptNotificationPayload(row.payload) as { token: string };
    expect(token).not.toMatch(/^\d{6}$/);
    expect(token.length).toBeGreaterThan(20);
  });
});
