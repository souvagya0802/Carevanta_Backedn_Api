/**
 * Openly licensed web photos: search route (mocked upstream), attach from the search results only,
 * SSRF refusal, non-image refusal, NC licence refusal, a pharmacy photo replacing a web photo, and the
 * credit in patient payloads.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { setPhotoSearchFetch } from '../../src/modules/catalogue/medicine-photo-search.js';
import { resetDatabase } from '../helpers/db.js';
import { actor, api, type Actor } from '../helpers/factory.js';
import { actorForUser, approveProvider, staff, TAMLUK } from '../helpers/fixtures.js';

const V = '/api/v1';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
const GOOD = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Synthetic.jpg/800px-Synthetic.jpg';
const HTML = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Page.jpg/800px-Page.jpg';
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const page = (id: number, url: string, licence: string) => ({ pageid: id, index: id, title: `File:Synthetic ${id}.jpg`, imageinfo: [{ url, thumburl: url, thumbwidth: 800, thumbheight: 600, mime: 'image/jpeg', descriptionurl: `https://commons.wikimedia.org/wiki/File:Synthetic_${id}.jpg`, extmetadata: { LicenseShortName: { value: licence }, Artist: { value: '<a href="x">Synthetic Artist</a>' } } }] });

let sa: Actor;
let med = '';
const auth = () => ({ Authorization: `Bearer ${sa.tokens.accessToken}` });

beforeAll(async () => {
  await resetDatabase();
  sa = await actor(['SUPER_ADMIN']);
  med = (await prisma.medicine.create({ data: { name: 'Webocin', strength: '500 mg', dosageForm: 'Tablet', composition: 'Webomycin', searchName: 'webocin' } })).id;
  setPhotoSearchFetch(async (url) => {
    if (url === GOOD) return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    if (url === HTML) return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    if (url.includes('openverse')) return json({ results: [] });
    if (url.includes('Webocin')) return json({ query: { pages: { 1: page(1, GOOD, 'CC BY-SA 4.0'), 2: page(2, HTML, 'CC BY 4.0'), 3: page(3, 'https://upload.wikimedia.org/x/nc.jpg', 'CC BY-NC 4.0') } } });
    return json({ query: { pages: {} } });
  });
});
afterAll(() => setPhotoSearchFetch(null));

const search = () => api().get(`${V}/admin/catalogue/medicines/${med}/image/search`).set(auth());
const attach = (body: Record<string, unknown>) => api().post(`${V}/admin/catalogue/medicines/${med}/image/from-web`).set(auth()).send({ sourcePageUrl: 'https://commons.wikimedia.org/wiki/File:Synthetic_1.jpg', licence: 'CC BY-SA 4.0', creator: 'Synthetic Artist', attribution: 'x', representative: false, ...body });

describe('web photo search and attach', () => {
  it('returns licensed candidates only, with the queries used', async () => {
    const res = await search();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.queries[0]).toBe('Webocin 500 mg');
    expect(res.body.data.candidates.map((c: { fullUrl: string }) => c.fullUrl)).toEqual([GOOD, HTML]);
    expect(res.body.data.candidates[0]).toMatchObject({ provider: 'commons', licence: 'CC BY-SA 4.0', creator: 'Synthetic Artist', matchedOn: 'brand' });
  });

  it('refuses a host not on the allowlist, an unknown URL, an NC licence and a non-image', async () => {
    expect((await attach({ fullUrl: 'http://169.254.169.254/latest/meta-data' })).status).toBe(400);
    expect((await attach({ fullUrl: 'https://evil.example.com/x.jpg' })).status).toBe(400);
    expect((await attach({ fullUrl: GOOD, licence: 'CC BY-NC 4.0' })).status).toBe(400);
    const html = await attach({ fullUrl: HTML, licence: 'CC BY 4.0' });
    expect(html.status, JSON.stringify(html.body)).toBe(415);
    expect((await prisma.medicine.findUniqueOrThrow({ where: { id: med } })).imageSha256).toBeNull();
  });

  it('attaches a chosen photo with credit, visible in patient payloads; a pharmacy photo replaces it', async () => {
    const res = await attach({ fullUrl: GOOD });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ imageSource: 'WEB', imageLicence: 'CC BY-SA 4.0', imageCredit: 'Synthetic Artist via Wikimedia Commons', imageIsRepresentative: false });
    expect(await prisma.auditEvent.count({ where: { action: 'catalogue.medicine_photo_from_web', entityId: med } })).toBe(1);

    const detail = await api().get(`${V}/public/catalogue/medicines/${med}`);
    expect(detail.body.data).toMatchObject({ imageCredit: 'Synthetic Artist via Wikimedia Commons', imageLicence: 'CC BY-SA 4.0', imageSourceUrl: 'https://commons.wikimedia.org/wiki/File:Synthetic_1.jpg' });
    const list = await api().get(`${V}/public/catalogue/medicines`).query({ q: 'Webocin' });
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.data[0]).toMatchObject({ id: med, imageCredit: 'Synthetic Artist via Wikimedia Commons' });

    const { registrar, verifier } = await staff();
    const create = await registrar.post(`${V}/admin/providers`, {
      type: 'PHARMACY', legalName: 'Web Photo Medicos', displayName: 'Web Photo Medicos', contactPhone: '9800072099',
      owner: { fullName: 'Web Photo Owner', email: 'web.photo.owner@test.carevanta.local' },
      pharmacy: { retailDrugLicenseNo: 'WB/RET/2026/W1', pharmacistName: 'R. Das', pharmacistRegistrationNo: 'WBPC-W1', homeDeliveryAvailable: false },
      location: { name: 'Store', addressLine1: 'Bazar Road', city: 'Tamluk', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721636', latitude: TAMLUK.lat, longitude: TAMLUK.lng },
    });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const pid = create.body.data.id as string;
    await approveProvider(pid, registrar, verifier);
    const owner = await actorForUser(create.body.data.members[0].userId);
    const put = await api().put(`${V}/portal/providers/${pid}/medicines/${med}/image`).set('Authorization', `Bearer ${owner.tokens.accessToken}`).set('Content-Type', 'image/png').send(Buffer.concat([PNG, Buffer.alloc(8, 9)]));
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.data).toMatchObject({ imageSource: 'PROVIDER', imageCredit: null, imageLicence: null, imageSourceUrl: null, imageIsRepresentative: false });
  });

  it('maps an exhausted upstream to 503', async () => {
    setPhotoSearchFetch(async () => json({}, 429));
    const res = await search();
    expect(res.status).toBe(503);
    expect(res.body.error.message).toBe('Image search limit reached, try again in an hour');
  });
});
