import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { resetDatabase } from '../helpers/db.js';
import { actor, idem, type Actor } from '../helpers/factory.js';
import { actorForUser, approveProvider, patient, randomUUID, staff } from '../helpers/fixtures.js';

beforeAll(resetDatabase);

const PDF = Buffer.from('%PDF-1.4\n% synthetic edge report\n%%EOF');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const location = { name: 'Main', addressLine1: 'Market Road', city: 'Tamluk', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721636', latitude: 22.3, longitude: 87.92 };

async function lab(registrar: Actor, verifier: Actor, approve = true) {
  const res = await registrar.post('/api/v1/admin/providers', {
    type: 'DIAGNOSTIC_LAB',
    legalName: 'Edge Path Lab',
    displayName: `Edge Path Lab ${randomUUID().slice(0, 6)}`,
    contactPhone: '9800077777',
    owner: { fullName: 'Lab Owner', email: `lab-${randomUUID().slice(0, 8)}@test.carevanta.local` },
    diagnostic: { offersPathology: true, homeCollectionAvailable: true },
    location,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const id = res.body.data.id as string;
  if (approve) await approveProvider(id, registrar, verifier);
  await registrar.put(`/api/v1/admin/providers/${id}/services/LAB_LFT`, { priceMinor: 80000, homeServiceAvailable: true });
  const offerings = await prisma.providerService.findMany({ where: { providerId: id } });
  return { id, ownerUserId: res.body.data.members[0].userId as string, lft: offerings[0]!.id };
}

async function pharmacy(registrar: Actor, verifier: Actor, opts: { delivers?: boolean; approve?: boolean } = {}) {
  const res = await registrar.post('/api/v1/admin/providers', {
    type: 'PHARMACY',
    legalName: 'Edge Medical Hall',
    displayName: `Edge Medical Hall ${randomUUID().slice(0, 6)}`,
    contactPhone: '9800088888',
    owner: { fullName: 'Pharmacist', email: `ph-${randomUUID().slice(0, 8)}@test.carevanta.local` },
    pharmacy: { retailDrugLicenseNo: `WB-RDL-${randomUUID().slice(0, 6)}`, pharmacistName: 'Synthetic Pharmacist', homeDeliveryAvailable: opts.delivers ?? false },
    location: { ...location, name: 'Shop' },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const id = res.body.data.id as string;
  if (opts.approve !== false) await approveProvider(id, registrar, verifier);
  return { id, locationId: res.body.data.locations[0].id as string, ownerUserId: res.body.data.members[0].userId as string };
}

describe('EDGE-DX: diagnostic orders', () => {
  it('EDGE-DX-01: creation limits — empty or 31 tests, unknown offering, wrong provider type, unapproved lab, missing PIN', async () => {
    const { registrar, verifier } = await staff();
    const ops = await actor(['PLATFORM_ADMIN']);
    const l = await lab(registrar, verifier);
    const draft = await lab(registrar, verifier, false);
    const p = await patient();
    const base = { patientProfileId: p.profileId, providerId: l.id, providerServiceIds: [l.lft], collectionMode: 'CENTRE_VISIT' };
    const url = '/api/v1/admin/diagnostic-orders';
    expect((await ops.post(url, { ...base, providerServiceIds: [] }, idem())).status).toBe(400);
    expect((await ops.post(url, { ...base, providerServiceIds: Array.from({ length: 31 }, () => l.lft) }, idem())).status).toBe(400);
    expect((await ops.post(url, { ...base, providerServiceIds: [randomUUID()] }, idem())).status).toBe(400);
    expect((await ops.post(url, { ...base, providerServiceIds: [l.lft, draft.lft] }, idem())).status).toBe(400);
    expect((await ops.post(url, { ...base, providerId: draft.id, providerServiceIds: [draft.lft] }, idem())).status).toBe(422);
    expect((await ops.post(url, { ...base, collectionMode: 'HOME_COLLECTION' }, idem())).status).toBe(400);
    expect((await ops.post(url, { ...base, collectionMode: 'HOME_COLLECTION', collectionPincode: '72163' }, idem())).status).toBe(400);
    expect((await ops.post(url, { ...base, collectionMode: 'COURIER' }, idem())).status).toBe(400);
    expect((await ops.post(url, { ...base, patientProfileId: randomUUID() }, idem())).status).toBe(404);
    expect((await ops.post(url, { ...base, scheduledAt: '2026-11-10 10:00' }, idem())).status).toBe(400);
    // The patient app refuses a collection time in the past; the same booking in the future is fine.
    const past = await p.post('/api/v1/patient/diagnostic-orders', { ...base, scheduledAt: new Date(Date.now() - 3_600_000).toISOString() }, idem());
    expect(past.status).toBe(400);
    const ok = await p.post('/api/v1/patient/diagnostic-orders', { ...base, scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }, idem());
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.status).toBe('REQUESTED');
  });

  it('EDGE-DX-02: state machine — skipped steps, missing reasons, report before processing, REPORT_READY without a report, terminal states', async () => {
    const { registrar, verifier } = await staff();
    const ops = await actor(['PLATFORM_ADMIN']);
    const l = await lab(registrar, verifier);
    const owner = await actorForUser(l.ownerUserId);
    const p = await patient();
    const create = () => ops.post('/api/v1/admin/diagnostic-orders', { patientProfileId: p.profileId, providerId: l.id, providerServiceIds: [l.lft], collectionMode: 'CENTRE_VISIT' }, idem());
    const o = await create();
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    const id = o.body.data.id as string;
    const move = (status: string, reason?: string) => ops.post(`/api/v1/admin/diagnostic-orders/${id}/status`, { status, ...(reason ? { reason } : {}) });
    const report = (q = '') => owner.upload(`/api/v1/portal/providers/${l.id}/diagnostic-orders/${id}/reports${q}`, PDF, 'application/pdf');
    expect((await move('SAMPLE_COLLECTED')).status).toBe(409);
    expect((await move('REQUESTED')).status).toBe(400);
    expect((await move('COMPLETED')).status).toBe(409);
    expect((await move('REJECTED')).status).toBe(400);
    expect((await report()).status).toBe(409);
    expect((await move('CONFIRMED')).status).toBe(200);
    expect((await move('CONFIRMED')).status).toBe(409);
    expect((await move('REJECTED', 'edge: too late')).status).toBe(409);
    expect((await move('SAMPLE_COLLECTED')).status).toBe(200);
    expect((await move('PROCESSING')).status).toBe(200);
    expect((await move('CANCELLED', 'edge: cannot cancel while processing')).status).toBe(409);
    expect((await move('REPORT_READY')).status).toBe(422);
    expect((await owner.upload(`/api/v1/portal/providers/${l.id}/diagnostic-orders/${id}/reports`, PNG, 'application/pdf')).status).toBe(415);
    expect((await owner.upload(`/api/v1/portal/providers/${l.id}/diagnostic-orders/${id}/reports`, PDF, 'image/png')).status).toBe(400);
    const v1 = await report();
    expect(v1.status, JSON.stringify(v1.body)).toBe(201);
    expect(v1.body.data.version).toBe(1);
    expect((await report()).status).toBe(400);
    expect((await report('?correctionReason=typo')).status).toBe(400);
    const v2 = await report('?correctionReason=edge%3A%20corrected%20haemoglobin%20units');
    expect(v2.status).toBe(201);
    expect(v2.body.data.version).toBe(2);
    expect((await prisma.diagnosticReport.findMany({ where: { orderId: id }, orderBy: { version: 'asc' } })).map((r) => r.status)).toEqual(['AMENDED', 'PUBLISHED']);
    expect((await move('REPORT_READY')).status).toBe(200);
    expect((await move('COMPLETED')).status).toBe(200);
    for (const s of ['CANCELLED', 'REJECTED', 'PROCESSING', 'COMPLETED']) expect((await move(s, 'edge: after completion')).status, s).toBe(409);
    // Another lab's staff can neither read nor advance this order.
    const other = await lab(registrar, verifier);
    const stranger = await actorForUser(other.ownerUserId);
    expect((await stranger.post(`/api/v1/portal/providers/${other.id}/diagnostic-orders/${id}/status`, { status: 'CONFIRMED' })).status).toBe(404);
    expect((await stranger.upload(`/api/v1/portal/providers/${other.id}/diagnostic-orders/${id}/reports`, PDF, 'application/pdf')).status).toBe(404);
    expect((await stranger.post(`/api/v1/portal/providers/${l.id}/diagnostic-orders/${id}/status`, { status: 'CONFIRMED' })).status).toBe(403);
  });
});

describe('EDGE-RX: pharmacy inventory and orders', () => {
  it('EDGE-RX-01: inventory boundaries — expiry today, quantities, batch names, foreign location, non-pharmacy; on-hand below reserved is 409', async () => {
    const { registrar, verifier } = await staff();
    const ops = await actor(['PLATFORM_ADMIN']);
    const ph = await pharmacy(registrar, verifier);
    const other = await pharmacy(registrar, verifier);
    const med = await ops.post('/api/v1/admin/catalogue/medicines', { name: `Edge Paracetamol ${randomUUID().slice(0, 6)}`, strength: '500 mg', dosageForm: 'Tablet', packSize: '10', manufacturer: 'SynPharma' });
    expect(med.status, JSON.stringify(med.body)).toBe(201);
    const medicineId = med.body.data.id as string;
    const url = `/api/v1/admin/pharmacies/${ph.id}/inventory`;
    const good = { locationId: ph.locationId, medicineId, batchNumber: 'EDGE-1', expiryDate: day(400), quantityOnHand: 10, mrpMinor: 3000, sellingPriceMinor: 2500 };
    const bad = [
      { expiryDate: day(0) },
      { expiryDate: day(-1) },
      { expiryDate: '2030-02-30' },
      { quantityOnHand: -1 },
      { quantityOnHand: 1_000_001 },
      { quantityOnHand: 1.5 },
      { batchNumber: '' },
      { batchNumber: 'B'.repeat(65) },
      { locationId: other.locationId },
      { medicineId: randomUUID() },
      { mrpMinor: -1 },
      { sellingPriceMinor: 3001 },
    ];
    for (const extra of bad) expect((await ops.put(url, { ...good, ...extra })).status, JSON.stringify(extra)).toBe(400);
    expect((await ops.put(`/api/v1/admin/pharmacies/${randomUUID()}/inventory`, good)).status).toBe(404);
    const hospital = await registrar.post('/api/v1/admin/providers', { type: 'HOSPITAL', legalName: 'Not A Pharmacy', displayName: `Not A Pharmacy ${randomUUID().slice(0, 6)}`, contactPhone: '9800011111', location });
    expect((await ops.put(`/api/v1/admin/pharmacies/${hospital.body.data.id}/inventory`, good)).status).toBe(404);
    // Selling price equal to MRP, and a batch expiring in 29 days (listed but not sellable).
    expect((await ops.put(url, { ...good, sellingPriceMinor: 3000 })).status).toBe(200);
    const soon = await ops.put(url, { ...good, batchNumber: 'EDGE-SOON', expiryDate: day(29), quantityOnHand: 5 });
    expect(soon.status).toBe(200);
    const inv = await ops.get(url);
    const soonRow = (inv.body.data as { batchNumber: string; available: number; expiringSoon: boolean; onShelf: number }[]).find((r) => r.batchNumber === 'EDGE-SOON')!;
    expect(soonRow).toMatchObject({ available: 0, expiringSoon: true, onShelf: 5 });
    // Reserve 4 from EDGE-1 and then try to correct on-hand to 3.
    const p = await patient();
    const order = await ops.post('/api/v1/admin/pharmacy-orders', { patientProfileId: p.profileId, providerId: ph.id, locationId: ph.locationId, fulfilment: 'PICKUP', items: [{ medicineId, quantity: 4 }] }, idem());
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    const below = await ops.put(url, { ...good, quantityOnHand: 3 });
    expect(below.status).toBe(409);
    expect((await ops.put(url, { ...good, quantityOnHand: 4 })).status).toBe(200);
    // Batches expiring within 30 days are never reserved: 11 units are wanted, only 10 sellable remain across good batches (4 reserved) → 409.
    expect((await ops.post('/api/v1/admin/pharmacy-orders', { patientProfileId: p.profileId, providerId: ph.id, locationId: ph.locationId, fulfilment: 'PICKUP', items: [{ medicineId, quantity: 1 }] }, idem())).status).toBe(409);
  });

  it('EDGE-RX-02: order limits and the status machine — stock is released on cancel/return and consumed on delivery', async () => {
    const { registrar, verifier } = await staff();
    const ops = await actor(['PLATFORM_ADMIN']);
    const ph = await pharmacy(registrar, verifier, { delivers: false });
    const draft = await pharmacy(registrar, verifier, { approve: false });
    const med = await ops.post('/api/v1/admin/catalogue/medicines', { name: `Edge Cetirizine ${randomUUID().slice(0, 6)}`, strength: '10 mg', dosageForm: 'Tablet', packSize: '10', manufacturer: 'SynPharma' });
    const medicineId = med.body.data.id as string;
    await ops.put(`/api/v1/admin/pharmacies/${ph.id}/inventory`, { locationId: ph.locationId, medicineId, batchNumber: 'EDGE-2', expiryDate: day(400), quantityOnHand: 10, mrpMinor: 3000, sellingPriceMinor: 2500 });
    const p = await patient();
    const url = '/api/v1/admin/pharmacy-orders';
    const base = { patientProfileId: p.profileId, providerId: ph.id, locationId: ph.locationId, fulfilment: 'PICKUP', items: [{ medicineId, quantity: 2 }] };
    expect((await ops.post(url, { ...base, items: [] }, idem())).status).toBe(400);
    expect((await ops.post(url, { ...base, items: Array.from({ length: 51 }, () => ({ medicineId, quantity: 1 })) }, idem())).status).toBe(400);
    expect((await ops.post(url, { ...base, items: [{ medicineId, quantity: 0 }] }, idem())).status).toBe(400);
    expect((await ops.post(url, { ...base, items: [{ medicineId, quantity: 1001 }] }, idem())).status).toBe(400);
    expect((await ops.post(url, { ...base, fulfilment: 'DELIVERY' }, idem())).status).toBe(400);
    expect((await ops.post(url, { ...base, fulfilment: 'DELIVERY', deliveryPincode: '721636' }, idem())).status).toBe(422);
    expect((await ops.post(url, { ...base, providerId: draft.id, locationId: draft.locationId }, idem())).status).toBe(422);
    expect((await ops.post(url, { ...base, items: [{ medicineId, quantity: 11 }] }, idem())).status).toBe(409);
    expect((await ops.post(url, { ...base, prescriptionId: randomUUID() }, idem())).status).toBe(400);

    const stock = () => prisma.pharmacyInventory.findFirstOrThrow({ where: { providerId: ph.id, batchNumber: 'EDGE-2' } });
    const place = async () => {
      const o = await ops.post(url, base, idem());
      expect(o.status, JSON.stringify(o.body)).toBe(201);
      return o.body.data.id as string;
    };
    const move = (id: string, status: string, reason?: string) => ops.post(`${url}/${id}/status`, { status, ...(reason ? { reason } : {}) });

    // Order A: skipped steps and missing reasons.
    const a = await place();
    expect((await stock()).quantityReserved).toBe(2);
    expect((await move(a, 'PREPARING')).status).toBe(409);
    expect((await move(a, 'PLACED')).status).toBe(400);
    expect((await move(a, 'DELIVERED')).status).toBe(409);
    expect((await move(a, 'CANCELLED')).status).toBe(400);
    expect((await move(a, 'ACCEPTED')).status).toBe(200);
    expect((await move(a, 'READY_FOR_PICKUP')).status).toBe(409);
    expect((await move(a, 'PREPARING')).status).toBe(200);
    expect((await move(a, 'OUT_FOR_DELIVERY')).status).toBe(200);
    expect((await move(a, 'CANCELLED', 'edge: cannot cancel on the road')).status).toBe(409);
    expect((await move(a, 'RETURNED', 'edge: patient absent')).status).toBe(200);
    expect((await stock()).quantityReserved, 'return releases the reservation').toBe(0);
    expect((await stock()).quantityOnHand).toBe(10);
    expect((await move(a, 'DELIVERED')).status).toBe(409);

    // Order B: delivered consumes stock; terminal afterwards.
    const b = await place();
    expect((await move(b, 'ACCEPTED')).status).toBe(200);
    expect((await move(b, 'PREPARING')).status).toBe(200);
    expect((await move(b, 'READY_FOR_PICKUP')).status).toBe(200);
    expect((await move(b, 'DELIVERED')).status).toBe(200);
    expect(await stock()).toMatchObject({ quantityReserved: 0, quantityOnHand: 8 });
    for (const s of ['CANCELLED', 'RETURNED', 'ACCEPTED']) expect((await move(b, s, 'edge: after delivery')).status, s).toBe(409);

    // Order C: the patient cancels while PLACED, and cannot cancel twice.
    const c = await place();
    expect((await stock()).quantityReserved).toBe(2);
    expect((await p.post(`/api/v1/patient/pharmacy-orders/${c}/cancel`, { reason: 'edge: changed my mind' })).status).toBe(200);
    expect((await stock()).quantityReserved).toBe(0);
    expect((await p.post(`/api/v1/patient/pharmacy-orders/${c}/cancel`, { reason: 'edge: twice' })).status).toBe(409);
    const stranger = await patient();
    expect((await stranger.post(`/api/v1/patient/pharmacy-orders/${b}/cancel`, { reason: 'edge: not mine' })).status).toBe(404);
    expect((await stranger.get(`/api/v1/patient/pharmacy-orders/${b}`)).status).toBe(404);
  });

  it('EDGE-RX-03: prescription review — only the dispensing pharmacy, a valid-until date in the past is refused, rejection blocks acceptance', async () => {
    const { registrar, verifier } = await staff();
    const ops = await actor(['PLATFORM_ADMIN']);
    const ph = await pharmacy(registrar, verifier);
    const other = await pharmacy(registrar, verifier);
    const pharmacist = await actorForUser(ph.ownerUserId);
    const outsider = await actorForUser(other.ownerUserId);
    const rxMed = await ops.post('/api/v1/admin/catalogue/medicines', { name: `Edge Amoxicillin ${randomUUID().slice(0, 6)}`, strength: '500 mg', dosageForm: 'Capsule', packSize: '10', manufacturer: 'SynPharma', schedule: 'SCHEDULE_H' });
    const medicineId = rxMed.body.data.id as string;
    await ops.put(`/api/v1/admin/pharmacies/${ph.id}/inventory`, { locationId: ph.locationId, medicineId, batchNumber: 'EDGE-RX', expiryDate: day(400), quantityOnHand: 10, mrpMinor: 9000, sellingPriceMinor: 9000 });
    const p = await patient();
    const upload = await p.upload(`/api/v1/patient/prescriptions?patientProfileId=${p.profileId}`, PNG, 'image/png');
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);
    const rxId = upload.body.data.id as string;
    expect((await p.upload(`/api/v1/patient/prescriptions?patientProfileId=${p.profileId}`, PNG, 'application/pdf')).status).toBe(415);
    expect((await p.upload(`/api/v1/patient/prescriptions?patientProfileId=${p.profileId}&issuedOn=31-12-2026`, PNG, 'image/png')).status).toBe(400);
    const stranger = await patient();
    expect((await stranger.upload(`/api/v1/patient/prescriptions?patientProfileId=${p.profileId}`, PNG, 'image/png')).status).toBe(404);
    // Scheduled drug without an approved prescription cannot be accepted.
    const order = await ops.post('/api/v1/admin/pharmacy-orders', { patientProfileId: p.profileId, providerId: ph.id, locationId: ph.locationId, fulfilment: 'PICKUP', prescriptionId: rxId, items: [{ medicineId, quantity: 1 }] }, idem());
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    expect(order.body.data.status).toBe('PRESCRIPTION_REVIEW');
    const oid = order.body.data.id as string;
    expect((await ops.post(`/api/v1/admin/pharmacy-orders/${oid}/status`, { status: 'ACCEPTED' })).status).toBe(422);
    const review = (who: Actor, pid: string, body: object) => who.post(`/api/v1/portal/providers/${pid}/prescriptions/${rxId}/review`, body);
    expect((await review(outsider, other.id, { decision: 'APPROVED' })).status).toBe(404);
    expect((await review(outsider, ph.id, { decision: 'APPROVED' })).status).toBe(403);
    expect((await review(pharmacist, ph.id, { decision: 'MAYBE' })).status).toBe(400);
    expect((await review(pharmacist, ph.id, { decision: 'APPROVED', validUntil: day(-1) })).status).toBe(400);
    expect((await review(pharmacist, ph.id, { decision: 'REJECTED', note: 'edge: illegible' })).status).toBe(200);
    expect((await ops.post(`/api/v1/admin/pharmacy-orders/${oid}/status`, { status: 'ACCEPTED' })).status).toBe(422);
    expect((await review(pharmacist, ph.id, { decision: 'APPROVED', validUntil: day(30) })).status).toBe(200);
    expect((await ops.post(`/api/v1/admin/pharmacy-orders/${oid}/status`, { status: 'ACCEPTED' })).status).toBe(200);
  });
});

describe('EDGE-AMB: fleet, crew and emergencies', () => {
  it('EDGE-AMB-01: registration format, expired insurance/fitness, duplicates, operator approval gate, crew licences', async () => {
    const { registrar, verifier } = await staff();
    const ops = await actor(['PLATFORM_ADMIN']);
    const mk = async (approve: boolean) => {
      const op = await registrar.post('/api/v1/admin/providers', { type: 'AMBULANCE_OPERATOR', legalName: 'Edge Ambulance', displayName: `Edge Ambulance ${randomUUID().slice(0, 6)}`, contactPhone: '9800099999', ambulance: { dispatchPhone: '9800099999' }, location });
      expect(op.status).toBe(201);
      if (approve) await approveProvider(op.body.data.id, registrar, verifier);
      return op.body.data.id as string;
    };
    const approved = await mk(true);
    const draft = await mk(false);
    const hospital = await registrar.post('/api/v1/admin/providers', { type: 'HOSPITAL', legalName: 'Not An Operator', displayName: `Not An Operator ${randomUUID().slice(0, 6)}`, contactPhone: '9800011111', location });
    const reg = `WB${Math.floor(10 + Math.random() * 89)}EC${Math.floor(1000 + Math.random() * 8999)}`;
    const url = '/api/v1/admin/ambulance/vehicles';
    const good = { operatorProviderId: approved, registrationNumber: reg, vehicleType: 'BLS', insuranceValidUntil: day(365) };
    for (const extra of [
      { registrationNumber: 'WB29AB12345' },
      { registrationNumber: '29WB1234' },
      { registrationNumber: 'WB29ABCD1234' },
      { insuranceValidUntil: day(-1) },
      { insuranceValidUntil: '01/01/2030' },
      { vehicleType: 'HELICOPTER' },
      { equipment: Array.from({ length: 41 }, () => 'oxygen') },
      { operatorProviderId: hospital.body.data.id },
      { baseLocationId: randomUUID() },
    ]) {
      expect((await ops.post(url, { ...good, ...extra })).status, JSON.stringify(extra)).toBe(400);
    }
    const created = await ops.post(url, { ...good, registrationNumber: reg.toLowerCase(), fitnessValidUntil: day(-1) });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.registrationNumber).toBe(reg);
    const vid = created.body.data.id as string;
    expect((await ops.post(url, good)).status).toBe(409);
    // Fitness certificate expired → cannot go AVAILABLE; fix the date, then it can.
    expect((await ops.post(`${url}/${vid}/status`, { status: 'AVAILABLE' })).status).toBe(422);
    await prisma.ambulanceVehicle.update({ where: { id: vid }, data: { fitnessValidUntil: new Date(Date.now() + 30 * 86_400_000) } });
    expect((await ops.post(`${url}/${vid}/status`, { status: 'AVAILABLE' })).status).toBe(200);
    expect((await ops.post(`${url}/${vid}/status`, { status: 'ON_TRIP' })).status).toBe(400);
    // Draft operator: a vehicle can be registered but never made AVAILABLE.
    const v2 = await ops.post(url, { ...good, operatorProviderId: draft, registrationNumber: `WB${Math.floor(10 + Math.random() * 89)}ED${Math.floor(1000 + Math.random() * 8999)}` });
    expect(v2.status).toBe(201);
    const gate = await ops.post(`${url}/${v2.body.data.id}/status`, { status: 'AVAILABLE' });
    expect(gate.status).toBe(422);
    // Crew.
    const crew = `/api/v1/admin/ambulance/operators/${approved}/crew`;
    expect((await ops.post(crew, { fullName: 'Edge Driver', role: 'DRIVER' })).status).toBe(400);
    expect((await ops.post(crew, { fullName: 'Edge Driver', role: 'DRIVER', licenseNumber: 'WB-DL-1', licenseValidUntil: day(-1) })).status).toBe(400);
    expect((await ops.post(crew, { fullName: 'Edge Driver', role: 'PILOT', licenseNumber: 'WB-DL-1' })).status).toBe(400);
    expect((await ops.post(`/api/v1/admin/ambulance/operators/${hospital.body.data.id}/crew`, { fullName: 'Edge EMT', role: 'EMT' })).status).toBe(404);
    expect((await ops.post(crew, { fullName: 'Edge Driver', role: 'DRIVER', licenseNumber: 'WB-DL-1', licenseValidUntil: day(365) })).status).toBe(201);
    expect((await ops.post(crew, { fullName: 'Edge EMT', role: 'EMT' })).status).toBe(201);
  });

  it('EDGE-AMB-02: an emergency always says call 112, never confirms an ambulance by itself, and the request is private; closing twice is 409', async () => {
    const p = await patient();
    expect((await p.post('/api/v1/patient/emergency', { callbackPhone: '12345' })).status).toBe(400);
    expect((await p.post('/api/v1/patient/emergency', { latitude: 91 })).status).toBe(400);
    expect((await p.post('/api/v1/patient/emergency', { address: 'x'.repeat(501) })).status).toBe(400);
    const res = await p.post('/api/v1/patient/emergency', { latitude: 22.3, district: 'Purba Medinipur', callbackPhone: '9800012345' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.callNow).toBe('112');
    expect(res.body.data.ambulanceConfirmed).toBe(false);
    expect(res.body.data.message).toMatch(/Call 112 now/);
    const id = res.body.data.requestId as string;
    expect((await p.get(`/api/v1/patient/emergency/${id}`)).status).toBe(200);
    const stranger = await patient();
    expect((await stranger.get(`/api/v1/patient/emergency/${id}`)).status).toBe(404);
    const ops = await actor(['OPERATIONS_DISPATCHER']);
    expect((await ops.post(`/api/v1/admin/dispatch/${id}/escalate`, { note: 'hmm' })).status).toBe(400);
    expect((await ops.post(`/api/v1/admin/dispatch/${id}/cancel`, { reason: 'edge: caller found a vehicle' })).status).toBe(200);
    const closed = await ops.post(`/api/v1/admin/dispatch/${id}/cancel`, { reason: 'edge: closing twice' });
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect((await ops.post(`/api/v1/admin/dispatch/${id}/escalate`, { note: 'edge: escalate after close' })).status).toBe(409);
    // Patient still sees the (closed) request; an unrelated patient still cannot.
    expect((await p.get(`/api/v1/patient/emergency/${id}`)).body.data.status).toBe('CANCELLED');
    expect((await stranger.get(`/api/v1/patient/emergency/${id}`)).status).toBe(404);
  });
});
