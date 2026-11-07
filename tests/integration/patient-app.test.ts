/**
 * The patient app's API surface: super-admin-editable content, public
 * browsing, and the signed-in patient's orders, prescriptions, reviews and
 * emergency status. Also checks the walls between patients.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { resetDatabase } from '../helpers/db.js';
import { actor, idem } from '../helpers/factory.js';
import { actorForUser, affiliatedDoctor, approveProvider, patient, slotsFor, staff, TAMLUK } from '../helpers/fixtures.js';
import { invalidateSetting } from '../../src/modules/settings/settings.service.js';

beforeAll(resetDatabase);
const V = '/api/v1';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0300050001ff4d4b5f1a0000000049454e44ae426082', 'hex');

describe('patient app — content and browsing', () => {
  it('serves editable home content with sensible defaults, validates edits, and stores the hero image', async () => {
    const anon = await actor([]);
    const ui = await anon.get(`${V}/public/patient-ui`);
    expect(ui.status).toBe(200);
    expect(ui.body.data.hero.title).toMatch(/doctor/i);
    expect(ui.body.data.categories.length).toBeGreaterThanOrEqual(5);
    expect(ui.body.data.theme.primary).toMatch(/^#/);
    expect(ui.body.data.heroImageUrl).toBeNull();

    const sa = await actor(['SUPER_ADMIN']);
    const view = await sa.get(`${V}/admin/patient-ui`);
    expect(view.status).toBe(200);
    expect((await sa.put(`${V}/admin/patient-ui`, { value: { hero: { title: '' } }, expectedVersion: view.body.data.version, reason: 'bad title' })).status).toBe(400);
    expect((await sa.put(`${V}/admin/patient-ui`, { value: { theme: { primary: 'blue' } }, expectedVersion: view.body.data.version, reason: 'bad colour' })).status).toBe(400);
    expect((await sa.put(`${V}/admin/patient-ui`, { value: { categories: [{ key: 'x', label: 'X', icon: 'pill', href: 'javascript:alert(1)' }] }, expectedVersion: view.body.data.version, reason: 'bad link' })).status).toBe(400);
    const saved = await sa.put(`${V}/admin/patient-ui`, { value: { hero: { title: 'Care for Moyna and Tamluk', ctaLabel: 'Book Now' }, theme: { primary: '#0055FF' }, announcement: { text: 'Free health camp this Sunday', tone: 'success' }, support: { phone: '+91 98000 00000' } }, expectedVersion: view.body.data.version, reason: 'pilot launch copy' });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    invalidateSetting('patient.ui');
    const after = await anon.get(`${V}/public/patient-ui`);
    expect(after.body.data.hero).toMatchObject({ title: 'Care for Moyna and Tamluk', ctaLabel: 'Book Now' });
    expect(after.body.data.hero.subtitle).toBeTruthy(); // default kept where not overridden
    expect(after.body.data.theme).toEqual({ primary: '#0055FF', accent: '#12C2E9' });
    expect(after.body.data.announcement.text).toContain('health camp');
    // Stale version is refused; the generic settings endpoint refuses the key.
    expect((await sa.put(`${V}/admin/patient-ui`, { value: {}, expectedVersion: view.body.data.version, reason: 'stale' })).status).toBe(409);
    const row = await prisma.platformSetting.findUniqueOrThrow({ where: { key: 'patient.ui' } });
    expect((await sa.put(`${V}/admin/settings/patient.ui`, { value: {}, expectedVersion: row.version, reason: 'blocked path' })).status).toBe(400);

    const img = await sa.upload(`${V}/admin/patient-ui/hero`, PNG, 'image/png');
    expect(img.status, JSON.stringify(img.body)).toBe(200);
    invalidateSetting('patient.hero_image');
    const withHero = await anon.get(`${V}/public/patient-ui`);
    expect(withHero.body.data.heroImageUrl).toMatch(/^\/api\/v1\/public\/patient-ui\/hero\?v=/);
    const file = await anon.get(withHero.body.data.heroImageUrl);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect((await sa.delete(`${V}/admin/patient-ui/hero`)).status).toBe(200);
    await expect((await actor([])).get(`${V}/admin/patient-ui`).then((r) => r.status)).resolves.toBe(403);
  });

  it('lets anyone browse verified providers, specialities, tests and medicines without secrets', async () => {
    const { hospital, doctor, registrar, verifier } = await affiliatedDoctor({ specialities: ['CARDIOLOGY'], departments: ['DEPT_CARDIO'] });
    const anon = await actor([]);
    const specs = await anon.get(`${V}/public/catalogue/specialities`);
    expect(specs.status).toBe(200);
    expect(specs.body.data.find((s: { code: string }) => s.code === 'CARDIOLOGY').doctors).toBe(1);

    const browse = await anon.get(`${V}/discovery/providers?type=DOCTOR&speciality=CARDIOLOGY`);
    expect(browse.status, JSON.stringify(browse.body)).toBe(200);
    expect(browse.body.data.items).toHaveLength(1);
    expect(browse.body.data.items[0]).toMatchObject({ id: doctor.id, type: 'DOCTOR', specialities: ['Cardiology'] });
    expect((await anon.get(`${V}/discovery/providers?type=DOCTOR&speciality=DENTISTRY`)).body.data.items).toHaveLength(0);
    // Geo search within 2 km of Tamluk finds the hospital; 200 km away finds nothing.
    expect((await anon.get(`${V}/discovery/providers?type=HOSPITAL&lat=${TAMLUK.lat}&lng=${TAMLUK.lng}&radiusKm=2`)).body.data.items.map((x: { id: string }) => x.id)).toContain(hospital.id);
    expect((await anon.get(`${V}/discovery/providers?type=HOSPITAL&lat=28.6&lng=77.2&radiusKm=5`)).body.data.items).toHaveLength(0);

    const profile = await anon.get(`${V}/discovery/providers/${doctor.id}`);
    expect(profile.status).toBe(200);
    expect(profile.body.data.doctor.practisesAt[0]).toMatchObject({ facilityId: hospital.id, department: 'Cardiology' });
    expect(profile.body.data.doctor.registrationVerified).toBe(true);
    expect(JSON.stringify(profile.body)).not.toMatch(/registrationNumber|gstin|legalName|passwordHash/);
    const facility = await anon.get(`${V}/discovery/providers/${hospital.id}`);
    expect(facility.body.data.doctors[0]).toMatchObject({ id: doctor.id, speciality: 'Cardiology' });
    expect(facility.body.data.departments.map((d: { code: string }) => d.code)).toContain('DEPT_CARDIO');
    // Draft / unlisted providers are invisible.
    const hidden = await registrar.post(`${V}/admin/providers`, { type: 'CLINIC', legalName: 'Hidden Clinic', displayName: 'Hidden Clinic', contactPhone: '9800070001', owner: { fullName: 'Owner', email: 'hidden.clinic@test.carevanta.local' }, facility: { ownershipType: 'PRIVATE' }, location: { name: 'Clinic', addressLine1: 'Road', city: 'Tamluk', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721636', latitude: TAMLUK.lat, longitude: TAMLUK.lng } });
    expect((await anon.get(`${V}/discovery/providers/${hidden.body.data.id}`)).status).toBe(404);
    void verifier;

    // Lab tests and medicines with "from" prices and provider counts.
    const sa = await actor(['SUPER_ADMIN']);
    const lab = await registrar.post(`${V}/admin/providers`, { type: 'DIAGNOSTIC_LAB', legalName: 'Browse Lab', displayName: 'Browse Lab', contactPhone: '9800070002', owner: { fullName: 'Lab Owner', email: 'browse.lab@test.carevanta.local' }, diagnostic: { offersPathology: true, homeCollectionAvailable: true }, location: { name: 'Lab', addressLine1: 'Road', city: 'Tamluk', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721636', latitude: TAMLUK.lat, longitude: TAMLUK.lng } });
    await approveProvider(lab.body.data.id, registrar, verifier);
    const labOwner = await actorForUser(lab.body.data.members[0].userId);
    expect((await labOwner.put(`${V}/portal/providers/${lab.body.data.id}/services/LAB_LFT`, { priceMinor: 45000, homeServiceAvailable: true })).status).toBe(200);
    const tests = await anon.get(`${V}/public/catalogue/services?category=DIAGNOSTIC_TEST`);
    expect(tests.body.data.find((t: { code: string }) => t.code === 'LAB_LFT')).toMatchObject({ providers: 1, fromMinor: 45000 });
    const labs = await anon.get(`${V}/discovery/providers?serviceCode=LAB_LFT`);
    expect(labs.body.data.items[0]).toMatchObject({ id: lab.body.data.id, priceMinor: 45000, homeService: true });
    const med = await sa.post(`${V}/admin/catalogue/medicines`, { name: 'Browse Paracetamol', strength: '500 mg', dosageForm: 'Tablet', packSize: '10', manufacturer: 'SynPharma' });
    expect((await anon.get(`${V}/public/catalogue/medicines?q=browse`)).body.data[0]).toMatchObject({ id: med.body.data.id, pharmacies: 0, fromMinor: null });
    const home = await anon.get(`${V}/public/patient-home`);
    expect(home.status).toBe(200);
    expect(home.body.data.counts.DOCTOR).toBeGreaterThanOrEqual(1);
    expect(home.body.data.topDoctors[0].id).toBe(doctor.id);
  });
});

describe('patient app — my care', () => {
  it('books tests and medicines, uploads a prescription, reviews a visit and tracks an emergency; other patients see none of it', async () => {
    const { registrar, verifier } = await staff();
    const sa = await actor(['SUPER_ADMIN']);
    const me = await patient();
    const other = await patient();
    const summary0 = await me.get(`${V}/patient/summary`);
    expect(summary0.status).toBe(200);
    expect(summary0.body.data).toMatchObject({ nextAppointment: null, openLabOrders: 0, openPharmacyOrders: 0, unreadNotifications: 0 });
    expect(summary0.body.data.profiles[0].relationship).toBe('SELF');

    // Family: add, rename, refuse removing self, cannot touch another account's profile.
    expect((await me.post(`${V}/patient/profiles`, { fullName: 'Future Baby', relationship: 'CHILD', dateOfBirth: '2999-01-01' })).status).toBe(400); // born in the future
    const child = await me.post(`${V}/patient/profiles`, { fullName: 'Little One', relationship: 'CHILD', dateOfBirth: '2020-05-01', gender: 'FEMALE' });
    expect(child.status).toBe(201);
    expect((await me.patch(`${V}/patient/profiles/${child.body.data.id}`, { fullName: 'Little Two' })).body.data.fullName).toBe('Little Two');
    expect((await me.patch(`${V}/patient/profiles/${me.profileId}`, { isActive: false })).status).toBe(400);
    expect((await other.patch(`${V}/patient/profiles/${child.body.data.id}`, { fullName: 'Hijack' })).status).toBe(404);

    // Lab order for the child at a verified lab.
    const lab = await registrar.post(`${V}/admin/providers`, { type: 'DIAGNOSTIC_LAB', legalName: 'My Care Lab', displayName: 'My Care Lab', contactPhone: '9800070003', owner: { fullName: 'Lab Owner', email: 'mycare.lab@test.carevanta.local' }, diagnostic: { offersPathology: true, homeCollectionAvailable: true }, location: { name: 'Lab', addressLine1: 'Road', city: 'Tamluk', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721636', latitude: TAMLUK.lat, longitude: TAMLUK.lng } });
    const labId = lab.body.data.id as string;
    await approveProvider(labId, registrar, verifier);
    const labOwner = await actorForUser(lab.body.data.members[0].userId);
    const offering = await labOwner.put(`${V}/portal/providers/${labId}/services/LAB_LFT`, { priceMinor: 45000, homeServiceAvailable: true });
    await labOwner.put(`${V}/portal/providers/${labId}/service-areas`, { areas: [{ purpose: 'HOME_COLLECTION', district: 'Purba Medinipur', pincode: '721636' }] });
    expect((await me.post(`${V}/patient/diagnostic-orders`, { patientProfileId: other.profileId, providerId: labId, providerServiceIds: [offering.body.data.id], collectionMode: 'CENTRE_VISIT' }, idem())).status).toBe(404); // not my profile
    expect((await me.post(`${V}/patient/diagnostic-orders`, { patientProfileId: child.body.data.id, providerId: labId, providerServiceIds: [offering.body.data.id], collectionMode: 'HOME_COLLECTION' }, idem())).status).toBe(400); // no PIN
    expect((await me.post(`${V}/patient/diagnostic-orders`, { patientProfileId: child.body.data.id, providerId: labId, providerServiceIds: [offering.body.data.id], collectionMode: 'CENTRE_VISIT', scheduledAt: '2020-01-01T05:00:00.000Z' }, idem())).status).toBe(400); // in the past
    const labOrder = await me.post(`${V}/patient/diagnostic-orders`, { patientProfileId: child.body.data.id, providerId: labId, providerServiceIds: [offering.body.data.id], collectionMode: 'HOME_COLLECTION', collectionPincode: '721636' }, idem());
    expect(labOrder.status, JSON.stringify(labOrder.body)).toBe(201);
    expect(labOrder.body.data).toMatchObject({ status: 'REQUESTED', totalMinor: 45000, patient: { fullName: 'Little Two' } });
    expect((await me.get(`${V}/patient/diagnostic-orders`)).body.data).toHaveLength(1);
    expect((await other.get(`${V}/patient/diagnostic-orders/${labOrder.body.data.id}`)).status).toBe(404);
    // The lab was told.
    expect((await labOwner.get(`${V}/portal/notifications/unread-count`)).body.data.unread).toBeGreaterThanOrEqual(1);

    // Medicines: upload a prescription, order an Rx medicine, cancel before preparation.
    const pharmacy = await registrar.post(`${V}/admin/providers`, { type: 'PHARMACY', legalName: 'My Care Medicos', displayName: 'My Care Medicos', contactPhone: '9800070004', owner: { fullName: 'Pharmacy Owner', email: 'mycare.pharmacy@test.carevanta.local' }, pharmacy: { retailDrugLicenseNo: 'WB/RET/2026/777', pharmacistName: 'R. Das', homeDeliveryAvailable: false }, location: { name: 'Store', addressLine1: 'Bazar', city: 'Tamluk', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721636', latitude: TAMLUK.lat, longitude: TAMLUK.lng } });
    const pharmacyId = pharmacy.body.data.id as string;
    const storeId = pharmacy.body.data.locations[0].id as string;
    await approveProvider(pharmacyId, registrar, verifier);
    const pharmacist = await actorForUser(pharmacy.body.data.members[0].userId);
    const otc = await sa.post(`${V}/admin/catalogue/medicines`, { name: 'Care Cetirizine', strength: '10 mg', dosageForm: 'Tablet', packSize: '10', manufacturer: 'SynPharma' });
    const rxMed = await sa.post(`${V}/admin/catalogue/medicines`, { name: 'Care Amoxicillin', strength: '500 mg', dosageForm: 'Capsule', packSize: '10', manufacturer: 'SynPharma', schedule: 'SCHEDULE_H' });
    for (const m of [otc, rxMed]) expect((await pharmacist.put(`${V}/portal/providers/${pharmacyId}/inventory`, { locationId: storeId, medicineId: m.body.data.id, batchNumber: `B-${m.body.data.id.slice(0, 6)}`, expiryDate: '2030-01-01', quantityOnHand: 50, mrpMinor: 5000, sellingPriceMinor: 4500 })).status).toBe(200);
    expect((await me.get(`${V}/public/catalogue/medicines?q=care%20cet`)).body.data[0]).toMatchObject({ pharmacies: 1, fromMinor: 4500 });
    expect((await me.get(`${V}/discovery/providers?medicineId=${otc.body.data.id}`)).body.data.items[0]).toMatchObject({ id: pharmacyId, priceMinor: 4500 });
    // Rx medicine without a prescription is refused; upload one and retry.
    expect((await me.post(`${V}/patient/pharmacy-orders`, { patientProfileId: me.profileId, providerId: pharmacyId, locationId: storeId, fulfilment: 'PICKUP', items: [{ medicineId: rxMed.body.data.id, quantity: 1 }] }, idem())).status).toBe(422);
    const rx = await me.upload(`${V}/patient/prescriptions?patientProfileId=${me.profileId}&issuedOn=2026-11-01`, PNG, 'image/png');
    expect(rx.status, JSON.stringify(rx.body)).toBe(201);
    expect((await me.get(`${V}/patient/prescriptions`)).body.data).toHaveLength(1);
    expect((await other.get(`${V}/patient/prescriptions/${rx.body.data.id}/file`)).status).toBe(404);
    expect((await me.get(`${V}/patient/prescriptions/${rx.body.data.id}/file`)).status).toBe(200);
    expect((await me.post(`${V}/patient/pharmacy-orders`, { patientProfileId: me.profileId, providerId: pharmacyId, locationId: storeId, fulfilment: 'PICKUP', prescriptionId: rx.body.data.id, items: [{ medicineId: otc.body.data.id, quantity: 2 }, { medicineId: rxMed.body.data.id, quantity: 1 }] }, idem())).body.data).toMatchObject({ status: 'PRESCRIPTION_REVIEW', totalMinor: 13500 });
    const otcOrder = await me.post(`${V}/patient/pharmacy-orders`, { patientProfileId: me.profileId, providerId: pharmacyId, locationId: storeId, fulfilment: 'PICKUP', items: [{ medicineId: otc.body.data.id, quantity: 3 }] }, idem());
    expect(otcOrder.body.data.status).toBe('PLACED');
    expect((await me.post(`${V}/patient/pharmacy-orders`, { patientProfileId: me.profileId, providerId: pharmacyId, locationId: storeId, fulfilment: 'DELIVERY', deliveryPincode: '721636', items: [{ medicineId: otc.body.data.id, quantity: 1 }] }, idem())).status).toBe(422); // no delivery
    expect((await other.post(`${V}/patient/pharmacy-orders/${otcOrder.body.data.id}/cancel`, {})).status).toBe(404);
    expect((await me.post(`${V}/patient/pharmacy-orders/${otcOrder.body.data.id}/cancel`, { reason: 'Found it nearer' })).body.data.status).toBe('CANCELLED');
    const stock = await pharmacist.get(`${V}/portal/providers/${pharmacyId}/inventory`);
    expect(stock.body.data.find((b: { medicine: { id: string } }) => b.medicine.id === otc.body.data.id).quantityReserved).toBe(2); // only the open order holds stock
    expect((await me.get(`${V}/patient/summary`)).body.data).toMatchObject({ openLabOrders: 1, openPharmacyOrders: 1 });

    // Review only after a completed visit, once.
    const { hospital, doctor, hospitalOwner } = await affiliatedDoctor();
    const { slots } = await slotsFor(hospitalOwner, doctor.id, hospital.locationId);
    const appt = await me.post(`${V}/patient/appointments`, { slotId: slots[0]!.id, patientProfileId: me.profileId }, idem());
    expect(appt.status).toBe(201);
    expect((await me.get(`${V}/patient/summary`)).body.data.nextAppointment).toMatchObject({ id: appt.body.data.id });
    expect((await me.post(`${V}/patient/reviews`, { appointmentId: appt.body.data.id, rating: 5 })).status).toBe(409);
    await prisma.appointment.update({ where: { id: appt.body.data.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
    expect((await me.post(`${V}/patient/reviews`, { appointmentId: appt.body.data.id, rating: 5, comment: 'Kind and quick' })).status).toBe(201);
    expect((await me.post(`${V}/patient/reviews`, { appointmentId: appt.body.data.id, rating: 1 })).status).toBe(409);
    expect((await other.post(`${V}/patient/reviews`, { appointmentId: appt.body.data.id, rating: 1 })).status).toBe(404);
    // Pending moderation: not public yet.
    expect((await me.get(`${V}/discovery/providers/${hospital.id}/reviews`)).body.data).toHaveLength(0);

    // Emergency: 112 first, then status only to the requester.
    const emergency = await me.post(`${V}/patient/emergency`, { district: 'Purba Medinipur' });
    expect(emergency.status).toBe(201);
    const status = await me.get(`${V}/patient/emergency/${emergency.body.data.requestId}`);
    expect(status.status).toBe(200);
    expect(status.body.data.emergencyNumber).toBe('112');
    expect(status.body.data.assignments).toBeUndefined();
    expect((await other.get(`${V}/patient/emergency/${emergency.body.data.requestId}`)).status).toBe(404);
    expect((await me.get(`${V}/patient/emergency`)).body.data).toHaveLength(1);
  });
});
