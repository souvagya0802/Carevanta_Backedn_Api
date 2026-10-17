import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { resetDatabase } from '../helpers/db.js';
import { actor } from '../helpers/factory.js';
import { createDoctor, createHospital, staff } from '../helpers/fixtures.js';
import { gstinChecksumValid } from '../../src/http/dto.js';

beforeAll(resetDatabase);

/** Build a GSTIN with a valid check digit for a West Bengal company PAN. */
function validGstin(): string {
  const stem = '19AABCT1332L1Z';
  for (const ch of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ') if (gstinChecksumValid(stem + ch)) return stem + ch;
  throw new Error('unreachable');
}

describe('verification registries', () => {
  it('rejects GSTINs with a bad check digit at registration', async () => {
    const { registrar } = await staff();
    const good = validGstin();
    const bad = good.slice(0, 14) + (good[14] === 'A' ? 'B' : 'A');
    const res = await registrar.post('/api/v1/admin/providers', { type: 'CLINIC', legalName: 'Checksum Clinic', displayName: 'Checksum Clinic', contactPhone: '9800033333', gstin: bad });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/check digit/i);
    const ok = await registrar.post('/api/v1/admin/providers', { type: 'CLINIC', legalName: 'Checksum Clinic', displayName: 'Checksum Clinic', contactPhone: '9800033333', gstin: good });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it('serves the registry catalogue, connector status and queue stats', async () => {
    const { verifier } = await staff();
    const cat = await verifier.get('/api/v1/admin/verification-cases/registries');
    expect(cat.status).toBe(200);
    const keys = cat.body.data.registries.map((r: { key: string }) => r.key);
    expect(keys).toEqual(expect.arrayContaining(['nmc_nmr', 'abdm_hpr', 'abdm_hfr', 'clinical_establishments', 'gstn', 'state_drugs_control', 'aerb', 'nabl', 'vahan']));
    expect(cat.body.data.connectors).toEqual({ abdm: 'not_configured', gstin: 'not_configured', vahan: 'not_configured' });
    expect(cat.body.data.requirements.DOCTOR.required).toContain('PROFESSIONAL_REGISTRATION');

    const stats = await verifier.get('/api/v1/admin/verification-cases/stats');
    expect(stats.status).toBe(200);
    expect(stats.body.data.slaHours).toBe(72);
    expect(typeof stats.body.data.open).toBe('number');
  });

  it('gives per-check guidance with identifiers, warnings and evidence status, and filters the queue', async () => {
    const { registrar, verifier } = await staff();
    const doc = await createDoctor(registrar);
    await registrar.post(`/api/v1/admin/providers/${doc.id}/submit`);
    const kase = await prisma.verificationCase.findFirstOrThrow({ where: { providerId: doc.id } });

    const g = await verifier.get(`/api/v1/admin/verification-cases/${kase.id}/guidance`);
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    const reg = g.body.data.checks.find((c: { checkType: string }) => c.checkType === 'PROFESSIONAL_REGISTRATION');
    expect(reg.identifiers[0].label).toMatch(/registration/i);
    expect(reg.registries.map((r: { key: string }) => r.key)).toEqual(expect.arrayContaining(['nmc_nmr', 'abdm_hpr']));
    expect(reg.registries.find((r: { key: string }) => r.key === 'nmc_nmr').portalUrl).toContain('nmc.org.in');
    expect(reg.registries.find((r: { key: string }) => r.key === 'abdm_hpr').lookupAvailable).toBe(false);
    expect(reg.evidence).toContainEqual(expect.objectContaining({ documentType: 'MEDICAL_REGISTRATION_CERTIFICATE', status: 'MISSING' }));
    expect(reg.warnings.join(' ')).toMatch(/No evidence document/);

    // Automatic lookup is refused until a connector is configured; manual portal lookups are the path.
    const lookup = await verifier.post(`/api/v1/admin/verification-cases/${kase.id}/checks/PROFESSIONAL_REGISTRATION/lookup`);
    expect(lookup.status).toBe(422);
    expect(lookup.body.error.details.connector).toBe('abdm');
    const none = await verifier.post(`/api/v1/admin/verification-cases/${kase.id}/checks/QUALIFICATION/lookup`);
    expect(none.status).toBe(422);

    // Queue filters and name search.
    const list = await verifier.get(`/api/v1/admin/verification-cases?q=${encodeURIComponent('Dr.')}&unassignedOnly=true&providerType=DOCTOR`);
    expect(list.status).toBe(200);
    expect(list.body.data.map((c: { id: string }) => c.id)).toContain(kase.id);
    expect(list.body.data[0].outstanding).toContain('PROFESSIONAL_REGISTRATION');
    expect(list.body.data[0].overdue).toBe(false);
    expect((await verifier.get('/api/v1/admin/verification-cases?overdueOnly=true')).body.data.map((c: { id: string }) => c.id)).not.toContain(kase.id);
    expect((await verifier.get('/api/v1/admin/verification-cases?decidedOnly=true')).body.data.map((c: { id: string }) => c.id)).not.toContain(kase.id);

    // Case detail carries names and SLA fields.
    const detail = await verifier.get(`/api/v1/admin/verification-cases/${kase.id}`);
    expect(detail.body.data.registrarName).toBeTruthy();
    expect(detail.body.data.slaHours).toBe(72);
  });

  it('stores registry connector settings with secrets encrypted and masked', async () => {
    const sa = await actor(['SUPER_ADMIN']);
    const put = await sa.put('/api/v1/admin/integrations/registries', { abdm: { environment: 'sandbox', clientId: 'SBX_test_client', clientSecret: 'super-secret-value' }, gstin: { baseUrl: 'https://api.example-gsp.in/v1/gstin', apiKey: 'k-123' } });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.data.abdm).toMatchObject({ clientId: 'SBX_test_client', hasSecret: true });
    expect(put.body.data.status).toMatchObject({ abdm: 'configured', gstin: 'configured', vahan: 'not_configured' });
    expect(JSON.stringify(put.body)).not.toContain('super-secret-value');
    const row = await prisma.platformSetting.findUniqueOrThrow({ where: { key: 'registry.abdm.clientSecret' } });
    expect(row.isSensitive).toBe(true);
    expect(String(row.value)).not.toContain('super-secret-value');

    // Blank secret keeps the stored one; null clears it; http URLs are refused.
    expect((await sa.put('/api/v1/admin/integrations/registries', { abdm: { clientSecret: '' } })).body.data.abdm.hasSecret).toBe(true);
    expect((await sa.put('/api/v1/admin/integrations/registries', { gstin: { baseUrl: 'http://insecure.example' } })).status).toBe(400);
    expect((await sa.put('/api/v1/admin/integrations/registries', { abdm: { clientSecret: null } })).body.data.abdm.hasSecret).toBe(false);

    // A configured connector still needs the lookup endpoint confirmed before it is used.
    const { registrar, verifier } = await staff();
    const h = await createHospital(registrar);
    await sa.put('/api/v1/admin/integrations/registries', { abdm: { clientSecret: 'again' } });
    await registrar.post(`/api/v1/admin/providers/${h.id}/submit`);
    const kase = await prisma.verificationCase.findFirstOrThrow({ where: { providerId: h.id } });
    const g = await verifier.get(`/api/v1/admin/verification-cases/${kase.id}/guidance`);
    const fac = g.body.data.checks.find((c: { checkType: string }) => c.checkType === 'FACILITY_REGISTRATION');
    expect(fac.registries.find((r: { key: string }) => r.key === 'abdm_hfr').lookupAvailable).toBe(true);
    const lookup = await verifier.post(`/api/v1/admin/verification-cases/${kase.id}/checks/FACILITY_REGISTRATION/lookup`);
    expect(lookup.status).toBe(422);
    expect(lookup.body.error.message).toMatch(/HFR lookup endpoint is not set/);
  });
});
