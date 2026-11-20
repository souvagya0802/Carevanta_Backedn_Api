/**
 * Patient medicine flow: search counts near a point and in total, the shop list falling back to the nearest pharmacies
 * beyond the radius, the medicine detail (information, substitutes ranking, other strengths), CDCI information import
 * that never overwrites admin text, and the information backfill.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { prisma } from '../../src/lib/prisma.js';
import { invalidateSetting } from '../../src/modules/settings/settings.service.js';
import { backfillMedicineInfo, importCdci } from '../../src/modules/catalogue/cdci-import.js';
import { resetDatabase } from '../helpers/db.js';
import { api } from '../helpers/factory.js';
import { actorForUser, approveProvider, randomUUID, staff, TAMLUK } from '../helpers/fixtures.js';

const V = '/api/v1';
const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'cdci-info');
/** Synthetic far points (about 50 km from Tamluk). */
const FAR_SHOP = { lat: 22.57, lng: 88.36 };
const FAR_PATIENT = { lat: 22.0, lng: 87.5 };

async function pharmacy(n: number, at: { lat: number; lng: number }, name: string) {
  const { registrar, verifier } = await staff();
  const create = await registrar.post(`${V}/admin/providers`, {
    type: 'PHARMACY', legalName: name, displayName: name, contactPhone: `980007000${n}`,
    owner: { fullName: `Detail Owner ${n}`, email: `detail.owner${n}@test.carevanta.local` },
    pharmacy: { retailDrugLicenseNo: `WB/RET/2026/D${n}`, pharmacistName: 'R. Das', pharmacistRegistrationNo: `WBPC-D${n}`, homeDeliveryAvailable: false },
    location: { name: 'Store', addressLine1: 'Bazar Road', city: 'Synthetic Town', district: 'Synthetic District', state: 'West Bengal', pincode: '721636', latitude: at.lat, longitude: at.lng },
  });
  expect(create.status, JSON.stringify(create.body)).toBe(201);
  const id = create.body.data.id as string;
  await approveProvider(id, registrar, verifier);
  const owner = await actorForUser(create.body.data.members[0].userId);
  const locationId = create.body.data.locations[0].id as string;
  return {
    id,
    stock: async (medicineId: string, priceMinor: number) => {
      const res = await owner.put(`${V}/portal/providers/${id}/inventory`, { locationId, medicineId, batchNumber: `B${n}${priceMinor}`, expiryDate: '2030-01-01', quantityOnHand: 40, mrpMinor: priceMinor + 500, sellingPriceMinor: priceMinor });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    },
  };
}

const ids: Record<string, string> = {};
const geo = (p: { lat: number; lng: number }) => `&lat=${p.lat}&lng=${p.lng}`;

beforeAll(async () => {
  await resetDatabase();
  // The radius assertions assume the seed default; an earlier file may have changed the shared setting.
  await prisma.platformSetting.update({ where: { key: 'search.default_radius_km' }, data: { value: 15 } });
  invalidateSetting();
  const first = await importCdci(FIXTURE);
  expect(first).toMatchObject({ read: 7, inserted: 7, skipped: 0, infoUpdated: 7 });
  for (const m of await prisma.medicine.findMany({ select: { id: true, name: true } })) ids[m.name] = m.id;
  await prisma.medicine.update({ where: { id: ids['Oldpara 650']! }, data: { isActive: false } });
  const near = await pharmacy(1, TAMLUK, 'Detail Near Pharmacy');
  const far = await pharmacy(2, FAR_SHOP, 'Detail Far Pharmacy');
  await near.stock(ids['Dolo 650']!, 3000);
  await near.stock(ids['Calpol 650']!, 2500);
  await far.stock(ids['Pacimol 650']!, 2000);
});

describe('CDCI information import', () => {
  it('fills information and substitute keys, and a re-run changes nothing', async () => {
    const dolo = await prisma.medicine.findUniqueOrThrow({ where: { id: ids['Dolo 650']! } });
    expect(dolo).toMatchObject({ compositionKey: 'paracetamol|650mg|tablet', therapeuticClass: 'Analgesic', uses: 'Fever and mild to moderate pain.', contraindications: 'Severe liver disease.', interactions: 'Warfarin: may raise INR with regular use.', howItWorks: 'Paracetamol lowers fever and relieves pain.', sideEffects: 'Nausea; liver damage in overdose.', infoSource: 'CDCI' });
    expect(dolo.infoUpdatedAt).toBeInstanceOf(Date);
    const calpol = await prisma.medicine.findUniqueOrThrow({ where: { id: ids['Calpol 650']! } });
    expect(calpol.compositionKey).toBe(dolo.compositionKey); // film-coated tablet is the same family
    const flucret = await prisma.medicine.findUniqueOrThrow({ where: { id: ids.Flucret! } });
    expect(flucret).toMatchObject({ compositionKey: 'caffeine+paracetamol|30mg+500mg|tablet', howItWorks: 'Caffeine:\nCaffeine is a mild stimulant.\n\nParacetamol:\nParacetamol lowers fever and relieves pain.' });
    const febrex = await prisma.medicine.findUniqueOrThrow({ where: { id: ids.Febrex! } });
    expect(febrex).toMatchObject({ uses: null, howItWorks: 'Paracetamol lowers fever and relieves pain.', infoSource: 'CDCI' });

    const again = await importCdci(FIXTURE);
    expect(again).toMatchObject({ inserted: 0, updated: 0, unchanged: 7, infoUpdated: 0 });
  });

  it('never overwrites information an admin edited (infoSource ADMIN)', async () => {
    await prisma.medicine.update({ where: { id: ids['Paracip 500']! }, data: { uses: 'Admin reviewed text.', sideEffects: null, infoSource: 'ADMIN' } });
    const r = await importCdci(FIXTURE);
    expect(r.infoUpdated).toBe(0);
    expect(await prisma.medicine.findUniqueOrThrow({ where: { id: ids['Paracip 500']! } })).toMatchObject({ uses: 'Admin reviewed text.', sideEffects: null, infoSource: 'ADMIN' });
  });
});

describe('medicine search counts', () => {
  const search = async (q: string, extra = '') => {
    const res = await api().get(`${V}/public/catalogue/medicines?q=${encodeURIComponent(q)}${extra}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.data as Record<string, unknown>[];
  };

  it('without a location: totals only, pharmacies equals the total', async () => {
    const rows = await search('650');
    const dolo = rows.find((m) => m.id === ids['Dolo 650'])!;
    expect(dolo).toMatchObject({ pharmacies: 1, pharmaciesTotal: 1, pharmaciesNearby: null, fromMinor: 3000, fromMinorNearby: null, nearest: null, composition: 'Paracetamol', substitutes: 2, imageUrl: null });
    expect(rows.map((m) => m.id)).not.toContain(ids['Oldpara 650']);
  });

  it('with a location: nearby counts use the radius; nothing nearby names the nearest pharmacy', async () => {
    const rows = await search('650', geo(TAMLUK));
    const dolo = rows.find((m) => m.id === ids['Dolo 650'])!;
    expect(dolo).toMatchObject({ pharmacies: 1, pharmaciesTotal: 1, pharmaciesNearby: 1, fromMinorNearby: 3000, radiusKm: 15 });
    const pacimol = rows.find((m) => m.id === ids['Pacimol 650'])!;
    expect(pacimol).toMatchObject({ pharmacies: 1, pharmaciesTotal: 1, pharmaciesNearby: 0, fromMinor: 2000, fromMinorNearby: null });
    expect(pacimol.nearest).toMatchObject({ pharmacyName: 'Detail Far Pharmacy' });
    expect((pacimol.nearest as { distanceKm: number }).distanceKm).toBeGreaterThan(15);
    // In stock nearby sorts first.
    expect(rows[0]!.pharmaciesNearby).toBe(1);
    // A wider radius brings the far pharmacy in.
    const wide = (await search('pacimol', `${geo(TAMLUK)}&radiusKm=200`))[0]!;
    expect(wide).toMatchObject({ pharmaciesNearby: 1, radiusKm: 200 });
  });
});

describe('shop list for a medicine', () => {
  it('lists pharmacies within the radius, else the nearest ones beyond it, flagged', async () => {
    const near = await api().get(`${V}/discovery/providers?medicineId=${ids['Dolo 650']}${geo(TAMLUK)}`);
    expect(near.status).toBe(200);
    expect(near.body.data).toMatchObject({ beyondRadius: false, radiusKm: 15 });
    expect(near.body.data.items).toHaveLength(1);
    expect(near.body.data.items[0]).toMatchObject({ name: 'Detail Near Pharmacy', beyondRadius: false, priceMinor: 3000 });

    const beyond = await api().get(`${V}/discovery/providers?medicineId=${ids['Dolo 650']}${geo(FAR_PATIENT)}`);
    expect(beyond.body.data.beyondRadius).toBe(true);
    expect(beyond.body.data.items).toHaveLength(1);
    expect(beyond.body.data.items[0]).toMatchObject({ name: 'Detail Near Pharmacy', beyondRadius: true });
    expect(beyond.body.data.items[0].distanceKm).toBeGreaterThan(15);

    // Nobody stocks it anywhere: still empty, not flagged.
    const none = await api().get(`${V}/discovery/providers?medicineId=${ids['Paracip 500']}${geo(TAMLUK)}`);
    expect(none.body.data).toMatchObject({ items: [], beyondRadius: false });
    // Other provider searches are unchanged (no beyondRadius field).
    const docs = await api().get(`${V}/discovery/providers?type=PHARMACY${geo(TAMLUK)}`);
    expect(docs.body.data.beyondRadius).toBeUndefined();
  });
});

describe('medicine detail', () => {
  it('returns information, availability, ranked substitutes and other strengths', async () => {
    const res = await api().get(`${V}/public/catalogue/medicines/${ids['Dolo 650']}?${geo(TAMLUK).slice(1)}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const d = res.body.data;
    expect(d).toMatchObject({
      name: 'Dolo 650', composition: 'Paracetamol', strength: '650 mg', requiresPrescription: true, schedule: 'SCHEDULE_H1',
      therapeuticClass: 'Analgesic', uses: 'Fever and mild to moderate pain.', infoSource: 'CDCI', infoSourceLine: 'Information from CDCI, Government of India', disclaimer: 'This is not medical advice.',
      substituteNote: 'Ask your doctor or pharmacist before switching to a substitute.',
      availability: { pharmaciesTotal: 1, pharmaciesNearby: 1, fromMinor: 3000, fromMinorNearby: 3000, radiusKm: 15 },
      substitutesTotal: 2,
    });
    expect(d.attribution).toContain('CDCI');
    expect(d.imageUrl).toBeNull();
    expect(d.substitutes.every((s: { imageUrl: unknown }) => s.imageUrl === null)).toBe(true);
    expect(d.similarGenerics[0].imageUrl).toBeNull();
    // In stock nearby first (Calpol), then the cheaper one that is only far away (Pacimol); inactive Oldpara excluded.
    expect(d.substitutes.map((s: { name: string }) => s.name)).toEqual(['Calpol 650', 'Pacimol 650']);
    expect(d.substitutes[0]).toMatchObject({ pharmaciesNearby: 1, savingsMinor: 500, savingsPercent: 17, manufacturer: 'Synthetic Pharma Limited' });
    expect(d.substitutes[1]).toMatchObject({ pharmaciesNearby: 0, pharmaciesTotal: 1, nearest: { pharmacyName: 'Detail Far Pharmacy' } });
    expect(d.similarGenerics).toEqual([{ compositionKey: 'paracetamol|500mg|tablet', strength: '500 mg', medicines: 1, exampleId: ids['Paracip 500'], exampleName: 'Paracip 500', imageUrl: null }]);

    // Admin-reviewed information carries the Carevanta line.
    const paracip = (await api().get(`${V}/public/catalogue/medicines/${ids['Paracip 500']}`)).body.data;
    expect(paracip).toMatchObject({ infoSourceLine: 'Reviewed by Carevanta', uses: 'Admin reviewed text.', availability: { pharmaciesTotal: 0, pharmaciesNearby: null } });
  });

  it('404 for unknown or inactive medicines, 400 for a bad id', async () => {
    expect((await api().get(`${V}/public/catalogue/medicines/${randomUUID()}`)).status).toBe(404);
    expect((await api().get(`${V}/public/catalogue/medicines/${ids['Oldpara 650']}`)).status).toBe(404);
    expect((await api().get(`${V}/public/catalogue/medicines/not-a-uuid`)).status).toBe(400);
  });
});

describe('medicine photos', () => {
  it('returns imageUrl in search, detail, substitutes and other strengths once a photo hash is set', async () => {
    const sha = 'ab'.repeat(32);
    await prisma.medicine.updateMany({ where: { id: { in: [ids['Dolo 650']!, ids['Calpol 650']!, ids['Paracip 500']!] } }, data: { imageSha256: sha } });
    const url = (id: string) => `/api/v1/public/catalogue/medicines/${id}/image?v=${sha.slice(0, 12)}`;
    const search = (await api().get(`${V}/public/catalogue/medicines?q=dolo`)).body.data;
    expect(search.find((m: { id: string }) => m.id === ids['Dolo 650'])).toMatchObject({ imageUrl: url(ids['Dolo 650']!) });
    const d = (await api().get(`${V}/public/catalogue/medicines/${ids['Dolo 650']}`)).body.data;
    expect(d.imageUrl).toBe(url(ids['Dolo 650']!));
    expect(d.substitutes.find((s: { id: string }) => s.id === ids['Calpol 650'])).toMatchObject({ imageUrl: url(ids['Calpol 650']!) });
    expect(d.substitutes.find((s: { id: string }) => s.id === ids['Pacimol 650'])).toMatchObject({ imageUrl: null });
    expect(d.similarGenerics[0]).toMatchObject({ exampleId: ids['Paracip 500'], imageUrl: url(ids['Paracip 500']!) });
    await prisma.medicine.updateMany({ where: { imageSha256: sha }, data: { imageSha256: null } });
  });
});

describe('information backfill', () => {
  it('fills keys and CDCI information for existing rows, skips admin text, and is idempotent', async () => {
    await prisma.medicine.updateMany({ where: { code: { in: ['9100001', '9100007'] } }, data: { compositionKey: null, uses: null, howItWorks: null, infoSource: null } });
    const manual = await prisma.medicine.create({ data: { name: 'Synthetic Para', composition: 'Paracetamol', strength: '0.65 g', dosageForm: 'Tablet', searchName: 'synthetic para' } });
    // A hand-added medicine with the salt only in genericName (as the demo catalogue has).
    const generic = await prisma.medicine.create({ data: { name: 'Synthetic Febril', genericName: 'Paracetamol', strength: '650 mg', dosageForm: 'Tablet', searchName: 'synthetic febril' } });
    const r = await backfillMedicineInfo(FIXTURE);
    expect(r).toMatchObject({ scanned: 9, keysUpdated: 4, infoUpdated: 4, infoSkippedAdmin: 1 });
    // Both borrow the CDCI text of the CDCI medicine with the same key.
    expect(await prisma.medicine.findUniqueOrThrow({ where: { id: manual.id } })).toMatchObject({ compositionKey: 'paracetamol|650mg|tablet', infoSource: 'CDCI', uses: 'Fever and mild to moderate pain.' });
    expect(await prisma.medicine.findUniqueOrThrow({ where: { id: generic.id } })).toMatchObject({ compositionKey: 'paracetamol|650mg|tablet', infoSource: 'CDCI' });
    expect(await prisma.medicine.findUniqueOrThrow({ where: { id: ids['Dolo 650']! } })).toMatchObject({ uses: 'Fever and mild to moderate pain.', infoSource: 'CDCI', compositionKey: 'paracetamol|650mg|tablet' });
    expect(await backfillMedicineInfo(FIXTURE)).toMatchObject({ keysUpdated: 0, infoUpdated: 0, infoSkippedAdmin: 1 });
    // The manual medicine is now a substitute of Dolo 650.
    const d = (await api().get(`${V}/public/catalogue/medicines/${ids['Dolo 650']}`)).body.data;
    expect(d.substitutesTotal).toBe(4);
  });
});
