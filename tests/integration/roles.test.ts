import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { resetDatabase } from '../helpers/db.js';
import { actor, createUser } from '../helpers/factory.js';

beforeAll(resetDatabase);

describe('custom roles — lifecycle and edge cases', () => {
  it('validates the key format and rejects duplicates and unknown permissions', async () => {
    const sa = await actor(['SUPER_ADMIN']);
    expect((await sa.post('/api/v1/admin/roles', { key: 'bad key', name: 'Bad', permissions: ['users.read'] })).status).toBe(400);
    expect((await sa.post('/api/v1/admin/roles', { key: '1STARTS_WITH_DIGIT', name: 'Bad', permissions: ['users.read'] })).status).toBe(400);
    expect((await sa.post('/api/v1/admin/roles', { key: 'NO_PERMS', name: 'Empty', permissions: [] })).status).toBe(400);
    expect((await sa.post('/api/v1/admin/roles', { key: 'GHOST', name: 'Ghost', permissions: ['does.not.exist'] })).status).toBe(400);
    const dupe = await sa.post('/api/v1/admin/roles', { key: 'SUPER_ADMIN', name: 'Clash', permissions: ['users.read'] });
    expect(dupe.status).toBe(409);
    expect(dupe.body.error.details).toMatchObject({ field: 'key' });
  });

  it('creates with a reason, de-duplicates permissions, and reports counts and timestamps', async () => {
    const sa = await actor(['SUPER_ADMIN']);
    const res = await sa.post('/api/v1/admin/roles', { key: 'OPS_VIEWER', name: 'Operations viewer', description: '  Read-only ops  ', permissions: ['bookings.read', 'bookings.read', 'dispatch.read'], reason: 'Pilot ops team needs read-only access' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ key: 'OPS_VIEWER', isSystem: false, scope: 'PLATFORM', permissions: ['bookings.read', 'dispatch.read'], activeAssignments: 0, totalAssignments: 0 });
    expect(typeof res.body.data.createdAt).toBe('string');
    expect(typeof res.body.data.updatedAt).toBe('string');
    const ev = await prisma.auditEvent.findFirst({ where: { action: 'role.created', entityId: res.body.data.id } });
    expect(ev?.metadata).toMatchObject({ key: 'OPS_VIEWER', reason: 'Pilot ops team needs read-only access' });
    const detail = await sa.get(`/api/v1/admin/roles/${res.body.data.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.key).toBe('OPS_VIEWER');
  });

  it('system roles cannot be edited or deleted', async () => {
    const sa = await actor(['SUPER_ADMIN']);
    const list = await sa.get('/api/v1/admin/roles');
    const finance = list.body.data.find((r: { key: string }) => r.key === 'FINANCE_OFFICER');
    expect(finance.isSystem).toBe(true);
    expect((await sa.patch(`/api/v1/admin/roles/${finance.id}`, { name: 'Renamed' })).status).toBe(403);
    expect((await sa.delete(`/api/v1/admin/roles/${finance.id}`)).status).toBe(403);
  });

  it('rejects a stale edit (optimistic concurrency) and audits the permission diff with the affected-user count', async () => {
    const sa = await actor(['SUPER_ADMIN']);
    const created = await sa.post('/api/v1/admin/roles', { key: 'REGION_LEAD', name: 'Region lead', permissions: ['providers.read'] });
    const role = created.body.data;
    const holder = await createUser();
    expect((await sa.post(`/api/v1/admin/users/${holder.id}/roles`, { roleKey: 'REGION_LEAD' })).status).toBe(200);

    const first = await sa.patch(`/api/v1/admin/roles/${role.id}`, { permissions: ['providers.read', 'bookings.read'], expectedUpdatedAt: role.updatedAt, reason: 'Leads also triage bookings' });
    expect(first.status).toBe(200);
    expect(first.body.data.activeAssignments).toBe(1);

    const stale = await sa.patch(`/api/v1/admin/roles/${role.id}`, { name: 'Stale rename', expectedUpdatedAt: role.updatedAt });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('CONFLICT');
    expect(stale.body.error.details.updatedAt).toBe(first.body.data.updatedAt);

    const ev = await prisma.auditEvent.findFirst({ where: { action: 'role.updated', entityId: role.id }, orderBy: { occurredAt: 'desc' } });
    expect(ev?.metadata).toMatchObject({ added: ['bookings.read'], removed: [], affectedUsers: 1, reason: 'Leads also triage bookings' });

    // the holder's effective permissions changed immediately
    const me = await (await actor(['REGION_LEAD'])).get('/api/v1/auth/me');
    expect(me.body.data.permissions).toEqual(expect.arrayContaining(['providers.read', 'bookings.read']));
  });

  it('a role with assignment history cannot be deleted even after revocation; an unused one can', async () => {
    const sa = await actor(['SUPER_ADMIN']);
    const list = await sa.get('/api/v1/admin/roles');
    const lead = list.body.data.find((r: { key: string }) => r.key === 'REGION_LEAD');
    // Two holders exist from the previous test (the granted user and the REGION_LEAD actor); revoke them all.
    const holders = await prisma.userRole.findMany({ where: { roleId: lead.id, revokedAt: null } });
    expect(holders.length).toBe(2);
    for (const h of holders) expect((await sa.delete(`/api/v1/admin/users/${h.userId}/roles/REGION_LEAD`)).status).toBe(200);
    const after = (await sa.get(`/api/v1/admin/roles/${lead.id}`)).body.data;
    expect(after).toMatchObject({ activeAssignments: 0, totalAssignments: 2 });
    const del = await sa.delete(`/api/v1/admin/roles/${lead.id}`);
    expect(del.status).toBe(409);
    expect(del.body.error.details).toMatchObject({ totalAssignments: 2 });

    const unused = await sa.post('/api/v1/admin/roles', { key: 'TEMP_ROLE', name: 'Temporary', permissions: ['users.read'] });
    expect((await sa.delete(`/api/v1/admin/roles/${unused.body.data.id}`)).status).toBe(204);
    expect((await sa.get(`/api/v1/admin/roles/${unused.body.data.id}`)).status).toBe(404);
  });

  it('a role manager cannot remove roles.manage from the only role that grants it to them', async () => {
    const sa = await actor(['SUPER_ADMIN']);
    const created = await sa.post('/api/v1/admin/roles', { key: 'ACCESS_ADMIN', name: 'Access administrator', permissions: ['roles.read', 'roles.manage', 'users.read'] });
    expect(created.status).toBe(201);
    const roleId = created.body.data.id;
    const admin = await actor(['ACCESS_ADMIN']);

    const lockout = await admin.patch(`/api/v1/admin/roles/${roleId}`, { permissions: ['roles.read', 'users.read'] });
    expect(lockout.status).toBe(409);
    expect(lockout.body.error.message).toMatch(/lock you out/i);

    // Trimming an unrelated permission is fine, as is renaming.
    expect((await admin.patch(`/api/v1/admin/roles/${roleId}`, { permissions: ['roles.read', 'roles.manage'] })).status).toBe(200);
    expect((await admin.patch(`/api/v1/admin/roles/${roleId}`, { name: 'Access admin' })).status).toBe(200);
    // Escalation is still blocked: the access admin does not hold finance permissions.
    const escalate = await admin.patch(`/api/v1/admin/roles/${roleId}`, { permissions: ['roles.read', 'roles.manage', 'finance.settlements.approve'] });
    expect(escalate.status).toBe(403);
    expect(escalate.body.error.details).toMatchObject({ missing: ['finance.settlements.approve'] });
    // A super-admin may remove it (they are not locked out).
    expect((await sa.patch(`/api/v1/admin/roles/${roleId}`, { permissions: ['roles.read'] })).status).toBe(200);
  });
});
