/**
 * Medicine photos: admin set/replace/remove, pharmacy uploads (only over no photo or its own), type and size
 * limits, the public versioned image URL with long cache headers, and imageUrl in medicine payloads.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { resetDatabase } from '../helpers/db.js';
import { actor, api, type Actor } from '../helpers/factory.js';
import { actorForUser, approveProvider, staff, TAMLUK } from '../helpers/fixtures.js';

const V = '/api/v1';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const PNG2 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 2)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 3)]);
const PDF = Buffer.from('%PDF-1.4 synthetic');

let sa: Actor;
let medA = '';
let medB = '';
const pharmacies: { id: string; owner: Actor }[] = [];

async function pharmacy(n: number) {
  const { registrar, verifier } = await staff();
  const create = await registrar.post(`${V}/admin/providers`, {
    type: 'PHARMACY', legalName: `Photo Medicos ${n}`, displayName: `Photo Medicos ${n}`, contactPhone: `980007200${n}`,
    owner: { fullName: `Photo Owner ${n}`, email: `photo.owner${n}@test.carevanta.local` },
    pharmacy: { retailDrugLicenseNo: `WB/RET/2026/P${n}`, pharmacistName: 'R. Das', pharmacistRegistrationNo: `WBPC-P${n}`, homeDeliveryAvailable: false },
    location: { name: 'Store', addressLine1: 'Bazar Road', city: 'Tamluk', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721636', latitude: TAMLUK.lat, longitude: TAMLUK.lng },
  });
  expect(create.status, JSON.stringify(create.body)).toBe(201);
  const id = create.body.data.id as string;
  await approveProvider(id, registrar, verifier);
  return { id, owner: await actorForUser(create.body.data.members[0].userId) };
}

beforeAll(async () => {
  await resetDatabase();
  sa = await actor(['SUPER_ADMIN']);
  medA = (await prisma.medicine.create({ data: { name: 'Photocin', strength: '500 mg', dosageForm: 'Tablet', searchName: 'photocin' } })).id;
  medB = (await prisma.medicine.create({ data: { name: 'Photomol', strength: '650 mg', dosageForm: 'Tablet', searchName: 'photomol' } })).id;
  pharmacies.push(await pharmacy(1), await pharmacy(2));
});

const adminUrl = (id: string) => `${V}/admin/catalogue/medicines/${id}/image`;
const portalUrl = (providerId: string, id: string) => `${V}/portal/providers/${providerId}/medicines/${id}/image`;

describe('admin medicine photos', () => {
  it('uploads, serves with cache headers, replaces (new URL) and removes', async () => {
    expect((await api().get(`${V}/public/catalogue/medicines/${medA}/image`)).status).toBe(404);

    const put = await api().put(adminUrl(medA)).set('Authorization', `Bearer ${sa.tokens.accessToken}`).set('Content-Type', 'image/png').send(PNG);
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.data).toMatchObject({ id: medA, imageSource: 'ADMIN' });
    const url1 = put.body.data.imageUrl as string;
    expect(url1).toMatch(new RegExp(`^/api/v1/public/catalogue/medicines/${medA}/image\\?v=[0-9a-f]{12}$`));

    const img = await api().get(url1).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(img.headers['x-content-type-options']).toBe('nosniff');
    expect(img.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(Buffer.compare(img.body as Buffer, PNG)).toBe(0);
    expect((await api().get(url1).set('If-None-Match', img.headers.etag!)).status).toBe(304);

    const list = await sa.get(`${V}/admin/catalogue/medicines?q=photocin`);
    expect(list.body.data[0].imageUrl).toBe(url1);
    expect(list.body.data[0].imageKey).toBeUndefined();

    const replace = await api().put(adminUrl(medA)).set('Authorization', `Bearer ${sa.tokens.accessToken}`).set('Content-Type', 'image/jpeg').send(JPEG);
    expect(replace.status).toBe(200);
    expect(replace.body.data.imageUrl).not.toBe(url1);
    expect((await sa.get(`${V}/admin/catalogue/medicines/${medA}/detail`)).body.data.medicine.imageUrl).toBe(replace.body.data.imageUrl);
    expect(await prisma.auditEvent.count({ where: { action: 'catalogue.medicine_photo_set', entityId: medA } })).toBe(2);

    const del = await sa.delete(adminUrl(medA));
    expect(del.status).toBe(200);
    expect(del.body.data.imageUrl).toBeNull();
    expect((await api().get(`${V}/public/catalogue/medicines/${medA}/image`)).status).toBe(404);
    expect((await sa.delete(adminUrl(medA))).status).toBe(409);
  });

  it('refuses other file types (415), disguised files (415) and photos over 2 MB (413)', async () => {
    const send = (buf: Buffer, type: string) => api().put(adminUrl(medB)).set('Authorization', `Bearer ${sa.tokens.accessToken}`).set('Content-Type', type).send(buf);
    expect((await send(PDF, 'application/pdf')).status).toBe(415);
    expect((await send(PDF, 'image/png')).status).toBe(415); // magic bytes do not match
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
    const tooBig = await send(big, 'image/png');
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.error.message).toContain('2 MB');
  });

  it('needs catalogue.manage', async () => {
    const reviewer = await actor(['CLINICAL_REVIEWER']);
    const res = await api().put(adminUrl(medB)).set('Authorization', `Bearer ${reviewer.tokens.accessToken}`).set('Content-Type', 'image/png').send(PNG);
    expect(res.status).toBe(403);
  });
});

describe('pharmacy medicine photos', () => {
  const send = (who: Actor, providerId: string, id: string, buf = PNG) => api().put(portalUrl(providerId, id)).set('Authorization', `Bearer ${who.tokens.accessToken}`).set('Content-Type', 'image/png').send(buf);

  it('adds a photo when there is none, replaces its own, and is refused over another pharmacy or Carevanta', async () => {
    const [p1, p2] = pharmacies as [{ id: string; owner: Actor }, { id: string; owner: Actor }];
    const first = await send(p1.owner, p1.id, medB);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.data).toMatchObject({ imageSource: 'PROVIDER' });
    expect(await prisma.medicine.findUniqueOrThrow({ where: { id: medB } })).toMatchObject({ imageUpdatedByProviderId: p1.id, imageUpdatedById: p1.owner.user.id });

    const own = await send(p1.owner, p1.id, medB, PNG2);
    expect(own.status).toBe(200);
    expect(own.body.data.imageUrl).not.toBe(first.body.data.imageUrl);

    const other = await send(p2.owner, p2.id, medB);
    expect(other.status).toBe(409);
    expect(other.body.error.message).toContain('another pharmacy');

    // The picker search shows the photo and who owns it.
    const search = await p2.owner.get(`${V}/portal/catalogue/medicines?q=photomol`);
    expect(search.body.data[0]).toMatchObject({ imageUrl: own.body.data.imageUrl, imageSource: 'PROVIDER', imageProviderId: p1.id });

    // A pharmacy cannot upload for another pharmacy's account.
    expect((await send(p2.owner, p1.id, medA)).status).toBe(403);

    // Carevanta's photo cannot be overwritten by a pharmacy.
    await api().put(adminUrl(medA)).set('Authorization', `Bearer ${sa.tokens.accessToken}`).set('Content-Type', 'image/png').send(PNG);
    const refused = await send(p1.owner, p1.id, medA);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe('This medicine already has a photo set by Carevanta.');
    expect(await prisma.auditEvent.count({ where: { action: 'catalogue.medicine_photo_added_by_provider' } })).toBe(2);
  });

  it('shows the photo and who may change it on inventory rows', async () => {
    const p1 = pharmacies[0]!;
    const loc = await prisma.providerLocation.findFirstOrThrow({ where: { providerId: p1.id } });
    await prisma.pharmacyInventory.create({ data: { providerId: p1.id, locationId: loc.id, medicineId: medB, batchNumber: 'PH1', expiryDate: new Date(Date.now() + 200 * 86_400_000), quantityOnHand: 5, mrpMinor: 1000n, sellingPriceMinor: 900n } });
    const res = await p1.owner.get(`${V}/portal/providers/${p1.id}/inventory`);
    expect(res.status).toBe(200);
    expect(res.body.data[0].medicine).toMatchObject({ id: medB, photoOwner: 'mine', dosageForm: 'Tablet' });
    expect(res.body.data[0].medicine.imageUrl).toMatch(/\?v=/);
  });
});
