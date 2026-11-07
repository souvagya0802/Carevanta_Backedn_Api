import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../http/route.js';
import { prisma } from '../../lib/prisma.js';
import { aggregate, dateTrunc, ejsonDate, istDayStart } from '../../lib/mongo.js';
import type { Granularity } from '../../lib/mongo.js';
import { badRequest } from '../../lib/errors.js';
import { DateTimeString } from '../../http/dto.js';
import { env } from '../../config/env.js';

/**
 * Dashboard metrics. Every number is an aggregate query over real rows — there
 * is no synthetic fallback. `dataSource` tells the UI which environment the
 * figures come from so demo data can be labelled.
 *
 * Counters that Prisma's typed API can express use it; everything that needs a
 * join, a date bucket or a grouped sum runs as a MongoDB aggregation pipeline
 * through `aggregate()`. Pipelines use the stored snake_case field names.
 */
const n = (v: bigint | number | null | undefined) => Number(v ?? 0);

/**
 * 30-second in-process cache. Dashboards poll these aggregates and many
 * viewers ask for the same ranges; invalidation is TTL-only, which is
 * acceptable for reporting figures (never used for operational decisions).
 */
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
  const value = await fn();
  if (cache.size > 500) cache.clear();
  cache.set(key, { at: Date.now(), value });
  return value;
}
const minuteKey = (d: Date) => Math.floor(d.getTime() / 60_000);

const Range = z
  .object({ from: DateTimeString.optional(), to: DateTimeString.optional() })
  .transform((q) => {
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86_400_000);
    if (to.getTime() - from.getTime() > 366 * 86_400_000) throw badRequest('Range may not exceed 366 days');
    if (from >= to) throw badRequest('`from` must be before `to`');
    return { from, to };
  });

type Match = Record<string, unknown>;
type Stage = Record<string, unknown>;

/** `field >= from AND field < to` as a `$match` fragment. */
const between = (field: string, from: Date, to: Date): Match => ({ [field]: { $gte: ejsonDate(from), $lt: ejsonDate(to) } });

/** `SELECT field, count(*) FROM collection WHERE match GROUP BY field` → `{ [field value]: count }`. */
async function countBy<K extends string>(collection: string, field: string, match: Match = {}): Promise<Record<K, number>> {
  const rows = await aggregate<{ _id: K; c: bigint | number }>(prisma, collection, [
    ...(Object.keys(match).length ? [{ $match: match }] : []),
    { $group: { _id: `$${field}`, c: { $sum: 1 } } },
  ]);
  return Object.fromEntries(rows.map((r) => [String(r._id), n(r.c)])) as Record<K, number>;
}

type SeriesRow = { bucket: Date; group: string | null; value: bigint | number };

/**
 * `SELECT date_trunc(g, dateField) AS bucket, groupField AS "group", <value> ... GROUP BY 1,2 ORDER BY 1`.
 * `valueExpr` defaults to `count(*)`; pass a `$sum` operand for grouped sums.
 */
function series(collection: string, dateField: string, g: Granularity, match: Match, groupField: string | null, valueExpr: unknown = 1): Promise<SeriesRow[]> {
  const stages: Stage[] = [
    { $match: match },
    { $group: { _id: { bucket: dateTrunc(`$${dateField}`, g), ...(groupField ? { group: `$${groupField}` } : {}) }, value: { $sum: valueExpr } } },
    { $sort: { '_id.bucket': 1, '_id.group': 1 } },
    { $project: { _id: 0, bucket: '$_id.bucket', group: { $ifNull: ['$_id.group', null] }, value: 1 } },
  ];
  return aggregate<SeriesRow>(prisma, collection, stages);
}

export function analyticsRouter(): Router {
  const r = Router();
  const base = '/admin/analytics';
  const tags = ['Admin · Analytics'];

  defineRoute(r, base, {
    method: 'get',
    path: '/overview',
    summary: 'Dashboard overview counters',
    tags,
    permissions: ['analytics.read'],
    query: Range,
    handler: ({ query }) => cached(`overview:${minuteKey(query.from)}:${minuteKey(query.to)}`, async () => {
      const { from, to } = query;
      const now = new Date();
      const todayStart = istDayStart(now);
      const todayEnd = new Date(todayStart.getTime() + 86_400_000);
      const [users, providersByType, providersByStatus, pendingCases, apptPeriod, apptToday, dxPeriod, rxPeriod, dispatchActive, finance, refunds, failedPayments, payables, settlements, support] = await Promise.all([
        countBy<string>('users', 'status'),
        countBy<string>('providers', 'type', { status: 'APPROVED' }),
        countBy<string>('providers', 'status'),
        prisma.verificationCase.count({ where: { status: { in: ['OPEN', 'IN_REVIEW', 'AWAITING_PROVIDER'] } } }),
        countBy<string>('appointments', 'status', between('created_at', from, to)),
        // Appointments whose slot starts during the current IST calendar day and are still live or completed.
        aggregate<{ c: number }>(prisma, 'appointment_slots', [
          { $match: between('starts_at', todayStart, todayEnd) },
          { $lookup: { from: 'appointments', localField: '_id', foreignField: 'slot_id', as: 'a' } },
          { $unwind: '$a' },
          { $match: { 'a.status': { $in: ['REQUESTED', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED'] } } },
          { $count: 'c' },
        ]),
        countBy<string>('diagnostic_orders', 'status', between('created_at', from, to)),
        countBy<string>('pharmacy_orders', 'status', between('created_at', from, to)),
        prisma.dispatchRequest.count({ where: { mode: 'LIVE', status: { notIn: ['COMPLETED', 'CANCELLED'] } } }),
        // GTV net of refunds plus the FINAL commission snapshot (at most one per transaction, enforced by a partial unique index).
        aggregate<{ gtv: bigint | number; commission: bigint | number; tax: bigint | number; txns: bigint | number }>(prisma, 'service_transactions', [
          { $match: between('service_completed_at', from, to) },
          { $lookup: { from: 'commission_snapshots', localField: '_id', foreignField: 'transaction_id', as: 'snaps' } },
          {
            $project: {
              net: { $subtract: ['$gross_minor', '$refunded_minor'] },
              final: { $filter: { input: '$snaps', as: 's', cond: { $eq: ['$$s.status', 'FINAL'] } } },
            },
          },
          {
            $group: {
              _id: null,
              gtv: { $sum: '$net' },
              commission: { $sum: { $sum: '$final.commission_minor' } },
              tax: { $sum: { $sum: '$final.tax_minor' } },
              txns: { $sum: 1 },
            },
          },
        ]),
        aggregate<{ amount: bigint | number; c: bigint | number }>(prisma, 'refunds', [
          { $match: { status: 'SUCCEEDED', ...between('processed_at', from, to) } },
          { $group: { _id: null, amount: { $sum: '$amount_minor' }, c: { $sum: 1 } } },
        ]),
        prisma.payment.count({ where: { status: 'FAILED', createdAt: { gte: from, lt: to } } }),
        // Unsettled ledger balance and the number of distinct providers holding one.
        aggregate<{ amount: bigint | number; providers: bigint | number }>(prisma, 'provider_ledger_entries', [
          { $match: { settlement_item_id: null } },
          { $group: { _id: '$provider_id', amount: { $sum: '$amount_minor' } } },
          { $group: { _id: null, amount: { $sum: '$amount' }, providers: { $sum: 1 } } },
        ]),
        countBy<string>('settlement_batches', 'status'),
        aggregate<{ open: bigint | number; breached: bigint | number; avg_hours: number | null }>(prisma, 'support_cases', [
          {
            $group: {
              _id: null,
              open: { $sum: { $cond: [{ $not: [{ $in: ['$status', ['RESOLVED', 'CLOSED']] }] }, 1, 0] } },
              breached: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $not: [{ $in: ['$status', ['RESOLVED', 'CLOSED']] }] },
                        { $eq: [{ $type: '$sla_due_at' }, 'date'] },
                        { $lt: ['$sla_due_at', ejsonDate(now)] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              // AVG(...) FILTER (WHERE resolved_at in range): $avg skips nulls, so out-of-range rows contribute nothing.
              avg_hours: {
                $avg: {
                  $cond: [
                    {
                      $and: [
                        { $eq: [{ $type: '$resolved_at' }, 'date'] },
                        { $gte: ['$resolved_at', ejsonDate(from)] },
                        { $lt: ['$resolved_at', ejsonDate(to)] },
                      ],
                    },
                    { $divide: [{ $subtract: ['$resolved_at', '$created_at'] }, 3_600_000] },
                    null,
                  ],
                },
              },
            },
          },
        ]),
      ]);
      // A `$group` over zero input documents yields no row (unlike SQL aggregates), so default every scalar.
      const fin = finance[0] ?? { gtv: 0, commission: 0, tax: 0, txns: 0 };
      const completed = n(apptPeriod['COMPLETED']);
      const cancelled = n(apptPeriod['CANCELLED_BY_PATIENT']) + n(apptPeriod['CANCELLED_BY_PROVIDER']) + n(apptPeriod['CANCELLED_BY_PLATFORM']);
      const noShow = n(apptPeriod['NO_SHOW']);
      const totalAppts = Object.values(apptPeriod).reduce((s, v) => s + v, 0);
      return {
        dataSource: env.APP_ENV,
        range: { from: from.toISOString(), to: to.toISOString() },
        users: { total: Object.values(users).reduce((s, v) => s + v, 0), byStatus: users },
        providers: { activeByType: providersByType, byStatus: providersByStatus, pendingVerificationCases: pendingCases },
        appointments: {
          inRange: totalAppts,
          byStatus: apptPeriod,
          today: n(apptToday[0]?.c),
          completionRate: totalAppts ? Math.round((completed / totalAppts) * 1000) / 10 : null,
          cancellationRate: totalAppts ? Math.round((cancelled / totalAppts) * 1000) / 10 : null,
          noShowRate: totalAppts ? Math.round((noShow / totalAppts) * 1000) / 10 : null,
        },
        diagnosticOrders: { byStatus: dxPeriod },
        pharmacyOrders: { byStatus: rxPeriod },
        dispatch: { activeLiveRequests: dispatchActive },
        finance: {
          currency: 'INR',
          grossTransactionValueMinor: n(fin.gtv),
          commissionRevenueMinor: n(fin.commission),
          commissionTaxMinor: n(fin.tax),
          completedTransactions: n(fin.txns),
          refundsMinor: n(refunds[0]?.amount),
          refundsCount: n(refunds[0]?.c),
          failedPayments,
          providerPayablesMinor: n(payables[0]?.amount),
          providersWithPayables: n(payables[0]?.providers),
          settlementBatchesByStatus: settlements,
        },
        support: { openCases: n(support[0]?.open), slaBreached: n(support[0]?.breached), avgResolutionHours: support[0]?.avg_hours == null ? null : Math.round(Number(support[0].avg_hours) * 10) / 10 },
      };
    }),
  });

  const Metric = z.enum(['registrations', 'appointments', 'diagnostic_orders', 'pharmacy_orders', 'gtv', 'commission', 'refunds', 'complaints', 'provider_applications']);
  defineRoute(r, base, {
    method: 'get',
    path: '/series',
    summary: 'Time series for a metric (day/week/month buckets)',
    tags,
    permissions: ['analytics.read'],
    query: z.object({ metric: Metric, granularity: z.enum(['day', 'week', 'month']).default('day'), from: DateTimeString.optional(), to: DateTimeString.optional() }),
    response: z.object({ metric: z.string(), granularity: z.string(), unit: z.string(), points: z.array(z.object({ bucket: z.string(), value: z.number(), group: z.string().nullable() })) }),
    handler: ({ query }) => cached(`series:${query.metric}:${query.granularity}:${query.from ?? ''}:${query.to ?? ''}`, async () => {
      const { from, to } = Range.parse({ from: query.from, to: query.to });
      const g = query.granularity;
      let rows: SeriesRow[];
      let unit = 'count';
      switch (query.metric) {
        case 'registrations':
          rows = await series('users', 'created_at', g, between('created_at', from, to), null);
          break;
        case 'appointments':
          rows = await series('appointments', 'created_at', g, between('created_at', from, to), 'status');
          break;
        case 'diagnostic_orders':
          rows = await series('diagnostic_orders', 'created_at', g, between('created_at', from, to), 'status');
          break;
        case 'pharmacy_orders':
          rows = await series('pharmacy_orders', 'created_at', g, between('created_at', from, to), 'status');
          break;
        case 'gtv':
          unit = 'INR_minor';
          rows = await series('service_transactions', 'service_completed_at', g, between('service_completed_at', from, to), 'category', { $subtract: ['$gross_minor', '$refunded_minor'] });
          break;
        case 'commission':
          unit = 'INR_minor';
          rows = await series('commission_snapshots', 'calculated_at', g, { status: 'FINAL', ...between('calculated_at', from, to) }, null, '$commission_minor');
          break;
        case 'refunds':
          unit = 'INR_minor';
          rows = await series('refunds', 'processed_at', g, { status: 'SUCCEEDED', ...between('processed_at', from, to) }, null, '$amount_minor');
          break;
        case 'complaints':
          rows = await series('support_cases', 'created_at', g, between('created_at', from, to), 'type');
          break;
        case 'provider_applications':
          rows = await series('provider_status_history', 'created_at', g, { to_status: { $in: ['SUBMITTED', 'APPROVED', 'REJECTED'] }, ...between('created_at', from, to) }, 'to_status');
          break;
      }
      return { metric: query.metric, granularity: g, unit, points: rows.map((x) => ({ bucket: x.bucket.toISOString(), group: x.group, value: n(x.value) })) };
    }),
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/geography',
    summary: 'Providers and bookings by district (expansion view)',
    tags,
    permissions: ['analytics.read'],
    query: Range,
    handler: async ({ query }) => {
      // Distinct approved providers per (district, type), counted once even when a provider has several active locations in a district.
      const providers = await aggregate<{ district: string; type: string; c: bigint | number }>(prisma, 'provider_locations', [
        { $match: { is_active: true } },
        { $lookup: { from: 'providers', localField: 'provider_id', foreignField: '_id', as: 'p' } },
        { $unwind: '$p' },
        { $match: { 'p.status': 'APPROVED' } },
        { $group: { _id: { district: '$district', type: '$p.type', provider: '$p._id' } } },
        { $group: { _id: { district: '$_id.district', type: '$_id.type' }, c: { $sum: 1 } } },
        { $sort: { '_id.district': 1, '_id.type': 1 } },
        { $project: { _id: 0, district: '$_id.district', type: '$_id.type', c: 1 } },
      ]);
      const bookings = await aggregate<{ district: string; c: bigint | number }>(prisma, 'appointments', [
        { $match: between('created_at', query.from, query.to) },
        { $lookup: { from: 'provider_locations', localField: 'location_id', foreignField: '_id', as: 'l' } },
        { $unwind: '$l' },
        { $group: { _id: '$l.district', c: { $sum: 1 } } },
        { $sort: { c: -1, _id: 1 } },
        { $project: { _id: 0, district: '$_id', c: 1 } },
      ]);
      const regions = await prisma.serviceRegion.findMany({ select: { code: true, name: true, district: true, status: true } });
      return {
        dataSource: env.APP_ENV,
        regions,
        providersByDistrict: providers.map((x) => ({ district: x.district, type: x.type, count: n(x.c) })),
        bookingsByDistrict: bookings.map((x) => ({ district: x.district, count: n(x.c) })),
      };
    },
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/service-demand',
    summary: 'Demand by speciality / service category',
    tags,
    permissions: ['analytics.read'],
    query: Range,
    handler: async ({ query }) => {
      // Appointments in range joined to the doctor's primary speciality.
      const specialities = await aggregate<{ name: string; c: bigint | number }>(prisma, 'appointments', [
        { $match: between('created_at', query.from, query.to) },
        { $lookup: { from: 'doctor_specialities', localField: 'doctor_provider_id', foreignField: 'doctor_provider_id', as: 'ds' } },
        { $unwind: '$ds' },
        { $match: { 'ds.is_primary': true } },
        { $lookup: { from: 'specialities', localField: 'ds.speciality_id', foreignField: '_id', as: 's' } },
        { $unwind: '$s' },
        { $group: { _id: '$s.name', c: { $sum: 1 } } },
        { $sort: { c: -1, _id: 1 } },
        { $limit: 20 },
        { $project: { _id: 0, name: '$_id', c: 1 } },
      ]);
      // Line items of diagnostic orders placed in range, by service name snapshot.
      const tests = await aggregate<{ name: string; c: bigint | number }>(prisma, 'diagnostic_orders', [
        { $match: between('created_at', query.from, query.to) },
        { $lookup: { from: 'diagnostic_order_items', localField: '_id', foreignField: 'order_id', as: 'i' } },
        { $unwind: '$i' },
        { $group: { _id: '$i.service_name', c: { $sum: 1 } } },
        { $sort: { c: -1, _id: 1 } },
        { $limit: 20 },
        { $project: { _id: 0, name: '$_id', c: 1 } },
      ]);
      return { dataSource: env.APP_ENV, specialities: specialities.map((x) => ({ name: x.name, count: n(x.c) })), tests: tests.map((x) => ({ name: x.name, count: n(x.c) })) };
    },
  });

  return r;
}
