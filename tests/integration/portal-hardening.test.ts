/**
 * Adversarial tests for the provider portal: cross-tenant probing, role
 * escalation, state-machine abuse and the super-admin configuration layer.
 * Every case here is something a real user (or attacker) could try from the
 * portal; the API must refuse it cleanly, never with a 500.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { resetDatabase } from '../helpers/db.js';
import { actor, idem } from '../helpers/factory.js';
import { actorForUser, affiliatedDoctor, approveProvider, createHospital, patient, slotsFor, staff, TAMLUK } from '../helpers/fixtures.js';
import { invalidateSetting } from '../../src/modules/settings/settings.service.js';

beforeAll(resetDatabase);

const PDF = Buffer.from('%PDF-1.4\n% synthetic\n%%EOF');
const V = '/api/v1';
const nextDate = (days: number) => new Date(Date.now() + 330 * 60_000 + days * 86_400_000).toISOString().slice(0, 10);

async function setSetting(sa: Awaited<ReturnType<typeof actor>>, key: string, value: unknown) {
  const all = await sa.get(`${V}/admin/settings`);
  const row = all.body.data.find((s: { key: string }) => s.key === key);
  const res = await sa.put(`${V}/admin/settings/${key}`, { value, expectedVersion: row.version, reason: 'hardening test' });
  invalidateSetting(key);
  return res;
}

describe('portal hardening — tenancy and roles', () => {
  it('never lets one organisation read, act on or probe another organisation’s records', async () => {
    const { hospital, doctor, hospitalOwner, doctorUser, registrar, verifier } = await affiliatedDoctor({ specialities: ['GENERAL_MEDICINE'] });
    const other = await createHospital(registrar, { name: 'Other Hospital' });
    await approveProvider(other.id, registrar, verifier);
    const otherOwner = await actorForUser(other.ownerUserId);
    const p = await patient();
    const { slots } = await slotsFor(hospitalOwner, doctor.id, hospital.locationId);
    const booking = await p.post(`${V}/patient/appointments`, { slotId: slots[0]!.id, patientProfileId: p.profileId }, idem());
    expect(booking.status).toBe(201);
    const apptId = booking.body.data.id as string;

    // Reading or acting through the wrong provider id: 404, never the record.
    expect((await otherOwner.get(`${V}/portal/providers/${other.id}/appointments/${apptId}`)).status).toBe(404);
    expect((await otherOwner.post(`${V}/portal/providers/${other.id}/appointments/${apptId}/actions`, { action: 'CONFIRM' })).status).toBe(404);
    // Using the victim's provider id while being a member elsewhere: 403, and the id is not confirmed to exist.
    expect((await otherOwner.get(`${V}/portal/providers/${hospital.id}/appointments/${apptId}`)).status).toBe(403);
    expect((await otherOwner.get(`${V}/portal/providers/${hospital.id}`)).status).toBe(403);
    expect((await otherOwner.get(`${V}/portal/providers/00000000-0000-7000-8000-000000000000`)).status).toBe(404);
    // Walk-in into another facility's slot, or a doctor blocking a slot at a facility that is not theirs.
    expect((await otherOwner.post(`${V}/portal/providers/${other.id}/appointments/walk-in`, { slotId: slots[1]!.id, patientFullName: 'Intruder', patientPhone: '9800012345' }, idem())).status).toBe(404);
    expect((await otherOwner.post(`${V}/portal/providers/${other.id}/slots/${slots[1]!.id}/status`, { status: 'BLOCKED' })).status).toBe(404);
    // The doctor may read their own appointment at the hospital through their practice view, but cannot manage hospital staff.
    expect((await doctorUser.get(`${V}/portal/providers/${doctor.id}/appointments/${apptId}`)).status).toBe(200);
    expect((await doctorUser.post(`${V}/portal/providers/${hospital.id}/members`, { fullName: 'Mole', email: 'mole@test.carevanta.local', memberRole: 'ADMIN' })).status).toBe(403);
  });

  it('keeps staff inside their role, and lets the super-admin reshape roles without a release', async () => {
    const { hospital, hospitalOwner } = await affiliatedDoctor();
    const sa = await actor(['SUPER_ADMIN']);
    const invite = await hospitalOwner.post(`${V}/portal/providers/${hospital.id}/members`, { fullName: 'Desk Clerk', email: 'clerk.hardening@test.carevanta.local', memberRole: 'STAFF' });
    expect(invite.status, JSON.stringify(invite.body)).toBe(201);
    const clerkId = invite.body.data.members.find((m: { memberRole: string }) => m.memberRole === 'STAFF').userId as string;
    const clerk = await actorForUser(clerkId);
    const base = `${V}/portal/providers/${hospital.id}`;

    // Shipped matrix: staff manage bookings only.
    expect((await clerk.get(`${base}/finance/summary`)).status).toBe(403);
    expect((await clerk.get(`${base}/doctors`)).status).toBe(200);
    expect((await clerk.post(`${base}/schedules`, { doctorProviderId: hospital.id, locationId: hospital.locationId, dayOfWeek: 1, startMinute: 600, endMinute: 660, slotMinutes: 15, feeMinor: 100, validFrom: nextDate(0) })).status).toBe(403);
    let me = await clerk.get(`${V}/portal/me`);
    expect(me.body.data.memberships[0].capabilities).toEqual(['manage_bookings']);

    // Super-admin grants staff finance read-only; owners cannot be touched; junk is refused.
    expect((await setSetting(sa, 'portal.member_capabilities', { STAFF: ['manage_bookings', 'view_finance'] })).status).toBe(200);
    expect((await clerk.get(`${base}/finance/summary`)).status).toBe(200);
    me = await clerk.get(`${V}/portal/me`);
    expect(me.body.data.memberships[0].capabilities).toContain('view_finance');
    expect((await setSetting(sa, 'portal.member_capabilities', { OWNER: ['manage_bookings'] })).status).toBe(400);
    expect((await setSetting(sa, 'portal.member_capabilities', { STAFF: ['delete_everything'] })).status).toBe(400);
    expect((await setSetting(sa, 'portal.member_capabilities', [])).status).toBe(400);
    // Back to shipped.
    expect((await setSetting(sa, 'portal.member_capabilities', {})).status).toBe(200);
    expect((await clerk.get(`${base}/finance/summary`)).status).toBe(403);

    // Membership hygiene: the last owner cannot be removed, nobody removes themselves, and inviting an existing user reuses the account.
    const members = (await hospitalOwner.get(base)).body.data.members as { id: string; userId: string; memberRole: string }[];
    const ownerRow = members.find((m) => m.memberRole === 'OWNER')!;
    expect((await hospitalOwner.delete(`${base}/members/${ownerRow.id}`)).status).toBe(409);
    const again = await hospitalOwner.post(`${base}/members`, { fullName: 'Desk Clerk', email: 'clerk.hardening@test.carevanta.local', memberRole: 'ADMIN' });
    expect(again.status).toBe(409); // already a member
    expect((await prisma.user.count({ where: { email: 'clerk.hardening@test.carevanta.local' } }))).toBe(1);
  });
});

describe('portal hardening — configuration layer', () => {
  it('serves configuration publicly without secrets, validates it, and hides expired announcements', async () => {
    const sa = await actor(['SUPER_ADMIN']);
    const pub = await sa.get(`${V}/public/portal-ui`);
    expect(pub.status).toBe(200);
    expect(pub.body.data).toMatchObject({ announcement: null, support: {}, types: {}, emergencyNumber: '112' });
    expect(JSON.stringify(pub.body)).not.toMatch(/password|secret|token/i);

    expect((await setSetting(sa, 'portal.ui', { types: { HOSPITAL: { nav: { '/nope': { hidden: true } } } } })).status).toBe(400);
    expect((await setSetting(sa, 'portal.ui', { types: { HOSPITAL: { nav: { '/': { hidden: true } } } } })).status).toBe(400);
    expect((await setSetting(sa, 'portal.ui', { announcement: { text: '', tone: 'info' } })).status).toBe(400);
    expect((await setSetting(sa, 'portal.ui', { support: { email: 'not-an-email' } })).status).toBe(400);

    const ok = await setSetting(sa, 'portal.ui', { announcement: { text: 'Old notice', tone: 'warning', until: '2000-01-01' }, support: { phone: '+91 98000 00000' }, types: { HOSPITAL: { words: { noun: 'nursing home' }, nav: { '/appointments': { label: 'OPD' }, '/documents': { hidden: true } }, pages: { '/appointments': { title: 'OPD Desk' } } } } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const cfg = await sa.get(`${V}/portal/config`);
    expect(cfg.status).toBe(200);
    expect(cfg.body.data.announcement).toBeNull(); // expired
    expect(cfg.body.data.support.phone).toBe('+91 98000 00000');
    expect(cfg.body.data.types.HOSPITAL.nav['/appointments'].label).toBe('OPD');
    expect(cfg.body.data.catalogue.pages.some((p: { href: string }) => p.href === '/analytics')).toBe(true);
    expect(cfg.body.data.roles.OWNER).toContain('manage_dispatch');
    expect((await setSetting(sa, 'portal.ui', {})).status).toBe(200);
  });
});

describe('portal hardening — state machines and new operations', () => {
  it('refuses impossible schedule, slot and report operations instead of corrupting data', async () => {
    const { hospital, doctor, hospitalOwner } = await affiliatedDoctor();
    const base = `${V}/portal/providers/${hospital.id}`;
    const s1 = await hospitalOwner.post(`${base}/schedules`, { doctorProviderId: doctor.id, locationId: hospital.locationId, dayOfWeek: 3, startMinute: 600, endMinute: 720, slotMinutes: 30, feeMinor: 50000, validFrom: nextDate(0) });
    expect(s1.status).toBe(201);
    const gen = await hospitalOwner.post(`${base}/schedules/${s1.body.data.id}/generate-slots`, { from: nextDate(1), to: nextDate(14) });
    expect(gen.status).toBe(200);
    // An overlapping template is refused up front with a readable reason (QA PORT-2), never a 500.
    const clash = await hospitalOwner.post(`${base}/schedules`, { doctorProviderId: doctor.id, locationId: hospital.locationId, dayOfWeek: 3, startMinute: 630, endMinute: 690, slotMinutes: 30, feeMinor: 50000, validFrom: nextDate(0) });
    expect(clash.status).toBe(409);
    expect(clash.body.error.message).toMatch(/overlaps/);
    // Back-to-back is allowed.
    const s2 = await hospitalOwner.post(`${base}/schedules`, { doctorProviderId: doctor.id, locationId: hospital.locationId, dayOfWeek: 3, startMinute: 720, endMinute: 780, slotMinutes: 30, feeMinor: 50000, validFrom: nextDate(0) });
    expect(s2.status).toBe(201);
    // Deactivated template cannot generate; 100-day ranges are refused.
    expect((await hospitalOwner.post(`${base}/schedules/${s1.body.data.id}/deactivate`)).status).toBe(200);
    expect((await hospitalOwner.post(`${base}/schedules/${s1.body.data.id}/generate-slots`, { from: nextDate(1), to: nextDate(7) })).status).toBe(404);
    expect((await hospitalOwner.post(`${base}/schedules/${s2.body.data.id}/generate-slots`, { from: nextDate(1), to: nextDate(100) })).status).toBe(400);
    // Booked slot cannot be blocked; a blocked slot cannot be booked.
    const p = await patient();
    const slots = (await hospitalOwner.get(`${base}/slots?doctorProviderId=${doctor.id}&from=${new Date().toISOString()}&to=${new Date(Date.now() + 20 * 86_400_000).toISOString()}`)).body.data as { id: string; status: string; bookedCount: number }[];
    const open = slots.filter((s) => s.status === 'OPEN' && s.bookedCount === 0);
    expect((await p.post(`${V}/patient/appointments`, { slotId: open[0]!.id, patientProfileId: p.profileId }, idem())).status).toBe(201);
    expect((await hospitalOwner.post(`${base}/slots/${open[0]!.id}/status`, { status: 'BLOCKED' })).status).toBe(409);
    expect((await hospitalOwner.post(`${base}/slots/${open[1]!.id}/status`, { status: 'BLOCKED' })).status).toBe(200);
    expect((await p.post(`${V}/patient/appointments`, { slotId: open[1]!.id, patientProfileId: p.profileId }, idem())).status).toBe(409);
    expect((await hospitalOwner.post(`${base}/slots/${open[1]!.id}/status`, { status: 'BLOCKED' })).status).toBe(409); // already blocked
  });

  it('operators control vehicle availability only within verification, report incidents, and ask for refunds once', async () => {
    const { registrar, verifier } = await staff();
    const ops = await actor(['SUPER_ADMIN']);
    const op = await registrar.post(`${V}/admin/providers`, { type: 'AMBULANCE_OPERATOR', legalName: 'Hardening Ambulance', displayName: 'Hardening Ambulance', contactPhone: '9800077001', owner: { fullName: 'Op Owner', email: 'op.hardening@test.carevanta.local' }, ambulance: { dispatchPhone: '9800077002', isOpen24x7: true }, location: { name: 'Base', addressLine1: 'Bypass', city: 'Tamluk', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721636', latitude: TAMLUK.lat, longitude: TAMLUK.lng } });
    expect(op.status, JSON.stringify(op.body)).toBe(201);
    const opId = op.body.data.id as string;
    const owner = await actorForUser(op.body.data.members[0].userId);
    const base = `${V}/portal/providers/${opId}`;
    const v = await owner.post(`${base}/vehicles`, { registrationNumber: 'WB29HD0001', vehicleType: 'BLS', insuranceValidUntil: nextDate(300), equipment: ['OXYGEN'] });
    expect(v.status).toBe(201);
    const vid = v.body.data.id as string;
    // Unverified: the operator cannot declare it available (document rule), even after approval.
    expect((await owner.post(`${base}/vehicles/${vid}/status`, { status: 'AVAILABLE' })).status).toBe(422);
    await approveProvider(opId, registrar, verifier);
    await owner.put(`${base}/service-areas`, { areas: [{ purpose: 'AMBULANCE', district: 'Purba Medinipur' }] });
    expect((await owner.post(`${base}/vehicles/${vid}/status`, { status: 'AVAILABLE' })).status).toBe(422);
    expect((await ops.post(`${V}/admin/ambulance/vehicles/${vid}/status`, { status: 'AVAILABLE' })).status).toBe(200);
    // Verified: off the road and back, idempotent, never for someone else's vehicle.
    expect((await owner.post(`${base}/vehicles/${vid}/status`, { status: 'OUT_OF_SERVICE', reason: 'Workshop' })).body.data.status).toBe('OUT_OF_SERVICE');
    expect((await owner.post(`${base}/vehicles/${vid}/status`, { status: 'OUT_OF_SERVICE' })).status).toBe(200);
    expect((await owner.post(`${base}/vehicles/${vid}/status`, { status: 'AVAILABLE' })).body.data.status).toBe('AVAILABLE');
    const stranger = await createHospital(registrar, { name: 'Not An Operator' });
    const strangerOwner = await actorForUser(stranger.ownerUserId);
    expect((await strangerOwner.post(`${V}/portal/providers/${stranger.id}/vehicles/${vid}/status`, { status: 'OUT_OF_SERVICE' })).status).toBe(404);
    // Expired insurance blocks a return to service.
    await prisma.ambulanceVehicle.update({ where: { id: vid }, data: { status: 'OUT_OF_SERVICE', insuranceValidUntil: new Date(Date.now() - 86_400_000) } });
    expect((await owner.post(`${base}/vehicles/${vid}/status`, { status: 'AVAILABLE' })).status).toBe(422);
    await prisma.ambulanceVehicle.update({ where: { id: vid }, data: { status: 'AVAILABLE', insuranceValidUntil: new Date(Date.now() + 300 * 86_400_000) } });

    // A live trip: incident reports need an accepted assignment; the trip is on the vehicle so it cannot be taken off road mid-trip.
    await prisma.platformSetting.update({ where: { key: 'emergency.live_dispatch_enabled' }, data: { value: true } });
    invalidateSetting('emergency.live_dispatch_enabled');
    const p = await patient();
    const emergency = await p.post(`${V}/patient/emergency`, { district: 'Purba Medinipur' });
    expect(emergency.body.data.status).toBe('OFFERED');
    const requestId = emergency.body.data.requestId as string;
    expect((await owner.post(`${base}/dispatch/requests/${requestId}/incident`, { category: 'DELAY', description: 'Not ours yet, should fail' })).status).toBe(404);
    const offers = await owner.get(`${base}/dispatch/offers`);
    expect((await owner.post(`${base}/dispatch/assignments/${offers.body.data[0].id}/accept`, { vehicleId: vid, etaMinutes: 10 })).status).toBe(200);
    expect((await owner.post(`${base}/vehicles/${vid}/status`, { status: 'OUT_OF_SERVICE' })).status).toBe(409);
    const active = await owner.get(`${base}/dispatch/active`);
    expect(active.body.data[0]).toMatchObject({ id: requestId });
    expect(Object.keys(active.body.data[0])).toEqual(expect.arrayContaining(['callerPhone', 'pickupAddress']));
    const incident = await owner.post(`${base}/dispatch/requests/${requestId}/incident`, { category: 'SAFETY', description: 'Crowd blocking the road near the pickup, police called.' });
    expect(incident.status, JSON.stringify(incident.body)).toBe(201);
    const kase = await prisma.supportCase.findUniqueOrThrow({ where: { id: incident.body.data.id } });
    expect(kase).toMatchObject({ type: 'PROVIDER_REPORT', priority: 'URGENT', providerId: opId, category: 'AMBULANCE_SAFETY' });
    expect((await owner.post(`${base}/dispatch/requests/${requestId}/incident`, { category: 'OTHER', description: 'short' })).status).toBe(400);
    for (const s of ['EN_ROUTE', 'ARRIVED', 'PATIENT_ONBOARD', 'AT_DESTINATION', 'COMPLETED']) await owner.post(`${base}/dispatch/requests/${requestId}/progress`, { status: s });
    await prisma.platformSetting.update({ where: { key: 'emergency.live_dispatch_enabled' }, data: { value: false } });
    invalidateSetting('emergency.live_dispatch_enabled');

    // Refund requests: only PAID transactions, only yours, only one open at a time (an appointment transaction, since trips carry no fare yet).
    const { hospital, doctor, hospitalOwner } = await affiliatedDoctor();
    const { slots } = await slotsFor(hospitalOwner, doctor.id, hospital.locationId);
    const p2 = await patient();
    const booked = await p2.post(`${V}/patient/appointments`, { slotId: slots[0]!.id, patientProfileId: p2.profileId }, idem());
    expect(booked.status).toBe(201);
    const txn = await prisma.serviceTransaction.findFirstOrThrow({ where: { appointmentId: booked.body.data.id } });
    const hBase = `${V}/portal/providers/${hospital.id}`;
    expect((await hospitalOwner.post(`${hBase}/finance/transactions/${txn.id}/refund-request`, { reason: 'Not paid yet, so nothing to refund' })).status).toBe(422);
    await prisma.serviceTransaction.update({ where: { id: txn.id }, data: { status: 'PAID' } });
    expect((await strangerOwner.post(`${V}/portal/providers/${stranger.id}/finance/transactions/${txn.id}/refund-request`, { reason: 'Not my transaction at all' })).status).toBe(404);
    expect((await hospitalOwner.post(`${hBase}/finance/transactions/${txn.id}/refund-request`, { reason: 'Patient was charged twice for this visit', amountMinor: Number(txn.grossMinor) + 1 })).status).toBe(400);
    const rr = await hospitalOwner.post(`${hBase}/finance/transactions/${txn.id}/refund-request`, { reason: 'Patient was charged twice for this visit' });
    expect(rr.status, JSON.stringify(rr.body)).toBe(201);
    expect((await hospitalOwner.post(`${hBase}/finance/transactions/${txn.id}/refund-request`, { reason: 'Patient was charged twice for this visit' })).status).toBe(409);
    // Daily analytics for an operator counts the trip.
    const daily = await owner.get(`${base}/analytics/daily`);
    expect(daily.status, JSON.stringify(daily.body)).toBe(200);
    expect(daily.body.data.kind).toBe('trips');
    expect(daily.body.data.series.reduce((n: number, d: { completed: number }) => n + d.completed, 0)).toBe(1);
  });

  it('publishes reports only as PDF and only for orders in the right state', async () => {
    const { registrar, verifier } = await staff();
    const sa = await actor(['SUPER_ADMIN']);
    const lab = await registrar.post(`${V}/admin/providers`, { type: 'DIAGNOSTIC_LAB', legalName: 'Hardening Lab', displayName: 'Hardening Lab', contactPhone: '9800077003', owner: { fullName: 'Lab Owner', email: 'lab.hardening@test.carevanta.local' }, diagnostic: { offersPathology: true, homeCollectionAvailable: false }, location: { name: 'Lab', addressLine1: 'Road', city: 'Tamluk', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721636', latitude: TAMLUK.lat, longitude: TAMLUK.lng } });
    const labId = lab.body.data.id as string;
    await approveProvider(labId, registrar, verifier);
    const owner = await actorForUser(lab.body.data.members[0].userId);
    const base = `${V}/portal/providers/${labId}`;
    const offering = await owner.put(`${base}/services/LAB_LFT`, { priceMinor: 40000 });
    expect(offering.status).toBe(200);
    const p = await patient();
    const order = await sa.post(`${V}/admin/diagnostic-orders`, { patientProfileId: p.profileId, providerId: labId, providerServiceIds: [offering.body.data.id], collectionMode: 'CENTRE_VISIT' }, idem());
    expect(order.status).toBe(201);
    const oid = order.body.data.id as string;
    // Too early, wrong type, wrong order, then the real thing.
    expect((await owner.upload(`${base}/diagnostic-orders/${oid}/reports`, PDF, 'application/pdf')).status).toBe(409);
    for (const s of ['CONFIRMED', 'SAMPLE_COLLECTED', 'PROCESSING']) expect((await owner.post(`${base}/diagnostic-orders/${oid}/status`, { status: s })).status).toBe(200);
    expect((await owner.upload(`${base}/diagnostic-orders/${oid}/reports`, Buffer.from('<html>not a pdf</html>'), 'text/html')).status).toBeGreaterThanOrEqual(400);
    expect((await owner.upload(`${base}/diagnostic-orders/00000000-0000-7000-8000-000000000000/reports`, PDF, 'application/pdf')).status).toBe(404);
    const pub = await owner.upload(`${base}/diagnostic-orders/${oid}/reports`, PDF, 'application/pdf');
    expect([200, 201]).toContain(pub.status);
    // A correction without a reason is refused; skipping straight to COMPLETED from PROCESSING is refused.
    expect((await owner.upload(`${base}/diagnostic-orders/${oid}/reports`, PDF, 'application/pdf')).status).toBe(400);
    expect((await owner.post(`${base}/diagnostic-orders/${oid}/status`, { status: 'COMPLETED' })).status).toBeGreaterThanOrEqual(400);
  });
});
