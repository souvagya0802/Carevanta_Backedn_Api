import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { resetDatabase } from '../helpers/db.js';
import { TEST_PASSWORD, actor, api, createUser } from '../helpers/factory.js';
import { actorForUser, affiliatedDoctor, approveProvider, createDoctor, createHospital, randomUUID, slotsFor, staff } from '../helpers/fixtures.js';

beforeAll(resetDatabase);

describe('EDGE-USER: admin user management', () => {
  it('EDGE-USER-01: editing the email in a different case keeps it verified; removing the last contact or reusing another’s phone is refused', async () => {
    const admin = await actor(['SUPER_ADMIN']);
    const u = await createUser({ fullName: 'Edge User' });
    const other = await createUser({ phone: '+919811100001' });
    const sameCase = await admin.patch(`/api/v1/admin/users/${u.id}`, { email: u.email!.toUpperCase() });
    expect(sameCase.status, JSON.stringify(sameCase.body)).toBe(200);
    expect(sameCase.body.data.email).toBe(u.email);
    expect(sameCase.body.data.emailVerified, 'unchanged address stays verified').toBe(true);
    expect((await admin.patch(`/api/v1/admin/users/${u.id}`, { email: null })).status).toBe(400);
    expect((await admin.patch(`/api/v1/admin/users/${u.id}`, { phone: '9811100001' })).status).toBe(409);
    expect((await admin.patch(`/api/v1/admin/users/${u.id}`, { phone: '09811100002' })).status).toBe(400);
    expect((await admin.patch(`/api/v1/admin/users/${u.id}`, { preferredLanguage: 'fr' })).status).toBe(400);
    expect((await admin.patch(`/api/v1/admin/users/${u.id}`, {})).status).toBe(200);
    // A new address is unverified until confirmed.
    const changed = await admin.patch(`/api/v1/admin/users/${u.id}`, { email: `new-${randomUUID().slice(0, 8)}@test.carevanta.local` });
    expect(changed.status).toBe(200);
    expect(changed.body.data.emailVerified).toBe(false);
    expect(other.id).toBeTruthy();
  });

  it('EDGE-USER-02: status machine — same-state, DEACTIVATED→SUSPENDED and anything after ANONYMISED are 409; reasons under 5 chars are 400', async () => {
    const admin = await actor(['SUPER_ADMIN']);
    const u = await createUser();
    const url = `/api/v1/admin/users/${u.id}/status`;
    expect((await admin.post(url, { status: 'ACTIVE', reason: 'already active' })).status).toBe(409);
    expect((await admin.post(url, { status: 'SUSPENDED', reason: 'bad' })).status).toBe(400);
    expect((await admin.post(url, { status: 'ANONYMISED', reason: 'not via status' })).status).toBe(400);
    expect((await admin.post(url, { status: 'DEACTIVATED', reason: 'edge: closing' })).status).toBe(200);
    const res = await admin.post(url, { status: 'SUSPENDED', reason: 'edge: suspend after close' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect((await admin.post(url, { status: 'ACTIVE', reason: 'edge: reopen' })).status).toBe(200);
    expect((await admin.post(`/api/v1/admin/users/${u.id}/anonymise`, { reason: 'edge: retention', confirm: 'YES' })).status).toBe(400);
    expect((await admin.post(`/api/v1/admin/users/${u.id}/anonymise`, { reason: 'edge: retention', confirm: 'ANONYMISE' })).status).toBe(204);
    expect((await admin.post(`/api/v1/admin/users/${u.id}/anonymise`, { reason: 'edge: twice', confirm: 'ANONYMISE' })).status).toBe(409);
    expect((await admin.post(url, { status: 'ACTIVE', reason: 'edge: after anonymise' })).status).toBe(409);
    expect((await admin.patch(`/api/v1/admin/users/${u.id}`, { fullName: 'Named Again' })).status).toBe(409);
    expect((await admin.post(`/api/v1/admin/users/${u.id}/roles`, { roleKey: 'AUDITOR' })).status).toBe(409);
  });

  it('EDGE-USER-03: roles — unknown key 404, duplicate grant 409, revoking a role not held 404, grant to a closed account 409', async () => {
    const admin = await actor(['SUPER_ADMIN']);
    const u = await createUser();
    expect((await admin.post(`/api/v1/admin/users/${u.id}/roles`, { roleKey: 'NO_SUCH_ROLE' })).status).toBe(404);
    expect((await admin.post(`/api/v1/admin/users/${u.id}/roles`, { roleKey: 'AUDITOR' })).status).toBe(200);
    expect((await admin.post(`/api/v1/admin/users/${u.id}/roles`, { roleKey: 'AUDITOR' })).status).toBe(409);
    expect((await admin.delete(`/api/v1/admin/users/${u.id}/roles/FINANCE_OFFICER`)).status).toBe(404);
    expect((await admin.delete(`/api/v1/admin/users/${u.id}/roles/AUDITOR`)).status).toBe(200);
    expect((await admin.delete(`/api/v1/admin/users/${u.id}/roles/AUDITOR`)).status).toBe(404);
    // Revoke → grant again works (history kept, no unique clash).
    expect((await admin.post(`/api/v1/admin/users/${u.id}/roles`, { roleKey: 'AUDITOR' })).status).toBe(200);
    await admin.post(`/api/v1/admin/users/${u.id}/status`, { status: 'DEACTIVATED', reason: 'edge: closing' });
    expect((await admin.post(`/api/v1/admin/users/${u.id}/roles`, { roleKey: 'SUPPORT_AGENT' })).status).toBe(409);
  });

  it('EDGE-USER-04: doctors and provider owners cannot be anonymised; a plain patient can, and then cannot sign in', async () => {
    const admin = await actor(['SUPER_ADMIN']);
    const { registrar, verifier } = await staff();
    const doctor = await createDoctor(registrar);
    const hospital = await createHospital(registrar);
    expect((await admin.post(`/api/v1/admin/users/${doctor.userId}/anonymise`, { reason: 'edge: doctor', confirm: 'ANONYMISE' })).status).toBe(422);
    expect((await admin.post(`/api/v1/admin/users/${hospital.ownerUserId}/anonymise`, { reason: 'edge: owner', confirm: 'ANONYMISE' })).status).toBe(422);
    const p = await actor([]);
    expect((await admin.post(`/api/v1/admin/users/${p.user.id}/anonymise`, { reason: 'edge: patient', confirm: 'ANONYMISE' })).status).toBe(204);
    // Sessions are revoked at once (401); a fresh login is impossible because the password hash is gone.
    expect((await p.get('/api/v1/auth/me')).status).toBe(401);
    expect((await api().post('/api/v1/auth/login').send({ identifier: p.user.email, password: TEST_PASSWORD })).status).toBe(401);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: p.user.id } });
    expect(row.status).toBe('ANONYMISED');
    expect(row.email).not.toBe(p.user.email);
    expect(verifier.user.id).toBeTruthy();
  }, 120_000);
});

describe('EDGE-AFF: affiliation corner cases', () => {
  it('EDGE-AFF-01: wrong party types and bad terms are 400; a closed doctor is 409', async () => {
    const { registrar, verifier } = await staff();
    const admin = await actor(['SUPER_ADMIN']);
    const hospital = await createHospital(registrar, { departments: ['DEPT_GASTRO'] });
    const other = await createHospital(registrar);
    const lab = await registrar.post('/api/v1/admin/providers', { type: 'DIAGNOSTIC_LAB', legalName: 'Edge Lab', displayName: `Edge Lab ${randomUUID().slice(0, 6)}`, contactPhone: '9800077777' });
    const doctor = await createDoctor(registrar);
    const owner = await actorForUser(hospital.ownerUserId);
    const url = `/api/v1/portal/providers/${hospital.id}/affiliations/invite`;
    expect((await owner.post(url, { doctorProviderId: other.id })).status).toBe(400);
    expect((await owner.post(url, { doctorProviderId: lab.body.data.id })).status).toBe(400);
    expect((await owner.post(url, { doctorProviderId: doctor.id, departmentCode: 'DEPT_CARDIO' })).status).toBe(400);
    expect((await owner.post(url, { doctorProviderId: doctor.id, locationId: other.locationId })).status).toBe(400);
    expect((await owner.post(url, { doctorProviderId: doctor.id, consultationFeeMinor: -1 })).status).toBe(400);
    expect((await owner.post(url, { doctorProviderId: doctor.id, startDate: '2026-13-01' })).status).toBe(400);
    expect((await owner.post(url, { doctorProviderId: doctor.id, engagementType: 'LOCUM' })).status).toBe(400);
    expect((await owner.post(url, { doctorProviderId: randomUUID() })).status).toBe(400);
    // Platform create: a lab as the facility is 400 too.
    expect((await admin.post('/api/v1/admin/affiliations', { doctorProviderId: doctor.id, facilityProviderId: lab.body.data.id, evidenceNote: 'edge: signed letter' })).status).toBe(400);
    await admin.post(`/api/v1/admin/providers/${doctor.id}/status`, { action: 'DEACTIVATE', reason: 'edge: doctor left' });
    expect((await owner.post(url, { doctorProviderId: doctor.id })).status).toBe(409);
    expect(verifier.user.id).toBeTruthy();
  });

  it('EDGE-AFF-02: each side may only do its own moves; terminal states stay terminal; a rejected pair can start again', async () => {
    const { registrar, verifier } = await staff();
    const hospital = await createHospital(registrar, { departments: ['DEPT_GASTRO'] });
    const doctor = await createDoctor(registrar);
    await approveProvider(hospital.id, registrar, verifier);
    await approveProvider(doctor.id, registrar, verifier);
    const owner = await actorForUser(hospital.ownerUserId);
    const doc = await actorForUser(doctor.userId);
    const fac = (id: string, action: string, note?: string) => owner.post(`/api/v1/portal/providers/${hospital.id}/affiliations/${id}/${action}`, note ? { note } : {});
    const dr = (id: string, action: string, note?: string) => doc.post(`/api/v1/portal/doctor/affiliations/${id}/${action}`, note ? { note } : {});

    // Facility invites: the facility cannot accept its own invitation, nor can the doctor withdraw it.
    const invite = await owner.post(`/api/v1/portal/providers/${hospital.id}/affiliations/invite`, { doctorProviderId: doctor.id, departmentCode: 'DEPT_GASTRO' });
    expect(invite.status, JSON.stringify(invite.body)).toBe(201);
    const inv = invite.body.data.id as string;
    expect((await fac(inv, 'accept')).status).toBe(409);
    expect((await dr(inv, 'withdraw')).status).toBe(403);
    expect((await dr(inv, 'end')).status).toBe(409);
    expect((await fac(inv, 'bogus')).status).toBe(400);
    expect((await dr(inv, 'decline', 'edge: not now')).status).toBe(200);
    // REJECTED is terminal.
    expect((await dr(inv, 'accept')).status).toBe(409);
    expect((await fac(inv, 'withdraw')).status).toBe(409);
    expect((await verifier.post(`/api/v1/admin/affiliations/${inv}/actions`, { action: 'VERIFY' })).status).toBe(409);
    // A fresh request from the doctor is allowed after a rejection.
    const req = await doc.post('/api/v1/portal/doctor/affiliations/request', { facilityProviderId: hospital.id, departmentCode: 'DEPT_GASTRO' });
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    const rq = req.body.data.id as string;
    expect(req.body.data.status).toBe('REQUESTED');
    // The doctor cannot accept their own request; the facility cannot withdraw it.
    expect((await dr(rq, 'accept')).status).toBe(409);
    expect((await fac(rq, 'withdraw')).status).toBe(403);
    expect((await dr(rq, 'withdraw')).status).toBe(200);
    expect(await prisma.doctorAffiliation.findUniqueOrThrow({ where: { id: rq } }).then((a) => a.status)).toBe('CANCELLED');
    expect((await fac(rq, 'accept')).status).toBe(409);
  }, 120_000);

  it('EDGE-AFF-03: admin actions on an active affiliation — REACTIVATE while active 409, SUSPEND blocks slots, REACTIVATE re-opens them, END is final', async () => {
    const ctx = await affiliatedDoctor();
    const { slots } = await slotsFor(ctx.hospitalOwner, ctx.doctor.id, ctx.hospital.locationId);
    const act = (action: string) => ctx.verifier.post(`/api/v1/admin/affiliations/${ctx.affiliationId}/actions`, { action, note: `edge: ${action.toLowerCase()}` });
    expect((await act('REACTIVATE')).status).toBe(409);
    expect((await act('VERIFY')).status).toBe(409);
    expect((await act('ACCEPT')).status).toBe(400);
    const suspended = await act('SUSPEND');
    expect(suspended.status, JSON.stringify(suspended.body)).toBe(200);
    expect((await prisma.appointmentSlot.findMany({ where: { id: { in: slots.map((s) => s.id) } } })).every((s) => s.status === 'BLOCKED')).toBe(true);
    expect((await ctx.registrar.get(`/api/v1/discovery/doctors/${ctx.doctor.id}/slots`)).body.data).toEqual([]);
    expect((await act('SUSPEND')).status).toBe(409);
    expect((await act('REACTIVATE')).status).toBe(200);
    expect((await prisma.appointmentSlot.findMany({ where: { id: { in: slots.map((s) => s.id) } } })).every((s) => s.status === 'OPEN')).toBe(true);
    // Stale version is refused.
    const current = await ctx.verifier.get(`/api/v1/admin/affiliations/${ctx.affiliationId}`);
    expect((await ctx.verifier.post(`/api/v1/admin/affiliations/${ctx.affiliationId}/actions`, { action: 'END', note: 'edge: stale', expectedVersion: current.body.data.version - 1 })).status).toBe(409);
    const ended = await ctx.hospitalOwner.post(`/api/v1/portal/providers/${ctx.hospital.id}/affiliations/${ctx.affiliationId}/end`, { note: 'edge: contract over' });
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    expect(ended.body.data.endDate).toBeTruthy();
    expect((await act('REACTIVATE')).status).toBe(409);
    expect((await act('SUSPEND')).status).toBe(409);
    // Scheduling for an ended affiliation is refused.
    const sched = await ctx.hospitalOwner.post('/api/v1/schedules', { doctorProviderId: ctx.doctor.id, locationId: ctx.hospital.locationId, dayOfWeek: 3, startMinute: 900, endMinute: 960, slotMinutes: 30, capacityPerSlot: 1, validFrom: new Date().toISOString().slice(0, 10) });
    expect([400, 403, 404, 409, 422].includes(sched.status), JSON.stringify(sched.body)).toBe(true);
  }, 120_000);
});
