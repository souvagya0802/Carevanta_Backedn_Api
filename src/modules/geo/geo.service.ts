import { City, Country, State } from 'country-state-city';
import { geocodePincode } from './geocoder.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

/**
 * Reference geography. Countries, states and cities come from the
 * `country-state-city` dataset (ISO 3166); Indian PIN codes resolve through the
 * India Post directory so district and locality are never typed from memory.
 * Nothing here is specific to the pilot region — any Indian (or other) address
 * is supported, and the pilot is just data in `service_regions`.
 */

export interface GeoCountry { code: string; name: string; phoneCode: string; flag: string }
export interface GeoState { code: string; name: string; latitude: number | null; longitude: number | null }
export interface GeoCity { name: string; latitude: number | null; longitude: number | null }
export interface PincodeResult {
  pincode: string;
  country: string;
  state: string;
  district: string;
  /** Administrative block / taluka, a good default for city or town. */
  block: string | null;
  division: string | null;
  /** Post offices serving this PIN — used as locality suggestions. */
  offices: { name: string; branchType: string }[];
}

const num = (s: string | null | undefined) => {
  if (s == null || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

export function listCountries(): GeoCountry[] {
  return Country.getAllCountries().map((c) => ({ code: c.isoCode, name: c.name, phoneCode: c.phonecode, flag: c.flag }));
}

export function listStates(countryCode: string): GeoState[] {
  const cc = countryCode.toUpperCase();
  if (!Country.getCountryByCode(cc)) throw notFound('Country');
  return State.getStatesOfCountry(cc)
    .map((s) => ({ code: s.isoCode, name: s.name, latitude: num(s.latitude), longitude: num(s.longitude) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function listCities(countryCode: string, stateCode: string): GeoCity[] {
  const cc = countryCode.toUpperCase();
  const sc = stateCode.toUpperCase();
  if (!State.getStateByCodeAndCountry(sc, cc)) throw notFound('State');
  return City.getCitiesOfState(cc, sc)
    .map((c) => ({ name: c.name, latitude: num(c.latitude), longitude: num(c.longitude) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* ─── Indian PIN code directory (India Post) ─────────────────────────────── */

const PIN_API = 'https://api.postalpincode.in/pincode/';
const PIN_TTL_MS = 24 * 60 * 60 * 1000;
const PIN_CACHE_MAX = 5000;
const pinCache = new Map<string, { at: number; value: PincodeResult | null }>();

interface IndiaPostOffice { Name: string; BranchType: string; District: string; Division: string | null; Block: string | null; State: string; Country: string }
interface IndiaPostResponse { Status: string; PostOffice: IndiaPostOffice[] | null }

function remember(pin: string, value: PincodeResult | null) {
  if (pinCache.size >= PIN_CACHE_MAX) pinCache.delete(pinCache.keys().next().value!);
  pinCache.set(pin, { at: Date.now(), value });
}

export async function lookupPincode(raw: string, fetchImpl: typeof fetch = fetch): Promise<PincodeResult> {
  const pin = raw.trim();
  if (!/^[1-9][0-9]{5}$/.test(pin)) throw badRequest('A PIN code is six digits and cannot start with 0');
  const hit = pinCache.get(pin);
  if (hit && Date.now() - hit.at < PIN_TTL_MS) {
    if (!hit.value) throw notFound('PIN code');
    return hit.value;
  }
  let body: IndiaPostResponse[];
  try {
    const res = await fetchImpl(`${PIN_API}${pin}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = (await res.json()) as IndiaPostResponse[];
  } catch (err) {
    logger.warn({ err, pin }, 'PIN code directory unavailable');
    throw new AppError(503, 'SERVICE_UNAVAILABLE', 'The PIN code directory is not reachable right now; fill the address manually');
  }
  const offices = body[0]?.PostOffice ?? null;
  if (body[0]?.Status !== 'Success' || !offices?.length) {
    remember(pin, null);
    throw notFound('PIN code');
  }
  const first = offices[0]!;
  const mode = (pick: (o: IndiaPostOffice) => string | null) => {
    const counts = new Map<string, number>();
    for (const o of offices) { const v = pick(o); if (v) counts.set(v, (counts.get(v) ?? 0) + 1); }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };
  const value: PincodeResult = {
    pincode: pin,
    country: first.Country,
    state: first.State,
    district: mode((o) => o.District) ?? first.District,
    block: mode((o) => (o.Block && o.Block !== 'NA' ? o.Block : null)),
    division: first.Division ?? null,
    offices: offices.map((o) => ({ name: o.Name, branchType: o.BranchType })).sort((a, b) => a.name.localeCompare(b.name)),
  };
  remember(pin, value);
  return value;
}

/** Test hook. */
export function clearPincodeCache() {
  pinCache.clear();
}

/* ─── Approximate coordinates for a PIN code ─────────────────────────────── */

export type CoordinateSource = 'providers' | 'locality' | 'district' | 'state';
export interface ApproximateCoordinates { latitude: number | null; longitude: number | null; accuracy: CoordinateSource | null }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

/**
 * India Post gives names, not coordinates. For distance sorting we take, in
 * order: the centre of verified provider locations at this PIN, a town in the
 * country-state-city dataset matching a post office, the block or the district,
 * and finally the state centre. `accuracy` tells the app how approximate it is.
 * All data-driven: no place is hard-coded.
 */
export async function approximateCoordinates(r: PincodeResult): Promise<ApproximateCoordinates> {
  const { prisma } = await import('../../lib/prisma.js');
  const { aggregate } = await import('../../lib/mongo.js');
  const at = await aggregate<{ lat: number | null; lng: number | null }>(prisma, 'provider_locations', [
    { $match: { pincode: r.pincode, is_active: true, latitude: { $type: 'number' }, longitude: { $type: 'number' } } },
    { $lookup: { from: 'providers', localField: 'provider_id', foreignField: '_id', as: 'p' } },
    { $unwind: '$p' },
    { $match: { 'p.status': 'APPROVED' } },
    { $group: { _id: null, lat: { $avg: '$latitude' }, lng: { $avg: '$longitude' } } },
  ]);
  if (at[0]?.lat != null && at[0]?.lng != null) return { latitude: Math.round(at[0].lat * 1e5) / 1e5, longitude: Math.round(at[0].lng * 1e5) / 1e5, accuracy: 'providers' };

  const country = Country.getAllCountries().find((c) => norm(c.name) === norm(r.country)) ?? Country.getCountryByCode('IN');
  const state = country ? State.getStatesOfCountry(country.isoCode).find((s) => norm(s.name) === norm(r.state)) : undefined;
  if (country && state) {
    const cities = City.getCitiesOfState(country.isoCode, state.isoCode);
    const byName = new Map(cities.map((c) => [norm(c.name), c]));
    const officeWords = r.offices.flatMap((o) => [o.name, o.name.replace(/\s+(B\.?O|S\.?O|H\.?O)\.?$/i, '')]);
    for (const [names, accuracy] of [[officeWords, 'locality'], [[r.block ?? ''], 'locality'], [[r.district, r.district.replace(/^(purba|paschim|uttar|dakshin|north|south|east|west)\s+/i, '')], 'district']] as const) {
      for (const n of names) {
        const c = n ? byName.get(norm(n)) : undefined;
        const lat = num(c?.latitude), lng = num(c?.longitude);
        if (lat != null && lng != null) {
          // A district-level match is coarse: ask the geocoder for the PIN's own centre first (cached, best effort).
          if (accuracy === 'district') {
            const exact = await geocodePincode(r.pincode);
            if (exact) return { ...exact, accuracy: 'locality' };
          }
          return { latitude: lat, longitude: lng, accuracy };
        }
      }
    }
    const exact = await geocodePincode(r.pincode);
    if (exact) return { ...exact, accuracy: 'locality' };
    const lat = num(state.latitude), lng = num(state.longitude);
    if (lat != null && lng != null) return { latitude: lat, longitude: lng, accuracy: 'state' };
  }
  return { latitude: null, longitude: null, accuracy: null };
}
