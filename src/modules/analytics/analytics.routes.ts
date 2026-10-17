import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../http/route.js';
import { prisma, Prisma } from '../../lib/prisma.js';
import { badRequest } from '../../lib/errors.js';
import { DateTimeString } from '../../http/dto.js';
import { env } from '../../config/env.js';

/**
 * Dashboard metrics. Every number is an aggregate query over real rows — there
 * is no synthetic fallback. `dataSource` tells the UI which environment the
 * figures come from so demo data can be labelled.
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

async function groupCount<K extends string>(sql: Prisma.Sql): Promise<Record<K, number>> {
  const rows = await prisma.$queryRaw<{ k: K; c: bigint }[]>(sql);
  return Object.fromEntries(rows.map((r) => [r.k, n(r.c)])) as Record<K, number>;
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
      const [users, providersByType, providersByStatus, pendingCases, apptPeriod, apptToday, dxPeriod, rxPeriod, dispatchActive, finance, refunds, failedPayments, payables, settlements, support] = await Promise.all([
        groupCount<string>(Prisma.sql`SELECT status AS k, count(*)::bigint AS c FROM users GROUP BY 1`),
        groupCount<string>(Prisma.sql`SELECT type AS k, count(*)::bigint AS c FROM providers WHERE status = 'APPROVED' GROUP BY 1`),
        groupCount<string>(Prisma.sql`SELECT status AS k, count(*)::bigint AS c FROM providers GROUP BY 1`),
        prisma.verificationCase.count({ where: { status: { in: ['OPEN', 'IN_REVIEW', 'AWAITING_PROVIDER'] } } }),
        groupCount<string>(Prisma.sql`SELECT status AS k, count(*)::bigint AS c FROM appointments WHERE created_at >= ${from} AND created_at < ${to} GROUP BY 1`),
        prisma.$queryRaw<{ c: bigint }[]>`SELECT count(*)::bigint AS c FROM appointments a JOIN appointment_slots s ON s.id = a.slot_id WHERE s.starts_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata' AND s.starts_at < (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') + interval '1 day') AT TIME ZONE 'Asia/Kolkata' AND a.status IN ('REQUESTED','CONFIRMED','CHECKED_IN','COMPLETED')`,
        groupCount<string>(Prisma.sql`SELECT status AS k, count(*)::bigint AS c FROM diagnostic_orders WHERE created_at >= ${from} AND created_at < ${to} GROUP BY 1`),
        groupCount<string>(Prisma.sql`SELECT status AS k, count(*)::bigint AS c FROM pharmacy_orders WHERE created_at >= ${from} AND created_at < ${to} GROUP BY 1`),
        prisma.dispatchRequest.count({ where: { mode: 'LIVE', status: { notIn: ['COMPLETED', 'CANCELLED'] } } }),
        prisma.$queryRaw<{ gtv: bigint | null; commission: bigint | null; tax: bigint | null; txns: bigint }[]>`
          SELECT COALESCE(SUM(t.gross_minor - t.refunded_minor), 0)::bigint AS gtv,
                 COALESCE(SUM(c.commission_minor), 0)::bigint AS commission,
                 COALESCE(SUM(c.tax_minor), 0)::bigint AS tax,
                 count(DISTINCT t.id)::bigint AS txns
            FROM service_transactions t
            LEFT JOIN commission_snapshots c ON c.transaction_id = t.id AND c.status = 'FINAL'
           WHERE t.service_completed_at >= ${from} AND t.service_completed_at < ${to}`,
        prisma.$queryRaw<{ amount: bigint | null; c: bigint }[]>`SELECT COALESCE(SUM(amount_minor),0)::bigint AS amount, count(*)::bigint AS c FROM refunds WHERE status = 'SUCCEEDED' AND processed_at >= ${from} AND processed_at < ${to}`,
        prisma.payment.count({ where: { status: 'FAILED', createdAt: { gte: from, lt: to } } }),
        prisma.$queryRaw<{ amount: bigint | null; providers: bigint }[]>`SELECT COALESCE(SUM(amount_minor),0)::bigint AS amount, count(DISTINCT provider_id)::bigint AS providers FROM provider_ledger_entries WHERE settlement_item_id IS NULL`,
        groupCount<string>(Prisma.sql`SELECT status AS k, count(*)::bigint AS c FROM settlement_batches GROUP BY 1`),
        prisma.$queryRaw<{ open: bigint; breached: bigint; avg_hours: number | null }[]>`
          SELECT count(*) FILTER (WHERE status NOT IN ('RESOLVED','CLOSED'))::bigint AS open,
                 count(*) FILTER (WHERE status NOT IN ('RESOLVED','CLOSED') AND sla_due_at < now())::bigint AS breached,
                 AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600) FILTER (WHERE resolved_at >= ${from} AND resolved_at < ${to}) AS avg_hours
            FROM support_cases`,
      ]);
      const fin = finance[0]!;
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
      type Row = { bucket: Date; group: string | null; value: bigint | number };
      let rows: Row[];
      let unit = 'count';
      switch (query.metric) {
        case 'registrations':
          rows = await prisma.$queryRaw<Row[]>`SELECT date_trunc(${g}, created_at) AS bucket, NULL AS "group", count(*)::bigint AS value FROM users WHERE created_at >= ${from} AND created_at < ${to} GROUP BY 1 ORDER BY 1`;
          break;
        case 'appointments':
          rows = await prisma.$queryRaw<Row[]>`SELECT date_trunc(${g}, created_at) AS bucket, status::text AS "group", count(*)::bigint AS value FROM appointments WHERE created_at >= ${from} AND created_at < ${to} GROUP BY 1,2 ORDER BY 1`;
          break;
        case 'diagnostic_orders':
          rows = await prisma.$queryRaw<Row[]>`SELECT date_trunc(${g}, created_at) AS bucket, status::text AS "group", count(*)::bigint AS value FROM diagnostic_orders WHERE created_at >= ${from} AND created_at < ${to} GROUP BY 1,2 ORDER BY 1`;
          break;
        case 'pharmacy_orders':
          rows = await prisma.$queryRaw<Row[]>`SELECT date_trunc(${g}, created_at) AS bucket, status::text AS "group", count(*)::bigint AS value FROM pharmacy_orders WHERE created_at >= ${from} AND created_at < ${to} GROUP BY 1,2 ORDER BY 1`;
          break;
        case 'gtv':
          unit = 'INR_minor';
          rows = await prisma.$queryRaw<Row[]>`SELECT date_trunc(${g}, service_completed_at) AS bucket, category::text AS "group", COALESCE(SUM(gross_minor - refunded_minor),0)::bigint AS value FROM service_transactions WHERE service_completed_at >= ${from} AND service_completed_at < ${to} GROUP BY 1,2 ORDER BY 1`;
          break;
        case 'commission':
          unit = 'INR_minor';
          rows = await prisma.$queryRaw<Row[]>`SELECT date_trunc(${g}, calculated_at) AS bucket, NULL AS "group", COALESCE(SUM(commission_minor),0)::bigint AS value FROM commission_snapshots WHERE status = 'FINAL' AND calculated_at >= ${from} AND calculated_at < ${to} GROUP BY 1 ORDER BY 1`;
          break;
        case 'refunds':
          unit = 'INR_minor';
          rows = await prisma.$queryRaw<Row[]>`SELECT date_trunc(${g}, processed_at) AS bucket, NULL AS "group", COALESCE(SUM(amount_minor),0)::bigint AS value FROM refunds WHERE status = 'SUCCEEDED' AND processed_at >= ${from} AND processed_at < ${to} GROUP BY 1 ORDER BY 1`;
          break;
        case 'complaints':
          rows = await prisma.$queryRaw<Row[]>`SELECT date_trunc(${g}, created_at) AS bucket, type::text AS "group", count(*)::bigint AS value FROM support_cases WHERE created_at >= ${from} AND created_at < ${to} GROUP BY 1,2 ORDER BY 1`;
          break;
        case 'provider_applications':
          rows = await prisma.$queryRaw<Row[]>`SELECT date_trunc(${g}, created_at) AS bucket, to_status::text AS "group", count(*)::bigint AS value FROM provider_status_history WHERE to_status IN ('SUBMITTED','APPROVED','REJECTED') AND created_at >= ${from} AND created_at < ${to} GROUP BY 1,2 ORDER BY 1`;
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
      const providers = await prisma.$queryRaw<{ district: string; type: string; c: bigint }[]>`
        SELECT l.district, p.type::text AS type, count(DISTINCT p.id)::bigint AS c
          FROM providers p JOIN provider_locations l ON l.provider_id = p.id AND l.is_active
         WHERE p.status = 'APPROVED' GROUP BY 1,2 ORDER BY 1,2`;
      const bookings = await prisma.$queryRaw<{ district: string; c: bigint }[]>`
        SELECT l.district, count(*)::bigint AS c FROM appointments a JOIN provider_locations l ON l.id = a.location_id
         WHERE a.created_at >= ${query.from} AND a.created_at < ${query.to} GROUP BY 1 ORDER BY 2 DESC`;
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
      const specialities = await prisma.$queryRaw<{ name: string; c: bigint }[]>`
        SELECT s.name, count(*)::bigint AS c
          FROM appointments a JOIN doctor_specialities ds ON ds.doctor_provider_id = a.doctor_provider_id AND ds.is_primary
          JOIN specialities s ON s.id = ds.speciality_id
         WHERE a.created_at >= ${query.from} AND a.created_at < ${query.to} GROUP BY 1 ORDER BY 2 DESC LIMIT 20`;
      const tests = await prisma.$queryRaw<{ name: string; c: bigint }[]>`
        SELECT i.service_name AS name, count(*)::bigint AS c FROM diagnostic_order_items i JOIN diagnostic_orders o ON o.id = i.order_id
         WHERE o.created_at >= ${query.from} AND o.created_at < ${query.to} GROUP BY 1 ORDER BY 2 DESC LIMIT 20`;
      return { dataSource: env.APP_ENV, specialities: specialities.map((x) => ({ name: x.name, count: n(x.c) })), tests: tests.map((x) => ({ name: x.name, count: n(x.c) })) };
    },
  });

  return r;
}
