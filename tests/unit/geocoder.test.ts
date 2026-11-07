import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearGeocoderCache, geocoderConfig, mapOsmAddress, reverseGeocode, searchPlaces, GEOCODER_UNAVAILABLE } from '../../src/modules/geo/geocoder.js';

const osm = (over: Record<string, unknown> = {}) => ({
  lat: '22.2896', lon: '87.9183', display_name: 'Tamluk, Purba Medinipur, West Bengal, 721636, India',
  address: { road: 'Hospital Road', suburb: 'Abasbari', town: 'Tamluk', state_district: 'Purba Medinipur District', state: 'West Bengal', postcode: '721636', country_code: 'in' },
  ...over,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const nominatim = geocoderConfig({ GEOCODER_PROVIDER: 'nominatim', GEOCODER_API_KEY: undefined, GEOCODER_CONTACT_EMAIL: 'ops@example.com' });
const locationiq = geocoderConfig({ GEOCODER_PROVIDER: 'locationiq', GEOCODER_API_KEY: 'pk.test-key-1234', GEOCODER_CONTACT_EMAIL: 'ops@example.com' });

describe('geocoder', () => {
  afterEach(() => clearGeocoderCache());

  it('maps OSM address tags the same way the map pickers do', () => {
    expect(mapOsmAddress({ house_number: '12', road: 'Hospital Road', neighbourhood: 'Abasbari', village: 'Moyna', county: 'Purba Medinipur district', state: 'West Bengal', postcode: '721629' })).toEqual({
      addressLine1: '12, Hospital Road', locality: 'Abasbari', city: 'Moyna', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721629',
    });
    expect(mapOsmAddress({ city_district: 'Salt Lake', postcode: 'WB 700091' })).toMatchObject({ city: 'Salt Lake', pincode: '700091', addressLine1: null, district: null });
    expect(mapOsmAddress(undefined)).toEqual({ addressLine1: null, locality: null, city: null, district: null, state: null, pincode: null });
  });

  it('selects the provider from env: nominatim needs no key, locationiq requires one and sends it', async () => {
    expect(nominatim).toMatchObject({ provider: 'nominatim', key: null, minIntervalMs: 1000, userAgent: 'Carevanta/0.1 (+ops@example.com)' });
    expect(() => geocoderConfig({ GEOCODER_PROVIDER: 'locationiq', GEOCODER_API_KEY: undefined, GEOCODER_CONTACT_EMAIL: undefined })).toThrow(/GEOCODER_API_KEY/);
    const fetchMock = vi.fn(async () => json([osm()]));
    const places = await searchPlaces({ q: 'Tamluk hospital', lat: 22.3, lng: 87.9 }, fetchMock as unknown as typeof fetch, locationiq);
    const [calledUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const url = new URL(calledUrl);
    expect(url.origin + url.pathname).toBe('https://us1.locationiq.com/v1/search');
    expect(url.searchParams.get('key')).toBe('pk.test-key-1234');
    expect(url.searchParams.get('countrycodes')).toBe('in');
    expect(url.searchParams.get('viewbox')).toBeTruthy();
    expect(init.headers).toMatchObject({ 'user-agent': 'Carevanta/0.1 (+ops@example.com)' });
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ latitude: 22.2896, longitude: 87.9183, address: { city: 'Tamluk', district: 'Purba Medinipur', pincode: '721636' } });
  });

  it('caches by normalised query and rounded coordinates', async () => {
    const fetchMock = vi.fn(async () => json([osm()]));
    await searchPlaces({ q: '  Tamluk   Hospital ' }, fetchMock as unknown as typeof fetch, nominatim);
    await searchPlaces({ q: 'tamluk hospital' }, fetchMock as unknown as typeof fetch, nominatim);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const rev = vi.fn(async () => json(osm()));
    await reverseGeocode(22.28961, 87.91834, rev as unknown as typeof fetch, nominatim);
    await reverseGeocode(22.28963, 87.91831, rev as unknown as typeof fetch, nominatim);
    expect(rev).toHaveBeenCalledTimes(1);
  });

  it('turns upstream failures into a 503 with a fixed message and never leaks the key', async () => {
    const failing = vi.fn(async () => { throw new Error('ECONNRESET key=pk.test-key-1234'); });
    await expect(searchPlaces({ q: 'anything here' }, failing as unknown as typeof fetch, locationiq)).rejects.toMatchObject({ status: 503, message: GEOCODER_UNAVAILABLE });
    const serverError = vi.fn(async () => json({ error: 'boom' }, 500));
    await expect(reverseGeocode(22, 88, serverError as unknown as typeof fetch, nominatim)).rejects.toMatchObject({ status: 503 });
    const notFound = vi.fn(async () => json({ error: 'Unable to geocode' }, 404));
    expect(await reverseGeocode(0.5, 0.5, notFound as unknown as typeof fetch, locationiq)).toBeNull();
  });

  it('keeps at least one second between nominatim calls', async () => {
    const times: number[] = [];
    const fetchMock = vi.fn(async () => { times.push(Date.now()); return json([osm()]); });
    await Promise.all([searchPlaces({ q: 'first query' }, fetchMock as unknown as typeof fetch, nominatim), searchPlaces({ q: 'second query' }, fetchMock as unknown as typeof fetch, nominatim)]);
    expect(times).toHaveLength(2);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(950);
  }, 10_000);
});
