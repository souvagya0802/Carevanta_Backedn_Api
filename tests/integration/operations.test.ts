import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { invalidateSetting } from '../../src/modules/settings/settings.service.js';
import { resetDatabase } from '../helpers/db.js';
import { actor, idem } from '../helpers/factory.js';
import { actorForUser, approveProvider, patient, staff } from '../helpers/fixtures.js';

beforeAll(resetDatabase);

const PDF = Buffer.from('%PDF-1.4\n% synthetic report\n%%EOF');

async function lab(registrar: Awaited<ReturnType<typeof staff>>['registrar'], verifier: Awaited<ReturnType<typeof staff>>['verifier']) {
  const res = await registrar.post('/api/v1/admin/providers', {
    type: 'DIAGNOSTIC_LAB',
    legalName: 'Tamluk Path Lab',
    displayName: `Tamluk Path Lab ${Date.now()}`,
    contactPhone: '9800077777',
    owner: { fullName: 'Lab Owner', email: `lab-${Date.now()}@test.carevanta.local` },
    diagnostic: { offersPathology: true, homeCollectionAvailable: true },
    location: { name: 'Lab', addressLine1: 'Market Road', city: 'Tamluk', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721636', latitude: 22.3, longitude: 87.92 },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const id = res.body.data.id as string;
  await approveProvider(id, registrar, verifier);
  await registrar.put(`/api/v1/admin/providers/${id}/services/LAB_LFT`, { priceMinor: 80000, homeServiceAvailable: true });
  await registrar.put(`/api/v1/admin/providers/${id}/services/LAB_CBC`, { priceMinor: 30000, homeServiceAvailable: false });
  await registrar.put(`/api/v1/admin/providers/${id}/service-areas`, { areas: [{ purpose: 'HOME_COLLECTION', district: 'Purba Medinipur', pincode: '721636' }] });
  const offerings = await prisma.providerService.findMany({ where: { providerId: id }, include: { service: true } });
  const owner = res.body.data.members.find((m: { memberRole: string }) => m.memberRole === 'OWNER');
  await prisma.providerMember.create({ data: { providerId: id, userId: (await actor([], {})).user.id, memberRole: 'LAB_TECHNICIAN', status: 'ACTIVE' } });
  return { id, ownerUserId: owner.userId as string, lft: offerings.find((o) => o.service.code === 'LAB_LFT')!.id, cbc: offerings.find((o) => o.service.code === 'LAB_CBC')!.id };
}

describe('diagnostics', () => {
  it('books tests, enforces home-collection coverage, publishes versioned reports, and gates report access', async () => {
    const { registrar, verifier } = await staff();
    const l = await lab(registrar, verifier);
    const p = await patient();
    const ops = await actor(['PLATFORM_ADMIN']);

    const noCoverage = await ops.post('/api/v1/admin/diagnostic-orders', { patientProfileId: p.profileId, providerId: l.id, providerServiceIds: [l.lft], collectionMode: 'HOME_COLLECTION', collectionPincode: '700001' }, idem());
    expect(noCoverage.status).toBe(422);
    const notHome = await ops.post('/api/v1/admin/diagnostic-orders', { patientProfileId: p.profileId, providerId: l.id, providerServiceIds: [l.cbc], collectionMode: 'HOME_COLLECTION', collectionPincode: '721636' }, idem());
    expect(notHome.status).toBe(422);
    const order = await ops.post('/api/v1/admin/diagnostic-orders', { patientProfileId: p.profileId, providerId: l.id, providerServiceIds: [l.lft, l.cbc], collectionMode: 'CENTRE_VISIT' }, idem());
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    expect(order.body.data.totalMinor).toBe(110000);
    const id = order.body.data.id;

    const owner = await actorForUser(l.ownerUserId);
    const early = await owner.upload(`/api/v1/portal/providers/${l.id}/diagnostic-orders/${id}/reports`, PDF, 'application/pdf');
    expect(early.status).toBe(409); // not PROCESSING yet
    for (const s of ['CONFIRMED', 'SAMPLE_COLLECTED', 'PROCESSING']) {
      expect((await owner.post(`/api/v1/portal/providers/${l.id}/diagnostic-orders/${id}/status`, { status: s })).status).toBe(200);
    }
    const tooEarly = await owner.post(`/api/v1/portal/providers/${l.id}/diagnostic-orders/${id}/status`, { status: 'REPORT_READY' });
    expect(tooEarly.status).toBe(422);
    const v1 = await owner.upload(`/api/v1/portal/providers/${l.id}/diagnostic-orders/${id}/reports`, PDF, 'application/pdf');
    expect(v1.status, JSON.stringify(v1.body)).toBe(201);
    const noReason = await owner.upload(`/api/v1/portal/providers/${l.id}/diagnostic-orders/${id}/reports`, PDF, 'application/pdf');
    expect(noReason.status).toBe(400);
    const v2 = await owner.upload(`/api/v1/portal/providers/${l.id}/diagnostic-orders/${id}/reports?correctionReason=Transcription%20error%20in%20ALT`, PDF, 'application/pdf');
    expect(v2.status).toBe(201);
    expect(v2.body.data.version).toBe(2);
    const reports = await prisma.diagnosticReport.findMany({ where: { orderId: id }, orderBy: { version: 'asc' } });
    expect(reports.map((r) => r.status)).toEqual(['AMENDED', 'PUBLISHED']);

    expect((await owner.post(`/api/v1/portal/providers/${l.id}/diagnostic-orders/${id}/status`, { status: 'REPORT_READY' })).status).toBe(200);
    expect((await owner.post(`/api/v1/portal/providers/${l.id}/diagnostic-orders/${id}/status`, { status: 'COMPLETED' })).status).toBe(200);
    const txn = await prisma.serviceTransaction.findUniqueOrThrow({ where: { diagnosticOrderId: id } });
    expect(txn.serviceCompletedAt).not.toBeNull();

    // Patient sees own report; another patient cannot; support agent lacks the permission.
    const mine = await p.get(`/api/v1/patient/diagnostic-orders/${id}/reports/${reports[1]!.id}/file`);
    expect(mine.status).toBe(200);
    expect(mine.headers['content-type']).toContain('application/pdf');
    const other = await patient();
    expect((await other.get(`/api/v1/patient/diagnostic-orders/${id}/reports/${reports[1]!.id}/file`)).status).toBe(404);
    const support = await actor(['SUPPORT_AGENT']);
    expect((await support.get(`/api/v1/admin/diagnostic-orders/${id}/reports/${reports[1]!.id}/file?purpose=complaint%20review`)).status).toBe(403);
    expect(await prisma.sensitiveAccessLog.count({ where: { resourceId: reports[1]!.id } })).toBe(2);
  });
});

describe('pharmacy', () => {
  it('reserves stock FEFO, requires approved prescriptions for scheduled drugs, releases on cancel', async () => {
    const { registrar, verifier } = await staff();
    const ops = await actor(['PLATFORM_ADMIN']);
    const ph = await registrar.post('/api/v1/admin/providers', {
      type: 'PHARMACY',
      legalName: 'Moyna Medical Hall',
      displayName: `Moyna Medical Hall ${Date.now()}`,
      contactPhone: '9800088888',
      owner: { fullName: 'Pharmacist', email: `ph-${Date.now()}@test.carevanta.local` },
      pharmacy: { retailDrugLicenseNo: 'WB-RDL-SYN-2', pharmacistName: 'Synthetic Pharmacist', homeDeliveryAvailable: false },
      location: { name: 'Shop', addressLine1: 'Bazar', city: 'Moyna', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721629' },
    });
    expect(ph.status).toBe(201);
    const pid = ph.body.data.id as string;
    const locationId = ph.body.data.locations[0].id as string;
    await approveProvider(pid, registrar, verifier);
    const owner = ph.body.data.members.find((m: { memberRole: string }) => m.memberRole === 'OWNER');
    await prisma.providerMember.update({ where: { providerId_userId: { providerId: pid, userId: owner.userId } }, data: { memberRole: 'PHARMACIST' } });

    const otc = await ops.post('/api/v1/admin/catalogue/medicines', { name: 'Paracetamol', strength: '500 mg', dosageForm: 'Tablet', packSize: '10', manufacturer: 'SynPharma' });
    const rx = await ops.post('/api/v1/admin/catalogue/medicines', { name: 'Amoxicillin', strength: '500 mg', dosageForm: 'Capsule', packSize: '10', manufacturer: 'SynPharma', schedule: 'SCHEDULE_H' });
    expect(rx.body.data.requiresPrescription).toBe(true);
    const far = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
    const near = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
    const stale = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    for (const [batch, expiry, qty] of [['B-FAR', far, 10], ['B-NEAR', near, 3], ['B-STALE', stale, 50]] as const) {
      const r = await ops.put(`/api/v1/admin/pharmacies/${pid}/inventory`, { locationId, medicineId: otc.body.data.id, batchNumber: batch, expiryDate: expiry, quantityOnHand: qty, mrpMinor: 3000, sellingPriceMinor: 2500 });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    expect((await ops.put(`/api/v1/admin/pharmacies/${pid}/inventory`, { locationId, medicineId: otc.body.data.id, batchNumber: 'B-BAD', expiryDate: far, quantityOnHand: 1, mrpMinor: 1000, sellingPriceMinor: 2000 })).status).toBe(400);

    const p = await patient();
    const order = await ops.post('/api/v1/admin/pharmacy-orders', { patientProfileId: p.profileId, providerId: pid, locationId, fulfilment: 'PICKUP', items: [{ medicineId: otc.body.data.id, quantity: 5 }] }, idem());
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    // FEFO: 3 from B-NEAR then 2 from B-FAR; B-STALE (expires in 10 days) never dispensed.
    const lines = order.body.data.items.map((i: { batchNumber: string; quantity: number }) => [i.batchNumber, i.quantity]).sort();
    expect(lines).toEqual([['B-FAR', 2], ['B-NEAR', 3]]);
    const tooMany = await ops.post('/api/v1/admin/pharmacy-orders', { patientProfileId: p.profileId, providerId: pid, locationId, fulfilment: 'PICKUP', items: [{ medicineId: otc.body.data.id, quantity: 9 }] }, idem());
    expect(tooMany.status).toBe(409);

    const cancel = await ops.post(`/api/v1/admin/pharmacy-orders/${order.body.data.id}/status`, { status: 'CANCELLED', reason: 'Patient changed mind' });
    expect(cancel.status).toBe(200);
    const inv = await prisma.pharmacyInventory.findMany({ where: { providerId: pid } });
    expect(inv.every((i) => i.quantityReserved === 0)).toBe(true);

    const noRx = await ops.post('/api/v1/admin/pharmacy-orders', { patientProfileId: p.profileId, providerId: pid, locationId, fulfilment: 'PICKUP', items: [{ medicineId: rx.body.data.id, quantity: 1 }] }, idem());
    expect(noRx.status).toBe(422);
    const prescription = await prisma.prescription.create({ data: { patientProfileId: p.profileId, uploadedByUserId: p.user.id, storageKey: `rx/test/${Date.now()}.pdf`, sha256: 'a'.repeat(64) } });
    await ops.put(`/api/v1/admin/pharmacies/${pid}/inventory`, { locationId, medicineId: rx.body.data.id, batchNumber: 'A-1', expiryDate: far, quantityOnHand: 20, mrpMinor: 9000, sellingPriceMinor: 9000 });
    const rxOrder = await ops.post('/api/v1/admin/pharmacy-orders', { patientProfileId: p.profileId, providerId: pid, locationId, fulfilment: 'PICKUP', prescriptionId: prescription.id, items: [{ medicineId: rx.body.data.id, quantity: 1 }] }, idem());
    expect(rxOrder.status, JSON.stringify(rxOrder.body)).toBe(201);
    expect(rxOrder.body.data.status).toBe('PRESCRIPTION_REVIEW');
    const unreviewed = await ops.post(`/api/v1/admin/pharmacy-orders/${rxOrder.body.data.id}/status`, { status: 'ACCEPTED' });
    expect(unreviewed.status).toBe(422);
    const pharmacist = await actorForUser(owner.userId);
    expect((await pharmacist.post(`/api/v1/portal/providers/${pid}/prescriptions/${prescription.id}/review`, { decision: 'APPROVED' })).status).toBe(200);
    for (const s of ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'DELIVERED']) {
      const r = await ops.post(`/api/v1/admin/pharmacy-orders/${rxOrder.body.data.id}/status`, { status: s });
      expect(r.status, `${s}: ${JSON.stringify(r.body)}`).toBe(200);
    }
    const batch = await prisma.pharmacyInventory.findFirstOrThrow({ where: { batchNumber: 'A-1' } });
    expect(batch.quantityOnHand).toBe(19);
    expect(batch.quantityReserved).toBe(0);
  });
});

describe('emergency dispatch', () => {
  it('always returns 112 guidance, never claims an ambulance until an operator accepts', async () => {
    const { registrar, verifier } = await staff();
    const p = await patient();
    const off = await p.post('/api/v1/patient/emergency', { district: 'Purba Medinipur', latitude: 22.3, longitude: 87.92 });
    expect(off.status).toBe(201);
    expect(off.body.data.callNow).toBe('112');
    expect(off.body.data.ambulanceConfirmed).toBe(false);
    expect(off.body.data.status).toBe('NO_PROVIDER_AVAILABLE'); // live dispatch disabled by default

    await prisma.platformSetting.update({ where: { key: 'emergency.live_dispatch_enabled' }, data: { value: true } });
    invalidateSetting();
    const op = await registrar.post('/api/v1/admin/providers', {
      type: 'AMBULANCE_OPERATOR',
      legalName: 'Tamluk Ambulance Service',
      displayName: `Tamluk Ambulance ${Date.now()}`,
      contactPhone: '9800099999',
      owner: { fullName: 'Dispatcher', email: `amb-${Date.now()}@test.carevanta.local` },
      ambulance: { dispatchPhone: '9800099999', isOpen24x7: true },
      location: { name: 'Base', addressLine1: 'Bypass', city: 'Tamluk', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721636' },
    });
    const opId = op.body.data.id as string;
    await approveProvider(opId, registrar, verifier);
    await registrar.put(`/api/v1/admin/providers/${opId}/service-areas`, { areas: [{ purpose: 'AMBULANCE', district: 'Purba Medinipur' }] });
    const ops = await actor(['OPERATIONS_DISPATCHER', 'PLATFORM_ADMIN']);
    const v = await ops.post('/api/v1/admin/ambulance/vehicles', { operatorProviderId: opId, registrationNumber: 'WB29AB1234', vehicleType: 'BLS', insuranceValidUntil: '2030-01-01' });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    expect((await ops.post(`/api/v1/admin/ambulance/vehicles/${v.body.data.id}/status`, { status: 'AVAILABLE' })).status).toBe(200);

    const live = await p.post('/api/v1/patient/emergency', { district: 'Purba Medinipur' });
    expect(live.body.data.operatorsNotified).toBe(1);
    expect(live.body.data.ambulanceConfirmed).toBe(false);
    expect(live.body.data.status).toBe('OFFERED');

    const owner = op.body.data.members.find((m: { memberRole: string }) => m.memberRole === 'OWNER');
    await prisma.providerMember.update({ where: { providerId_userId: { providerId: opId, userId: owner.userId } }, data: { memberRole: 'DISPATCHER' } });
    const dispatcher = await actorForUser(owner.userId);
    const offers = await dispatcher.get(`/api/v1/portal/providers/${opId}/dispatch/offers`);
    expect(offers.body.data).toHaveLength(1);
    const accept = await dispatcher.post(`/api/v1/portal/providers/${opId}/dispatch/assignments/${offers.body.data[0].id}/accept`, { vehicleId: v.body.data.id, etaMinutes: 12 });
    expect(accept.status, JSON.stringify(accept.body)).toBe(200);
    expect(accept.body.data.ambulanceConfirmed).toBe(true);
    expect(accept.body.data.confirmedBy.confirmationSource).toBe('OPERATOR_APP');
    expect((await prisma.ambulanceVehicle.findUniqueOrThrow({ where: { id: v.body.data.id } })).status).toBe('ON_TRIP');

    // The vehicle is busy: a second request finds no available vehicle.
    const second = await p.post('/api/v1/patient/emergency', { district: 'Purba Medinipur' });
    expect(second.body.data.status).toBe('NO_PROVIDER_AVAILABLE');

    // The accepted trip is recoverable after an app reload, until it completes.
    const active = await dispatcher.get(`/api/v1/portal/providers/${opId}/dispatch/active`);
    expect(active.body.data.map((d: { id: string }) => d.id)).toEqual([live.body.data.requestId]);

    for (const s of ['EN_ROUTE', 'ARRIVED', 'PATIENT_ONBOARD', 'AT_DESTINATION', 'COMPLETED']) {
      const r = await dispatcher.post(`/api/v1/portal/providers/${opId}/dispatch/requests/${live.body.data.requestId}/progress`, { status: s });
      expect(r.status, `${s}: ${JSON.stringify(r.body)}`).toBe(200);
    }
    expect((await prisma.ambulanceVehicle.findUniqueOrThrow({ where: { id: v.body.data.id } })).status).toBe('AVAILABLE');
    expect((await dispatcher.get(`/api/v1/portal/providers/${opId}/dispatch/active`)).body.data).toHaveLength(0);

    // TEST drills never notify operators.
    const drill = await ops.post('/api/v1/admin/dispatch/test', { district: 'Purba Medinipur' });
    expect(drill.body.data.isTest).toBe(true);
    expect(drill.body.data.assignments).toHaveLength(0);
  });
});

describe('support, settings, audit, exports', () => {
  it('runs the support lifecycle with SLA tracking', async () => {
    const agent = await actor(['SUPPORT_AGENT']);
    const c = await agent.post('/api/v1/admin/support-cases', { type: 'COMPLAINT', category: 'LATE_REPORT', priority: 'URGENT', subject: 'Report delayed', description: 'Report promised in 24h not delivered after 3 days.' });
    expect(c.status).toBe(201);
    expect(c.body.data.slaDueAt).not.toBeNull();
    const id = c.body.data.id;
    expect((await agent.post(`/api/v1/admin/support-cases/${id}/status`, { status: 'RESOLVED' })).status).toBe(400); // note required
    expect((await agent.post(`/api/v1/admin/support-cases/${id}/status`, { status: 'RESOLVED', note: 'Lab re-issued the report and apologised.' })).status).toBe(200);
    expect((await agent.post(`/api/v1/admin/support-cases/${id}/status`, { status: 'CLOSED' })).status).toBe(200);
    expect((await agent.post(`/api/v1/admin/support-cases/${id}/comments`, { body: 'late comment' })).status).toBe(409);
  });

  it('settings use optimistic concurrency and type checks; audit log is searchable', async () => {
    const sa = await actor(['SUPER_ADMIN']);
    const list = await sa.get('/api/v1/admin/settings');
    const s = list.body.data.find((x: { key: string }) => x.key === 'search.default_radius_km');
    expect((await sa.put('/api/v1/admin/settings/search.default_radius_km', { value: 'twenty', expectedVersion: s.version, reason: 'wrong type test' })).status).toBe(400);
    expect((await sa.put('/api/v1/admin/settings/search.default_radius_km', { value: 20, expectedVersion: s.version, reason: 'Pilot area is spread out' })).status).toBe(200);
    expect((await sa.put('/api/v1/admin/settings/search.default_radius_km', { value: 25, expectedVersion: s.version, reason: 'stale write' })).status).toBe(409);
    const log = await sa.get('/api/v1/admin/audit-events?action=settings.changed&limit=5');
    expect(log.status).toBe(200);
    expect(log.body.data.length).toBeGreaterThan(0);
    expect(JSON.stringify(log.body.data[0].metadata)).toContain('Pilot area');
    const auditor = await actor(['AUDITOR']);
    expect((await auditor.get('/api/v1/admin/audit-events?limit=1')).status).toBe(200);
    expect((await auditor.put('/api/v1/admin/settings/search.default_radius_km', { value: 1, expectedVersion: 9, reason: 'read only' })).status).toBe(403);
  });

  it('produces a CSV export, logs downloads, and never includes contact details in bulk user exports', async () => {
    const sa = await actor(['SUPER_ADMIN']);
    const job = await sa.post('/api/v1/admin/exports', { exportType: 'users', purpose: 'Quarterly access review' });
    expect(job.status, JSON.stringify(job.body)).toBe(201);
    expect(job.body.data.status).toBe('COMPLETED'); // JOBS_ENABLED=false → inline
    const dl = await sa.get(`/api/v1/admin/exports/${job.body.data.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toContain('text/csv');
    const text = dl.text;
    expect(text.split('\r\n')[0]).toBe('id,status,roles,emailVerified,phoneVerified,createdAt,lastLoginAt');
    expect(text).not.toContain('@test.carevanta.local');
    expect(await prisma.sensitiveAccessLog.count({ where: { resourceType: 'EXPORT', resourceId: job.body.data.id } })).toBe(1);
  });

  it('describes export data sets and rejects filters that do not apply to them', async () => {
    const sa = await actor(['SUPER_ADMIN']);
    const opts = await sa.get('/api/v1/admin/exports/options');
    expect(opts.status).toBe(200);
    expect(opts.body.data.maxRows).toBe(50_000);
    expect(opts.body.data.processing).toBe('inline');
    const types = opts.body.data.types as { type: string; statuses: string[]; supportsProvider: boolean; requiresRange: boolean }[];
    expect(types.map((t) => t.type)).toEqual(['providers', 'appointments', 'transactions', 'settlements', 'audit_events', 'users']);
    expect(types.find((t) => t.type === 'appointments')!.statuses).toContain('COMPLETED');
    expect(types.find((t) => t.type === 'audit_events')!.requiresRange).toBe(true);

    // Status that belongs to another data set → 400 before any job is created, with the allowed list.
    const bad = await sa.post('/api/v1/admin/exports', { exportType: 'users', purpose: 'Status check', filters: { status: 'COMPLETED' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.allowed).toContain('ACTIVE');
    // Audit events need a range; provider filter is refused where it does not apply; unknown provider is a 404.
    expect((await sa.post('/api/v1/admin/exports', { exportType: 'audit_events', purpose: 'Unbounded audit' })).status).toBe(400);
    expect((await sa.post('/api/v1/admin/exports', { exportType: 'users', purpose: 'Provider filter', filters: { providerId: '00000000-0000-7000-8000-000000000000' } })).status).toBe(400);
    expect((await sa.post('/api/v1/admin/exports', { exportType: 'appointments', purpose: 'Missing provider', filters: { providerId: '00000000-0000-7000-8000-000000000000' } })).status).toBe(404);

    const ok = await sa.post('/api/v1/admin/exports', { exportType: 'audit_events', purpose: 'Bounded audit', filters: { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date().toISOString() } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.truncated).toBe(false);
    expect(typeof ok.body.data.requestedByName).toBe('string');
    const list = await sa.get('/api/v1/admin/exports?limit=5');
    expect(list.body.data[0].requestedByName).toBe(ok.body.data.requestedByName);
  });
});
