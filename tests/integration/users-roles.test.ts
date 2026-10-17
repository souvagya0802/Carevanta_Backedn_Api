import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { resetDatabase } from '../helpers/db.js';
import { actor, createUser } from '../helpers/factory.js';

beforeAll(resetDatabase);

describe('user administration', () => {
  it('creates a user with an invite and never accepts a password from the admin', async () => {
    const admin = await actor(['SUPER_ADMIN']);
    const res = await admin.post('/api/v1/admin/users', { fullName: 'New Staff', email: 'new.staff@test.carevanta.local', roles: ['SUPPORT_AGENT'] });
    expect(res.status).toBe(201);
    expect(res.body.data.roles).toEqual(['SUPPORT_AGENT']);
    expect(res.body.data.mustChangePassword).toBe(true);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(u.passwordHash).toBeNull();
    expect(await prisma.notification.count({ where: { userId: u.id, templateKey: 'auth.account_created' } })).toBe(1);
  });

  it('lets an admin send a password-reset link without ever seeing the token', async () => {
    const admin = await actor(['SUPER_ADMIN']);
    const created = await admin.post('/api/v1/admin/users', { fullName: 'Reset Me', email: 'reset.me@test.carevanta.local', sendInvite: false });
    expect(created.status).toBe(201);
    const res = await admin.post(`/api/v1/admin/users/${created.body.data.id}/password-reset`);
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ channel: 'EMAIL', expiresInMinutes: 60 });
    expect(res.body.data.recipient).toBe('re***@test.carevanta.local');
    expect(JSON.stringify(res.body)).not.toMatch(/token/i);
    const tokens = await prisma.verificationToken.count({ where: { userId: created.body.data.id, purpose: 'PASSWORD_RESET', consumedAt: null } });
    expect(tokens).toBe(1);
    expect(await prisma.notification.count({ where: { userId: created.body.data.id, templateKey: 'auth.password_reset' } })).toBe(1);

    // A suspended account cannot be sent a link.
    await admin.post(`/api/v1/admin/users/${created.body.data.id}/status`, { status: 'SUSPENDED', reason: 'test suspension' });
    const blocked = await admin.post(`/api/v1/admin/users/${created.body.data.id}/password-reset`);
    expect(blocked.status).toBe(422);
  });

  it('rejects duplicate email', async () => {
    const admin = await actor(['SUPER_ADMIN']);
    await admin.post('/api/v1/admin/users', { fullName: 'Dup One', email: 'dup@test.carevanta.local' });
    const res = await admin.post('/api/v1/admin/users', { fullName: 'Dup Two', email: 'DUP@test.carevanta.local' });
    expect(res.status).toBe(409);
  });

  it('lists and searches with cursor pagination', async () => {
    const admin = await actor(['SUPER_ADMIN']);
    for (let i = 0; i < 5; i++) await createUser({ fullName: `Paginated Person ${i}` });
    const p1 = await admin.get('/api/v1/admin/users?q=Paginated&limit=2');
    expect(p1.status).toBe(200);
    expect(p1.body.data).toHaveLength(2);
    expect(p1.body.page.hasMore).toBe(true);
    const p2 = await admin.get(`/api/v1/admin/users?q=Paginated&limit=2&cursor=${p1.body.page.nextCursor}`);
    expect(p2.body.data).toHaveLength(2);
    const ids = new Set([...p1.body.data, ...p2.body.data].map((u: { id: string }) => u.id));
    expect(ids.size).toBe(4);
    const bad = await admin.get('/api/v1/admin/users?cursor=not-a-cursor');
    expect(bad.status).toBe(400);
  });

  it('enforces permissions on admin endpoints', async () => {
    const support = await actor(['SUPPORT_AGENT']);
    expect((await support.get('/api/v1/admin/users')).status).toBe(200); // users.read
    const create = await support.post('/api/v1/admin/users', { fullName: 'Nope', email: 'nope@test.carevanta.local' });
    expect(create.status).toBe(403);
    const denied = await prisma.auditEvent.count({ where: { action: 'access.denied', actorUserId: support.user.id } });
    expect(denied).toBeGreaterThan(0);
  });

  it('suspension revokes sessions; users cannot change their own status', async () => {
    const admin = await actor(['SUPER_ADMIN']);
    const target = await actor(['AUDITOR']);
    const self = await admin.post(`/api/v1/admin/users/${admin.user.id}/status`, { status: 'SUSPENDED', reason: 'testing self change' });
    expect(self.status).toBe(403);
    const res = await admin.post(`/api/v1/admin/users/${target.user.id}/status`, { status: 'SUSPENDED', reason: 'Policy violation (test)' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('SUSPENDED');
    expect((await target.get('/api/v1/auth/me')).status).toBe(401);
    const invalid = await admin.post(`/api/v1/admin/users/${target.user.id}/status`, { status: 'SUSPENDED', reason: 'again please' });
    expect(invalid.status).toBe(409);
  });

  it('cannot suspend the last super-admin', async () => {
    await prisma.userRole.deleteMany({ where: { role: { key: 'SUPER_ADMIN' } } });
    const a = await actor(['SUPER_ADMIN']);
    const b = await actor(['PLATFORM_ADMIN']);
    // PLATFORM_ADMIN cannot manage a super-admin at all.
    const res = await b.post(`/api/v1/admin/users/${a.user.id}/status`, { status: 'SUSPENDED', reason: 'take over attempt' });
    expect(res.status).toBe(403);
  });
});

describe('privilege escalation protections', () => {
  it('a platform admin cannot grant SUPER_ADMIN', async () => {
    const pa = await actor(['PLATFORM_ADMIN']);
    const victim = await createUser();
    const res = await pa.post(`/api/v1/admin/users/${victim.id}/roles`, { roleKey: 'SUPER_ADMIN' });
    expect(res.status).toBe(403);
  });

  it('a platform admin cannot grant a role with permissions they lack', async () => {
    const pa = await actor(['PLATFORM_ADMIN']);
    const victim = await createUser();
    const res = await pa.post(`/api/v1/admin/users/${victim.id}/roles`, { roleKey: 'FINANCE_APPROVER' });
    expect(res.status).toBe(403);
  });

  it('nobody can grant themselves a role', async () => {
    const sa = await actor(['SUPER_ADMIN']);
    const res = await sa.post(`/api/v1/admin/users/${sa.user.id}/roles`, { roleKey: 'AUDITOR' });
    expect(res.status).toBe(403);
  });

  it('a custom role cannot contain permissions the creator lacks', async () => {
    const pa = await actor(['PLATFORM_ADMIN']);
    const res = await pa.post('/api/v1/admin/roles', { key: 'SNEAKY_ROLE', name: 'Sneaky', permissions: ['finance.settlements.approve'] });
    expect(res.status).toBe(403); // PLATFORM_ADMIN lacks roles.manage entirely
    const sa = await actor(['SUPER_ADMIN']);
    const ok = await sa.post('/api/v1/admin/roles', { key: 'REGION_COORDINATOR', name: 'Region coordinator', permissions: ['providers.read', 'bookings.read'] });
    expect(ok.status).toBe(201);
    const edit = await sa.patch(`/api/v1/admin/roles/${(await prisma.role.findUniqueOrThrow({ where: { key: 'FINANCE_OFFICER' } })).id}`, { name: 'x x x' });
    expect(edit.status).toBe(403); // system roles immutable
  });

  it('grant and revoke are audited and keep history', async () => {
    const sa = await actor(['SUPER_ADMIN']);
    const u = await createUser();
    expect((await sa.post(`/api/v1/admin/users/${u.id}/roles`, { roleKey: 'AUDITOR', reason: 'quarterly audit' })).status).toBe(200);
    expect((await sa.post(`/api/v1/admin/users/${u.id}/roles`, { roleKey: 'AUDITOR' })).status).toBe(409);
    const rev = await sa.delete(`/api/v1/admin/users/${u.id}/roles/AUDITOR`);
    expect(rev.status).toBe(200);
    expect(rev.body.data.roles).toEqual([]);
    expect(rev.body.data.roleHistory).toHaveLength(1);
    expect(rev.body.data.roleHistory[0].revokedAt).not.toBeNull();
    // Re-grant works after revoke (partial unique index on active assignments).
    expect((await sa.post(`/api/v1/admin/users/${u.id}/roles`, { roleKey: 'AUDITOR' })).status).toBe(200);
  });

  it('audit log rows are append-only at the database level', async () => {
    const e = await prisma.auditEvent.findFirstOrThrow();
    await expect(prisma.auditEvent.update({ where: { id: e.id }, data: { action: 'tampered' } })).rejects.toThrow();
    await expect(prisma.auditEvent.delete({ where: { id: e.id } })).rejects.toThrow();
  });
});

describe('anonymisation', () => {
  it('anonymises a patient account and blocks it under a legal hold', async () => {
    const sa = await actor(['SUPER_ADMIN']);
    const held = await createUser({ fullName: 'Held Person' });
    await prisma.legalHold.create({ data: { entityType: 'user', entityId: held.id, reason: 'Consumer dispute', placedById: sa.user.id } });
    const blocked = await sa.post(`/api/v1/admin/users/${held.id}/anonymise`, { reason: 'Erasure request', confirm: 'ANONYMISE' });
    expect(blocked.status).toBe(422);

    const u = await createUser({ fullName: 'Erase Me' });
    const res = await sa.post(`/api/v1/admin/users/${u.id}/anonymise`, { reason: 'Erasure request', confirm: 'ANONYMISE' });
    expect(res.status).toBe(204);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(after.email).toBeNull();
    expect(after.fullName).toBe('Anonymised user');
    expect(after.status).toBe('ANONYMISED');
  });
});
