import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { resetDatabase } from '../helpers/db.js';
import { approveProvider, createDoctor, createHospital, staff } from '../helpers/fixtures.js';
import { cleanupExpired, enforceCredentialExpiry, openRenewalReminders } from '../../src/jobs/maintenance.js';
import { seedReferenceData } from '../../src/seed/reference-data.js';

beforeAll(resetDatabase);

describe('scheduled maintenance', () => {
  it('suspends a pharmacy whose drug licence lapsed and opens a renewal case', async () => {
    const { registrar, verifier } = await staff();
    const ph = await registrar.post('/api/v1/admin/providers', {
      type: 'PHARMACY',
      legalName: 'Lapsed Pharmacy',
      displayName: 'Lapsed Pharmacy',
      contactPhone: '9800012345',
      pharmacy: { retailDrugLicenseNo: 'WB-RDL-OLD', drugLicenseValidUntil: '2030-01-01' },
      location: { name: 'Shop', addressLine1: 'Road', city: 'Tamluk', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721636' },
    });
    await approveProvider(ph.body.data.id, registrar, verifier);
    await prisma.pharmacyProfile.update({ where: { providerId: ph.body.data.id }, data: { drugLicenseValidUntil: new Date('2020-01-01') } });
    const r = await enforceCredentialExpiry();
    expect(r.providersSuspended).toBeGreaterThanOrEqual(1);
    const p = await prisma.provider.findUniqueOrThrow({ where: { id: ph.body.data.id } });
    expect(p.status).toBe('SUSPENDED');
    expect(p.isListed).toBe(false);
    expect(await prisma.verificationCase.count({ where: { providerId: p.id, kind: 'RENEWAL' } })).toBe(1);
    // Idempotent: a second run changes nothing.
    expect((await enforceCredentialExpiry()).providersSuspended).toBe(0);
  });

  it('keeps doctors and pharmacies whose credentials have no expiry date, and suspends a doctor whose registration lapsed', async () => {
    const { registrar, verifier } = await staff();
    const ph = await registrar.post('/api/v1/admin/providers', {
      type: 'PHARMACY',
      legalName: 'Open-ended Pharmacy',
      displayName: 'Open-ended Pharmacy',
      contactPhone: '9800012346',
      pharmacy: { retailDrugLicenseNo: 'WB-RDL-NOEXP', drugLicenseValidUntil: '2030-01-01' },
      location: { name: 'Shop', addressLine1: 'Road', city: 'Tamluk', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721636' },
    });
    await approveProvider(ph.body.data.id, registrar, verifier);
    await prisma.pharmacyProfile.update({ where: { providerId: ph.body.data.id }, data: { drugLicenseValidUntil: null } });
    const keep = await createDoctor(registrar);
    const lapse = await createDoctor(registrar);
    await approveProvider(keep.id, registrar, verifier);
    await approveProvider(lapse.id, registrar, verifier);
    await prisma.professionalRegistration.updateMany({ where: { doctorProviderId: keep.id }, data: { validUntil: null, verifiedAt: new Date() } });
    await prisma.professionalRegistration.updateMany({ where: { doctorProviderId: lapse.id }, data: { validUntil: new Date('2020-01-01'), verifiedAt: new Date() } });

    await enforceCredentialExpiry();
    const status = async (id: string) => (await prisma.provider.findUniqueOrThrow({ where: { id } })).status;
    expect(await status(ph.body.data.id)).toBe('APPROVED');
    expect(await status(keep.id)).toBe('APPROVED');
    expect(await status(lapse.id)).toBe('SUSPENDED');
  });

  it('opens renewal reminders 30 days ahead and cleans up expired rows', async () => {
    const { registrar, verifier } = await staff();
    const h = await createHospital(registrar);
    await approveProvider(h.id, registrar, verifier);
    await prisma.providerDocument.create({
      data: { providerId: h.id, documentType: 'TRADE_LICENSE', status: 'ACCEPTED', storageKey: `providers/${h.id}/x.pdf`, fileName: 'x.pdf', mimeType: 'application/pdf', sizeBytes: 10, sha256: 'b'.repeat(64), expiresAt: new Date(Date.now() + 10 * 86_400_000) },
    });
    expect(await openRenewalReminders()).toBeGreaterThanOrEqual(1);
    expect(await openRenewalReminders()).toBe(0); // one open case at a time
    await prisma.idempotencyRecord.create({ data: { userId: registrar.user.id, scope: 'x', key: 'old-key-1', requestHash: 'c'.repeat(64), expiresAt: new Date(Date.now() - 1000) } });
    const cleaned = await cleanupExpired();
    expect(cleaned.idempotencyRecords).toBeGreaterThanOrEqual(1);
  });

  it('reference seed is idempotent and never overwrites reviewer decisions', async () => {
    const m = await prisma.conditionSpecialityMapping.findFirstOrThrow();
    await prisma.conditionSpecialityMapping.update({ where: { id: m.id }, data: { reviewStatus: 'APPROVED' } });
    await seedReferenceData(prisma);
    expect((await prisma.conditionSpecialityMapping.findUniqueOrThrow({ where: { id: m.id } })).reviewStatus).toBe('APPROVED');
    expect(await prisma.speciality.count()).toBeGreaterThan(20);
  });
});
