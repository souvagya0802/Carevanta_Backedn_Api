import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../helpers/factory.js';
import { clearPincodeCache, lookupPincode } from '../../src/modules/geo/geo.service.js';
import { clearGeocoderCache } from '../../src/modules/geo/geocoder.js';

const indiaPost = (offices: object[], status = 'Success') => [{ Message: 'synthetic', Status: status, PostOffice: offices.length ? offices : null }];
const office = (over: Partial<Record<string, string | null>> = {}) => ({ Name: 'Moyna', BranchType: 'Sub Post Office', DeliveryStatus: 'Delivery', Circle: 'West Bengal', District: 'East Midnapore', Division: 'Tamluk', Region: 'South Bengal', Block: 'Moyna', State: 'West Bengal', Country: 'India', Pincode: '721629', ...over });

describe('reference geography (public, no login)', () => {
  afterEach(() => { clearPincodeCache(); vi.unstubAllGlobals(); });

  it('lists every country and the states of India from the ISO dataset — nothing is hardcoded to one state', async () => {
    const countries = await api().get('/api/v1/public/geo/countries');
    expect(countries.status).toBe(200);
    expect(countries.body.data.length).toBeGreaterThan(200);
    expect(countries.body.data.find((c: { code: string }) => c.code === 'IN')?.name).toBe('India');
    expect(countries.headers['cache-control']).toContain('max-age=86400');

    const states = await api().get('/api/v1/public/geo/states?country=in');
    expect(states.status).toBe(200);
    const names = states.body.data.map((s: { name: string }) => s.name);
    expect(names.length).toBeGreaterThanOrEqual(36);
    for (const expected of ['West Bengal', 'Maharashtra', 'Tamil Nadu', 'Delhi', 'Kerala']) expect(names).toContain(expected);
    expect(states.body.data.find((s: { code: string }) => s.code === 'WB')).toBeTruthy();
  });

  it('lists cities of a state and rejects unknown codes', async () => {
    const wb = await api().get('/api/v1/public/geo/cities?country=IN&state=WB');
    expect(wb.status).toBe(200);
    expect(wb.body.data.length).toBeGreaterThan(100);
    expect(wb.body.data.map((c: { name: string }) => c.name)).toContain('Tamluk');
    const mh = await api().get('/api/v1/public/geo/cities?country=IN&state=MH');
    expect(mh.body.data.map((c: { name: string }) => c.name)).toContain('Pune');
    expect((await api().get('/api/v1/public/geo/cities?country=IN&state=ZZ')).status).toBe(404);
    expect((await api().get('/api/v1/public/geo/states?country=XX')).status).toBe(404);
    expect((await api().get('/api/v1/public/geo/states')).status).toBe(400);
  });

  it('resolves a PIN code through the India Post directory, picking the majority district and listing post offices', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(indiaPost([office({ Name: 'Changra', BranchType: 'Branch Post Office' }), office(), office({ Name: 'Dakshinmoyna', BranchType: 'Branch Post Office' })]))));
    const r = await lookupPincode('721629', fetchMock as unknown as typeof fetch);
    expect(r).toMatchObject({ pincode: '721629', state: 'West Bengal', district: 'East Midnapore', block: 'Moyna', division: 'Tamluk', country: 'India' });
    expect(r.offices.map((o) => o.name)).toEqual(['Changra', 'Dakshinmoyna', 'Moyna']);
    // second call served from cache
    await lookupPincode('721629', fetchMock as unknown as typeof fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns 404 for an unknown PIN, 400 for a malformed one, and 503 when the directory is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(indiaPost([], 'Error')))));
    expect((await api().get('/api/v1/public/geo/pincode/999999')).status).toBe(404);
    expect((await api().get('/api/v1/public/geo/pincode/12')).status).toBe(400);
    expect((await api().get('/api/v1/public/geo/pincode/012345')).status).toBe(400);
    clearPincodeCache();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    const down = await api().get('/api/v1/public/geo/pincode/400001');
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });
});

describe('place search and reverse geocoding (proxied geocoder, public)', () => {
  const osm = (over: Record<string, unknown> = {}) => ({
    lat: '22.2896', lon: '87.9183', display_name: 'Tamluk, Purba Medinipur, West Bengal, 721636, India',
    address: { road: 'Hospital Road', suburb: 'Abasbari', town: 'Tamluk', state_district: 'Purba Medinipur District', state: 'West Bengal', postcode: '721636' },
    ...over,
  });
  const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  afterEach(() => { vi.unstubAllGlobals(); clearGeocoderCache(); });

  it('searches places in India with the injected fetch, biased to the caller, and maps the address', async () => {
    const fetchMock = vi.fn(async () => respond([osm()]));
    vi.stubGlobal('fetch', fetchMock);
    const r = await api().get('/api/v1/public/geo/search?q=Tamluk%20hospital&lat=22.3&lng=87.9&limit=3');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0]).toMatchObject({ label: expect.stringContaining('Tamluk'), latitude: 22.2896, longitude: 87.9183, address: { addressLine1: 'Hospital Road', locality: 'Abasbari', city: 'Tamluk', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721636' } });
    const [calledUrl] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const url = new URL(calledUrl);
    expect(url.searchParams.get('countrycodes')).toBe('in');
    expect(url.searchParams.get('limit')).toBe('3');
    expect(url.searchParams.get('viewbox')).toBeTruthy();
    expect((await api().get('/api/v1/public/geo/search?q=ab')).status).toBe(400); // q must be at least 3 chars
  });

  it('reverse-geocodes a point, returns null when nothing is there, and 503 when the geocoder is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(osm())));
    const hit = await api().get('/api/v1/public/geo/reverse?lat=22.2896&lng=87.9183');
    expect(hit.status).toBe(200);
    expect(hit.body.data).toMatchObject({ address: { city: 'Tamluk', pincode: '721636' } });
    vi.stubGlobal('fetch', vi.fn(async () => respond({ error: 'Unable to geocode' })));
    const none = await api().get('/api/v1/public/geo/reverse?lat=0.5&lng=0.5');
    expect(none.status).toBe(200);
    expect(none.body.data).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ETIMEDOUT'); }));
    const down = await api().get('/api/v1/public/geo/reverse?lat=22.1&lng=88.1');
    expect(down.status).toBe(503);
    expect(down.body.error.message).toBe('Place search is unavailable right now');
    expect((await api().get('/api/v1/public/geo/reverse?lat=95&lng=10')).status).toBe(400);
  });
});
