import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { resetDatabase } from '../helpers/db.js';
import { actor, api } from '../helpers/factory.js';
import { TAMLUK, affiliatedDoctor, approveProvider, createHospital } from '../helpers/fixtures.js';

beforeAll(resetDatabase);

describe('condition-based discovery', () => {
  it('uses only clinically reviewed mappings, never the proposer’s own review', async () => {
    const reviewer = await actor(['CLINICAL_REVIEWER']);
    const liver = await prisma.condition.findUniqueOrThrow({ where: { slug: 'liver-disease' } });
    const before = await api().get('/api/v1/discovery/search?q=liver%20disease');
    expect(before.status).toBe(200);
    expect(before.body.data.specialities).toEqual([]); // nothing APPROVED yet

    const mappings = await prisma.conditionSpecialityMapping.findMany({ where: { conditionId: liver.id } });
    for (const m of mappings) {
      const res = await reviewer.post(`/api/v1/admin/catalogue/mappings/${m.id}/review`, { decision: 'APPROVED', note: 'Reviewed by clinician (synthetic)' });
      expect(res.status).toBe(200);
    }
    const proposer = await actor(['SUPER_ADMIN']);
    const proposal = await proposer.post('/api/v1/admin/catalogue/mappings', {
      conditionId: liver.id,
      specialityCode: 'GENERAL_MEDICINE',
      relevance: 'SECONDARY',
      rationale: 'General physicians often see liver complaints first',
    });
    expect(proposal.status).toBe(201);
    const selfReview = await proposer.post(`/api/v1/admin/catalogue/mappings/${proposal.body.data.id}/review`, { decision: 'APPROVED', note: 'self approve' });
    expect(selfReview.status).toBe(403);
  });

  it('liver disease finds gastro doctors and gastro hospitals — not an eye hospital', async () => {
    const ctx = await affiliatedDoctor({ specialities: ['GASTROENTEROLOGY'], departments: ['DEPT_GASTRO'] });
    const eye = await createHospital(ctx.registrar, { name: 'Tamluk Eye Hospital', departments: ['DEPT_EYE'] });
    await approveProvider(eye.id, ctx.registrar, ctx.verifier);

    const res = await api().get(`/api/v1/discovery/search?q=fatty%20liver&lat=${TAMLUK.lat}&lng=${TAMLUK.lng}&radiusKm=25`);
    expect(res.status).toBe(200);
    const body = res.body.data;
    expect(body.matchedConditions.map((c: { name: string }) => c.name)).toContain('Liver disease');
    expect(body.doctors.map((d: { providerId: string }) => d.providerId)).toContain(ctx.doctor.id);
    const facilityIds = body.facilities.map((f: { providerId: string }) => f.providerId);
    expect(facilityIds).toContain(ctx.hospital.id);
    expect(facilityIds).not.toContain(eye.id);
    expect(body.disclaimer).toMatch(/not a diagnosis/);
  });

  it('filters by distance: a Delhi-located provider is not shown in Tamluk', async () => {
    const ctx = await affiliatedDoctor({ specialities: ['GASTROENTEROLOGY'], departments: ['DEPT_GASTRO'] });
    const far = await createHospital(ctx.registrar, { name: 'Far Away Gastro Centre', at: { lat: 28.61, lng: 77.21 }, departments: ['DEPT_GASTRO'] });
    await approveProvider(far.id, ctx.registrar, ctx.verifier);
    const res = await api().get(`/api/v1/discovery/search?q=liver%20disease&lat=${TAMLUK.lat}&lng=${TAMLUK.lng}&radiusKm=30`);
    const ids = res.body.data.facilities.map((f: { providerId: string }) => f.providerId);
    expect(ids).not.toContain(far.id);
    for (const f of res.body.data.facilities) expect(f.distanceKm).toBeLessThanOrEqual(30);
  });

  it('suspended or unapproved providers disappear from results', async () => {
    const ctx = await affiliatedDoctor({ specialities: ['GASTROENTEROLOGY'], departments: ['DEPT_GASTRO'] });
    await ctx.registrar.post(`/api/v1/admin/providers/${ctx.hospital.id}/status`, { action: 'SUSPEND', reason: 'Inspection pending' });
    const res = await api().get(`/api/v1/discovery/search?q=liver%20disease&lat=${TAMLUK.lat}&lng=${TAMLUK.lng}`);
    expect(res.body.data.facilities.map((f: { providerId: string }) => f.providerId)).not.toContain(ctx.hospital.id);
  });

  it('red-flag symptoms return emergency guidance first', async () => {
    const res = await api().get('/api/v1/discovery/search?q=chest%20pain');
    expect(res.status).toBe(200);
    expect(res.body.data.emergency.number).toBe('112');
  });
});
