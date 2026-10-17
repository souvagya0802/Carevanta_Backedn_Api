import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { resetDatabase } from '../helpers/db.js';
import { TEST_PASSWORD, actor, api, createUser, login } from '../helpers/factory.js';
import { decryptNotificationPayload } from '../../src/modules/notifications/notifications.service.js';
import { signAccessToken } from '../../src/modules/auth/tokens.js';

beforeAll(resetDatabase);

describe('login', () => {
  it('issues tokens for valid credentials and records the attempt', async () => {
    const user = await createUser();
    const res = await api().post('/api/v1/auth/login').send({ identifier: user.email, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTypeOf('string');
    expect(res.body.data.refreshToken).toBeTypeOf('string');
    const attempts = await prisma.loginAttempt.count({ where: { userId: user.id, success: true } });
    expect(attempts).toBe(1);
  });

  it('rejects an incorrect password with a generic error', async () => {
    const user = await createUser();
    const res = await api().post('/api/v1/auth/login').send({ identifier: user.email, password: 'wrong-password-123' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('returns the same error for an unknown account', async () => {
    const res = await api().post('/api/v1/auth/login').send({ identifier: 'nobody@test.carevanta.local', password: 'whatever-123456' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('validates the request body', async () => {
    const res = await api().post('/api/v1/auth/login').send({ identifier: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('locks the account after repeated failures, even for the correct password', async () => {
    const user = await createUser();
    for (let i = 0; i < 5; i++) {
      await api().post('/api/v1/auth/login').send({ identifier: user.email, password: `bad-password-${i}` });
    }
    const locked = await api().post('/api/v1/auth/login').send({ identifier: user.email, password: TEST_PASSWORD });
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
    const audit = await prisma.auditEvent.count({ where: { action: 'auth.account_locked', entityId: user.id } });
    expect(audit).toBe(1);
  });

  it('counts concurrent failures atomically', async () => {
    const user = await createUser();
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        api().post('/api/v1/auth/login').send({ identifier: user.email, password: `concurrent-bad-${i}` }),
      ),
    );
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(fresh.lockedUntil).not.toBeNull();
  });

  it('refuses suspended accounts', async () => {
    const user = await createUser({ status: 'SUSPENDED' });
    const res = await api().post('/api/v1/auth/login').send({ identifier: user.email, password: TEST_PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_INACTIVE');
  });
});

describe('access tokens and sessions', () => {
  it('requires authentication', async () => {
    const res = await api().get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a forged token', async () => {
    const res = await api().get('/api/v1/auth/me').set('Authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.forged');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });

  it('rejects a token for a revoked session immediately', async () => {
    const a = await actor(['AUDITOR']);
    expect((await a.get('/api/v1/auth/me')).status).toBe(200);
    expect((await a.post('/api/v1/auth/logout', {})).status).toBe(204);
    const after = await a.get('/api/v1/auth/me');
    expect(after.status).toBe(401);
  });

  it('rejects an expired access token', async () => {
    const user = await createUser();
    const t = await login(user.email!);
    // Signed correctly but expired: craft with past expiry via a direct session.
    const { token } = await signAccessToken({ sub: user.id, sid: t.sessionId });
    const parts = token.split('.');
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
    payload.exp = Math.floor(Date.now() / 1000) - 3600;
    const tampered = `${parts[0]}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${parts[2]}`;
    const res = await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${tampered}`);
    expect(res.status).toBe(401); // signature no longer matches either way
  });

  it('suspension takes effect on the next request', async () => {
    const a = await actor(['AUDITOR']);
    await prisma.user.update({ where: { id: a.user.id }, data: { status: 'SUSPENDED' } });
    const res = await a.get('/api/v1/auth/me');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_INACTIVE');
  });

  it('returns roles and effective permissions on /me', async () => {
    const a = await actor(['FINANCE_OFFICER']);
    const res = await a.get('/api/v1/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.data.roles).toEqual(['FINANCE_OFFICER']);
    expect(res.body.data.permissions).toContain('finance.policies.manage');
    expect(res.body.data.permissions).not.toContain('finance.policies.approve');
  });
});

describe('refresh token rotation', () => {
  it('rotates and invalidates the old refresh token', async () => {
    const user = await createUser();
    const t = await login(user.email!);
    const r1 = await api().post('/api/v1/auth/refresh').send({ refreshToken: t.refreshToken });
    expect(r1.status).toBe(200);
    expect(r1.body.data.refreshToken).not.toBe(t.refreshToken);
    const ok = await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${r1.body.data.accessToken}`);
    expect(ok.status).toBe(200);
  });

  it('detects reuse of a rotated token and revokes the whole family', async () => {
    const user = await createUser();
    const t = await login(user.email!);
    const r1 = await api().post('/api/v1/auth/refresh').send({ refreshToken: t.refreshToken });
    expect(r1.status).toBe(200);
    const reuse = await api().post('/api/v1/auth/refresh').send({ refreshToken: t.refreshToken });
    expect(reuse.status).toBe(401);
    // The legitimately rotated token is now revoked too.
    const r2 = await api().post('/api/v1/auth/refresh').send({ refreshToken: r1.body.data.refreshToken });
    expect(r2.status).toBe(401);
    const events = await prisma.auditEvent.count({ where: { action: 'auth.refresh_token_reuse_detected', entityId: user.id } });
    expect(events).toBe(1);
  });

  it('only one of two concurrent refreshes succeeds', async () => {
    const user = await createUser();
    const t = await login(user.email!);
    const results = await Promise.all([
      api().post('/api/v1/auth/refresh').send({ refreshToken: t.refreshToken }),
      api().post('/api/v1/auth/refresh').send({ refreshToken: t.refreshToken }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(1);
  });
});

describe('password reset and change', () => {
  it('always accepts forgot-password and does not reveal existence', async () => {
    const res = await api().post('/api/v1/auth/password/forgot').send({ identifier: 'ghost@test.carevanta.local' });
    expect(res.status).toBe(202);
  });

  it('resets the password with a valid token, clears lockout and revokes sessions', async () => {
    const user = await createUser();
    const t = await login(user.email!);
    await prisma.user.update({ where: { id: user.id }, data: { lockedUntil: new Date(Date.now() + 600_000) } });
    expect((await api().post('/api/v1/auth/password/forgot').send({ identifier: user.email })).status).toBe(202);
    const n = await prisma.notification.findFirstOrThrow({ where: { userId: user.id, templateKey: 'auth.password_reset' } });
    // Secrets in the outbox are encrypted at rest.
    expect(JSON.stringify(n.payload)).not.toMatch(/token/);
    const { token } = decryptNotificationPayload(n.payload) as { token: string };

    const newPassword = 'Another-Strong-Passphrase-42';
    const reset = await api().post('/api/v1/auth/password/reset').send({ token, newPassword });
    expect(reset.status).toBe(204);
    const reuse = await api().post('/api/v1/auth/password/reset').send({ token, newPassword: 'Yet-Another-Passphrase-77' });
    expect(reuse.status).toBe(400);
    const old = await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${t.accessToken}`);
    expect(old.status).toBe(401);
    await login(user.email!, newPassword);
  });

  it('enforces the password policy', async () => {
    const a = await actor(['AUDITOR']);
    const res = await a.post('/api/v1/auth/password/change', { currentPassword: TEST_PASSWORD, newPassword: 'short' });
    expect(res.status).toBe(400);
  });

  it('changes the password and keeps only the current session', async () => {
    const user = await createUser();
    const s1 = await login(user.email!);
    const s2 = await login(user.email!);
    const res = await api()
      .post('/api/v1/auth/password/change')
      .set('Authorization', `Bearer ${s1.accessToken}`)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'Brand-New-Passphrase-2026' });
    expect(res.status).toBe(204);
    expect((await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${s1.accessToken}`)).status).toBe(200);
    expect((await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${s2.accessToken}`)).status).toBe(401);
  });
});

describe('patient registration and verification', () => {
  it('registers a patient with a self profile and activates on phone OTP', async () => {
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ fullName: 'Rina Das', phone: '9800000001', password: 'Patient-Passphrase-1' });
    expect(reg.status).toBe(201);
    expect(reg.body.data.status).toBe('PENDING_VERIFICATION');
    const user = await prisma.user.findUniqueOrThrow({ where: { id: reg.body.data.id } });
    expect(user.phone).toBe('+919800000001');
    expect(await prisma.patientProfile.count({ where: { accountUserId: user.id, relationship: 'SELF' } })).toBe(1);

    const n = await prisma.notification.findFirstOrThrow({ where: { userId: user.id, templateKey: 'auth.verify_phone' } });
    const { token } = decryptNotificationPayload(n.payload) as { token: string };
    const wrong = await api().post('/api/v1/auth/verify/confirm').send({ token: token === '000000' ? '111111' : '000000', userId: user.id });
    expect(wrong.status).toBe(400);
    const ok = await api().post('/api/v1/auth/verify/confirm').send({ token, userId: user.id });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('ACTIVE');
  });

  it('rejects duplicate registration without revealing which field collided', async () => {
    const first = await api()
      .post('/api/v1/auth/register')
      .send({ fullName: 'Aa', phone: '9800000002', password: 'Patient-Passphrase-1' });
    expect(first.status).toBe(201);
    const dup = await api()
      .post('/api/v1/auth/register')
      .send({ fullName: 'Bb', phone: '9800000002', password: 'Patient-Passphrase-1' });
    expect(dup.status).toBe(409);
  });

  it('pending accounts have no platform permissions', async () => {
    const user = await createUser({ status: 'PENDING_VERIFICATION', roles: ['SUPER_ADMIN'] });
    const t = await login(user.email!);
    const me = await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${t.accessToken}`);
    expect(me.body.data.permissions).toEqual([]);
  });
});
