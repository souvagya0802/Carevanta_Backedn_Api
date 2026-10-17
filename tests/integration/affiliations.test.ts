import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { resetDatabase } from '../helpers/db.js';
import { actorForUser, affiliatedDoctor, approveProvider, createDoctor, createHospital, staff } from '../helpers/fixtures.js';

beforeAll(resetDatabase);

describe('doctor ↔ facility affiliations', () => {
  it('links one doctor identity to multiple facilities without duplication', async () => {
    const ctx = await affiliatedDoctor();
    const second = await createHospital(ctx.registrar, { name: 'Moyna Rural Hospital', departments: ['DEPT_GASTRO'] });
    await approveProvider(second.id, ctx.registrar, ctx.verifier);
    const owner2 = await actorForUser(second.ownerUserId);
    const invite = await owner2.post(`/api/v1/portal/providers/${second.id}/affiliations/invite`, { doctorProviderId: ctx.doctor.id });
    expect(invite.status).toBe(201);
    await ctx.doctorUser.post(`/api/v1/portal/doctor/affiliations/${invite.body.data.id}/accept`, {});
    expect((await ctx.verifier.post(`/api/v1/admin/affiliations/${invite.body.data.id}/actions`, { action: 'VERIFY' })).status).toBe(200);

    expect(await prisma.doctorProfile.count({ where: { userId: ctx.doctor.userId } })).toBe(1);
    const mine = await ctx.doctorUser.get('/api/v1/portal/doctor/affiliations?status=ACTIVE');
    expect(mine.body.data).toHaveLength(2);
  });

  it('rejects duplicate live affiliation requests (including concurrent ones)', async () => {
    const { registrar, verifier } = await staff();
    const h = await createHospital(registrar);
    const d = await createDoctor(registrar);
    await approveProvider(h.id, registrar, verifier);
    const owner = await actorForUser(h.ownerUserId);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => owner.post(`/api/v1/portal/providers/${h.id}/affiliations/invite`, { doctorProviderId: d.id })),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(3);
  });

  it('a facility cannot accept on the doctor’s behalf, and cannot edit the doctor profile', async () => {
    const { registrar, verifier } = await staff();
    const h = await createHospital(registrar);
    const d = await createDoctor(registrar);
    await approveProvider(h.id, registrar, verifier);
    const owner = await actorForUser(h.ownerUserId);
    const inv = await owner.post(`/api/v1/portal/providers/${h.id}/affiliations/invite`, { doctorProviderId: d.id });
    const accept = await owner.post(`/api/v1/portal/providers/${h.id}/affiliations/${inv.body.data.id}/accept`, {});
    expect(accept.status).toBe(409); // facility can only accept a doctor's REQUEST
    const editDoctor = await owner.patch(`/api/v1/admin/providers/${d.id}`, { description: 'hijack', expectedVersion: 1 });
    expect(editDoctor.status).toBe(403);
    // Another doctor cannot accept someone else's invitation.
    const other = await createDoctor(registrar);
    const otherUser = await actorForUser(other.userId);
    const steal = await otherUser.post(`/api/v1/portal/doctor/affiliations/${inv.body.data.id}/accept`, {});
    expect(steal.status).toBe(404);
  });

  it('verification needs both confirmations, approved parties, and a verifier who is not the creator', async () => {
    const { registrar, verifier } = await staff();
    const h = await createHospital(registrar, { departments: ['DEPT_GASTRO'] });
    const d = await createDoctor(registrar);
    await approveProvider(h.id, registrar, verifier);
    // Doctor not yet approved.
    const created = await registrar.post('/api/v1/admin/affiliations', { doctorProviderId: d.id, facilityProviderId: h.id, evidenceNote: 'Signed roster letter dated 2026-10-01' });
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe('PENDING_VERIFICATION');
    const early = await verifier.post(`/api/v1/admin/affiliations/${created.body.data.id}/actions`, { action: 'VERIFY' });
    expect(early.status).toBe(422);
    await approveProvider(d.id, registrar, verifier);
    const sa = registrar; // creator
    const selfVerify = await sa.post(`/api/v1/admin/affiliations/${created.body.data.id}/actions`, { action: 'VERIFY' });
    expect(selfVerify.status).toBe(403);
    const ok = await verifier.post(`/api/v1/admin/affiliations/${created.body.data.id}/actions`, { action: 'VERIFY' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('ACTIVE');
  });

  it('rejects invalid transitions and stale versions', async () => {
    const ctx = await affiliatedDoctor();
    const again = await ctx.verifier.post(`/api/v1/admin/affiliations/${ctx.affiliationId}/actions`, { action: 'VERIFY' });
    expect(again.status).toBe(409);
    const stale = await ctx.verifier.post(`/api/v1/admin/affiliations/${ctx.affiliationId}/actions`, { action: 'SUSPEND', expectedVersion: 1 });
    expect(stale.status).toBe(409);
    const end = await ctx.doctorUser.post(`/api/v1/portal/doctor/affiliations/${ctx.affiliationId}/end`, { note: 'Moving away' });
    expect(end.status).toBe(200);
    expect(end.body.data.status).toBe('ENDED');
    const revive = await ctx.verifier.post(`/api/v1/admin/affiliations/${ctx.affiliationId}/actions`, { action: 'REACTIVATE' });
    expect(revive.status).toBe(409);
    const events = await prisma.affiliationEvent.findMany({ where: { affiliationId: ctx.affiliationId }, orderBy: { createdAt: 'asc' } });
    expect(events.map((e) => e.toStatus)).toEqual(['INVITED', 'PENDING_VERIFICATION', 'ACTIVE', 'ENDED']);
  });
});
