/**
 * Patient app: public browsing (what the home screen and search need without
 * signing in) and the signed-in patient's own orders, prescriptions, reviews
 * and emergency status. Anything a patient can read about a provider here is
 * public marketplace information; legal identifiers, documents and other
 * patients' data never appear.
 */
import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../http/route.js';
import { prisma } from '../../lib/prisma.js';
import { aggregate, boundingBox, distanceKmExpr, ejsonDate, istDayStart, num } from '../../lib/mongo.js';
import { audit, logSensitiveAccess } from '../../lib/audit.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { PaginationQuery, buildPage, cursorOrderBy, cursorWhere, decodeCursor } from '../../lib/pagination.js';
import { publishedReviewIdsFor, shortName } from '../reviews/reviews.service.js';
import { getObject, IMAGE_TYPES, putObject } from '../../lib/storage.js';
import { BirthDate, DateString, DateTimeString, Pincode, iso, isoDate, minor } from '../../http/dto.js';
import { env } from '../../config/env.js';
import { authenticate } from '../../middleware/auth.js';
import { setSetting } from '../platform/integrations.service.js';
import { getSetting, invalidateSetting } from '../settings/settings.service.js';
import { createDiagnosticOrder, listDiagnosticOrders, loadDiagnosticOrder } from '../diagnostics/diagnostics.routes.js';
import { advancePharmacyOrder, createPharmacyOrder, listPharmacyOrders, loadPharmacyOrder } from '../pharmacy/pharmacy.routes.js';
import { loadDispatch } from '../ambulance/ambulance.routes.js';
import { PatientUiSchema, patientUi, patientUiAdminView, type HeroImage } from './patient-ui.js';

const Passthrough = z.object({}).passthrough();
const PROVIDER_TYPES = ['DOCTOR', 'HOSPITAL', 'CLINIC', 'DIAGNOSTIC_LAB', 'IMAGING_CENTRE', 'PHARMACY', 'AMBULANCE_OPERATOR'] as const;
const MAX_HERO_BYTES = 3 * 1024 * 1024;
const MAX_RX_BYTES = 8 * 1024 * 1024;
const RX_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

/** Lowest fee among a doctor's bookable sessions (schedule fees are what slots copy), so "from ₹X" is always something a patient can actually book. */
const lowestFee = (fees: (bigint | null | undefined)[]) => { const xs = fees.filter((f): f is bigint => f != null); return xs.length ? minor(xs.reduce((a, b) => (b < a ? b : a))) : null; };

const Geo = { lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional(), radiusKm: z.coerce.number().min(1).max(200).optional() };
const round1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);

// ── Aggregation-pipeline helpers (stored snake_case field names) ─────────
/** Escape user text for use inside `$regex`. */
const rx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Case-insensitive "contains" (SQL `ILIKE '%q%'`). */
const contains = (s: string) => ({ $regex: rx(s), $options: 'i' });
/** Case-insensitive whole-value match (SQL `ILIKE 'q'`). */
const equalsCi = (s: string) => ({ $regex: `^${rx(s)}$`, $options: 'i' });
/** Money read back from a pipeline: Long → bigint; any other numeric form is normalised so `minor()` can serialise it. */
const big = (v: unknown): bigint | null => (v == null ? null : typeof v === 'bigint' ? v : BigInt(Math.trunc(Number(v))));
/** Inventory that is really sellable: stock not reserved, and not expiring within 30 days (SQL `expiry_date > current_date + 30`). */
const inStock = (horizon: Date) => ({ expiry_date: { $gt: ejsonDate(horizon) }, $expr: { $gt: [{ $subtract: ['$quantity_on_hand', '$quantity_reserved'] }, 0] } });
const stockHorizon = () => new Date(istDayStart().getTime() + 30 * 86_400_000);
/** `$lookup` that attaches the row's provider only when it is approved and listed; follow with `liveOnly` to keep such rows. */
const liveProviderLookup = (localField: string) => ({ $lookup: { from: 'providers', localField, foreignField: '_id', pipeline: [{ $match: { status: 'APPROVED', is_listed: true } }, { $project: { _id: 1 } }], as: 'live' } });
const liveOnly = { $match: { live: { $ne: [] } } };
/** For a `services` pipeline: how many live providers offer the service and the lowest price (`providers`, `from_minor`). */
const offeringStats = [
  { $lookup: { from: 'provider_services', localField: '_id', foreignField: 'service_id', pipeline: [{ $match: { is_active: true } }, liveProviderLookup('provider_id'), liveOnly, { $group: { _id: null, providers: { $addToSet: '$provider_id' }, from_minor: { $min: '$price_minor' } } }], as: 'offer' } },
  { $addFields: { providers: { $size: { $ifNull: [{ $arrayElemAt: ['$offer.providers', 0] }, []] } }, from_minor: { $ifNull: [{ $arrayElemAt: ['$offer.from_minor', 0] }, null] } } },
];

/** pg_trgm-style trigrams of a text: each word lower-cased and padded ("  word "). */
function trigramSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    const w = `  ${word} `;
    for (let i = 0; i + 3 <= w.length; i++) out.add(w.slice(i, i + 3));
  }
  return out;
}

/** Approximates pg_trgm `word_similarity(query, text)`: the best trigram overlap between the query and any word or adjacent word pair of the text. */
function trigramWordSimilarity(query: string, text: string): number {
  const q = trigramSet(query);
  if (!q.size) return 0;
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const extents = [...words, ...words.slice(1).map((w, i) => `${words[i]} ${w}`), text];
  let best = 0;
  for (const extent of extents) {
    const t = trigramSet(extent);
    let common = 0;
    for (const g of q) if (t.has(g)) common++;
    best = Math.max(best, common / (q.size + t.size - common));
  }
  return best;
}

/** Checks that a patient profile belongs to the signed-in account. */
async function ownProfile(userId: string, profileId: string) {
  const p = await prisma.patientProfile.findFirst({ where: { id: profileId, accountUserId: userId, isActive: true } });
  if (!p) throw notFound('Patient profile');
  return p;
}

export function patientRouter(): Router {
  const r = Router();
  const pub = ['Patient app · Public'];
  const tags = ['Patient app'];

  // ── Content set by the super-admin ──────────────────────────────────────
  defineRoute(r, '/public', {
    method: 'get',
    path: '/patient-ui',
    summary: 'Patient app content: hero, landing copy, categories, banner, support, theme (public)',
    tags: pub,
    auth: 'none',
    response: Passthrough,
    handler: () => patientUi(),
  });

  r.get('/public/patient-ui/hero', async (_req: Request, res: Response) => {
    const hero = await getSetting<HeroImage | null>('patient.hero_image', null);
    if (!hero?.storageKey) throw notFound('Hero image');
    const buf = await getObject(hero.storageKey);
    res.setHeader('Content-Type', hero.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    res.setHeader('ETag', `"${hero.sha256}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(buf);
  });

  defineRoute(r, '/admin/patient-ui', {
    method: 'get',
    path: '',
    summary: 'Patient app content: stored overrides, defaults and the effective result',
    tags: ['Admin · Settings'],
    permissions: ['settings.read'],
    response: Passthrough,
    handler: () => patientUiAdminView(),
  });

  defineRoute(r, '/admin/patient-ui', {
    method: 'put',
    path: '',
    summary: 'Replace the patient app content overrides',
    tags: ['Admin · Settings'],
    status: 200,
    permissions: ['settings.manage'],
    body: z.object({ value: PatientUiSchema, expectedVersion: z.number().int().min(0), reason: z.string().trim().min(5).max(500) }),
    response: Passthrough,
    handler: async ({ body, auth }) => {
      await prisma.$transaction(async (tx) => {
        const row = await tx.platformSetting.findUnique({ where: { key: 'patient.ui' } });
        if (row && row.version !== body.expectedVersion) throw conflict('The content changed concurrently; reload and retry');
        await setSetting(tx, 'patient.ui', body.value, 'Patient app content overrides (hero, landing, categories, banner, support, theme). Empty = as shipped.', false, auth.userId);
        await audit(tx, { action: 'patient_ui.updated', entityType: 'platform_setting', entityId: 'patient.ui', metadata: { reason: body.reason, keys: Object.keys(body.value) } });
      });
      invalidateSetting('patient.ui');
      return patientUiAdminView();
    },
  });

  defineRoute(r, '/admin/patient-ui', {
    method: 'post',
    path: '/hero',
    summary: 'Upload the home hero image (PNG, JPEG or WebP, ≤ 3 MB, raw body)',
    tags: ['Admin · Settings'],
    status: 200,
    permissions: ['settings.manage'],
    middleware: [express.raw({ type: [...IMAGE_TYPES], limit: MAX_HERO_BYTES })],
    response: Passthrough,
    handler: async ({ req, auth }) => {
      if (!Buffer.isBuffer(req.body)) throw badRequest('Send the image as the raw request body with Content-Type image/png, image/jpeg or image/webp');
      if (req.body.length > MAX_HERO_BYTES) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Image must be 3 MB or smaller');
      const mimeType = String(req.headers['content-type']).split(';')[0]!.trim();
      const stored = await putObject('patient-ui', req.body, mimeType);
      await prisma.$transaction(async (tx) => {
        await setSetting(tx, 'patient.hero_image', { storageKey: stored.key, mimeType, sha256: stored.sha256 }, 'Patient app hero image', false, auth.userId);
        await audit(tx, { action: 'patient_ui.hero_uploaded', entityType: 'platform_setting', entityId: 'patient.hero_image', metadata: { mimeType, sizeBytes: stored.sizeBytes } });
      });
      invalidateSetting('patient.hero_image');
      return patientUiAdminView();
    },
  });

  defineRoute(r, '/admin/patient-ui', {
    method: 'delete',
    path: '/hero',
    summary: 'Remove the hero image (the app shows its illustration instead)',
    tags: ['Admin · Settings'],
    status: 200,
    permissions: ['settings.manage'],
    response: Passthrough,
    handler: async ({ auth }) => {
      await prisma.$transaction(async (tx) => {
        await setSetting(tx, 'patient.hero_image', null, 'Patient app hero image', false, auth.userId);
        await audit(tx, { action: 'patient_ui.hero_removed', entityType: 'platform_setting', entityId: 'patient.hero_image' });
      });
      invalidateSetting('patient.hero_image');
      return patientUiAdminView();
    },
  });

  // ── Public catalogue for browsing ──────────────────────────────────────
  defineRoute(r, '/public/catalogue', {
    method: 'get',
    path: '/specialities',
    summary: 'Specialities with the number of verified doctors in each (public)',
    tags: pub,
    auth: 'none',
    response: z.array(z.object({ code: z.string(), name: z.string(), doctors: z.number().int() })),
    handler: async () => {
      const [specialities, counts] = await Promise.all([
        prisma.speciality.findMany({ where: { isActive: true }, select: { id: true, code: true, name: true } }),
        // Distinct approved, listed doctors per speciality over verified speciality rows.
        aggregate<{ _id: string; doctors: number }>(prisma, 'doctor_specialities', [
          { $match: { verified: true } },
          liveProviderLookup('doctor_provider_id'),
          liveOnly,
          { $group: { _id: '$speciality_id', doctors: { $addToSet: '$doctor_provider_id' } } },
          { $project: { doctors: { $size: '$doctors' } } },
        ]),
      ]);
      const doctorsBy = new Map(counts.map((c) => [c._id, num(c.doctors)]));
      return specialities
        .map((s) => ({ code: s.code, name: s.name, doctors: doctorsBy.get(s.id) ?? 0 }))
        .sort((a, b) => b.doctors - a.doctors || a.name.localeCompare(b.name));
    },
  });

  defineRoute(r, '/public/catalogue', {
    method: 'get',
    path: '/conditions',
    summary: 'Conditions and symptoms patients can search by (public)',
    tags: pub,
    auth: 'none',
    query: z.object({ q: z.string().trim().max(100).optional(), limit: z.coerce.number().int().min(1).max(100).default(40) }),
    response: z.array(z.object({ id: z.uuid(), name: z.string(), isRedFlag: z.boolean() })),
    handler: async ({ query }) => {
      const rows = await prisma.condition.findMany({ where: { isActive: true, ...(query.q ? { OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { synonyms: { has: query.q.toLowerCase() } }] } : {}) }, select: { id: true, name: true, isRedFlag: true }, orderBy: { name: 'asc' }, take: query.limit });
      return rows;
    },
  });

  defineRoute(r, '/public/catalogue', {
    method: 'get',
    path: '/services',
    summary: 'Tests, scans and procedures with the number of providers offering each (public)',
    tags: pub,
    auth: 'none',
    query: z.object({ category: z.enum(['CONSULTATION', 'DIAGNOSTIC_TEST', 'IMAGING', 'PROCEDURE', 'SURGERY', 'PHARMACY', 'AMBULANCE', 'HOME_CARE', 'OTHER']).optional(), q: z.string().trim().max(100).optional(), codes: z.string().max(400).optional().describe('Exact service codes, comma separated (e.g. LAB_FBS,LAB_CBC)'), limit: z.coerce.number().int().min(1).max(100).default(40) }),
    response: z.array(z.object({ code: z.string(), name: z.string(), category: z.string(), requiresPrescription: z.boolean(), fastingRequired: z.boolean().nullable(), preparationInstructions: z.string().nullable(), providers: z.number().int(), fromMinor: z.number().int().nullable() })),
    handler: async ({ query }) => {
      const codes = query.codes ? query.codes.split(',').map((c) => c.trim()).filter(Boolean).slice(0, 50) : null;
      type Row = { code: string; name: string; category: string; requires_prescription: boolean; fasting_required?: boolean | null; preparation_instructions?: string | null; providers: number; from_minor: bigint | number | null };
      const rows = await aggregate<Row>(prisma, 'services', [
        { $match: { is_active: true, ...(query.category ? { category: query.category } : {}), ...(query.q ? { $or: [{ name: contains(query.q) }, { synonyms: query.q.toLowerCase() }] } : {}), ...(codes ? { code: { $in: codes } } : {}) } },
        ...offeringStats,
        { $project: { _id: 0, code: 1, name: 1, category: 1, requires_prescription: 1, fasting_required: 1, preparation_instructions: 1, providers: 1, from_minor: 1 } },
        { $sort: { providers: -1, name: 1 } },
        { $limit: query.limit },
      ]);
      return rows.map((x) => ({ code: x.code, name: x.name, category: x.category, requiresPrescription: x.requires_prescription, fastingRequired: x.fasting_required ?? null, preparationInstructions: x.preparation_instructions ?? null, providers: num(x.providers), fromMinor: minor(big(x.from_minor)) }));
    },
  });

  defineRoute(r, '/public/catalogue', {
    method: 'get',
    path: '/medicines',
    summary: 'Medicines, with how many pharmacies currently stock each (public)',
    tags: pub,
    auth: 'none',
    query: z.object({ q: z.string().trim().min(2).max(100), limit: z.coerce.number().int().min(1).max(50).default(20) }),
    response: z.array(z.object({ id: z.uuid(), name: z.string(), genericName: z.string().nullable(), strength: z.string().nullable(), dosageForm: z.string().nullable(), packSize: z.string().nullable(), manufacturer: z.string().nullable(), requiresPrescription: z.boolean(), schedule: z.string(), pharmacies: z.number().int(), fromMinor: z.number().int().nullable() })),
    handler: async ({ query }) => {
      type Row = { _id: string; name: string; generic_name?: string | null; strength?: string | null; dosage_form?: string | null; pack_size?: string | null; manufacturer?: string | null; requires_prescription: boolean; schedule: string; pharmacies: number; from_minor: bigint | number | null };
      const rows = await aggregate<Row>(prisma, 'medicines', [
        { $match: { is_active: true, $or: [{ name: contains(query.q) }, { generic_name: contains(query.q) }] } },
        // Distinct approved, listed pharmacies with sellable stock, and the lowest selling price among them.
        { $lookup: { from: 'pharmacy_inventory', localField: '_id', foreignField: 'medicine_id', pipeline: [{ $match: inStock(stockHorizon()) }, liveProviderLookup('provider_id'), liveOnly, { $group: { _id: null, pharmacies: { $addToSet: '$provider_id' }, from_minor: { $min: '$selling_price_minor' } } }], as: 'stock' } },
        { $project: { name: 1, generic_name: 1, strength: 1, dosage_form: 1, pack_size: 1, manufacturer: 1, requires_prescription: 1, schedule: 1, pharmacies: { $size: { $ifNull: [{ $arrayElemAt: ['$stock.pharmacies', 0] }, []] } }, from_minor: { $ifNull: [{ $arrayElemAt: ['$stock.from_minor', 0] }, null] } } },
        { $sort: { pharmacies: -1, name: 1 } },
        { $limit: query.limit },
      ]);
      return rows.map((x) => ({ id: x._id, name: x.name, genericName: x.generic_name ?? null, strength: x.strength ?? null, dosageForm: x.dosage_form ?? null, packSize: x.pack_size ?? null, manufacturer: x.manufacturer ?? null, requiresPrescription: x.requires_prescription, schedule: x.schedule, pharmacies: num(x.pharmacies), fromMinor: minor(big(x.from_minor)) }));
    },
  });

  // ── Browsing providers ─────────────────────────────────────────────────
  const Card = z.object({ id: z.uuid(), type: z.string(), name: z.string(), specialities: z.array(z.string()), yearsOfExperience: z.number().int().nullable(), feeMinor: z.number().int().nullable(), latitude: z.number().nullable(), longitude: z.number().nullable(), rating: z.number().nullable(), ratingCount: z.number().int(), locationName: z.string().nullable(), locality: z.string().nullable(), city: z.string().nullable(), distanceKm: z.number().nullable(), nextSlotAt: z.string().nullable(), homeService: z.boolean(), priceMinor: z.number().int().nullable() });

  defineRoute(r, '/discovery', {
    method: 'get',
    path: '/providers',
    summary: 'Browse verified doctors, hospitals, clinics, labs, imaging centres and pharmacies near a point (public)',
    description: 'Doctors can be narrowed by speciality; labs by a test code; pharmacies by a medicine id (in stock). Sorted by distance when a location is given, else by rating.',
    tags: pub,
    auth: 'none',
    query: z.object({ type: z.enum(PROVIDER_TYPES).optional(), q: z.string().trim().max(100).optional(), speciality: z.string().max(400).optional().describe('One speciality code, or several separated by commas'), serviceCode: z.string().max(64).optional(), medicineId: z.uuid().optional(), city: z.string().trim().max(120).optional(), sort: z.enum(['distance', 'rating', 'fee']).optional(), limit: z.coerce.number().int().min(1).max(60).default(24), ...Geo }),
    response: z.object({ items: z.array(Card), radiusKm: z.number().nullable() }),
    handler: async ({ query }) => {
      const hasGeo = query.lat != null && query.lng != null;
      const radiusKm = query.radiusKm ?? (await getSetting<number>('search.default_radius_km', 15));
      const specialityCodes = (query.speciality ?? '').split(',').map((c) => c.trim()).filter(Boolean).slice(0, 10);
      const nameQ = query.q?.toLowerCase().replace(/^dr.?s+/, '').trim() ?? '';
      const types = query.type ? [query.type] : query.speciality ? ['DOCTOR'] : query.serviceCode ? ['DIAGNOSTIC_LAB', 'IMAGING_CENTRE', 'HOSPITAL', 'CLINIC'] : query.medicineId ? ['PHARMACY'] : ['DOCTOR', 'HOSPITAL', 'CLINIC', 'DIAGNOSTIC_LAB', 'IMAGING_CENTRE', 'PHARMACY'];
      const empty = { radiusKm: hasGeo ? radiusKm : null, items: [] };
      const providerMatch: Record<string, unknown> = { status: 'APPROVED', is_listed: true, type: { $in: types } };

      // Name search: substring, or a fuzzy (trigram) match for misspellings. Resolved in memory over the listed providers' names.
      if (nameQ) {
        const named = await aggregate<{ _id: string; display_name: string }>(prisma, 'providers', [{ $match: providerMatch }, { $project: { display_name: 1 } }]);
        const ids = named.filter((p) => { const n = p.display_name.toLowerCase(); return n.includes(nameQ) || trigramWordSimilarity(nameQ, n) >= 0.5; }).map((p) => p._id);
        if (!ids.length) return empty;
        providerMatch._id = { $in: ids };
      }
      const pipeline: Record<string, unknown>[] = [{ $match: providerMatch }];

      if (specialityCodes.length) {
        const specialityIds = (await prisma.speciality.findMany({ where: { code: { in: specialityCodes } }, select: { id: true } })).map((s) => s.id);
        if (!specialityIds.length) return empty;
        pipeline.push(
          { $lookup: { from: 'doctor_specialities', localField: '_id', foreignField: 'doctor_provider_id', pipeline: [{ $match: { verified: true, speciality_id: { $in: specialityIds } } }, { $limit: 1 }, { $project: { _id: 1 } }], as: 'spec' } },
          { $match: { spec: { $ne: [] } } },
        );
      }
      if (query.serviceCode) {
        // Only providers actively offering the service; price is the lowest offer, home service if any offer has it.
        const service = await prisma.service.findUnique({ where: { code: query.serviceCode }, select: { id: true } });
        if (!service) return empty;
        pipeline.push(
          { $lookup: { from: 'provider_services', localField: '_id', foreignField: 'provider_id', pipeline: [{ $match: { is_active: true, service_id: service.id } }, { $project: { price_minor: 1, home_service_available: 1 } }], as: 'offer' } },
          { $match: { offer: { $ne: [] } } },
          { $addFields: { price_minor: { $min: '$offer.price_minor' }, home_service: { $anyElementTrue: ['$offer.home_service_available'] } } },
        );
      } else if (query.medicineId) {
        // Only pharmacies with sellable stock of the medicine; price is the lowest selling price, home service = home delivery.
        pipeline.push(
          { $lookup: { from: 'pharmacy_inventory', localField: '_id', foreignField: 'provider_id', pipeline: [{ $match: { medicine_id: query.medicineId, ...inStock(stockHorizon()) } }, { $project: { selling_price_minor: 1 } }], as: 'stock' } },
          { $match: { stock: { $ne: [] } } },
          { $lookup: { from: 'pharmacy_profiles', localField: '_id', foreignField: '_id', as: 'pp' } },
          { $addFields: { price_minor: { $min: '$stock.selling_price_minor' }, home_service: { $anyElementTrue: ['$pp.home_delivery_available'] } } },
        );
      }

      // Where the provider can be visited: its own active locations plus, for a doctor, each approved facility it is
      // actively affiliated with (restricted to the affiliation's location when one is set). One row per
      // (provider, affiliation, location), then the nearest location per provider wins (SQL `DISTINCT ON`).
      pipeline.push(
        { $lookup: { from: 'doctor_profiles', localField: '_id', foreignField: '_id', as: 'dp' } },
        { $lookup: { from: 'doctor_affiliations', localField: '_id', foreignField: 'doctor_provider_id', pipeline: [
          { $match: { status: 'ACTIVE' } },
          { $lookup: { from: 'providers', localField: 'facility_provider_id', foreignField: '_id', pipeline: [{ $match: { status: 'APPROVED' } }, { $project: { _id: 1 } }], as: 'facility' } },
          { $project: { location_id: { $ifNull: ['$location_id', null] }, facility_provider_id: 1, consultation_fee_minor: 1, facility_ok: { $gt: [{ $size: '$facility' }, 0] } } },
        ], as: 'aff' } },
        { $unwind: { path: '$aff', preserveNullAndEmptyArrays: true } },
        { $lookup: { from: 'provider_locations', let: { pid: '$_id', fid: { $ifNull: ['$aff.facility_provider_id', null] }, fok: { $ifNull: ['$aff.facility_ok', false] }, aloc: { $ifNull: ['$aff.location_id', null] } }, pipeline: [
          { $match: {
            is_active: true,
            ...(hasGeo ? boundingBox(query.lat!, query.lng!, radiusKm) : {}),
            ...(query.city ? { city: equalsCi(query.city) } : {}),
            $expr: { $or: [{ $eq: ['$provider_id', '$$pid'] }, { $and: [{ $eq: ['$$fok', true] }, { $eq: ['$provider_id', '$$fid'] }, { $or: [{ $eq: ['$$aloc', null] }, { $eq: ['$$aloc', '$_id'] }] }] }] },
          } },
          { $project: { name: 1, locality: 1, city: 1, latitude: 1, longitude: 1 } },
        ], as: 'loc' } },
        { $unwind: '$loc' },
        { $addFields: {
          fee: { $ifNull: ['$aff.consultation_fee_minor', { $ifNull: [{ $arrayElemAt: ['$dp.default_fee_minor', 0] }, null] }] },
          years: { $ifNull: [{ $arrayElemAt: ['$dp.years_of_experience', 0] }, null] },
          ...(hasGeo ? { distance_km: distanceKmExpr(query.lat!, query.lng!, '$loc.latitude', '$loc.longitude') } : {}),
        } },
        { $sort: { _id: 1, distance_km: 1 } },
        { $group: { _id: '$_id', doc: { $first: '$$ROOT' } } },
        { $replaceRoot: { newRoot: '$doc' } },
        ...(hasGeo ? [{ $match: { distance_km: { $lte: radiusKm } } }] : []),
        // Postgres `NULLS LAST` on an ascending fee: MongoDB sorts nulls first, so sort on a "missing" flag before the value.
        { $addFields: { fee_missing: { $cond: [{ $eq: [{ $ifNull: ['$fee', null] }, null] }, 1, 0] } } },
        { $sort: query.sort === 'rating' || (!hasGeo && query.sort !== 'fee') ? { rating_average: -1, rating_count: -1, distance_km: 1, display_name: 1 } : query.sort === 'fee' ? { fee_missing: 1, fee: 1, distance_km: 1, display_name: 1 } : { distance_km: 1, display_name: 1 } },
        { $limit: query.limit },
        { $project: { type: 1, display_name: 1, years: 1, fee: 1, rating_average: 1, rating_count: 1, loc: 1, distance_km: 1, price_minor: 1, home_service: 1 } },
      );
      type Row = { _id: string; type: string; display_name: string; years?: number | null; fee?: bigint | number | null; rating_average?: number | null; rating_count: number; loc: { name: string; latitude?: number | null; longitude?: number | null; locality?: string | null; city?: string | null }; distance_km?: number | null; price_minor?: bigint | number | null; home_service?: boolean | null };
      const rows = await aggregate<Row>(prisma, 'providers', pipeline);
      const ids = rows.map((x) => x._id);
      const [specs, nextSlots] = await Promise.all([
        prisma.doctorSpeciality.findMany({ where: { doctorProviderId: { in: ids }, verified: true }, orderBy: { isPrimary: 'desc' }, select: { doctorProviderId: true, speciality: { select: { name: true } } } }),
        // Earliest open slot with room left per doctor (`booked_count < capacity` compares two fields, hence a pipeline).
        ids.length
          ? aggregate<{ _id: string; next: Date }>(prisma, 'appointment_slots', [
            { $match: { doctor_provider_id: { $in: ids }, status: 'OPEN', starts_at: { $gt: ejsonDate(new Date()) }, $expr: { $lt: ['$booked_count', '$capacity'] } } },
            { $group: { _id: '$doctor_provider_id', next: { $min: '$starts_at' } } },
          ])
          : Promise.resolve([]),
      ]);
      const specBy = new Map<string, string[]>();
      for (const s of specs) specBy.set(s.doctorProviderId, [...(specBy.get(s.doctorProviderId) ?? []), s.speciality.name]);
      const nextBy = new Map(nextSlots.map((n) => [n._id, n.next]));
      return {
        radiusKm: hasGeo ? radiusKm : null,
        items: rows.map((x) => ({ id: x._id, type: x.type, name: x.display_name, specialities: specBy.get(x._id) ?? [], yearsOfExperience: x.years ?? null, feeMinor: minor(big(x.fee)), latitude: x.loc?.latitude ?? null, longitude: x.loc?.longitude ?? null, rating: x.rating_average ?? null, ratingCount: num(x.rating_count), locationName: x.loc.name ?? null, locality: x.loc.locality ?? null, city: x.loc.city ?? null, distanceKm: round1(x.distance_km ?? null), nextSlotAt: iso(nextBy.get(x._id) ?? null), homeService: !!x.home_service, priceMinor: minor(big(x.price_minor)) })),
      };
    },
  });

  defineRoute(r, '/discovery', {
    method: 'get',
    path: '/providers/:id',
    summary: 'Public profile of a verified provider: what patients may know before booking',
    tags: pub,
    auth: 'none',
    params: z.object({ id: z.uuid() }),
    response: Passthrough,
    handler: async ({ params }) => {
      const p = await prisma.provider.findFirst({
        where: { id: params.id, status: 'APPROVED', isListed: true },
        include: {
          doctorProfile: { include: { specialities: { where: { verified: true }, include: { speciality: { select: { code: true, name: true } } }, orderBy: { isPrimary: 'desc' } }, qualifications: { orderBy: { yearAwarded: 'asc' } }, registrations: { select: { council: true, verifiedAt: true } } } },
          facilityProfile: true,
          diagnosticProfile: true,
          pharmacyProfile: { select: { homeDeliveryAvailable: true, pharmacistName: true } },
          locations: { where: { isActive: true }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }], select: { id: true, name: true, addressLine1: true, addressLine2: true, locality: true, city: true, district: true, state: true, pincode: true, latitude: true, longitude: true, phone: true, operatingHours: { select: { dayOfWeek: true, opensAtMin: true, closesAtMin: true, isClosed: true } } } },
          departments: { where: { isActive: true }, include: { department: { select: { code: true, name: true } } } },
          amenities: { include: { amenity: { select: { code: true, name: true, category: true } } } },
          services: { where: { isActive: true }, include: { service: { select: { code: true, name: true, category: true, requiresPrescription: true, fastingRequired: true, preparationInstructions: true } }, location: { select: { id: true, name: true } } } },
          doctorAffiliations: { where: { status: 'ACTIVE' }, include: { facility: { select: { id: true, displayName: true, type: true } }, location: { select: { id: true, name: true, locality: true, city: true, addressLine1: true, district: true, pincode: true, latitude: true, longitude: true } }, department: { select: { name: true } } } },
          facilityAffiliations: { where: { status: 'ACTIVE', doctor: { status: 'APPROVED', isListed: true } }, include: { doctor: { select: { id: true, displayName: true, ratingAverage: true, ratingCount: true, doctorProfile: { select: { yearsOfExperience: true, specialities: { where: { isPrimary: true }, select: { speciality: { select: { name: true } } } } } } } }, department: { select: { name: true } } } },
          serviceAreas: { select: { purpose: true, district: true, pincode: true } },
        },
      });
      if (!p) throw notFound('Provider');
      const next = p.type === 'DOCTOR' ? await prisma.appointmentSlot.findFirst({ where: { doctorProviderId: p.id, status: 'OPEN', startsAt: { gt: new Date() } }, orderBy: { startsAt: 'asc' }, select: { startsAt: true } }) : null;
      const dec = (v: number | null) => (v == null ? null : Number(v));
      return {
        id: p.id, type: p.type, name: p.displayName, description: p.description, contactPhone: p.contactPhone,
        rating: { average: dec(p.ratingAverage), count: p.ratingCount },
        doctor: p.doctorProfile ? {
          gender: p.doctorProfile.gender, yearsOfExperience: p.doctorProfile.yearsOfExperience, languages: p.doctorProfile.languages, bio: p.doctorProfile.bio, defaultFeeMinor: minor(p.doctorProfile.defaultFeeMinor),
          specialities: p.doctorProfile.specialities.map((s) => ({ code: s.speciality.code, name: s.speciality.name, isPrimary: s.isPrimary })),
          qualifications: p.doctorProfile.qualifications.map((q) => ({ degree: q.degree, institution: q.institution, yearAwarded: q.yearAwarded })),
          registrationVerified: p.doctorProfile.registrations.some((x) => !!x.verifiedAt),
          councils: [...new Set(p.doctorProfile.registrations.map((x) => x.council))],
          nextSlotAt: iso(next?.startsAt ?? null),
          practisesAt: p.doctorAffiliations.map((a) => ({ affiliationId: a.id, facilityId: a.facility.id, facilityName: a.facility.displayName, facilityType: a.facility.type, department: a.department?.name ?? null, locationId: a.location?.id ?? null, locationName: a.location?.name ?? null, locality: a.location?.locality ?? null, city: a.location?.city ?? null, addressLine1: a.location?.addressLine1 ?? null, district: a.location?.district ?? null, pincode: a.location?.pincode ?? null, latitude: a.location?.latitude ?? null, longitude: a.location?.longitude ?? null, feeMinor: minor(a.consultationFeeMinor), engagementType: a.engagementType })),
        } : null,
        facility: p.facilityProfile ? { ownershipType: p.facilityProfile.ownershipType, bedCount: p.facilityProfile.bedCount, icuBedCount: p.facilityProfile.icuBedCount, hasEmergency: p.facilityProfile.hasEmergency, isOpen24x7: p.facilityProfile.isOpen24x7, accreditations: p.facilityProfile.accreditations } : null,
        diagnostic: p.diagnosticProfile ? { offersPathology: p.diagnosticProfile.offersPathology, offersImaging: p.diagnosticProfile.offersImaging, homeCollectionAvailable: p.diagnosticProfile.homeCollectionAvailable } : null,
        pharmacy: p.pharmacyProfile ? { homeDeliveryAvailable: p.pharmacyProfile.homeDeliveryAvailable, pharmacistName: p.pharmacyProfile.pharmacistName } : null,
        locations: p.locations.map((l) => ({ ...l, latitude: dec(l.latitude), longitude: dec(l.longitude) })),
        departments: p.departments.map((d) => ({ code: d.department.code, name: d.department.name })),
        amenities: p.amenities.map((a) => ({ code: a.amenity.code, name: a.amenity.name, category: a.amenity.category })),
        services: p.services.map((s) => ({ id: s.id, code: s.service.code, name: s.service.name, category: s.service.category, requiresPrescription: s.service.requiresPrescription, fastingRequired: s.service.fastingRequired, preparationInstructions: s.service.preparationInstructions, priceMinor: minor(s.priceMinor), homeServiceAvailable: s.homeServiceAvailable, turnaroundHours: s.turnaroundHours, location: s.location })),
        doctors: p.facilityAffiliations.map((a) => ({ id: a.doctor.id, name: a.doctor.displayName, speciality: a.doctor.doctorProfile?.specialities[0]?.speciality.name ?? null, yearsOfExperience: a.doctor.doctorProfile?.yearsOfExperience ?? null, rating: dec(a.doctor.ratingAverage), ratingCount: a.doctor.ratingCount, department: a.department?.name ?? null, feeMinor: minor(a.consultationFeeMinor), engagementType: a.engagementType })),
        coverage: p.serviceAreas,
      };
    },
  });

  defineRoute(r, '/discovery', {
    kind: 'list',
    method: 'get',
    path: '/providers/:id/reviews',
    summary: 'Published patient reviews of a provider (public)',
    tags: pub,
    auth: 'none',
    params: z.object({ id: z.uuid() }),
    query: PaginationQuery,
    response: Passthrough,
    handler: async ({ params, query }) => {
      // A doctor's reviews are stored against the facility of the visit; include them on the doctor's page too.
      const ids: { id: string }[] = await publishedReviewIdsFor(params.id, query.limit + 1, decodeCursor(query.cursor));
      const found = await prisma.review.findMany({ where: { id: { in: ids.map((x) => x.id) } } });
      const rows = ids.flatMap((x) => { const f = found.find((rv) => rv.id === x.id); return f ? [f] : []; });
      const { items, page } = buildPage(rows, query.limit, (x) => x.createdAt);
      const authors = await prisma.user.findMany({ where: { id: { in: items.map((x) => x.authorUserId) } }, select: { id: true, fullName: true } });
      const nameOf = new Map(authors.map((a) => [a.id, a.fullName]));
      return { page, items: items.map((x) => ({ id: x.id, rating: x.rating, comment: x.comment, author: shortName(nameOf.get(x.authorUserId) ?? 'Patient'), createdAt: x.createdAt.toISOString() })) };
    },
  });

  // ── Home screen data in one call ────────────────────────────────────────
  defineRoute(r, '/public', {
    method: 'get',
    path: '/patient-home',
    summary: 'Counts, top doctors and popular tests for the home screen (public)',
    tags: pub,
    auth: 'none',
    query: z.object({ lat: Geo.lat, lng: Geo.lng }),
    response: Passthrough,
    handler: async ({ query }) => {
      // Only sessions still valid today count towards the advertised fee (PAT-16: never show a fee nobody can book).
      const today = new Date(new Date().toISOString().slice(0, 10));
      const [counts, topDoctors, tests] = await Promise.all([
        prisma.provider.groupBy({ by: ['type'], _count: { _all: true }, where: { status: 'APPROVED', isListed: true } }),
        prisma.provider.findMany({ where: { type: 'DOCTOR', status: 'APPROVED', isListed: true }, orderBy: [{ ratingAverage: 'desc' }, { ratingCount: 'desc' }], take: 8, select: { id: true, displayName: true, ratingAverage: true, ratingCount: true, doctorSchedules: { where: { isActive: true, OR: [{ validTo: null }, { validTo: { gte: today } }] }, select: { feeMinor: true } }, doctorProfile: { select: { yearsOfExperience: true, defaultFeeMinor: true, specialities: { where: { verified: true }, orderBy: { isPrimary: 'desc' }, take: 1, select: { speciality: { select: { name: true } } } } } } } }),
        // Tests and scans offered by at least one approved, listed provider, most widely offered first.
        aggregate<{ code: string; name: string; providers: number; from_minor: bigint | number | null }>(prisma, 'services', [
          { $match: { is_active: true, category: { $in: ['DIAGNOSTIC_TEST', 'IMAGING'] } } },
          ...offeringStats,
          { $match: { providers: { $gt: 0 } } },
          { $project: { _id: 0, code: 1, name: 1, providers: 1, from_minor: 1 } },
          { $sort: { providers: -1, name: 1 } },
          { $limit: 8 },
        ]),
      ]);
      return {
        counts: Object.fromEntries(counts.map((c) => [c.type, c._count._all])),
        topDoctors: topDoctors.map((d) => ({ id: d.id, name: d.displayName, speciality: d.doctorProfile?.specialities[0]?.speciality.name ?? null, yearsOfExperience: d.doctorProfile?.yearsOfExperience ?? null, feeMinor: lowestFee(d.doctorSchedules.map((s) => s.feeMinor)), feeIsFrom: new Set(d.doctorSchedules.map((s) => String(s.feeMinor ?? 0n))).size > 1, rating: d.ratingAverage ? Number(d.ratingAverage) : null, ratingCount: d.ratingCount })),
        popularTests: tests.map((t) => ({ code: t.code, name: t.name, providers: num(t.providers), fromMinor: minor(big(t.from_minor)) })),
        near: query.lat != null && query.lng != null,
      };
    },
  });

  // ── Signed-in patient ───────────────────────────────────────────────────
  defineRoute(r, '/patient', {
    method: 'get',
    path: '/summary',
    summary: 'My home strip: next appointment, open orders, unread notifications, family profiles',
    tags,
    response: Passthrough,
    handler: async ({ auth }) => {
      const profiles = await prisma.patientProfile.findMany({ where: { accountUserId: auth.userId, isActive: true }, orderBy: [{ relationship: 'asc' }, { createdAt: 'asc' }], select: { id: true, fullName: true, relationship: true } });
      const ids = profiles.map((p) => p.id);
      const [next, openLab, openRx, unread, emergency] = await Promise.all([
        prisma.appointment.findFirst({ where: { patientProfileId: { in: ids }, status: { in: ['REQUESTED', 'CONFIRMED', 'CHECKED_IN'] }, slot: { startsAt: { gte: new Date(Date.now() - 2 * 3_600_000) } } }, orderBy: { slot: { startsAt: 'asc' } }, include: { slot: { select: { startsAt: true } }, doctor: { select: { id: true, displayName: true } }, facility: { select: { displayName: true } }, location: { select: { name: true, city: true } }, patient: { select: { fullName: true } } } }),
        prisma.diagnosticOrder.count({ where: { patientProfileId: { in: ids }, status: { notIn: ['COMPLETED', 'CANCELLED', 'REJECTED'] } } }),
        prisma.pharmacyOrder.count({ where: { patientProfileId: { in: ids }, status: { notIn: ['DELIVERED', 'CANCELLED', 'REJECTED', 'RETURNED'] } } }),
        prisma.notification.count({ where: { userId: auth.userId, channel: 'IN_APP', readAt: null } }),
        prisma.dispatchRequest.findFirst({ where: { requestedByUserId: auth.userId, status: { in: ['RECEIVED', 'SEARCHING', 'OFFERED', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'PATIENT_ONBOARD', 'AT_DESTINATION'] } }, orderBy: { createdAt: 'desc' }, select: { id: true, reference: true, status: true } }),
      ]);
      return {
        profiles,
        nextAppointment: next ? { id: next.id, reference: next.reference, status: next.status, startsAt: next.slot.startsAt.toISOString(), doctor: next.doctor, facility: next.facility.displayName, location: next.location, patientName: next.patient.fullName } : null,
        openLabOrders: openLab,
        openPharmacyOrders: openRx,
        unreadNotifications: unread,
        activeEmergency: emergency,
      };
    },
  });

  defineRoute(r, '/patient', {
    method: 'patch',
    path: '/profiles/:id',
    summary: 'Update a family profile (name, date of birth, gender, phone) or deactivate it',
    tags,
    status: 200,
    params: z.object({ id: z.uuid() }),
    body: z.object({ fullName: z.string().trim().min(2).max(160).optional(), dateOfBirth: BirthDate.nullable().optional(), gender: z.enum(['FEMALE', 'MALE', 'OTHER', 'UNDISCLOSED']).nullable().optional(), phone: z.string().trim().regex(/^\+?[0-9]{10,15}$/).nullable().optional(), isActive: z.boolean().optional() }),
    response: Passthrough,
    handler: async ({ params, body, auth }) => {
      const p = await ownProfile(auth.userId, params.id);
      if (body.isActive === false && p.relationship === 'SELF') throw badRequest('Your own profile cannot be removed');
      const u = await prisma.patientProfile.update({ where: { id: p.id }, data: { ...body, dateOfBirth: body.dateOfBirth === undefined ? undefined : body.dateOfBirth ? new Date(body.dateOfBirth) : null } });
      await audit(prisma, { action: 'patient.profile_updated', entityType: 'patient_profile', entityId: p.id, actorUserId: auth.userId, metadata: { fields: Object.keys(body) } });
      return { id: u.id, fullName: u.fullName, relationship: u.relationship, dateOfBirth: isoDate(u.dateOfBirth), gender: u.gender, phone: u.phone, isActive: u.isActive };
    },
  });

  // Lab and imaging orders
  defineRoute(r, '/patient', {
    method: 'post',
    path: '/diagnostic-orders',
    summary: 'Book tests or scans at a lab or imaging centre (home collection where offered)',
    tags,
    idempotent: true,
    body: z.object({ patientProfileId: z.uuid(), providerId: z.uuid(), providerServiceIds: z.array(z.uuid()).min(1).max(20), collectionMode: z.enum(['CENTRE_VISIT', 'HOME_COLLECTION']), collectionPincode: Pincode.optional(), scheduledAt: DateTimeString.optional(), prescriptionId: z.uuid().optional() }),
    response: Passthrough,
    handler: async ({ body, auth }) => {
      await ownProfile(auth.userId, body.patientProfileId);
      if (body.collectionMode === 'HOME_COLLECTION' && !body.collectionPincode) throw badRequest('Give the PIN code for home collection');
      if (body.scheduledAt && new Date(body.scheduledAt).getTime() < Date.now() - 5 * 60_000) throw badRequest('Pick a collection time in the future');
      const id = await createDiagnosticOrder({ ...body, bookedByUserId: auth.userId, source: 'PATIENT_APP', attribution: 'PLATFORM', actorUserId: auth.userId });
      return loadDiagnosticOrder(id);
    },
  });

  defineRoute(r, '/patient', {
    kind: 'list',
    method: 'get',
    path: '/diagnostic-orders',
    summary: 'My lab and imaging orders (all family profiles)',
    tags,
    query: PaginationQuery.extend({ status: z.string().max(32).optional() }),
    response: Passthrough,
    handler: ({ query, auth }) => listDiagnosticOrders({ patient: { accountUserId: auth.userId }, ...(query.status ? { status: query.status as never } : {}) }, query),
  });

  defineRoute(r, '/patient', {
    method: 'get',
    path: '/diagnostic-orders/:id',
    summary: 'One of my lab or imaging orders, with report versions',
    tags,
    params: z.object({ id: z.uuid() }),
    response: Passthrough,
    handler: async ({ params, auth }) => {
      const o = await prisma.diagnosticOrder.findFirst({ where: { id: params.id, patient: { accountUserId: auth.userId } }, select: { id: true } });
      if (!o) throw notFound('Order');
      return loadDiagnosticOrder(o.id);
    },
  });

  // Medicine orders
  defineRoute(r, '/patient', {
    method: 'post',
    path: '/pharmacy-orders',
    summary: 'Order medicines from a pharmacy for pickup or delivery',
    tags,
    idempotent: true,
    body: z.object({ patientProfileId: z.uuid(), providerId: z.uuid(), locationId: z.uuid(), fulfilment: z.enum(['PICKUP', 'DELIVERY']), deliveryPincode: Pincode.optional(), prescriptionId: z.uuid().optional(), items: z.array(z.object({ medicineId: z.uuid(), quantity: z.number().int().min(1).max(100) })).min(1).max(30) }),
    response: Passthrough,
    handler: async ({ body, auth }) => {
      await ownProfile(auth.userId, body.patientProfileId);
      if (body.prescriptionId && !(await prisma.prescription.findFirst({ where: { id: body.prescriptionId, patientProfileId: body.patientProfileId } }))) throw badRequest('That prescription does not belong to this patient');
      const id = await createPharmacyOrder({ ...body, source: 'PATIENT_APP', attribution: 'PLATFORM', payAtProvider: false, actorUserId: auth.userId });
      return loadPharmacyOrder(id);
    },
  });

  defineRoute(r, '/patient', {
    kind: 'list',
    method: 'get',
    path: '/pharmacy-orders',
    summary: 'My medicine orders (all family profiles)',
    tags,
    query: PaginationQuery.extend({ status: z.string().max(32).optional() }),
    response: Passthrough,
    handler: ({ query, auth }) => listPharmacyOrders({ patient: { accountUserId: auth.userId }, ...(query.status ? { status: query.status as never } : {}) }, query),
  });

  defineRoute(r, '/patient', {
    method: 'get',
    path: '/pharmacy-orders/:id',
    summary: 'One of my medicine orders',
    tags,
    params: z.object({ id: z.uuid() }),
    response: Passthrough,
    handler: async ({ params, auth }) => {
      const o = await prisma.pharmacyOrder.findFirst({ where: { id: params.id, patient: { accountUserId: auth.userId } }, select: { id: true } });
      if (!o) throw notFound('Order');
      return loadPharmacyOrder(o.id);
    },
  });

  defineRoute(r, '/patient', {
    method: 'post',
    path: '/pharmacy-orders/:id/cancel',
    summary: 'Cancel a medicine order that has not been prepared yet',
    tags,
    status: 200,
    params: z.object({ id: z.uuid() }),
    body: z.object({ reason: z.string().trim().max(500).optional() }),
    response: Passthrough,
    handler: async ({ params, body, auth }) => {
      const o = await prisma.pharmacyOrder.findFirst({ where: { id: params.id, patient: { accountUserId: auth.userId } }, select: { id: true, status: true } });
      if (!o) throw notFound('Order');
      if (!['PLACED', 'PRESCRIPTION_REVIEW', 'ACCEPTED'].includes(o.status)) throw conflict(`The order is already ${o.status.toLowerCase().replace(/_/g, ' ')}; contact the pharmacy`);
      await advancePharmacyOrder(o.id, 'CANCELLED', auth.userId, body.reason ?? 'Cancelled by the patient');
      return loadPharmacyOrder(o.id);
    },
  });

  // Prescriptions (uploaded by the patient; reviewed by a pharmacist when used)
  defineRoute(r, '/patient', {
    kind: 'list',
    method: 'get',
    path: '/prescriptions',
    summary: 'My uploaded prescriptions',
    tags,
    query: PaginationQuery.extend({ patientProfileId: z.uuid().optional() }),
    response: Passthrough,
    handler: async ({ query, auth }) => {
      const rows = await prisma.prescription.findMany({ where: { patient: { accountUserId: auth.userId }, ...(query.patientProfileId ? { patientProfileId: query.patientProfileId } : {}), ...cursorWhere(query.cursor) }, orderBy: cursorOrderBy(), take: query.limit + 1, include: { patient: { select: { id: true, fullName: true } } } });
      const { items, page } = buildPage(rows, query.limit, (x) => x.createdAt);
      return { page, items: items.map((x) => ({ id: x.id, patient: x.patient, reviewStatus: x.reviewStatus, reviewNote: x.reviewNote, issuedOn: isoDate(x.issuedOn), validUntil: isoDate(x.validUntil), createdAt: x.createdAt.toISOString() })) };
    },
  });

  defineRoute(r, '/patient', {
    method: 'post',
    path: '/prescriptions',
    summary: 'Upload a prescription photo or PDF for a family profile (raw body, ≤ 8 MB)',
    tags,
    status: 201,
    middleware: [express.raw({ type: RX_TYPES, limit: MAX_RX_BYTES })],
    query: z.object({ patientProfileId: z.uuid(), issuedOn: DateString.optional() }),
    response: Passthrough,
    handler: async ({ query, req, auth }) => {
      await ownProfile(auth.userId, query.patientProfileId);
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw badRequest('Send the image or PDF as the raw request body (image/jpeg, image/png, image/webp or application/pdf)');
      if (req.body.length > MAX_RX_BYTES) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Prescription must be 8 MB or smaller');
      const mimeType = String(req.headers['content-type']).split(';')[0]!.trim();
      const stored = await putObject(`prescriptions/${query.patientProfileId}`, req.body, mimeType);
      const rx = await prisma.prescription.create({ data: { patientProfileId: query.patientProfileId, uploadedByUserId: auth.userId, storageKey: stored.key, sha256: stored.sha256, issuedOn: query.issuedOn ? new Date(query.issuedOn) : null } });
      await audit(prisma, { action: 'prescription.uploaded', entityType: 'prescription', entityId: rx.id, actorUserId: auth.userId, metadata: { mimeType, sizeBytes: stored.sizeBytes } });
      return { id: rx.id, patientProfileId: rx.patientProfileId, reviewStatus: rx.reviewStatus, issuedOn: isoDate(rx.issuedOn), createdAt: rx.createdAt.toISOString() };
    },
  });

  r.get('/patient/prescriptions/:id/file', authenticate, async (req: Request, res: Response) => {
    const auth = res.locals.auth as { userId: string };
    const id = z.uuid().safeParse(req.params.id);
    if (!id.success) throw badRequest('Invalid id');
    const rx = await prisma.prescription.findFirst({ where: { id: id.data, patient: { accountUserId: auth.userId } } });
    await logSensitiveAccess(prisma, { resourceType: 'PRESCRIPTION', resourceId: id.data, purpose: 'Patient viewing own prescription', granted: !!rx, actorUserId: auth.userId });
    if (!rx) throw notFound('Prescription');
    const buf = await getObject(rx.storageKey);
    res.setHeader('Content-Type', rx.storageKey.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  });

  // Reviews
  defineRoute(r, '/patient', {
    method: 'post',
    path: '/reviews',
    summary: 'Rate a completed appointment (one review per visit; published after moderation)',
    tags,
    status: 201,
    body: z.object({ appointmentId: z.uuid(), rating: z.number().int().min(1).max(5), comment: z.string().trim().max(2000).optional() }),
    response: Passthrough,
    handler: async ({ body, auth }) => {
      const a = await prisma.appointment.findFirst({ where: { id: body.appointmentId, patient: { accountUserId: auth.userId } }, select: { id: true, status: true, facilityProviderId: true, doctorProviderId: true } });
      if (!a) throw notFound('Appointment');
      if (a.status !== 'COMPLETED') throw conflict('You can review a visit once it is completed');
      if (await prisma.review.findUnique({ where: { appointmentId: a.id } })) throw conflict('You already reviewed this visit');
      const review = await prisma.review.create({ data: { providerId: a.facilityProviderId, authorUserId: auth.userId, appointmentId: a.id, rating: body.rating, comment: body.comment ?? null } });
      await audit(prisma, { action: 'review.submitted', entityType: 'review', entityId: review.id, actorUserId: auth.userId, metadata: { rating: body.rating } });
      return { id: review.id, status: review.status, rating: review.rating };
    },
  });

  // Emergency status
  defineRoute(r, '/patient', {
    method: 'get',
    path: '/emergency/:id',
    summary: 'Live status of my emergency request (who accepted, ETA, trip progress)',
    tags,
    params: z.object({ id: z.uuid() }),
    response: Passthrough,
    handler: async ({ params, auth }) => {
      const own = await prisma.dispatchRequest.findFirst({ where: { id: params.id, requestedByUserId: auth.userId }, select: { id: true } });
      if (!own) throw notFound('Emergency request');
      const dto = await loadDispatch(own.id);
      // Patients see the accepted operator and vehicle, never the other offers.
      return { ...dto, assignments: undefined, emergencyNumber: await getSetting<string>('emergency.public_number', '112') };
    },
  });

  defineRoute(r, '/patient', {
    kind: 'list',
    method: 'get',
    path: '/emergency',
    summary: 'My emergency requests',
    tags,
    query: PaginationQuery,
    response: Passthrough,
    handler: async ({ query, auth }) => {
      const rows = await prisma.dispatchRequest.findMany({ where: { requestedByUserId: auth.userId, ...cursorWhere(query.cursor) }, orderBy: cursorOrderBy(), take: query.limit + 1, select: { id: true, reference: true, status: true, pickupDistrict: true, createdAt: true, closedAt: true } });
      const { items, page } = buildPage(rows, query.limit, (x) => x.createdAt);
      return { page, items: items.map((x) => ({ ...x, createdAt: x.createdAt.toISOString(), closedAt: iso(x.closedAt) })) };
    },
  });

  void env;
  return r;
}
