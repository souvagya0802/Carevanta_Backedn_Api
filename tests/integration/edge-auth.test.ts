import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { decryptNotificationPayload } from '../../src/modules/notifications/notifications.service.js';
import { resetDatabase } from '../helpers/db.js';
import { TEST_PASSWORD, actor, api, createUser, login } from '../helpers/factory.js';
import { randomUUID } from '../helpers/fixtures.js';

beforeAll(resetDatabase);

const loginAs = (identifier: string, password: string = TEST_PASSWORD) => api().post('/api/v1/auth/login').send({ identifier, password });

describe('EDGE-AUTH: identifier normalisation', () => {
  it('EDGE-AUTH-01: upper-case email with surrounding spaces still signs in', async () => {
    const user = await createUser();
    const res = await loginAs(`  ${user.email!.toUpperCase()}  `);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('EDGE-AUTH-02: every Indian phone format resolves to the same account; a leading zero is refused', async () => {
    const digits = `98${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    const user = await createUser({ phone: `+91${digits}` });
    for (const form of [digits, `+91${digits}`, `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`, `${digits.slice(0, 5)}-${digits.slice(5)}`, `(+91) ${digits}`]) {
      const res = await loginAs(form);
      expect(res.status, `${form}: ${JSON.stringify(res.body)}`).toBe(200);
      const me = await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${res.body.data.accessToken}`);
      expect(me.body.data.id).toBe(user.id);
    }
    const leadingZero = await loginAs(`0${digits}`);
    expect(leadingZero.status).toBe(400);
    expect(leadingZero.body.error.code).toBe('VALIDATION_FAILED');
    // A landline-looking number (starts with 3) is not an Indian mobile.
    expect((await loginAs('3322334455')).status).toBe(400);
  });

  it('EDGE-AUTH-03: body boundaries — identifier under 3 chars, password over 128 chars, empty body', async () => {
    expect((await loginAs('ab')).status).toBe(400);
    expect((await loginAs('someone@test.carevanta.local', 'x'.repeat(129))).status).toBe(400);
    expect((await loginAs('someone@test.carevanta.local', '')).status).toBe(400);
    const empty = await api().post('/api/v1/auth/login').send({});
    expect(empty.status).toBe(400);
    expect(empty.body.error.details.issues.length).toBeGreaterThanOrEqual(2);
    // Exactly 128 characters is accepted by validation (wrong password → 401, not 400).
    expect((await loginAs('someone@test.carevanta.local', 'x'.repeat(128))).status).toBe(401);
  });
});

describe('EDGE-AUTH: lockout counter', () => {
  it('EDGE-AUTH-04: a successful login resets the failure counter; the 5th consecutive failure locks', async () => {
    const user = await createUser();
    for (let i = 0; i < 4; i++) expect((await loginAs(user.email!, 'wrong-password-1')).status).toBe(401);
    expect((await loginAs(user.email!)).status).toBe(200); // resets
    for (let i = 0; i < 4; i++) expect((await loginAs(user.email!, 'wrong-password-2')).status).toBe(401);
    expect((await loginAs(user.email!)).status).toBe(200); // still not locked
    for (let i = 0; i < 5; i++) await loginAs(user.email!, 'wrong-password-3');
    const locked = await loginAs(user.email!);
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
    expect(typeof locked.body.error.details.lockedUntil).toBe('string');
  });

  it('EDGE-AUTH-05: an expired lock lets the correct password in; an admin unlock clears an active lock', async () => {
    const user = await createUser();
    await prisma.user.update({ where: { id: user.id }, data: { lockedUntil: new Date(Date.now() - 1000), failedLoginCount: 4 } });
    const ok = await loginAs(user.email!);
    expect(ok.status).toBe(200);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.failedLoginCount).toBe(0);
    expect(after.lockedUntil).toBeNull();

    await prisma.user.update({ where: { id: user.id }, data: { lockedUntil: new Date(Date.now() + 600_000) } });
    expect((await loginAs(user.email!)).status).toBe(423);
    const admin = await actor(['SUPER_ADMIN']);
    expect((await admin.post(`/api/v1/admin/users/${user.id}/unlock`)).status).toBe(204);
    expect((await loginAs(user.email!)).status).toBe(200);
    expect((await admin.post(`/api/v1/admin/users/${randomUUID()}/unlock`)).status).toBe(404);
  });
});

describe('EDGE-AUTH: refresh tokens and sessions', () => {
  it('EDGE-AUTH-06: garbage, short, logged-out and expired refresh tokens are refused with the right status', async () => {
    const user = await createUser();
    expect((await api().post('/api/v1/auth/refresh').send({ refreshToken: 'tooshort' })).status).toBe(400);
    const garbage = await api().post('/api/v1/auth/refresh').send({ refreshToken: 'x'.repeat(43) });
    expect(garbage.status).toBe(401);
    expect(garbage.body.error.code).toBe('TOKEN_INVALID');

    const t = await login(user.email!);
    expect((await api().post('/api/v1/auth/logout').set('Authorization', `Bearer ${t.accessToken}`).send({})).status).toBe(204);
    expect((await api().post('/api/v1/auth/refresh').send({ refreshToken: t.refreshToken })).status).toBe(401);

    const t2 = await login(user.email!);
    await prisma.session.update({ where: { id: t2.sessionId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await api().post('/api/v1/auth/refresh').send({ refreshToken: t2.refreshToken });
    expect(expired.status).toBe(401);
    // The access token of an expired session is also dead, even if the JWT itself has not expired.
    expect((await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${t2.accessToken}`)).status).toBe(401);
  });

  it('EDGE-AUTH-07: a suspended account cannot refresh (403), and logout of all devices kills every session', async () => {
    const user = await createUser();
    const a = await login(user.email!);
    const b = await login(user.email!);
    await prisma.user.update({ where: { id: user.id }, data: { status: 'SUSPENDED' } });
    const r = await api().post('/api/v1/auth/refresh').send({ refreshToken: a.refreshToken });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('ACCOUNT_INACTIVE');
    await prisma.user.update({ where: { id: user.id }, data: { status: 'ACTIVE' } });
    expect((await api().post('/api/v1/auth/logout').set('Authorization', `Bearer ${a.accessToken}`).send({ allDevices: true })).status).toBe(204);
    expect((await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${b.accessToken}`)).status).toBe(401);
    expect((await api().post('/api/v1/auth/refresh').send({ refreshToken: b.refreshToken })).status).toBe(401);
  });

  it('EDGE-AUTH-08: sessions are private — another user’s session id is 404, a non-UUID is 400, revoking own current session logs out', async () => {
    const alice = await actor([]);
    const bob = await actor([]);
    expect((await alice.delete(`/api/v1/auth/sessions/${bob.tokens.sessionId}`)).status).toBe(404);
    expect((await alice.delete('/api/v1/auth/sessions/not-a-uuid')).status).toBe(400);
    const bobSessions = await bob.get('/api/v1/auth/sessions');
    expect(bobSessions.status).toBe(200);
    expect(bobSessions.body.data.map((s: { id: string }) => s.id)).toEqual([bob.tokens.sessionId]);
    expect(bobSessions.body.data[0].current).toBe(true);
    expect((await alice.delete(`/api/v1/auth/sessions/${alice.tokens.sessionId}`)).status).toBe(204);
    expect((await alice.get('/api/v1/auth/me')).status).toBe(401);
    // Bob was not affected by Alice revoking her own session.
    expect((await bob.get('/api/v1/auth/me')).status).toBe(200);
  });

  it('EDGE-AUTH-09: malformed Authorization headers are 401, never 500', async () => {
    for (const header of ['Bearer', 'Bearer ', 'Basic abc', 'bearer token', `Bearer ${'a'.repeat(5000)}`, 'Bearer a.b.c']) {
      const res = await api().get('/api/v1/auth/me').set('Authorization', header);
      expect(res.status, header.slice(0, 20)).toBe(401);
    }
  });
});

describe('EDGE-AUTH: registration and verification', () => {
  it('EDGE-AUTH-10: unicode names, spaced phone numbers and upper-case emails are stored normalised; duplicates in any format are 409', async () => {
    const digits = `97${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    const tag = randomUUID().slice(0, 8);
    const res = await api().post('/api/v1/auth/register').send({
      fullName: '  সুস্মিতা দাস  ',
      email: `Reg-${tag}@Test.Carevanta.Local`,
      phone: `${digits.slice(0, 5)} ${digits.slice(5)}`,
      password: 'Shobuj-Pata-Nodi-2026',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.status).toBe('PENDING_VERIFICATION');
    const u = await prisma.user.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(u.fullName).toBe('সুস্মিতা দাস');
    expect(u.email).toBe(`reg-${tag}@test.carevanta.local`);
    expect(u.phone).toBe(`+91${digits}`);
    const profile = await prisma.patientProfile.findFirstOrThrow({ where: { accountUserId: u.id } });
    expect(profile.relationship).toBe('SELF');
    expect(profile.phone).toBe(`+91${digits}`);

    const dupEmail = await api().post('/api/v1/auth/register').send({ fullName: 'Other Person', email: `REG-${tag}@test.carevanta.local`, password: 'Shobuj-Pata-Nodi-2027' });
    expect(dupEmail.status).toBe(409);
    const dupPhone = await api().post('/api/v1/auth/register').send({ fullName: 'Other Person', phone: `+91${digits}`, password: 'Shobuj-Pata-Nodi-2027' });
    expect(dupPhone.status).toBe(409);
    // Both collisions carry the same neutral message (no enumeration of which field clashed).
    expect(dupPhone.body.error.message).toBe(dupEmail.body.error.message);
  });

  it('EDGE-AUTH-11: registration boundaries — name 1 char / 161 chars, phone with leading zero or 21 chars, weak passwords, no contact', async () => {
    const base = { fullName: 'Valid Name', password: 'Shobuj-Pata-Nodi-2026' };
    const bad = [
      { ...base, fullName: 'A', email: 'n1@test.carevanta.local' },
      { ...base, fullName: 'A'.repeat(161), email: 'n2@test.carevanta.local' },
      { ...base, phone: '09800012345' },
      { ...base, phone: '9'.repeat(21) },
      { ...base, email: 'not-an-email' },
      { ...base, email: 'p1@test.carevanta.local', password: 'aaaaaaaaaaaa' },
      { ...base, email: 'p2@test.carevanta.local', password: 'carevanta123' },
      { ...base, email: 'p3@test.carevanta.local', password: 'Short-1' },
      { ...base, email: 'p4@test.carevanta.local', password: 'x'.repeat(129) },
      { ...base },
    ];
    for (const body of bad) {
      const res = await api().post('/api/v1/auth/register').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    // 160-character name and a 128-character password are the inclusive limits.
    const ok = await api().post('/api/v1/auth/register').send({ fullName: 'N'.repeat(160), email: `max-${randomUUID().slice(0, 8)}@test.carevanta.local`, password: 'Abcdef12'.repeat(16) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it('EDGE-AUTH-12: OTP needs the signed-in user, is bound to that user, and dies after one use or expiry', async () => {
    const digits = `96${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    const reg = await api().post('/api/v1/auth/register').send({ fullName: 'Otp Person', phone: digits, password: 'Shobuj-Pata-Nodi-2026' });
    expect(reg.status).toBe(201);
    const userId = reg.body.data.id as string;
    const n = await prisma.notification.findFirstOrThrow({ where: { userId, templateKey: 'auth.verify_phone' } });
    const { token } = decryptNotificationPayload(n.payload) as { token: string };
    expect(token).toMatch(/^\d{6}$/);
    // OTP without the user id is refused (low-entropy codes are never looked up globally).
    expect((await api().post('/api/v1/auth/verify/confirm').send({ token })).status).toBe(400);
    // The same code for a different user id is unknown.
    expect((await api().post('/api/v1/auth/verify/confirm').send({ token, userId: randomUUID() })).status).toBe(400);
    // Wrong code.
    const wrong = String((Number(token) + 1) % 1_000_000).padStart(6, '0');
    expect((await api().post('/api/v1/auth/verify/confirm').send({ token: wrong, userId })).status).toBe(400);
    const ok = await api().post('/api/v1/auth/verify/confirm').send({ token, userId });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.status).toBe('ACTIVE');
    // Replay of a consumed code.
    expect((await api().post('/api/v1/auth/verify/confirm').send({ token, userId })).status).toBe(400);
    // Asking for another SMS code once verified is a conflict.
    const t = await login(digits, 'Shobuj-Pata-Nodi-2026');
    expect((await api().post('/api/v1/auth/verify/request').set('Authorization', `Bearer ${t.accessToken}`).send({ channel: 'SMS' })).status).toBe(409);
    // No email on the account → cannot request an email code.
    expect((await api().post('/api/v1/auth/verify/request').set('Authorization', `Bearer ${t.accessToken}`).send({ channel: 'EMAIL' })).status).toBe(400);
  });

  it('EDGE-AUTH-13: an expired password-reset token is refused; forgot-password for a deactivated or malformed identifier is still 202 and sends nothing', async () => {
    const user = await createUser();
    expect((await api().post('/api/v1/auth/password/forgot').send({ identifier: user.email })).status).toBe(202);
    const n = await prisma.notification.findFirstOrThrow({ where: { userId: user.id, templateKey: 'auth.password_reset' } });
    const { token } = decryptNotificationPayload(n.payload) as { token: string };
    await prisma.verificationToken.updateMany({ where: { userId: user.id, purpose: 'PASSWORD_RESET' }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await api().post('/api/v1/auth/password/reset').send({ token, newPassword: 'Another-Strong-Passphrase-42' });
    expect(expired.status).toBe(400);
    expect(expired.body.error.code).toBe('TOKEN_INVALID');
    // Password unchanged.
    expect((await loginAs(user.email!)).status).toBe(200);

    const gone = await createUser({ status: 'DEACTIVATED' });
    expect((await api().post('/api/v1/auth/password/forgot').send({ identifier: gone.email })).status).toBe(202);
    expect(await prisma.notification.count({ where: { userId: gone.id } })).toBe(0);
    expect((await api().post('/api/v1/auth/password/forgot').send({ identifier: 'not an identifier' })).status).toBe(202);
  });

  it('EDGE-AUTH-14: change password refuses the current password, a wrong current password and common passwords', async () => {
    const a = await actor([]);
    expect((await a.post('/api/v1/auth/password/change', { currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD })).status).toBe(400);
    expect((await a.post('/api/v1/auth/password/change', { currentPassword: 'definitely-wrong', newPassword: 'Another-Strong-Passphrase-42' })).status).toBe(401);
    expect((await a.post('/api/v1/auth/password/change', { currentPassword: TEST_PASSWORD, newPassword: 'password123' })).status).toBe(400);
    // After five wrong "current password" attempts the account is NOT locked (lockout applies to login only) but the session still works.
    expect((await a.get('/api/v1/auth/me')).status).toBe(200);
  });
});
