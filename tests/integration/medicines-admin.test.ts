/**
 * Super-admin medicine tools: list filters, overview counts, patient information (ADMIN source, audit,
 * restore government text), bulk visibility / prescription, guarded merge, stock, substitutes, history,
 * duplicate check, and the catalogue.manage permission.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { resetDatabase } from '../helpers/db.js';
import { actor, type Actor } from '../helpers/factory.js';
import { approveProvider, staff, TAMLUK } from '../helpers/fixtures.js';

const V = '/api/v1';
const M = `${V}/admin/catalogue/medicines`;

let sa: Actor;
const ids: Record<string, string> = {};
let pharmacyId = '';
let locationId = '';

async function med(key: string, data: Parameters<typeof prisma.medicine.create>[0]['data']) {
  const m = await prisma.medicine.create({ data });
  ids[key] = m.id;
  return m;
}

beforeAll(async () => {
  await resetDatabase();
  sa = await actor(['SUPER_ADMIN'], { fullName: 'Synthetic Admin' });
  const { registrar, verifier } = await staff();
  const create = await registrar.post(`${V}/admin/providers`, {
    type: 'PHARMACY', legalName: 'Madm Medicos', displayName: 'Madm Medicos', contactPhone: '9800071001',
    owner: { fullName: 'Madm Owner', email: 'madm.owner@test.carevanta.local' },
    pharmacy: { retailDrugLicenseNo: 'WB/RET/2026/MA1', pharmacistName: 'R. Das', pharmacistRegistrationNo: 'WBPC-MA1', homeDeliveryAvailable: false },
    location: { name: 'Store', addressLine1: 'Bazar Road', city: 'Tamluk', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721636', latitude: TAMLUK.lat, longitude: TAMLUK.lng },
  });
  expect(create.status, JSON.stringify(create.body)).toBe(201);
  pharmacyId = create.body.data.id;
  locationId = create.body.data.locations[0].id;
  await approveProvider(pharmacyId, registrar, verifier);

  const key = 'paracetamol|650mg|tablet';
  await med('dolo', { name: 'Dolo 650', composition: 'Paracetamol', strength: '650 mg', dosageForm: 'Oral Tablet', manufacturer: 'Micro Labs', source: 'CDCI', code: '9100001', genericCode: 'G1', compositionKey: key, schedule: 'SCHEDULE_H1', requiresPrescription: true, uses: 'Fever and mild pain', infoSource: 'CDCI', searchName: 'dolo 650 paracetamol' });
  await med('calpol', { name: 'Calpol 650', composition: 'Paracetamol', strength: '650 mg', dosageForm: 'Oral Tablet', manufacturer: 'Synthetic Pharma', source: 'CDCI', code: '9100002', genericCode: 'G1', compositionKey: key, schedule: 'SCHEDULE_H1', requiresPrescription: true, uses: 'Fever and mild pain', howItWorks: 'Blocks pain signals', infoSource: 'CDCI', searchName: 'calpol 650 paracetamol' });
  await med('pharmacyAdded', { name: 'Moynazin', composition: 'Cetirizine', strength: '10 mg', dosageForm: 'Oral Tablet', source: 'PROVIDER', proposedByProviderId: pharmacyId, schedule: 'OTC', requiresPrescription: false, searchName: 'moynazin cetirizine' });
  await med('hiddenOld', { name: 'Oldcin', strength: '5 mg', source: 'MANUAL', isActive: false, createdAt: new Date(Date.now() - 90 * 86_400_000), searchName: 'oldcin' });
  await med('narcotic', { name: 'Synthmorph', strength: '10 mg', source: 'MANUAL', schedule: 'SCHEDULE_X', requiresPrescription: true, searchName: 'synthmorph' });
  await med('dupOfDolo', { name: 'Dolo 650', composition: 'Paracetamol', strength: '650mg', dosageForm: 'Tablet', manufacturer: 'Micro Labs', source: 'MANUAL', searchName: 'dolo 650 paracetamol' });

  const exp = (days: number) => new Date(Date.now() + days * 86_400_000);
  await prisma.pharmacyInventory.createMany({
    data: [
      { providerId: pharmacyId, locationId, medicineId: ids.dolo!, batchNumber: 'B1', expiryDate: exp(200), quantityOnHand: 30, quantityReserved: 2, mrpMinor: 3500n, sellingPriceMinor: 3200n },
      { providerId: pharmacyId, locationId, medicineId: ids.dolo!, batchNumber: 'B2', expiryDate: exp(60), quantityOnHand: 10, mrpMinor: 3500n, sellingPriceMinor: 3000n },
      { providerId: pharmacyId, locationId, medicineId: ids.dolo!, batchNumber: 'OLD', expiryDate: exp(-5), quantityOnHand: 4, mrpMinor: 3500n, sellingPriceMinor: 2900n },
      { providerId: pharmacyId, locationId, medicineId: ids.calpol!, batchNumber: 'X0', expiryDate: exp(-1), quantityOnHand: 9, mrpMinor: 3000n, sellingPriceMinor: 2800n },
    ],
  });
});

const names = async (params: string) => {
  const res = await sa.get(`${M}?limit=100&${params}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body.data as { name: string; manufacturer: string | null }[]).map((m) => `${m.name}${m.manufacturer ? ` (${m.manufacturer})` : ''}`).sort();
};

describe('admin medicine list and overview', () => {
  it('filters by prescription, visibility, information, stock, source, date and salt search, and counts pharmacies per row', async () => {
    expect(await names('inStock=yes')).toEqual(['Dolo 650 (Micro Labs)']); // Calpol's only batch is expired
    expect(await names('inStock=no')).toHaveLength(5);
    expect(await names('visibility=hidden')).toEqual(['Oldcin']);
    expect(await names('prescription=not_required')).toEqual(['Dolo 650 (Micro Labs)', 'Moynazin', 'Oldcin'].sort()); // manual rows default to OTC
    expect(await names('hasInfo=yes')).toEqual(['Calpol 650 (Synthetic Pharma)', 'Dolo 650 (Micro Labs)']);
    expect(await names('hasInfo=no')).toHaveLength(4);
    expect(await names('source=PROVIDER&addedSince=' + new Date(Date.now() - 30 * 86_400_000).toISOString())).toEqual(['Moynazin']);
    expect(await names('q=cetiri')).toEqual(['Moynazin']); // salt search
    expect(await names('q=dolo&source=CDCI')).toEqual(['Dolo 650 (Micro Labs)']);
    expect((await sa.get(`${M}?inStock=maybe`)).status).toBe(400);

    const rows = (await sa.get(`${M}?q=650&limit=100`)).body.data as { id: string; stockedAt: number; createdAt: string; schedule: string }[];
    expect(rows.find((r) => r.id === ids.dolo)?.stockedAt).toBe(1);
    expect(rows.find((r) => r.id === ids.calpol)?.stockedAt).toBe(0);
    expect(typeof rows[0]!.createdAt).toBe('string'); // existing shape kept
  });

  it('returns overview counts in plain categories', async () => {
    const res = await sa.get(`${M}/overview`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ total: 6, stocked: 1, addedByPharmaciesLast30Days: 1, missingInfo: 4, prescriptionRequired: 3, hidden: 1 });
  });

  it('finds likely duplicates before adding', async () => {
    const res = await sa.get(`${M}/duplicates?name=${encodeURIComponent('dolo 650')}&strength=650%20mg&dosageForm=Oral%20Tablet`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data[0]).toMatchObject({ id: ids.dolo, exact: true });
    expect((res.body.data as { id: string }[]).map((d) => d.id)).toContain(ids.dupOfDolo);
    expect((await sa.get(`${M}/duplicates?name=${encodeURIComponent('Zzz Unknown')}`)).body.data).toEqual([]);
  });
});

describe('patient information', () => {
  it('saves admin text as ADMIN with editor and time, audits it, and restores the government text', async () => {
    const put = await sa.put(`${M}/${ids.dolo}/info`, { uses: 'Fever, headache and body ache', storage: 'Below 25 °C', sideEffects: '', reason: 'Plainer words' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.data).toMatchObject({ uses: 'Fever, headache and body ache', storage: 'Below 25 °C', sideEffects: null, infoSource: 'ADMIN' });
    const row = await prisma.medicine.findUniqueOrThrow({ where: { id: ids.dolo! } });
    expect(row.infoUpdatedById).toBe(sa.user.id);
    expect(row.infoUpdatedAt).toBeInstanceOf(Date);
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'catalogue.medicine_info_updated', entityId: ids.dolo! } });
    expect(ev.metadata).toMatchObject({ fields: ['uses', 'sideEffects', 'storage'], previousSource: 'CDCI' });

    const detail = await sa.get(`${M}/${ids.dolo}/detail`);
    expect(detail.body.data).toMatchObject({ infoUpdatedByName: 'Synthetic Admin', hasGovernmentSource: true, stockedAt: 1, usage: { inventoryRows: 3, orderItems: 0 } });

    expect((await sa.put(`${M}/${ids.dolo}/info`, {})).status).toBe(400);

    // Calpol (same CDCI generic) still has the government text, so it comes back at once.
    const restore = await sa.post(`${M}/${ids.dolo}/info/restore`, {});
    expect(restore.status, JSON.stringify(restore.body)).toBe(200);
    expect(restore.body.data.restored).toBe('now');
    expect(restore.body.data.medicine).toMatchObject({ uses: 'Fever and mild pain', howItWorks: 'Blocks pain signals', storage: null, infoSource: 'CDCI' });
    expect((await prisma.medicine.findUniqueOrThrow({ where: { id: ids.dolo! } })).infoUpdatedById).toBeNull();

    // Without a donor the fields are cleared for the next list update; non-government rows have nothing to restore.
    await prisma.medicine.update({ where: { id: ids.calpol! }, data: { infoSource: 'ADMIN' } });
    await prisma.medicine.update({ where: { id: ids.dolo! }, data: { infoSource: 'ADMIN' } });
    const later = await sa.post(`${M}/${ids.calpol}/info/restore`, {});
    expect(later.body.data).toMatchObject({ restored: 'next_update', medicine: { uses: null, infoSource: 'CDCI' } });
    expect((await sa.post(`${M}/${ids.pharmacyAdded}/info/restore`, {})).status).toBe(409);
  });

  it('recomputes the substitutes key when salt, strength or form change, and lists substitutes', async () => {
    const add = await sa.post(M, { name: 'Pacimol 650', composition: 'Paracetamol', strength: '650 mg', dosageForm: 'Oral Tablet', manufacturer: 'Synth Labs' });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    const subs = await sa.get(`${M}/${add.body.data.id}/substitutes`);
    expect(subs.status).toBe(200);
    expect((subs.body.data.items as { id: string; stockedAt: number }[]).map((s) => s.id)).toEqual(expect.arrayContaining([ids.dolo, ids.calpol]));
    expect(subs.body.data.items[0]).toMatchObject({ id: ids.dolo, stockedAt: 1 });

    const edit = await sa.patch(`${M}/${add.body.data.id}`, { strength: '500 mg', reason: 'Wrong strength' });
    expect(edit.status).toBe(200);
    expect(edit.body.data.compositionKey).toBe('paracetamol|500mg|tablet');
    expect((await sa.get(`${M}/${add.body.data.id}/substitutes`)).body.data.items).toEqual([]);
  });
});

describe('bulk actions, merge, stock and history', () => {
  it('hides, shows and changes the prescription rule in bulk (max 200), never relaxing Schedule X', async () => {
    const hide = await sa.post(`${M}/bulk`, { ids: [ids.pharmacyAdded, ids.narcotic], action: 'hide', reason: 'Review' });
    expect(hide.status, JSON.stringify(hide.body)).toBe(200);
    expect(hide.body.data).toEqual({ updated: 2, skipped: [] });
    expect(await prisma.medicine.count({ where: { id: { in: [ids.pharmacyAdded!, ids.narcotic!] }, isActive: false } })).toBe(2);
    await sa.post(`${M}/bulk`, { ids: [ids.pharmacyAdded, ids.narcotic], action: 'show', reason: 'Reviewed' });

    const relax = await sa.post(`${M}/bulk`, { ids: [ids.calpol, ids.narcotic], action: 'no_prescription', reason: 'OTC analgesic' });
    expect(relax.body.data.updated).toBe(1);
    expect(relax.body.data.skipped).toEqual([{ id: ids.narcotic, reason: expect.stringContaining('Schedule X') }]);
    expect(await prisma.medicine.findUniqueOrThrow({ where: { id: ids.calpol! } })).toMatchObject({ requiresPrescription: false, schedule: 'OTC' });

    const rx = await sa.post(`${M}/bulk`, { ids: [ids.pharmacyAdded], action: 'require_prescription', reason: 'Antihistamine' });
    expect(rx.body.data.updated).toBe(1);
    expect(await prisma.auditEvent.count({ where: { action: 'catalogue.medicine_bulk_updated' } })).toBe(6);

    const many = Array.from({ length: 201 }, () => crypto.randomUUID());
    expect((await sa.post(`${M}/bulk`, { ids: many, action: 'hide', reason: 'Too many' })).status).toBe(400);
    expect((await sa.post(`${M}/bulk`, { ids: [ids.calpol], action: 'hide' })).status).toBe(400); // reason required
  });

  it('merges only a duplicate nobody stocks or ordered, and records it on both medicines', async () => {
    const refused = await sa.post(`${M}/${ids.dolo}/merge`, { keepId: ids.dupOfDolo, reason: 'Duplicate' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.details).toMatchObject({ inventoryRows: 3, orderItems: 0 });
    expect((await sa.post(`${M}/${ids.dolo}/merge`, { keepId: ids.dolo, reason: 'Duplicate' })).status).toBe(400);
    expect((await sa.post(`${M}/${ids.dupOfDolo}/merge`, { keepId: ids.hiddenOld, reason: 'Duplicate' })).status).toBe(409); // keep target hidden

    const ok = await sa.post(`${M}/${ids.dupOfDolo}/merge`, { keepId: ids.dolo, reason: 'Same as Dolo 650' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.isActive).toBe(false);
    const hist = await sa.get(`${M}/${ids.dolo}/history`);
    expect(hist.status).toBe(200);
    expect(hist.body.data[0]).toMatchObject({ action: 'catalogue.medicine_merge_kept', actorName: 'Synthetic Admin', metadata: { mergedMedicineId: ids.dupOfDolo } });
    expect((hist.body.data as { action: string }[]).map((h) => h.action)).toEqual(expect.arrayContaining(['catalogue.medicine_info_updated', 'catalogue.medicine_info_restored']));
  });

  it('shows where a medicine is stocked: quantity, batches, nearest expiry, price range', async () => {
    const res = await sa.get(`${M}/${ids.dolo}/stock`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ providerId: pharmacyId, providerName: 'Madm Medicos', locationId, quantity: 40, reserved: 2, batches: 3, expiredBatches: 1, minPriceMinor: 2900, maxPriceMinor: 3200, maxMrpMinor: 3500 });
    expect(new Date(res.body.data[0].nearestExpiry).getTime()).toBeLessThan(Date.now() + 61 * 86_400_000);
  });
});

describe('permissions', () => {
  it('lets catalogue readers look but not change anything', async () => {
    const reviewer = await actor(['CLINICAL_REVIEWER']);
    expect((await reviewer.get(`${M}/overview`)).status).toBe(200);
    expect((await reviewer.get(`${M}/${ids.dolo}/stock`)).status).toBe(200);
    expect((await reviewer.put(`${M}/${ids.dolo}/info`, { uses: 'x' })).status).toBe(403);
    expect((await reviewer.post(`${M}/${ids.dolo}/info/restore`, {})).status).toBe(403);
    expect((await reviewer.post(`${M}/bulk`, { ids: [ids.dolo], action: 'hide', reason: 'nope' })).status).toBe(403);
    expect((await reviewer.post(`${M}/${ids.calpol}/merge`, { keepId: ids.dolo, reason: 'nope' })).status).toBe(403);
    const patient = await actor([]);
    expect((await patient.get(`${M}/overview`)).status).toBe(403);
  });
});
