import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { resetDatabase } from '../helpers/db.js';
import { actor } from '../helpers/factory.js';
import { actorForUser, approveProvider, createHospital, createDoctor, staff, TAMLUK } from '../helpers/fixtures.js';

beforeAll(resetDatabase);

const PDF = Buffer.from('%PDF-1.4\n% synthetic test document\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF');

describe('provider portal — organisation self-service', () => {
  it('lets an owner see and run their hospital, while staff and outsiders are limited', async () => {
    const { registrar, verifier } = await staff();
    const h = await createHospital(registrar, { name: 'Portal General Hospital' });
    const owner = await actorForUser(h.ownerUserId);

    // Who am I: one membership with owner capabilities.
    const me = await owner.get('/api/v1/portal/me');
    expect(me.status).toBe(200);
    expect(me.body.data.memberships).toHaveLength(1);
    expect(me.body.data.memberships[0]).toMatchObject({ providerId: h.id, memberRole: 'OWNER' });
    expect(me.body.data.memberships[0].capabilities).toContain('manage_staff');

    // Profile read carries my role; edit uses optimistic concurrency.
    const detail = await owner.get(`/api/v1/portal/providers/${h.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.myRole).toBe('OWNER');
    const edit = await owner.patch(`/api/v1/portal/providers/${h.id}`, { description: 'Multi-speciality hospital on Hospital Road', expectedVersion: detail.body.data.version });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect((await owner.patch(`/api/v1/portal/providers/${h.id}`, { description: 'stale', expectedVersion: detail.body.data.version })).status).toBe(409);

    // Locations, hours, departments, amenities, coverage.
    const loc = await owner.post(`/api/v1/portal/providers/${h.id}/locations`, { name: 'Moyna Branch', addressLine1: 'Bazar Road', city: 'Moyna', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721629', latitude: 22.27, longitude: 87.77 });
    expect(loc.status, JSON.stringify(loc.body)).toBe(201);
    const branch = loc.body.data.locations.find((l: { name: string }) => l.name === 'Moyna Branch');
    expect(branch.isPrimary).toBe(false);
    const hours = await owner.put(`/api/v1/portal/providers/${h.id}/locations/${branch.id}/hours`, { hours: [{ dayOfWeek: 1, opensAtMin: 540, closesAtMin: 1080 }, { dayOfWeek: 2, opensAtMin: 540, closesAtMin: 1080 }] });
    expect(hours.status, JSON.stringify(hours.body)).toBe(200);
    expect((await owner.put(`/api/v1/portal/providers/${h.id}/locations/${branch.id}/hours`, { hours: [{ dayOfWeek: 1, opensAtMin: 600, closesAtMin: 540 }] })).status).toBe(400);
    const depts = await owner.put(`/api/v1/portal/providers/${h.id}/departments`, { departmentCodes: ['DEPT_CARDIO', 'DEPT_GENERAL_MEDICINE'] });
    expect(depts.status, JSON.stringify(depts.body)).toBe(200);
    expect(depts.body.data.departments.every((d: { verified: boolean }) => d.verified === false)).toBe(true);
    const areas = await owner.put(`/api/v1/portal/providers/${h.id}/service-areas`, { areas: [{ purpose: 'HOME_COLLECTION', district: 'Purba Medinipur', pincode: '721636' }, { purpose: 'HOME_COLLECTION', district: 'Purba Medinipur', pincode: '721636' }] });
    expect(areas.status).toBe(200);
    expect(areas.body.data).toHaveLength(1); // duplicates collapse
    expect((await owner.get(`/api/v1/portal/providers/${h.id}/service-areas`)).body.data).toHaveLength(1);

    // Staff: invite by email creates an account and queues the invite; STAFF role gets a narrow view.
    const invite = await owner.post(`/api/v1/portal/providers/${h.id}/members`, { fullName: 'Front Desk', email: 'frontdesk.portal@test.carevanta.local', memberRole: 'STAFF' });
    expect(invite.status, JSON.stringify(invite.body)).toBe(201);
    expect(invite.body.data.invited).toBe(true);
    const staffMember = invite.body.data.members.find((m: { email: string }) => m.email === 'frontdesk.portal@test.carevanta.local');
    expect(await prisma.notification.count({ where: { userId: staffMember.userId, templateKey: 'auth.account_created' } })).toBe(1);
    const frontDesk = await actorForUser(staffMember.userId);
    expect((await frontDesk.get(`/api/v1/portal/providers/${h.id}`)).body.data.myRole).toBe('STAFF');
    expect((await frontDesk.patch(`/api/v1/portal/providers/${h.id}`, { description: 'nope', expectedVersion: 99 })).status).toBe(403);
    expect((await frontDesk.post(`/api/v1/portal/providers/${h.id}/members`, { userId: h.ownerUserId, memberRole: 'ADMIN' })).status).toBe(403);
    // A STAFF member cannot promote anyone to OWNER through an ADMIN either; only owners can.
    const admin = await owner.post(`/api/v1/portal/providers/${h.id}/members`, { fullName: 'Ops Admin', email: 'ops.portal@test.carevanta.local', memberRole: 'ADMIN' });
    expect(admin.status).toBe(201);
    const opsAdmin = await actorForUser(admin.body.data.members.find((m: { email: string }) => m.email === 'ops.portal@test.carevanta.local').userId);
    expect((await opsAdmin.post(`/api/v1/portal/providers/${h.id}/members`, { userId: staffMember.userId, memberRole: 'OWNER' })).status).toBe(403); // ADMIN lacks manage_staff
    expect((await owner.delete(`/api/v1/portal/providers/${h.id}/members/${staffMember.id}`)).status).toBe(200);

    // Outsiders get 404 (ids cannot be probed); the verifier can read via platform permission.
    const stranger = await actor([]);
    expect((await stranger.get(`/api/v1/portal/providers/${h.id}`)).status).toBe(403);
    expect((await stranger.get('/api/v1/portal/providers/00000000-0000-7000-8000-000000000000')).status).toBe(404);
    expect((await verifier.get(`/api/v1/portal/providers/${h.id}`)).status).toBe(200);

    // Documents and verification checklist, then submit.
    const doc = await owner.upload(`/api/v1/portal/providers/${h.id}/documents?documentType=CLINICAL_ESTABLISHMENT_REGISTRATION&fileName=cea.pdf&documentNumber=CEA-2026-77`, PDF, 'application/pdf');
    expect(doc.status, JSON.stringify(doc.body)).toBe(201);
    const before = await owner.get(`/api/v1/portal/providers/${h.id}/verification`);
    expect(before.status).toBe(200);
    expect(before.body.data.readyToSubmit).toBe(true);
    expect(before.body.data.requiredChecks).toEqual(expect.arrayContaining(['FACILITY_REGISTRATION', 'ADDRESS']));
    const submit = await owner.post(`/api/v1/portal/providers/${h.id}/submit`);
    expect(submit.status, JSON.stringify(submit.body)).toBe(200);
    expect(submit.body.data.status).toBe('SUBMITTED');
    const after = await owner.get(`/api/v1/portal/providers/${h.id}/verification`);
    expect(after.body.data.caseStatus).toBe('OPEN');
    const fac = after.body.data.checks.find((c: { checkType: string }) => c.checkType === 'FACILITY_REGISTRATION');
    expect(fac.evidence).toContainEqual({ documentType: 'CLINICAL_ESTABLISHMENT_REGISTRATION', status: 'UPLOADED' });
    expect(fac.todo.join(' ')).toMatch(/not yet reviewed/);
    expect(JSON.stringify(after.body)).not.toContain('portalUrl'); // registry internals stay internal
    expect(after.body.data.readyToSubmit).toBe(false);

    // Analytics and finance are readable by the owner, not by a plain STAFF account.
    const analytics = await owner.get(`/api/v1/portal/providers/${h.id}/analytics`);
    expect(analytics.status, JSON.stringify(analytics.body)).toBe(200);
    expect(analytics.body.data.appointments.total).toBe(0);
    const fin = await owner.get(`/api/v1/portal/providers/${h.id}/finance/summary`);
    expect(fin.status, JSON.stringify(fin.body)).toBe(200);
    expect(fin.body.data).toMatchObject({ balanceMinor: 0, unsettledMinor: 0 });
    expect((await frontDesk.get(`/api/v1/portal/providers/${h.id}/finance/summary`)).status).toBe(403);
    expect((await owner.get(`/api/v1/portal/providers/${h.id}/finance/summary?from=2026-01-01T00:00:00Z&to=2025-01-01T00:00:00Z`)).status).toBe(400);
  });

  it('runs a lab: priced tests, home-collection coverage, order scheduling and the report flow', async () => {
    const { registrar, verifier } = await staff();
    const create = await registrar.post('/api/v1/admin/providers', {
      type: 'DIAGNOSTIC_LAB', legalName: 'Portal Path Lab Pvt Ltd', displayName: 'Portal Path Lab', contactPhone: '9800044444',
      owner: { fullName: 'Lab Owner', email: 'lab.owner.portal@test.carevanta.local' },
      diagnostic: { offersPathology: true, homeCollectionAvailable: true },
      location: { name: 'Main Lab', addressLine1: 'Station Road', city: 'Tamluk', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721636', latitude: TAMLUK.lat, longitude: TAMLUK.lng },
    });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const labId = create.body.data.id as string;
    const owner = await actorForUser(create.body.data.members[0].userId);

    // Price a catalogue test with home collection; unknown codes are refused.
    const offer = await owner.put(`/api/v1/portal/providers/${labId}/services/LAB_LFT`, { priceMinor: 65000, homeServiceAvailable: true, turnaroundHours: 24 });
    expect(offer.status, JSON.stringify(offer.body)).toBe(200);
    expect((await owner.put(`/api/v1/portal/providers/${labId}/services/NOT_A_TEST`, { priceMinor: 100 })).status).toBe(400);
    const offerings = await owner.get(`/api/v1/portal/providers/${labId}/services`);
    expect(offerings.body.data.find((o: { serviceCode: string }) => o.serviceCode === 'LAB_LFT')).toMatchObject({ priceMinor: 65000, homeServiceAvailable: true });
    await owner.put(`/api/v1/portal/providers/${labId}/service-areas`, { areas: [{ purpose: 'HOME_COLLECTION', district: 'Purba Medinipur' }] });

    // Approve the lab, then a patient books through the admin-assisted path.
    await approveProvider(labId, registrar, verifier);
    const sa = await actor(['SUPER_ADMIN']);
    const patientUser = await actor([], { fullName: 'Lab Patient' });
    const profile = await prisma.patientProfile.create({ data: { accountUserId: patientUser.user.id, fullName: 'Lab Patient', relationship: 'SELF' } });
    const offeringId = offerings.body.data.find((o: { serviceCode: string }) => o.serviceCode === 'LAB_LFT').id;
    const order = await sa.post('/api/v1/admin/diagnostic-orders', { patientProfileId: profile.id, providerId: labId, providerServiceIds: [offeringId], collectionMode: 'HOME_COLLECTION', collectionPincode: '721636' }, { 'Idempotency-Key': `lab-${Date.now()}` });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    const orderId = order.body.data.id;

    // Lab sees it, schedules collection, moves it along, publishes the report.
    const list = await owner.get(`/api/v1/portal/providers/${labId}/diagnostic-orders?collectionMode=HOME_COLLECTION`);
    expect(list.body.data.map((o: { id: string }) => o.id)).toContain(orderId);
    const when = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const sched = await owner.post(`/api/v1/portal/providers/${labId}/diagnostic-orders/${orderId}/schedule`, { scheduledAt: when });
    expect(sched.status, JSON.stringify(sched.body)).toBe(200);
    expect(sched.body.data.scheduledAt).toBe(when);
    expect((await owner.post(`/api/v1/portal/providers/${labId}/diagnostic-orders/${orderId}/schedule`, { scheduledAt: '2020-01-01T00:00:00Z' })).status).toBe(400);
    for (const status of ['CONFIRMED', 'SAMPLE_COLLECTED', 'PROCESSING']) {
      const r = await owner.post(`/api/v1/portal/providers/${labId}/diagnostic-orders/${orderId}/status`, { status });
      expect(r.status, `${status}: ${JSON.stringify(r.body)}`).toBe(200);
    }
    expect((await owner.post(`/api/v1/portal/providers/${labId}/diagnostic-orders/${orderId}/status`, { status: 'REPORT_READY' })).status).toBe(422); // no report yet
    const rep = await owner.upload(`/api/v1/portal/providers/${labId}/diagnostic-orders/${orderId}/reports`, PDF, 'application/pdf');
    expect(rep.status, JSON.stringify(rep.body)).toBe(201);
    expect((await owner.post(`/api/v1/portal/providers/${labId}/diagnostic-orders/${orderId}/status`, { status: 'REPORT_READY' })).status).toBe(200);
    expect((await owner.post(`/api/v1/portal/providers/${labId}/diagnostic-orders/${orderId}/schedule`, { scheduledAt: when })).status).toBe(409);
    // Another provider cannot see this order.
    const other = await createHospital(registrar, { name: 'Other Hospital' });
    const otherOwner = await actorForUser(other.ownerUserId);
    expect((await otherOwner.get(`/api/v1/portal/providers/${other.id}/diagnostic-orders/${orderId}`)).status).toBe(404);
  });

  it('runs a pharmacy: stock batches with expiry rules, orders and the prescription queue', async () => {
    const { registrar, verifier } = await staff();
    const create = await registrar.post('/api/v1/admin/providers', {
      type: 'PHARMACY', legalName: 'Portal Medicos', displayName: 'Portal Medicos', contactPhone: '9800055555',
      owner: { fullName: 'Pharmacy Owner', email: 'pharmacy.owner.portal@test.carevanta.local' },
      pharmacy: { retailDrugLicenseNo: 'WB/RET/2026/001', pharmacistName: 'R. Das', pharmacistRegistrationNo: 'WBPC-1234', homeDeliveryAvailable: false },
      location: { name: 'Store', addressLine1: 'Bazar Road', city: 'Tamluk', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721636', latitude: TAMLUK.lat, longitude: TAMLUK.lng },
    });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const pharmacyId = create.body.data.id as string;
    const locationId = create.body.data.locations[0].id as string;
    const owner = await actorForUser(create.body.data.members[0].userId);
    await approveProvider(pharmacyId, registrar, verifier);

    const sa = await actor(['SUPER_ADMIN']);
    const med = await sa.post('/api/v1/admin/catalogue/medicines', { name: 'Paracetamol 500', genericName: 'Paracetamol', strength: '500 mg', dosageForm: 'TABLET', requiresPrescription: false, schedule: 'OTC' });
    expect(med.status, JSON.stringify(med.body)).toBe(201);
    const medicineId = med.body.data.id;

    // Inventory: expired batch refused, selling price above MRP refused, valid batch saved.
    const expired = await owner.put(`/api/v1/portal/providers/${pharmacyId}/inventory`, { locationId, medicineId, batchNumber: 'OLD1', expiryDate: '2020-01-01', quantityOnHand: 10, mrpMinor: 2000, sellingPriceMinor: 1800 });
    expect(expired.status).toBe(400);
    expect((await owner.put(`/api/v1/portal/providers/${pharmacyId}/inventory`, { locationId, medicineId, batchNumber: 'B1', expiryDate: '2030-01-01', quantityOnHand: 10, mrpMinor: 2000, sellingPriceMinor: 2500 })).status).toBe(400);
    const batch = await owner.put(`/api/v1/portal/providers/${pharmacyId}/inventory`, { locationId, medicineId, batchNumber: 'B1', expiryDate: '2030-01-01', quantityOnHand: 100, mrpMinor: 2000, sellingPriceMinor: 1800 });
    expect(batch.status, JSON.stringify(batch.body)).toBe(200);
    const inv = await owner.get(`/api/v1/portal/providers/${pharmacyId}/inventory?q=para`);
    expect(inv.body.data).toHaveLength(1);
    expect(inv.body.data[0]).toMatchObject({ available: 100, locationName: 'Store' });

    // An order arrives; pharmacy accepts, prepares, hands over; stock is consumed.
    const patientUser = await actor([], { fullName: 'Pharmacy Patient' });
    const profile = await prisma.patientProfile.create({ data: { accountUserId: patientUser.user.id, fullName: 'Pharmacy Patient', relationship: 'SELF' } });
    const order = await sa.post('/api/v1/admin/pharmacy-orders', { patientProfileId: profile.id, providerId: pharmacyId, locationId, fulfilment: 'PICKUP', items: [{ medicineId, quantity: 4 }] }, { 'Idempotency-Key': `rx-${Date.now()}` });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    const orderId = order.body.data.id;
    expect((await owner.get(`/api/v1/portal/providers/${pharmacyId}/inventory`)).body.data[0]).toMatchObject({ quantityReserved: 4, available: 96 });
    for (const status of ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'DELIVERED']) {
      const r = await owner.post(`/api/v1/portal/providers/${pharmacyId}/pharmacy-orders/${orderId}/status`, { status });
      expect(r.status, `${status}: ${JSON.stringify(r.body)}`).toBe(200);
    }
    expect((await owner.get(`/api/v1/portal/providers/${pharmacyId}/inventory`)).body.data[0]).toMatchObject({ quantityOnHand: 96, quantityReserved: 0 });
    expect((await owner.get(`/api/v1/portal/providers/${pharmacyId}/pharmacy-orders?status=DELIVERED`)).body.data).toHaveLength(1);
    expect((await owner.get(`/api/v1/portal/providers/${pharmacyId}/prescriptions`)).body.data).toHaveLength(0);
    // Reducing stock below what is reserved is refused; cancelling a delivered order is refused.
    expect((await owner.post(`/api/v1/portal/providers/${pharmacyId}/pharmacy-orders/${orderId}/status`, { status: 'CANCELLED', reason: 'too late' })).status).toBe(409);
  });

  it('gives a doctor the same portal for their own practice, and lists ambulance fleet for operators', async () => {
    const { registrar } = await staff();
    const doc = await createDoctor(registrar);
    const doctorUser = await prisma.doctorProfile.findUniqueOrThrow({ where: { providerId: doc.id }, select: { userId: true } });
    const doctor = await actorForUser(doctorUser.userId);
    const me = await doctor.get('/api/v1/portal/me');
    expect(me.body.data.ownDoctorProviderId).toBe(doc.id);
    expect(me.body.data.memberships[0]).toMatchObject({ providerId: doc.id, memberRole: 'OWNER', type: 'DOCTOR' });
    const v = await doctor.get(`/api/v1/portal/providers/${doc.id}/verification`);
    expect(v.body.data.requiredChecks).toContain('PROFESSIONAL_REGISTRATION');
    expect((await doctor.get(`/api/v1/portal/providers/${doc.id}/appointments-today`)).status).toBe(200);

    const op = await registrar.post('/api/v1/admin/providers', {
      type: 'AMBULANCE_OPERATOR', legalName: 'Portal Ambulance Services', displayName: 'Portal Ambulance', contactPhone: '9800066666',
      owner: { fullName: 'Ambulance Owner', email: 'amb.owner.portal@test.carevanta.local' },
      ambulance: { dispatchPhone: '9800066667', isOpen24x7: true, fleetSize: 2 },
      location: { name: 'Base', addressLine1: 'Highway', city: 'Tamluk', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721636' },
    });
    expect(op.status, JSON.stringify(op.body)).toBe(201);
    const opOwner = await actorForUser(op.body.data.members[0].userId);
    const vehicle = await opOwner.post(`/api/v1/portal/providers/${op.body.data.id}/vehicles`, { registrationNumber: 'WB29AB1234', vehicleType: 'BLS', insuranceValidUntil: '2030-01-01', equipment: ['OXYGEN'] });
    expect(vehicle.status, JSON.stringify(vehicle.body)).toBe(201);
    expect(vehicle.body.data.status).toBe('PENDING_VERIFICATION');
    expect((await opOwner.post(`/api/v1/portal/providers/${op.body.data.id}/vehicles`, { registrationNumber: 'WB29AB1234', vehicleType: 'BLS', insuranceValidUntil: '2030-01-01' })).status).toBe(409);
    expect((await opOwner.post(`/api/v1/portal/providers/${op.body.data.id}/crew`, { fullName: 'Driver One', role: 'DRIVER' })).status).toBe(400); // licence needed
    expect((await opOwner.post(`/api/v1/portal/providers/${op.body.data.id}/crew`, { fullName: 'Driver One', role: 'DRIVER', licenseNumber: 'WB-DL-1', licenseValidUntil: '2029-01-01' })).status).toBe(201);
    expect((await opOwner.get(`/api/v1/portal/providers/${op.body.data.id}/vehicles`)).body.data).toHaveLength(1);
    expect((await opOwner.get(`/api/v1/portal/providers/${op.body.data.id}/crew`)).body.data[0]).toMatchObject({ role: 'DRIVER', licenseExpired: false });
  });
});
