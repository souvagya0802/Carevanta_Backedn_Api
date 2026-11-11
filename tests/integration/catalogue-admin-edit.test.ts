import { beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase } from '../helpers/db.js';
import { actor, type Actor } from '../helpers/factory.js';
import { createHospital, staff } from '../helpers/fixtures.js';
import { prisma } from '../../src/lib/prisma.js';
import { seedReferenceData } from '../../src/seed/reference-data.js';

// Works on rows this file creates, never on seeded ones, because other test files share the reference data.
const tag = Date.now().toString(36).toUpperCase();
let admin: Actor;
let registrar: Actor;

beforeAll(async () => {
  await resetDatabase();
  admin = await actor();
  ({ registrar } = await staff());
});

describe('super admin edits departments, amenities and regions', () => {
  it('edits and deactivates a department; a facility keeps it but cannot newly add it', async () => {
    const created = await admin.post('/api/v1/admin/catalogue/departments', { code: `DEPT_QA_${tag}`, name: `QA Department ${tag}` });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;

    const renamed = await admin.patch(`/api/v1/admin/catalogue/departments/${id}`, { name: `QA Renamed Department ${tag}`, specialityCode: 'PAEDIATRICS' });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body.data).toMatchObject({ code: `DEPT_QA_${tag}`, name: `QA Renamed Department ${tag}`, specialityCode: 'PAEDIATRICS', isActive: true });

    const cleared = await admin.patch(`/api/v1/admin/catalogue/departments/${id}`, { specialityCode: null });
    expect(cleared.body.data.specialityCode).toBeNull();

    const h = await createHospital(registrar);
    expect((await registrar.put(`/api/v1/admin/providers/${h.id}/departments`, { departmentCodes: [`DEPT_QA_${tag}`] })).status).toBe(200);

    expect((await admin.patch(`/api/v1/admin/catalogue/departments/${id}`, { isActive: false })).body.data.isActive).toBe(false);
    // Already listed: re-saving keeps it.
    expect((await registrar.put(`/api/v1/admin/providers/${h.id}/departments`, { departmentCodes: [`DEPT_QA_${tag}`] })).status).toBe(200);
    // Newly adding it elsewhere is refused.
    const other = await createHospital(registrar);
    const refused = await registrar.put(`/api/v1/admin/providers/${other.id}/departments`, { departmentCodes: [`DEPT_QA_${tag}`] });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain('no longer offered');
  });

  it('rejects empty, unknown-field and unknown-speciality edits, a duplicate name, and a missing department', async () => {
    const a = (await admin.post('/api/v1/admin/catalogue/departments', { code: `DEPT_QA_A_${tag}`, name: `QA Dept A ${tag}` })).body.data.id as string;
    await admin.post('/api/v1/admin/catalogue/departments', { code: `DEPT_QA_B_${tag}`, name: `QA Dept B ${tag}` });
    expect((await admin.patch(`/api/v1/admin/catalogue/departments/${a}`, {})).status).toBe(400);
    expect((await admin.patch(`/api/v1/admin/catalogue/departments/${a}`, { code: 'NEW_CODE' })).status).toBe(400);
    expect((await admin.patch(`/api/v1/admin/catalogue/departments/${a}`, { specialityCode: 'NOT_A_SPECIALITY' })).status).toBe(400);
    expect((await admin.patch(`/api/v1/admin/catalogue/departments/${a}`, { name: `QA Dept B ${tag}` })).status).toBe(409);
    expect((await admin.patch('/api/v1/admin/catalogue/departments/01a1a1a1-0000-7000-8000-000000000000', { name: 'QA Missing' })).status).toBe(404);
  });

  it('edits and deactivates an amenity; it leaves the provider picker and cannot be newly added', async () => {
    const created = await admin.post('/api/v1/admin/catalogue/amenities', { code: `AMEN_QA_${tag}`, name: `QA Amenity ${tag}`, category: 'CLINICAL' });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;

    const edited = await admin.patch(`/api/v1/admin/catalogue/amenities/${id}`, { name: `QA Lift Access ${tag}`, category: 'ACCESSIBILITY' });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({ name: `QA Lift Access ${tag}`, category: 'ACCESSIBILITY', isActive: true });

    const h = await createHospital(registrar);
    expect((await registrar.put(`/api/v1/admin/providers/${h.id}/amenities`, { amenityCodes: [`AMEN_QA_${tag}`] })).status).toBe(200);

    expect((await admin.patch(`/api/v1/admin/catalogue/amenities/${id}`, { isActive: false })).body.data.isActive).toBe(false);
    const list = await admin.get('/api/v1/admin/catalogue/amenities');
    expect(list.body.data.find((x: { code: string }) => x.code === `AMEN_QA_${tag}`)).toMatchObject({ isActive: false });
    expect((await prisma.amenity.findMany({ where: { isActive: true } })).some((x) => x.code === `AMEN_QA_${tag}`)).toBe(false);

    expect((await registrar.put(`/api/v1/admin/providers/${h.id}/amenities`, { amenityCodes: [`AMEN_QA_${tag}`] })).status).toBe(200);
    const other = await createHospital(registrar);
    expect((await registrar.put(`/api/v1/admin/providers/${other.id}/amenities`, { amenityCodes: [`AMEN_QA_${tag}`] })).status).toBe(400);
  });

  it('edits a region name, district and state but never its code', async () => {
    const created = await admin.post('/api/v1/admin/regions', { code: `QA-${tag}`, name: 'QA Town', district: 'QA District', state: 'QA State' });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    const edited = await admin.patch(`/api/v1/admin/regions/${id}`, { name: 'QA Town Renamed', district: 'QA District Two', state: 'QA State Two' });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.data).toMatchObject({ code: `QA-${tag}`, name: 'QA Town Renamed', district: 'QA District Two', state: 'QA State Two' });
    expect((await admin.patch(`/api/v1/admin/regions/${id}`, { code: 'QA-OTHER' })).status).toBe(400);
    expect((await admin.patch(`/api/v1/admin/regions/${id}`, {})).status).toBe(400);
    const limited = await actor(['VERIFICATION_OFFICER']);
    expect((await limited.patch(`/api/v1/admin/regions/${id}`, { name: 'QA Nope' })).status).toBe(403);
  });

  it('the reference seed creates no regions and never overwrites admin edits', async () => {
    const regionsBefore = await prisma.serviceRegion.count();
    const dept = await prisma.department.findFirstOrThrow({ where: { code: 'DEPT_PAEDIATRICS' } });
    const amenity = await prisma.amenity.findFirstOrThrow({ where: { code: 'ICU' } });
    // Edit seeded rows directly and restore them afterwards, so other test files see the original names.
    await prisma.department.update({ where: { id: dept.id }, data: { name: `QA Paeds ${tag}` } });
    await prisma.amenity.update({ where: { id: amenity.id }, data: { name: `QA ICU ${tag}` } });
    try {
      await seedReferenceData(prisma);
      expect((await prisma.department.findUniqueOrThrow({ where: { id: dept.id } })).name).toBe(`QA Paeds ${tag}`);
      expect((await prisma.amenity.findUniqueOrThrow({ where: { id: amenity.id } })).name).toBe(`QA ICU ${tag}`);
      expect(await prisma.serviceRegion.count()).toBe(regionsBefore);
    } finally {
      await prisma.department.update({ where: { id: dept.id }, data: { name: dept.name } });
      await prisma.amenity.update({ where: { id: amenity.id }, data: { name: amenity.name } });
    }
  });
});
