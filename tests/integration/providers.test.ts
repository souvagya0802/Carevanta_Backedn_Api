import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { resetDatabase } from '../helpers/db.js';
import { actor, api } from '../helpers/factory.js';
import { actorForUser, approveProvider, createDoctor, createHospital, staff } from '../helpers/fixtures.js';

beforeAll(resetDatabase);

const PDF = Buffer.from('%PDF-1.4\n% synthetic test document\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF');

describe('provider registration', () => {
  it('registers each provider type with its own profile', async () => {
    const { registrar } = await staff();
    const types = [
      { type: 'CLINIC', facility: { ownershipType: 'PRIVATE' } },
      { type: 'DIAGNOSTIC_LAB', diagnostic: { offersPathology: true, homeCollectionAvailable: true } },
      { type: 'IMAGING_CENTRE', diagnostic: { offersImaging: true, aerbLicenseNo: 'AERB-SYN-1' } },
      { type: 'PHARMACY', pharmacy: { retailDrugLicenseNo: 'WB-RDL-SYN-1', pharmacistName: 'Synthetic Pharmacist' } },
      { type: 'AMBULANCE_OPERATOR', ambulance: { dispatchPhone: '9800033333', isOpen24x7: true } },
    ];
    for (const t of types) {
      const res = await registrar.post('/api/v1/admin/providers', { legalName: `${t.type} Legal`, displayName: `${t.type} Display`, contactPhone: '9800044444', ...t });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data.status).toBe('DRAFT');
    }
    const lab = await prisma.provider.findFirstOrThrow({ where: { type: 'DIAGNOSTIC_LAB' }, include: { diagnosticProfile: true } });
    expect(lab.diagnosticProfile?.homeCollectionAvailable).toBe(true);
  });

  it('registers a doctor with several chambers and exactly one primary', async () => {
    const { registrar } = await staff();
    const chamber = (name: string, pin: string, lat: number, lng: number, isPrimary = false) => ({ name, addressLine1: 'Station Road', city: 'Tamluk', district: 'Purba Medinipur', state: 'West Bengal', pincode: pin, latitude: lat, longitude: lng, isPrimary });
    const res = await registrar.post('/api/v1/admin/providers', {
      type: 'DOCTOR',
      legalName: 'Dr. Multi Chamber',
      displayName: 'Dr. Multi Chamber',
      contactPhone: '9800022222',
      owner: { fullName: 'Dr. Multi Chamber', email: 'multi.chamber@test.carevanta.local' },
      doctor: { specialityCodes: ['GENERAL_MEDICINE'], registrations: [{ council: 'West Bengal Medical Council', registrationNumber: 'WBMC-MULTI-1' }] },
      locations: [chamber('Morning Chamber', '721636', 22.3, 87.92), chamber('Evening Chamber', '721629', 22.27, 87.77, true), chamber('Hospital OPD', '721636', 22.31, 87.93)],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const locs = res.body.data.locations as { name: string; isPrimary: boolean; latitude: number | null }[];
    expect(locs).toHaveLength(3);
    expect(locs.filter((l) => l.isPrimary).map((l) => l.name)).toEqual(['Evening Chamber']);
    expect(locs.every((l) => typeof l.latitude === 'number')).toBe(true);
    expect(await prisma.providerLocation.count({ where: { providerId: res.body.data.id, isPrimary: true } })).toBe(1);
  });

  it('validates required fields and type-specific shape', async () => {
    const { registrar } = await staff();
    const missing = await registrar.post('/api/v1/admin/providers', { type: 'HOSPITAL', displayName: 'No legal name' });
    expect(missing.status).toBe(400);
    const badGst = await registrar.post('/api/v1/admin/providers', { type: 'CLINIC', legalName: 'X Clinic', displayName: 'X Clinic', gstin: '12345' });
    expect(badGst.status).toBe(400);
    const doctorNoReg = await registrar.post('/api/v1/admin/providers', {
      type: 'DOCTOR',
      legalName: 'Dr X',
      displayName: 'Dr X',
      owner: { fullName: 'Dr X', email: 'drx@test.carevanta.local' },
      doctor: { registrations: [] },
    });
    expect(doctorNoReg.status).toBe(400);
  });

  it('never duplicates a doctor and rejects duplicate council registrations', async () => {
    const { registrar } = await staff();
    const d = await createDoctor(registrar);
    const again = await registrar.post('/api/v1/admin/providers', {
      type: 'DOCTOR',
      legalName: 'Dup',
      displayName: 'Dup',
      owner: { existingUserId: d.userId },
      doctor: { registrations: [{ council: 'West Bengal Medical Council', registrationNumber: 'OTHER-1' }] },
    });
    expect(again.status).toBe(409);
    const reg = await prisma.professionalRegistration.findFirstOrThrow({ where: { doctorProviderId: d.id } });
    const dupReg = await registrar.post('/api/v1/admin/providers', {
      type: 'DOCTOR',
      legalName: 'Dr Copy',
      displayName: 'Dr Copy',
      owner: { fullName: 'Dr Copy', email: 'drcopy@test.carevanta.local' },
      doctor: { registrations: [{ council: reg.council, registrationNumber: reg.registrationNumber }] },
    });
    expect(dupReg.status).toBe(409);
  });

  it('uses optimistic concurrency on edits', async () => {
    const { registrar } = await staff();
    const h = await createHospital(registrar);
    const ok = await registrar.patch(`/api/v1/admin/providers/${h.id}`, { description: 'Updated', expectedVersion: 1 });
    expect(ok.status).toBe(200);
    const stale = await registrar.patch(`/api/v1/admin/providers/${h.id}`, { description: 'Stale write', expectedVersion: 1 });
    expect(stale.status).toBe(409);
    const wrongType = await registrar.patch(`/api/v1/admin/providers/${h.id}`, { pharmacy: { pharmacistName: 'x' }, expectedVersion: 2 });
    expect(wrongType.status).toBe(400);
  });
});

describe('verification workflow', () => {
  it('runs pending → under review → approved and lists the provider', async () => {
    const { registrar, verifier } = await staff();
    const h = await createHospital(registrar);
    await approveProvider(h.id, registrar, verifier);
    const p = await prisma.provider.findUniqueOrThrow({ where: { id: h.id } });
    expect(p.status).toBe('APPROVED');
    expect(p.isListed).toBe(true);
    const history = await prisma.providerStatusHistory.findMany({ where: { providerId: h.id }, orderBy: { createdAt: 'asc' } });
    expect(history.map((x) => x.toStatus)).toEqual(['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED']);
    expect(await prisma.auditEvent.count({ where: { action: 'verification.approve' } })).toBeGreaterThan(0);
  });

  it('blocks approval until required checks pass', async () => {
    const { registrar, verifier } = await staff();
    const h = await createHospital(registrar);
    await registrar.post(`/api/v1/admin/providers/${h.id}/submit`);
    const kase = await prisma.verificationCase.findFirstOrThrow({ where: { providerId: h.id } });
    const res = await verifier.post(`/api/v1/admin/verification-cases/${kase.id}/decision`, { decision: 'APPROVE', note: 'trying too early' });
    expect(res.status).toBe(422);
    expect(res.body.error.details.outstanding.length).toBeGreaterThan(0);
  });

  it('requires evidence for a passed check and justification for a waiver', async () => {
    const { registrar, verifier } = await staff();
    const h = await createHospital(registrar);
    await registrar.post(`/api/v1/admin/providers/${h.id}/submit`);
    const kase = await prisma.verificationCase.findFirstOrThrow({ where: { providerId: h.id } });
    const noEvidence = await verifier.post(`/api/v1/admin/verification-cases/${kase.id}/checks/ADDRESS`, { status: 'PASSED', method: 'MANUAL_DOCUMENT_REVIEW' });
    expect(noEvidence.status).toBe(400);
    const waiver = await verifier.post(`/api/v1/admin/verification-cases/${kase.id}/checks/ADDRESS`, { status: 'WAIVED', method: 'MANUAL_DOCUMENT_REVIEW' });
    expect(waiver.status).toBe(400);
  });

  it('enforces separation of duties: the registrar cannot verify or approve', async () => {
    const sa = await actor(['SUPER_ADMIN']);
    const h = await createHospital(sa);
    await sa.post(`/api/v1/admin/providers/${h.id}/submit`);
    const kase = await prisma.verificationCase.findFirstOrThrow({ where: { providerId: h.id } });
    const check = await sa.post(`/api/v1/admin/verification-cases/${kase.id}/checks/ADDRESS`, { status: 'PASSED', method: 'PHYSICAL_INSPECTION', sourceReference: 'visit-1' });
    expect(check.status).toBe(403);
    expect(check.body.error.code).toBe('SEPARATION_OF_DUTIES');
    const decide = await sa.post(`/api/v1/admin/verification-cases/${kase.id}/decision`, { decision: 'APPROVE', note: 'self approval' });
    expect(decide.status).toBe(403);
  });

  it('only users with providers.approve can decide', async () => {
    const { registrar } = await staff();
    const support = await actor(['SUPPORT_AGENT']);
    const h = await createHospital(registrar);
    await registrar.post(`/api/v1/admin/providers/${h.id}/submit`);
    const kase = await prisma.verificationCase.findFirstOrThrow({ where: { providerId: h.id } });
    const res = await support.post(`/api/v1/admin/verification-cases/${kase.id}/decision`, { decision: 'APPROVE', note: 'not allowed' });
    expect(res.status).toBe(403);
  });

  it('request changes → resubmit → reject, and rejected cannot be suspended', async () => {
    const { registrar, verifier } = await staff();
    const h = await createHospital(registrar);
    await registrar.post(`/api/v1/admin/providers/${h.id}/submit`);
    const kase = await prisma.verificationCase.findFirstOrThrow({ where: { providerId: h.id } });
    const changes = await verifier.post(`/api/v1/admin/verification-cases/${kase.id}/decision`, { decision: 'REQUEST_CHANGES', note: 'Upload registration certificate' });
    expect(changes.status).toBe(200);
    expect((await prisma.provider.findUniqueOrThrow({ where: { id: h.id } })).status).toBe('CHANGES_REQUESTED');
    expect((await registrar.post(`/api/v1/admin/providers/${h.id}/submit`)).status).toBe(200);
    const reject = await verifier.post(`/api/v1/admin/verification-cases/${kase.id}/decision`, { decision: 'REJECT', note: 'Registration could not be confirmed' });
    expect(reject.status).toBe(200);
    const suspend = await registrar.post(`/api/v1/admin/providers/${h.id}/status`, { action: 'SUSPEND', reason: 'invalid transition test' });
    expect(suspend.status).toBe(409);
    expect(suspend.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('suspends and reactivates an approved provider', async () => {
    const { registrar, verifier } = await staff();
    const h = await createHospital(registrar);
    await approveProvider(h.id, registrar, verifier);
    const s = await registrar.post(`/api/v1/admin/providers/${h.id}/status`, { action: 'SUSPEND', reason: 'Licence under review' });
    expect(s.status).toBe(200);
    expect(s.body.data.isListed).toBe(false);
    const r = await registrar.post(`/api/v1/admin/providers/${h.id}/status`, { action: 'REACTIVATE', reason: 'Licence confirmed' });
    expect(r.body.data.status).toBe('APPROVED');
  });
});

describe('documents', () => {
  it('uploads with signature check, reviews with maker-checker, and logs every open', async () => {
    const { registrar, verifier } = await staff();
    const h = await createHospital(registrar);
    const up = await registrar.upload(`/api/v1/admin/providers/${h.id}/documents?documentType=CLINICAL_ESTABLISHMENT_REGISTRATION&fileName=reg.pdf&expiresAt=2030-01-01`, PDF, 'application/pdf');
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const docId = up.body.data.id;

    const fake = await registrar.upload(
      `/api/v1/admin/providers/${h.id}/documents?documentType=OTHER&fileName=evil.pdf`,
      Buffer.from('<script>alert(1)</script>'),
      'application/pdf',
    );
    expect(fake.status).toBe(415);

    const self = await registrar.post(`/api/v1/admin/providers/${h.id}/documents/${docId}/review`, { decision: 'ACCEPTED' });
    expect(self.status).toBe(403); // uploader cannot review (and PLATFORM_ADMIN has documents.review)
    const ok = await verifier.post(`/api/v1/admin/providers/${h.id}/documents/${docId}/review`, { decision: 'ACCEPTED' });
    expect(ok.status).toBe(200);

    const noPurpose = await verifier.get(`/api/v1/admin/providers/${h.id}/documents/${docId}/file`);
    expect(noPurpose.status).toBe(400);
    const file = await verifier.get(`/api/v1/admin/providers/${h.id}/documents/${docId}/file?purpose=Verification%20review`);
    expect(file.status).toBe(200);
    expect(file.headers['cache-control']).toBe('no-store');
    expect(await prisma.sensitiveAccessLog.count({ where: { resourceId: docId } })).toBe(1);

    const support = await actor(['SUPPORT_AGENT']);
    expect((await support.get(`/api/v1/admin/providers/${h.id}/documents/${docId}/file?purpose=curious%20look`)).status).toBe(403);
  });
});

describe('payout accounts', () => {
  it('stores account numbers encrypted and masks them', async () => {
    const { registrar } = await staff();
    const fin = await actor(['FINANCE_APPROVER']);
    const sa = await actor(['SUPER_ADMIN']);
    const h = await createHospital(registrar);
    const add = await sa.post(`/api/v1/admin/providers/${h.id}/payout-accounts`, { accountHolderName: 'Tamluk General', accountNumber: '123456789012', ifsc: 'SBIN0001234' });
    expect(add.status).toBe(201);
    expect(add.body.data.accountNumberMasked).toBe('XXXXXX9012');
    const row = await prisma.providerPayoutAccount.findUniqueOrThrow({ where: { id: add.body.data.id } });
    expect(row.accountNumberEncrypted).not.toContain('123456789012');
    const selfVerify = await sa.post(`/api/v1/admin/providers/${h.id}/payout-accounts/${row.id}/verify`, { method: 'PENNY_DROP' });
    expect(selfVerify.status).toBe(403);
    expect((await fin.get(`/api/v1/admin/providers/${h.id}/payout-accounts`)).status).toBe(200);
  });
});

describe('object-level authorisation (IDOR)', () => {
  it('a provider member cannot act for another provider', async () => {
    const { registrar } = await staff();
    const a = await createHospital(registrar);
    const b = await createHospital(registrar);
    const ownerA = await actorForUser(a.ownerUserId);
    const res = await ownerA.get(`/api/v1/portal/providers/${b.id}/affiliations`);
    expect([403, 404]).toContain(res.status);
    const ok = await ownerA.get(`/api/v1/portal/providers/${a.id}/affiliations`);
    expect(ok.status).toBe(200);
    // Members have no platform permissions, so admin endpoints are closed.
    expect((await ownerA.get(`/api/v1/admin/providers/${a.id}`)).status).toBe(403);
  });

  it('unauthenticated access is rejected everywhere', async () => {
    for (const url of ['/api/v1/admin/users', '/api/v1/admin/providers', '/api/v1/patient/appointments', '/api/v1/admin/verification-cases']) {
      expect((await api().get(url)).status).toBe(401);
    }
  });
});
