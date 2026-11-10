/**
 * CDCI medicine catalogue: import (idempotent, keeps admin edits), portal prefix search, and pharmacies
 * adding a missing medicine (usable at once, no approval step; duplicates refused; audited).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { prisma } from '../../src/lib/prisma.js';
import { importCdci } from '../../src/modules/catalogue/cdci-import.js';
import { resetDatabase } from '../helpers/db.js';
import { actor } from '../helpers/factory.js';
import { actorForUser, approveProvider, staff, TAMLUK } from '../helpers/fixtures.js';

const V = '/api/v1';
const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'cdci');

async function pharmacy(n: number) {
  const { registrar, verifier } = await staff();
  const create = await registrar.post(`${V}/admin/providers`, {
    type: 'PHARMACY', legalName: `Cdci Medicos ${n}`, displayName: `Cdci Medicos ${n}`, contactPhone: `980006000${n}`,
    owner: { fullName: `Cdci Owner ${n}`, email: `cdci.owner${n}@test.carevanta.local` },
    pharmacy: { retailDrugLicenseNo: `WB/RET/2026/C${n}`, pharmacistName: 'R. Das', pharmacistRegistrationNo: `WBPC-C${n}`, homeDeliveryAvailable: false },
    location: { name: 'Store', addressLine1: 'Bazar Road', city: 'Tamluk', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721636', latitude: TAMLUK.lat, longitude: TAMLUK.lng },
  });
  expect(create.status, JSON.stringify(create.body)).toBe(201);
  const id = create.body.data.id as string;
  await approveProvider(id, registrar, verifier);
  return { id, locationId: create.body.data.locations[0].id as string, owner: await actorForUser(create.body.data.members[0].userId) };
}

beforeAll(resetDatabase);

describe('CDCI import', () => {
  it('imports the fixture, skips withdrawn brands, and re-imports idempotently without touching admin edits', async () => {
    const first = await importCdci(FIXTURE);
    expect(first).toMatchObject({ read: 6, inserted: 5, updated: 0, unchanged: 0, skipped: 1 });
    const dolo = await prisma.medicine.findFirstOrThrow({ where: { code: '9000001' } });
    expect(dolo).toMatchObject({ name: 'Dolo 650', composition: 'Paracetamol', strength: '650 mg', dosageForm: 'Oral Tablet', manufacturer: 'Micro Labs Limited', genericName: 'Paracetamol 650 mg oral tablet', route: 'Oral', source: 'CDCI', requiresPrescription: true, schedule: 'SCHEDULE_H1', searchName: 'dolo 650 paracetamol', isActive: true, packSize: null });
    expect(await prisma.medicine.count({ where: { code: '9000005' } })).toBe(0);

    // An admin relaxes Dolo to OTC through the edit endpoint.
    const sa = await actor(['SUPER_ADMIN']);
    const edit = await sa.patch(`${V}/admin/catalogue/medicines/${dolo.id}`, { schedule: 'OTC', requiresPrescription: false, reason: 'OTC analgesic' });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);

    const again = await importCdci(FIXTURE);
    expect(again).toMatchObject({ read: 6, inserted: 0, updated: 0, unchanged: 5, skipped: 1 });
    const after = await prisma.medicine.findUniqueOrThrow({ where: { id: dolo.id } });
    expect(after).toMatchObject({ schedule: 'OTC', requiresPrescription: false });
    expect(await prisma.medicine.count({ where: { source: 'CDCI' } })).toBe(5);
  });
});

describe('portal medicine search and pharmacy-added medicines', () => {
  it('searches by case-insensitive prefix on name then composition, at most 20, min 2 characters', async () => {
    const { id, owner } = await pharmacy(1);
    void id;
    const names = async (q: string, extra = '') => {
      const res = await owner.get(`${V}/portal/catalogue/medicines?q=${encodeURIComponent(q)}${extra}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return (res.body.data as { name: string }[]).map((m) => m.name);
    };
    expect(await names('PARAC')).toEqual(['Paracip']);
    expect(await names('dolo')).toEqual(['Dolo 650']);
    expect(await names('olo')).toEqual([]); // prefix, not substring
    expect(await names('dolo 650 parac')).toEqual(['Dolo 650']); // composition follows the name
    const first = (await owner.get(`${V}/portal/catalogue/medicines?q=dolo`)).body.data[0];
    expect(first).toMatchObject({ name: 'Dolo 650', composition: 'Paracetamol', strength: '650 mg', dosageForm: 'Oral Tablet', manufacturer: 'Micro Labs Limited', source: 'CDCI' });
    expect(typeof first.requiresPrescription).toBe('boolean');
    expect((await owner.get(`${V}/portal/catalogue/medicines?q=d`)).status).toBe(400);
    expect((await owner.get(`${V}/portal/catalogue/medicines?q=do&limit=50`)).status).toBe(400);

    await prisma.medicine.createMany({ data: Array.from({ length: 25 }, (_, i) => ({ name: `Zinco ${i}`, strength: `${i} mg`, searchName: `zinco ${i}` })) });
    expect(await names('zinco')).toHaveLength(20);
    expect(await names('zinco', '&limit=5')).toHaveLength(5);
  });

  it('lets a pharmacy add a missing medicine that is usable at once by everyone, refusing duplicates', async () => {
    const a = await pharmacy(2);
    const b = await pharmacy(3);
    const body = { name: 'Moynacol', composition: 'paracetamol and caffeine', strength: '500 mg + 30 mg', dosageForm: 'oral tablet', manufacturer: 'Synthetic Pharma', requiresPrescription: false };
    const add = await a.owner.post(`${V}/portal/providers/${a.id}/medicines`, body);
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect(add.body.data).toMatchObject({ name: 'Moynacol', composition: 'Paracetamol and Caffeine', dosageForm: 'Oral Tablet', source: 'PROVIDER', requiresPrescription: false });
    const medicineId = add.body.data.id as string;
    const row = await prisma.medicine.findUniqueOrThrow({ where: { id: medicineId } });
    expect(row).toMatchObject({ proposedByProviderId: a.id, searchName: 'moynacol paracetamol and caffeine', schedule: 'OTC' });
    expect(await prisma.auditEvent.count({ where: { action: 'catalogue.medicine_added_by_provider', entityId: medicineId } })).toBe(1);

    // Same name, strength and form (different case and spacing) is refused; a different strength is fine.
    const dup = await b.owner.post(`${V}/portal/providers/${b.id}/medicines`, { ...body, name: 'MOYNACOL ', strength: '500mg + 30mg', dosageForm: 'Oral  Tablet' });
    expect(dup.status).toBe(409);
    expect((await a.owner.post(`${V}/portal/providers/${a.id}/medicines`, { ...body, strength: '650 mg + 30 mg' })).status).toBe(201);
    // Validation and access.
    expect((await a.owner.post(`${V}/portal/providers/${a.id}/medicines`, { name: 'X' })).status).toBe(400);
    expect((await a.owner.post(`${V}/portal/providers/${b.id}/medicines`, { ...body, name: 'Other' })).status).toBe(403);

    // Both pharmacies can find and stock it; patients see it too.
    expect((await b.owner.get(`${V}/portal/catalogue/medicines?q=moyna`)).body.data.map((m: { id: string }) => m.id)).toContain(medicineId);
    const stock = await b.owner.put(`${V}/portal/providers/${b.id}/inventory`, { locationId: b.locationId, medicineId, batchNumber: 'MC1', expiryDate: '2030-01-01', quantityOnHand: 50, mrpMinor: 3000, sellingPriceMinor: 2800 });
    expect(stock.status, JSON.stringify(stock.body)).toBe(200);
    const pub = await (await actor([])).get(`${V}/public/catalogue/medicines?q=moynacol`);
    expect(pub.status).toBe(200);
    expect(pub.body.data.find((m: { id: string }) => m.id === medicineId)).toMatchObject({ pharmacies: 1 });

    // Admins can list pharmacy-added medicines and edit them.
    const sa = await actor(['SUPER_ADMIN']);
    const list = await sa.get(`${V}/admin/catalogue/medicines?source=PROVIDER`);
    expect(list.status).toBe(200);
    expect(list.body.data.every((m: { source: string }) => m.source === 'PROVIDER')).toBe(true);
    expect(list.body.data).toHaveLength(2);
    const fix = await sa.patch(`${V}/admin/catalogue/medicines/${medicineId}`, { schedule: 'SCHEDULE_H', reason: 'Checked label' });
    expect(fix.body.data).toMatchObject({ schedule: 'SCHEDULE_H', requiresPrescription: true });
  });
});
