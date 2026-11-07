import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

/**
 * Place search and reverse geocoding through a free, OpenStreetMap-based
 * geocoder, proxied by the API so that (a) no key or contact e-mail ever
 * reaches a browser, (b) Nominatim's usage policy (identifying User-Agent,
 * at most one request per second) is honoured in one place, and (c) results
 * are cached. Provider is chosen by GEOCODER_PROVIDER:
 *   - nominatim  (default): https://nominatim.openstreetmap.org, no key
 *   - locationiq: https://us1.locationiq.com/v1, Nominatim-compatible JSON, key from GEOCODER_API_KEY
 * Results are restricted to India and biased towards the caller's position.
 */
export interface PlaceAddress {
  addressLine1: string | null;
  locality: string | null;
  city: string | null;
  district: string | null;
  state: string | null;
  pincode: string | null;
}
export interface Place { label: string; latitude: number; longitude: number; address: PlaceAddress }

export const GEOCODER_UNAVAILABLE = 'Place search is unavailable right now';
export class GeocoderUnavailable extends AppError {
  constructor() {
    super(503, 'SERVICE_UNAVAILABLE', GEOCODER_UNAVAILABLE);
  }
}

type OsmAddress = Record<string, string | undefined>;
interface OsmResult { lat: string | number; lon: string | number; display_name?: string; address?: OsmAddress; error?: string }

/** The same mapping from OSM address tags that the map pickers use, so every screen agrees on what a field means. */
export function mapOsmAddress(a: OsmAddress | undefined): PlaceAddress {
  const t = (...keys: string[]) => { for (const k of keys) { const v = a?.[k]?.trim(); if (v) return v; } return null; };
  const line1 = [t('house_number'), t('building'), t('road', 'pedestrian', 'footway', 'residential')].filter(Boolean).join(', ') || null;
  const rawDistrict = t('state_district', 'county');
  const pin = a?.postcode?.match(/\b[1-9][0-9]{5}\b/)?.[0] ?? null;
  return {
    addressLine1: line1,
    locality: t('suburb', 'neighbourhood', 'hamlet', 'quarter'),
    city: t('city', 'town', 'village', 'municipality', 'city_district'),
    district: rawDistrict ? rawDistrict.replace(/\s+district$/i, '') : null,
    state: t('state'),
    pincode: pin,
  };
}

export function toPlace(r: OsmResult): Place | null {
  const latitude = Number(r.lat), longitude = Number(r.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { label: r.display_name ?? '', latitude: Math.round(latitude * 1e6) / 1e6, longitude: Math.round(longitude * 1e6) / 1e6, address: mapOsmAddress(r.address) };
}

// ─── Provider configuration ───────────────────────────────────────────────
export interface GeocoderConfig { provider: 'nominatim' | 'locationiq'; searchUrl: string; reverseUrl: string; key: string | null; userAgent: string; minIntervalMs: number }

export function geocoderConfig(e: Pick<typeof env, 'GEOCODER_PROVIDER' | 'GEOCODER_API_KEY' | 'GEOCODER_CONTACT_EMAIL'> = env): GeocoderConfig {
  const userAgent = `Carevanta/0.1 (+${e.GEOCODER_CONTACT_EMAIL ?? 'https://carevanta.local'})`;
  if (e.GEOCODER_PROVIDER === 'locationiq') {
    if (!e.GEOCODER_API_KEY) throw new Error('GEOCODER_API_KEY is required when GEOCODER_PROVIDER=locationiq');
    return { provider: 'locationiq', searchUrl: 'https://us1.locationiq.com/v1/search', reverseUrl: 'https://us1.locationiq.com/v1/reverse', key: e.GEOCODER_API_KEY, userAgent, minIntervalMs: 0 };
  }
  return { provider: 'nominatim', searchUrl: 'https://nominatim.openstreetmap.org/search', reverseUrl: 'https://nominatim.openstreetmap.org/reverse', key: null, userAgent, minIntervalMs: 1000 };
}

// ─── Cache (LRU, 24 h) and Nominatim pacing ───────────────────────────────
const TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 2000;
const cache = new Map<string, { at: number; value: unknown }>();
function cached<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > TTL_MS) { cache.delete(key); return undefined; }
  cache.delete(key); cache.set(key, hit); // refresh recency
  return hit.value as T;
}
function remember<T>(key: string, value: T): T {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return value;
}
export function clearGeocoderCache() { cache.clear(); lastCallAt = 0; queue = Promise.resolve(); }

let queue: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;
/** Serialise upstream calls and keep at least `minIntervalMs` between them (Nominatim: 1 request per second). */
function paced<T>(minIntervalMs: number, fn: () => Promise<T>): Promise<T> {
  const run = async () => {
    const wait = lastCallAt + minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
    return fn();
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

const normQuery = (q: string) => q.trim().toLowerCase().replace(/\s+/g, ' ');
const roundCoord = (n: number) => Math.round(n * 1e4) / 1e4; // ~11 m: enough for a reverse-geocode cache key

async function callUpstream(url: URL, cfg: GeocoderConfig, fetchImpl: typeof fetch): Promise<unknown> {
  if (cfg.key) url.searchParams.set('key', cfg.key);
  const safeUrl = `${url.origin}${url.pathname}`; // never log the query string: it may carry the key
  try {
    const res = await paced(cfg.minIntervalMs, () =>
      fetchImpl(url.toString(), { headers: { accept: 'application/json', 'user-agent': cfg.userAgent, 'accept-language': 'en' }, signal: AbortSignal.timeout(6000) }),
    );
    if (res.status === 404) return null; // LocationIQ answers 404 for "no results"
    if (!res.ok) {
      logger.warn({ provider: cfg.provider, url: safeUrl, status: res.status }, 'geocoder request failed');
      throw new GeocoderUnavailable();
    }
    return await res.json();
  } catch (err) {
    if (err instanceof GeocoderUnavailable) throw err;
    logger.warn({ provider: cfg.provider, url: safeUrl, err: err instanceof Error ? err.message : String(err) }, 'geocoder unreachable');
    throw new GeocoderUnavailable();
  }
}

/** Free-text place search within India, biased towards (lat, lng) when given. */
export async function searchPlaces(input: { q: string; lat?: number; lng?: number; limit?: number }, fetchImpl: typeof fetch = fetch, cfg: GeocoderConfig = geocoderConfig()): Promise<Place[]> {
  const q = normQuery(input.q);
  const limit = Math.min(Math.max(input.limit ?? 6, 1), 10);
  const bias = input.lat != null && input.lng != null ? `${roundCoord(input.lat)},${roundCoord(input.lng)}` : '';
  const key = `s:${cfg.provider}:${q}:${limit}:${bias}`;
  const hit = cached<Place[]>(key);
  if (hit) return hit;
  const url = new URL(cfg.searchUrl);
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'json');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('countrycodes', 'in');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('dedupe', '1');
  if (bias) {
    // Prefer results near the caller without excluding the rest of the country.
    const [lat, lng] = bias.split(',').map(Number) as [number, number];
    url.searchParams.set('viewbox', `${lng - 0.5},${lat + 0.5},${lng + 0.5},${lat - 0.5}`);
    url.searchParams.set('bounded', '0');
  }
  const body = (await callUpstream(url, cfg, fetchImpl)) as OsmResult[] | null;
  const places = Array.isArray(body) ? body.map(toPlace).filter((p): p is Place => !!p) : [];
  return remember(key, places);
}

/** Nearest address for a point; null when the geocoder knows nothing there. */
export async function reverseGeocode(lat: number, lng: number, fetchImpl: typeof fetch = fetch, cfg: GeocoderConfig = geocoderConfig()): Promise<Place | null> {
  const key = `r:${cfg.provider}:${roundCoord(lat)},${roundCoord(lng)}`;
  const hit = cached<Place | null>(key);
  if (hit !== undefined) return hit;
  const url = new URL(cfg.reverseUrl);
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lng));
  url.searchParams.set('format', 'json');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('zoom', '18');
  const body = (await callUpstream(url, cfg, fetchImpl)) as OsmResult | null;
  const place = body && !body.error ? toPlace(body) : null;
  return remember(key, place);
}

/** Centre point of an Indian PIN code (postal-code search); null when unknown. */
export async function geocodePincode(pin: string, fetchImpl: typeof fetch = fetch, cfg: GeocoderConfig = geocoderConfig()): Promise<{ latitude: number; longitude: number } | null> {
  const key = `p:${cfg.provider}:${pin}`;
  const hit = cached<{ latitude: number; longitude: number } | null>(key);
  if (hit !== undefined) return hit;
  const url = new URL(cfg.searchUrl);
  url.searchParams.set('postalcode', pin);
  url.searchParams.set('countrycodes', 'in');
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');
  try {
    const body = (await callUpstream(url, cfg, fetchImpl)) as OsmResult[] | null;
    const p = Array.isArray(body) && body[0] ? toPlace(body[0]) : null;
    return remember(key, p ? { latitude: p.latitude, longitude: p.longitude } : null);
  } catch {
    return null; // PIN lookups degrade to the district/state centre instead of failing the request
  }
}
