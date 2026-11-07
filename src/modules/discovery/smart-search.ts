import { prisma, type Prisma } from '../../lib/prisma.js';
import { istDayStart } from '../../lib/mongo.js';
import { minor } from '../../http/dto.js';
import { getSetting } from '../settings/settings.service.js';
import { bestMatch, meaningfulWords, normalise, wordSimilarity } from './text-match.js';

/**
 * One search box for everything a patient might type: a symptom ("bukhar",
 * "stomach pain since 2 days"), a kind of doctor ("child doctor"), a test
 * ("sugar test"), a medicine ("paracitamol"), or a name ("ipsita", "tamluk
 * hospital").
 *
 * Safety rules kept from the symptom search:
 *   - A symptom only leads to specialists through APPROVED clinical mappings.
 *     If a symptom is recognised but nothing is approved yet, we say so and
 *     show no doctors for it, rather than guessing.
 *   - Red-flag symptoms put the emergency number first.
 *   - We never suggest a medicine or test FOR a symptom: those are matched by
 *     their own names and everyday names only.
 *
 * Storage note: MongoDB has no trigram similarity, so name matching is done in
 * tiers — exact, prefix, contains (all case-insensitive, via Prisma) — and a
 * typo-tolerant pass over names in JS (`wordSimilarity`) only when the exact
 * tiers did not already fill the page. Distance and "nearest location per
 * provider" are computed in JS from typed rows.
 */

const VOCAB_TTL_MS = 30_000;

interface ConditionEntry { id: string; name: string; kind: string; isRedFlag: boolean; terms: string[]; specialityCodes: { code: string; relevance: string }[] }
interface SpecialityEntry { code: string; name: string; terms: string[]; doctors: number }
interface ServiceEntry { code: string; name: string; category: string; terms: string[]; providers: number; fromMinor: number | null }
interface Vocabulary { conditions: ConditionEntry[]; specialities: SpecialityEntry[]; services: ServiceEntry[]; loadedAt: number }

let cache: Vocabulary | null = null;
let loading: Promise<Vocabulary> | null = null;

/** Forget the cached vocabulary (after a catalogue edit, and in tests). */
export function clearSearchVocabulary() {
  cache = null;
}

async function loadVocabulary(): Promise<Vocabulary> {
  const [conditions, specialities, doctorSpecialities, services] = await Promise.all([
    prisma.condition.findMany({
      where: { isActive: true },
      select: { id: true, name: true, kind: true, isRedFlag: true, synonyms: true, specialities: { where: { reviewStatus: 'APPROVED', speciality: { isActive: true } }, select: { relevance: true, speciality: { select: { code: true } } } } },
    }),
    prisma.speciality.findMany({ where: { isActive: true }, select: { code: true, name: true, synonyms: true } }),
    // Verified speciality claims of APPROVED + listed doctors → distinct doctors per speciality code.
    prisma.doctorSpeciality.findMany({
      where: { verified: true, doctor: { provider: { status: 'APPROVED', isListed: true } } },
      select: { doctorProviderId: true, speciality: { select: { code: true } } },
    }),
    // Tests with their live offerings (APPROVED + listed providers, active price rows); services without offerings still appear with 0 / null.
    prisma.service.findMany({
      where: { isActive: true, category: { in: ['DIAGNOSTIC_TEST', 'IMAGING', 'PROCEDURE'] } },
      select: { code: true, name: true, category: true, synonyms: true, offerings: { where: { isActive: true, provider: { status: 'APPROVED', isListed: true } }, select: { providerId: true, priceMinor: true } } },
    }),
  ]);
  const doctorsBy = new Map<string, Set<string>>();
  for (const ds of doctorSpecialities) {
    const set = doctorsBy.get(ds.speciality.code) ?? new Set<string>();
    set.add(ds.doctorProviderId);
    doctorsBy.set(ds.speciality.code, set);
  }
  return {
    loadedAt: Date.now(),
    conditions: conditions.map((c) => ({ id: c.id, name: c.name, kind: c.kind, isRedFlag: c.isRedFlag, terms: [c.name, ...c.synonyms], specialityCodes: c.specialities.map((m) => ({ code: m.speciality.code, relevance: m.relevance })) })),
    specialities: specialities.map((s) => ({ code: s.code, name: s.name, terms: [s.name, ...s.synonyms], doctors: doctorsBy.get(s.code)?.size ?? 0 })),
    services: services.map((s) => {
      let from: bigint | null = null;
      for (const o of s.offerings) if (from == null || o.priceMinor < from) from = o.priceMinor;
      return { code: s.code, name: s.name, category: s.category, terms: [s.name, ...s.synonyms], providers: new Set(s.offerings.map((o) => o.providerId)).size, fromMinor: minor(from) };
    }),
  };
}

async function vocabulary(): Promise<Vocabulary> {
  if (cache && Date.now() - cache.loadedAt < VOCAB_TTL_MS) return cache;
  loading ??= loadVocabulary().then((v) => { cache = v; return v; }).finally(() => { loading = null; });
  return loading;
}

/** Keep the strongest matches, dropping ones far weaker than the best (so "fever" does not also list "dengue fever"). */
function topMatches<T>(items: { item: T; score: number }[], limit: number, floor = 0.6, spread = 0.15) {
  const sorted = items.filter((x) => x.score >= floor).sort((a, b) => b.score - a.score);
  const top = sorted[0]?.score ?? 0;
  return sorted.filter((x) => x.score >= top - spread).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Name matching tiers (replacement for Postgres trigram similarity)
// ---------------------------------------------------------------------------

const TIER_EXACT = 1;
const TIER_PREFIX = 0.95;
const TIER_CONTAINS = 0.9;

/**
 * Typo-tolerant score of a query against a name: every query word must match
 * some word of the name (same rules as the catalogue matcher). Always below the
 * contains tier so a literal hit outranks a corrected one. 0 = no match.
 */
export function fuzzyNameScore(queryWords: string[], name: string): number {
  const nameWords = normalise(name).split(' ').filter(Boolean);
  if (!queryWords.length || !nameWords.length) return 0;
  let total = 0;
  for (const qw of queryWords) {
    let best = 0;
    for (const nw of nameWords) best = Math.max(best, wordSimilarity(qw, nw));
    if (best < 0.6) return 0;
    total += best;
  }
  return 0.6 + (total / queryWords.length) * 0.29;
}

/** Tiered score of a (normalised) query against one name: exact 1, prefix 0.95, contains 0.9, typo-tolerant < 0.9, else 0. */
export function nameScore(query: string, queryWords: string[], name: string | null | undefined): number {
  if (!name) return 0;
  const n = normalise(name);
  if (n === query) return TIER_EXACT;
  if (n.startsWith(query)) return TIER_PREFIX;
  if (n.includes(query)) return TIER_CONTAINS;
  return fuzzyNameScore(queryWords, name);
}

// ---------------------------------------------------------------------------
// Where a provider is, and what they charge there (replacement for the
// DISTINCT ON (p.id) … ORDER BY distance join over own + affiliated locations)
// ---------------------------------------------------------------------------

const EARTH_KM = 6371;

/** Great-circle distance in km (same haversine as the former SQL expression). */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(Math.min(1, a)));
}

export interface PlacementLocation { id: string; name: string; locality: string | null; city: string; latitude: number | null; longitude: number | null }
export interface PlacementAffiliation { locationId: string | null; consultationFeeMinor: bigint | null; facility: { status: string; locations: PlacementLocation[] } }
export interface PlacementSource {
  /** The provider's own active locations (already filtered by the caller, e.g. bounding box). */
  locations: PlacementLocation[];
  doctorProfile?: { defaultFeeMinor: bigint | null } | null;
  /** ACTIVE affiliations; facility locations are used only when the facility is APPROVED. */
  doctorAffiliations?: PlacementAffiliation[];
}
export interface Placement { location: PlacementLocation | null; distanceKm: number | null; feeMinor: bigint | null }

/** Ascending with nulls last (SQL `ASC NULLS LAST`). */
export const cmpAscNullsLast = (a: number | null, b: number | null) => (a == null ? (b == null ? 0 : 1) : b == null ? -1 : a - b);
/** Descending with nulls last (SQL `DESC NULLS LAST`). */
export const cmpDescNullsLast = (a: number | null, b: number | null) => (a == null ? (b == null ? 0 : 1) : b == null ? -1 : b - a);
/** Plain string order for names (SQL `ORDER BY name`). */
export const cmpName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Pick the location a provider should be shown at: the nearest of their own
 * active locations and the locations of APPROVED facilities they are ACTIVELY
 * affiliated with (restricted to the affiliation's location when it names one).
 * The fee is the affiliation's consultation fee, falling back to the doctor's
 * default fee. Without coordinates the first own location wins. When
 * `requireLocation` is set, a provider with no eligible location gets `null`
 * (SQL inner join); otherwise they are kept with a null location (left join).
 */
export function nearestPlacement(p: PlacementSource, lat: number | undefined, lng: number | undefined, requireLocation = false): Placement | null {
  const hasGeo = lat != null && lng != null;
  const defaultFee = p.doctorProfile?.defaultFeeMinor ?? null;
  const affiliations: (PlacementAffiliation | null)[] = p.doctorAffiliations?.length ? p.doctorAffiliations : [null];
  const rows: Placement[] = [];
  for (const a of affiliations) {
    const fee = a?.consultationFeeMinor ?? defaultFee;
    const locs = [...p.locations];
    if (a && a.facility.status === 'APPROVED') for (const l of a.facility.locations) if (a.locationId == null || a.locationId === l.id) locs.push(l);
    if (!locs.length) {
      if (!requireLocation) rows.push({ location: null, distanceKm: null, feeMinor: fee });
      continue;
    }
    for (const l of locs) {
      const distanceKm = hasGeo && l.latitude != null && l.longitude != null ? haversineKm(lat, lng, l.latitude, l.longitude) : null;
      rows.push({ location: l, distanceKm, feeMinor: fee });
    }
  }
  if (!rows.length) return null;
  // Stable sort: nearest first, nulls last; ties keep generation order (own locations before facility ones).
  rows.sort((x, y) => cmpAscNullsLast(x.distanceKm, y.distanceKm) || (x.location == null ? 1 : 0) - (y.location == null ? 1 : 0));
  return rows[0]!;
}

/** Nested selection for a provider's own + affiliated locations, used by both search entry points. */
export const placementSelect = (locationWhere: Prisma.ProviderLocationWhereInput = {}) => ({
  doctorProfile: { select: { defaultFeeMinor: true } },
  locations: { where: { isActive: true, ...locationWhere }, select: { id: true, name: true, locality: true, city: true, latitude: true, longitude: true } },
  doctorAffiliations: {
    where: { status: 'ACTIVE' as const },
    select: { locationId: true, consultationFeeMinor: true, facility: { select: { status: true, locations: { where: { isActive: true, ...locationWhere }, select: { id: true, name: true, locality: true, city: true, latitude: true, longitude: true } } } } },
  },
});

// ---------------------------------------------------------------------------

export interface SmartSearchInput { q: string; lat?: number; lng?: number; limit: number }

type ProviderRow = { id: string; type: string; name: string; city: string | null; locality: string | null; latitude: number | null; longitude: number | null; distance_km: number | null; fee: bigint | null; rating: number | null; rating_count: number; score: number };
type MedicineRow = { id: string; name: string; generic_name: string | null; strength: string | null; dosage_form: string | null; requires_prescription: boolean; pharmacies: number; from_minor: bigint | null; score: number };

const providerCardSelect = { id: true, type: true, displayName: true, ratingAverage: true, ratingCount: true, ...placementSelect() };

/** Approved, listed doctors holding a verified speciality in `codes`, each at their nearest location. */
async function doctorsBySpeciality(codes: string[], lat: number | undefined, lng: number | undefined, limit: number): Promise<ProviderRow[]> {
  const claims = await prisma.doctorSpeciality.findMany({ where: { verified: true, speciality: { code: { in: codes } } }, select: { doctorProviderId: true } });
  const ids = [...new Set(claims.map((c) => c.doctorProviderId))];
  if (!ids.length) return [];
  const providers = await prisma.provider.findMany({ where: { id: { in: ids }, type: 'DOCTOR', status: 'APPROVED', isListed: true }, select: providerCardSelect });
  const hasGeo = lat != null && lng != null;
  const rows: ProviderRow[] = [];
  for (const p of providers) {
    if (!p.doctorProfile) continue; // JOIN doctor_profiles
    const place = nearestPlacement(p, lat, lng);
    if (!place) continue;
    rows.push({ id: p.id, type: p.type, name: p.displayName, city: place.location?.city ?? null, locality: place.location?.locality ?? null, latitude: place.location?.latitude ?? null, longitude: place.location?.longitude ?? null, distance_km: place.distanceKm, fee: place.feeMinor, rating: p.ratingAverage, rating_count: p.ratingCount, score: 1 });
  }
  rows.sort((a, b) => (hasGeo ? cmpAscNullsLast(a.distance_km, b.distance_km) : 0) || cmpDescNullsLast(a.rating, b.rating) || b.rating_count - a.rating_count || cmpName(a.name, b.name));
  return rows.slice(0, limit);
}

/**
 * Approved, listed providers of any type whose display name matches the query:
 * literal (case-insensitive contains, in the database) first; a typo-tolerant
 * pass over the remaining names only when the literal hits did not fill the page.
 */
async function providersByName(nameQuery: string, lat: number | undefined, lng: number | undefined, limit: number): Promise<ProviderRow[]> {
  const words = nameQuery.split(' ').filter(Boolean);
  const literal = await prisma.provider.findMany({ where: { status: 'APPROVED', isListed: true, displayName: { contains: nameQuery, mode: 'insensitive' } }, select: providerCardSelect });
  const scored = new Map(literal.map((p) => [p.id, Math.max(TIER_CONTAINS, nameScore(nameQuery, words, p.displayName))]));
  let candidates = literal;
  if (literal.length < limit) {
    const rest = await prisma.provider.findMany({ where: { status: 'APPROVED', isListed: true, id: { notIn: [...scored.keys()] } }, select: { id: true, displayName: true } });
    const fuzzyIds: string[] = [];
    for (const r of rest) {
      const s = fuzzyNameScore(words, r.displayName);
      if (s > 0) { scored.set(r.id, s); fuzzyIds.push(r.id); }
    }
    if (fuzzyIds.length) candidates = [...literal, ...(await prisma.provider.findMany({ where: { id: { in: fuzzyIds } }, select: providerCardSelect }))];
  }
  const rows: ProviderRow[] = candidates.map((p) => {
    const place = nearestPlacement(p, lat, lng)!;
    return { id: p.id, type: p.type, name: p.displayName, city: place.location?.city ?? null, locality: place.location?.locality ?? null, latitude: place.location?.latitude ?? null, longitude: place.location?.longitude ?? null, distance_km: place.distanceKm, fee: place.feeMinor, rating: p.ratingAverage, rating_count: p.ratingCount, score: scored.get(p.id) ?? 0 };
  });
  rows.sort((a, b) => b.score - a.score || cmpDescNullsLast(a.rating, b.rating) || cmpName(a.name, b.name));
  return rows.slice(0, limit);
}

const medicineSelect = { id: true, name: true, genericName: true, strength: true, dosageForm: true, requiresPrescription: true };

/**
 * Active medicines whose brand or generic name matches the query (literal
 * tiers in the database, typo-tolerant pass in JS when needed), with how many
 * APPROVED + listed pharmacies have sellable stock expiring more than 30 days
 * out, and the lowest such price.
 */
async function medicinesByName(nameQuery: string, limit: number): Promise<MedicineRow[]> {
  const words = nameQuery.split(' ').filter(Boolean);
  const literal = await prisma.medicine.findMany({
    where: { isActive: true, OR: [{ name: { contains: nameQuery, mode: 'insensitive' } }, { genericName: { contains: nameQuery, mode: 'insensitive' } }] },
    select: medicineSelect,
  });
  const score = (m: { name: string; genericName: string | null }) => Math.max(nameScore(nameQuery, words, m.name), nameScore(nameQuery, words, m.genericName));
  const scored = new Map(literal.map((m) => [m.id, Math.max(TIER_CONTAINS, score(m))]));
  let candidates = literal;
  if (literal.length < limit) {
    const rest = await prisma.medicine.findMany({ where: { isActive: true, id: { notIn: [...scored.keys()] } }, select: medicineSelect });
    const fuzzy = rest.filter((m) => {
      const s = Math.max(fuzzyNameScore(words, m.name), m.genericName ? fuzzyNameScore(words, m.genericName) : 0);
      if (s > 0) scored.set(m.id, s);
      return s > 0;
    });
    candidates = [...literal, ...fuzzy];
  }
  if (!candidates.length) return [];

  // Sellable stock: on hand beyond reservations, not expiring within 30 days, at an APPROVED + listed pharmacy.
  const cutoff = new Date(istDayStart().getTime() + 30 * 86_400_000);
  const stock = await prisma.pharmacyInventory.findMany({
    where: { medicineId: { in: candidates.map((m) => m.id) }, expiryDate: { gt: cutoff }, provider: { status: 'APPROVED', isListed: true } },
    select: { medicineId: true, providerId: true, quantityOnHand: true, quantityReserved: true, sellingPriceMinor: true },
  });
  const pharmaciesBy = new Map<string, Set<string>>();
  const fromBy = new Map<string, bigint>();
  for (const s of stock) {
    if (s.quantityOnHand - s.quantityReserved <= 0) continue;
    const set = pharmaciesBy.get(s.medicineId) ?? new Set<string>();
    set.add(s.providerId);
    pharmaciesBy.set(s.medicineId, set);
    const from = fromBy.get(s.medicineId);
    if (from == null || s.sellingPriceMinor < from) fromBy.set(s.medicineId, s.sellingPriceMinor);
  }
  const rows: MedicineRow[] = candidates.map((m) => ({
    id: m.id, name: m.name, generic_name: m.genericName, strength: m.strength, dosage_form: m.dosageForm, requires_prescription: m.requiresPrescription,
    pharmacies: pharmaciesBy.get(m.id)?.size ?? 0, from_minor: fromBy.get(m.id) ?? null, score: scored.get(m.id) ?? 0,
  }));
  rows.sort((a, b) => b.score - a.score || b.pharmacies - a.pharmacies || cmpName(a.name, b.name));
  return rows.slice(0, limit);
}

export async function smartSearch(input: SmartSearchInput) {
  const words = meaningfulWords(input.q);
  const vocab = await vocabulary();

  // 1. What did the patient mean?
  const conditionHits = topMatches(vocab.conditions.map((c) => { const m = bestMatch(words, c.terms); return { item: { c, m }, score: m?.score ?? 0 }; }), 3);
  const specialityHits = topMatches(vocab.specialities.map((s) => { const m = bestMatch(words, s.terms); return { item: { s, m }, score: m?.score ?? 0 }; }), 3);
  const serviceHits = topMatches(vocab.services.map((s) => { const m = bestMatch(words, s.terms); return { item: { s, m }, score: m?.score ?? 0 }; }), input.limit, 0.6, 0.25);

  const conditions = conditionHits.map(({ item: { c, m } }) => ({ id: c.id, name: c.name, kind: c.kind, isRedFlag: c.isRedFlag, matchedTerm: m!.term, corrected: m!.corrected, approved: c.specialityCodes.length > 0 }));
  const redFlag = conditions.some((c) => c.isRedFlag);

  // 2. Which specialists? Approved symptom mappings first, then specialities named directly.
  const specByCode = new Map(vocab.specialities.map((s) => [s.code, s]));
  const specialities = new Map<string, { code: string; name: string; doctors: number; via: 'symptom' | 'speciality'; because: string | null; relevance: string }>();
  for (const { item: { c } } of conditionHits) {
    for (const link of [...c.specialityCodes].sort((a, b) => (a.relevance === b.relevance ? 0 : a.relevance === 'PRIMARY' ? -1 : 1))) {
      const s = specByCode.get(link.code);
      if (s && !specialities.has(s.code)) specialities.set(s.code, { code: s.code, name: s.name, doctors: s.doctors, via: 'symptom', because: c.name, relevance: link.relevance });
    }
  }
  for (const { item: { s } } of specialityHits) if (!specialities.has(s.code)) specialities.set(s.code, { code: s.code, name: s.name, doctors: s.doctors, via: 'speciality', because: null, relevance: 'PRIMARY' });
  const specialityList = [...specialities.values()];
  const specialityCodes = specialityList.map((s) => s.code);

  // 3. Fetch the people, places, tests and medicines in parallel.
  const nameQuery = words.filter((w) => w !== 'dr' && w !== 'doctor').join(' ');

  const [doctorRows, nameRows, medicineRows, emergencyNumber] = await Promise.all([
    specialityCodes.length ? doctorsBySpeciality(specialityCodes, input.lat, input.lng, input.limit) : Promise.resolve([] as ProviderRow[]),
    nameQuery.length >= 3 ? providersByName(nameQuery, input.lat, input.lng, input.limit) : Promise.resolve([] as ProviderRow[]),
    nameQuery.length >= 3 ? medicinesByName(nameQuery, input.limit) : Promise.resolve([] as MedicineRow[]),
    redFlag ? getSetting<string>('emergency.public_number', '112') : Promise.resolve(null),
  ]);

  // Doctors named in the query come first, then specialists for what they described.
  const nameIds = new Set(nameRows.map((r) => r.id));
  const doctorIds = [...new Set([...nameRows.filter((r) => r.type === 'DOCTOR').map((r) => r.id), ...doctorRows.map((r) => r.id)])];
  const doctorSpecs = doctorIds.length
    ? await prisma.doctorSpeciality.findMany({ where: { doctorProviderId: { in: doctorIds }, verified: true }, orderBy: { isPrimary: 'desc' }, select: { doctorProviderId: true, speciality: { select: { name: true } } } })
    : [];
  const specsBy = new Map<string, string[]>();
  for (const s of doctorSpecs) specsBy.set(s.doctorProviderId, [...(specsBy.get(s.doctorProviderId) ?? []), s.speciality.name]);
  const card = (r: ProviderRow) => ({
    id: r.id, type: r.type, name: r.name, specialities: specsBy.get(r.id) ?? [], feeMinor: minor(r.fee), rating: r.rating, ratingCount: r.rating_count,
    city: r.city, locality: r.locality, latitude: r.latitude, longitude: r.longitude, distanceKm: r.distance_km == null ? null : Math.round(r.distance_km * 10) / 10, matchedByName: nameIds.has(r.id),
  });
  const byId = new Map([...doctorRows, ...nameRows].map((r) => [r.id, r]));
  const doctors = doctorIds.map((id) => card(byId.get(id)!)).slice(0, input.limit);
  const places = nameRows.filter((r) => r.type !== 'DOCTOR').map(card);

  const tests = serviceHits.map(({ item: { s, m } }) => ({ code: s.code, name: s.name, category: s.category, providers: s.providers, fromMinor: s.fromMinor, matchedTerm: m!.term, corrected: m!.corrected }));
  const medicines = medicineRows.map((m) => ({ id: m.id, name: m.name, genericName: m.generic_name, strength: m.strength, dosageForm: m.dosage_form, requiresPrescription: m.requires_prescription, pharmacies: m.pharmacies, fromMinor: minor(m.from_minor) }));

  // A friendly line for the UI: the single strongest thing we understood, across symptoms, specialities and tests.
  const candidates = [
    ...conditionHits.map(({ item: { c, m }, score }) => ({ score, label: c.name, kind: 'condition' as const, corrected: m!.corrected, from: m!.term })),
    ...specialityHits.map(({ item: { s, m }, score }) => ({ score, label: s.name, kind: 'speciality' as const, corrected: m!.corrected, from: m!.term })),
    ...serviceHits.map(({ item: { s, m }, score }) => ({ score, label: s.name, kind: 'test' as const, corrected: m!.corrected, from: m!.term })),
  ].sort((x, y) => y.score - x.score);
  const understood = candidates[0] ? { label: candidates[0].label, kind: candidates[0].kind, corrected: candidates[0].corrected, from: candidates[0].from } : null;

  return {
    query: input.q,
    normalised: normalise(input.q),
    understood,
    emergency: redFlag ? { message: 'These symptoms can be a medical emergency. Call now or go to the nearest emergency department.', number: emergencyNumber! } : null,
    conditions,
    specialities: specialityList,
    // Symptoms we recognised but that no clinician has linked to a specialist yet.
    awaitingReview: conditions.filter((c) => !c.approved).map((c) => c.name),
    doctors,
    places,
    tests,
    medicines,
    disclaimer: 'Suggestions help you find the right kind of care. They are not a diagnosis or medical advice.',
  };
}

/** Conditions for a query using the same matcher (used by the older /discovery/search). */
export async function matchConditions(q: string) {
  const words = meaningfulWords(q);
  const vocab = await vocabulary();
  return topMatches(vocab.conditions.map((c) => ({ item: c, score: bestMatch(words, c.terms)?.score ?? 0 })), 5).map(({ item, score }) => ({ id: item.id, name: item.name, is_red_flag: item.isRedFlag, score }));
}
