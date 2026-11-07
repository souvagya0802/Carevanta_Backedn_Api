import type { Prisma } from '../../generated/prisma/client.js';
import type { Db } from './prisma.js';

/**
 * Helpers for the few places that need MongoDB aggregation pipelines or raw
 * commands instead of Prisma's typed API (analytics, discovery ranking,
 * grouped sums, atomic counters). Prisma's raw MongoDB surface speaks
 * Extended JSON: dates go in as `{ $date }` and come back the same way, 64-bit
 * integers as `{ $numberLong }`. Everything here converts at the boundary so
 * callers only ever see Date, bigint and number.
 *
 * Rules of thumb:
 * - Typed Prisma queries first; a pipeline only when a query needs joins, group
 *   sums, date buckets or computed distance.
 * - Raw commands run outside interactive transactions. Inside a `$transaction`
 *   use typed queries and group in memory.
 * - Field names in pipelines are the stored snake_case names (`@map`).
 */

/** Extended JSON date literal. */
export const ejsonDate = (d: Date) => ({ $date: d.toISOString() });
/** Extended JSON 64-bit integer literal (BigInt columns such as money minor units). */
export const ejsonLong = (n: bigint | number) => ({ $numberLong: String(n) });

type Ejson = { $date?: unknown; $numberLong?: string; $numberInt?: string; $numberDouble?: string; $numberDecimal?: string; $oid?: string };

/** Recursively convert Extended JSON values returned by raw commands into JS values. */
export function fromEjson<T = unknown>(value: unknown): T {
  if (Array.isArray(value)) return value.map((v) => fromEjson(v)) as T;
  if (value && typeof value === 'object') {
    const o = value as Ejson & Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1) {
      if ('$date' in o) {
        const d = o.$date as string | number | { $numberLong: string };
        return new Date(typeof d === 'object' ? Number(d.$numberLong) : d) as T;
      }
      if ('$numberLong' in o) return BigInt(o.$numberLong!) as T;
      if ('$numberInt' in o) return Number(o.$numberInt) as T;
      if ('$numberDouble' in o) return Number(o.$numberDouble) as T;
      if ('$numberDecimal' in o) return Number(o.$numberDecimal) as T;
      if ('$oid' in o) return o.$oid as T;
    }
    return Object.fromEntries(keys.map((k) => [k, fromEjson(o[k])])) as T;
  }
  return value as T;
}

interface AggregateResult { cursor: { firstBatch: unknown[]; nextBatch?: unknown[]; id: number | { $numberLong: string } }; ok?: number }

/**
 * Run an aggregation pipeline on `collection` and return plain JS documents.
 * Follows the cursor until exhausted so callers never see partial results.
 */
export async function aggregate<T = Record<string, unknown>>(db: Db, collection: string, pipeline: Record<string, unknown>[], options: { allowDiskUse?: boolean } = {}): Promise<T[]> {
  const first = (await db.$runCommandRaw({ aggregate: collection, pipeline, cursor: { batchSize: 5_000 }, allowDiskUse: options.allowDiskUse ?? true } as unknown as Prisma.InputJsonObject)) as unknown as AggregateResult;
  const out: unknown[] = [...first.cursor.firstBatch];
  let id = cursorId(first.cursor.id);
  while (id !== 0n) {
    const more = (await db.$runCommandRaw({ getMore: { $numberLong: String(id) }, collection, batchSize: 5_000 } as unknown as Prisma.InputJsonObject)) as unknown as AggregateResult;
    out.push(...(more.cursor.nextBatch ?? more.cursor.firstBatch ?? []));
    id = cursorId(more.cursor.id);
  }
  return out.map((d) => fromEjson<T>(d));
}

const cursorId = (id: number | { $numberLong: string }) => (typeof id === 'number' ? BigInt(id) : BigInt(id.$numberLong));

/**
 * Atomic conditional update on one or more documents, bypassing Prisma's typed
 * update so the filter can compare fields to each other (`$expr`) and apply
 * `$inc`. Returns the number of modified documents.
 */
export async function updateWhere(db: Db, collection: string, filter: Record<string, unknown>, update: Record<string, unknown>, options: { multi?: boolean } = {}): Promise<number> {
  const res = (await db.$runCommandRaw({ update: collection, updates: [{ q: filter, u: update, multi: options.multi ?? false }] } as unknown as Prisma.InputJsonObject)) as unknown as { nModified?: number; n?: number };
  return res.nModified ?? 0;
}

/** Haversine distance (km) as an aggregation expression over stored `latitude`/`longitude` fields. */
export function distanceKmExpr(lat: number, lng: number, latField = '$latitude', lngField = '$longitude'): Record<string, unknown> {
  const EARTH_KM = 6371;
  const rad = (deg: unknown) => ({ $degreesToRadians: deg });
  const dLat = { $subtract: [rad(latField), rad(lat)] };
  const dLng = { $subtract: [rad(lngField), rad(lng)] };
  const a = {
    $add: [
      { $pow: [{ $sin: { $divide: [dLat, 2] } }, 2] },
      { $multiply: [{ $cos: rad(lat) }, { $cos: rad(latField) }, { $pow: [{ $sin: { $divide: [dLng, 2] } }, 2] }] },
    ],
  };
  return { $multiply: [2 * EARTH_KM, { $asin: { $sqrt: { $min: [1, a] } } }] };
}

/** Bounding-box prefilter (degrees) so the distance expression only runs on nearby rows; uses the lat/lng index. */
export function boundingBox(lat: number, lng: number, radiusKm: number): Record<string, unknown> {
  const dLat = radiusKm / 111.32;
  const dLng = radiusKm / (111.32 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return { latitude: { $gte: lat - dLat, $lte: lat + dLat }, longitude: { $gte: lng - dLng, $lte: lng + dLng } };
}

/** `$dateTrunc` unit for analytics buckets. */
export type Granularity = 'day' | 'week' | 'month';
export const dateTrunc = (field: string, unit: Granularity, timezone = 'Asia/Kolkata') => ({ $dateTrunc: { date: field, unit, timezone, ...(unit === 'week' ? { startOfWeek: 'monday' } : {}) } });

/** Start of the IST calendar day containing `at`, as a UTC instant. */
export function istDayStart(at: Date = new Date()): Date {
  const IST_OFFSET_MS = 5.5 * 3_600_000;
  const shifted = new Date(at.getTime() + IST_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - IST_OFFSET_MS);
}

/** Convert a bigint-or-number aggregate value to a safe number (sums of minor units fit in 2^53). */
export const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : v == null ? 0 : Number(v));
