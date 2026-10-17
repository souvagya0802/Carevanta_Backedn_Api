import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { defineRoute, IdParams } from '../../http/route.js';
import { prisma } from '../../lib/prisma.js';
import { audit, logSensitiveAccess } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { buildPage, cursorOrderBy, cursorWhere, PaginationQuery } from '../../lib/pagination.js';
import { DateTimeString, Reason, iso } from '../../http/dto.js';
import { getObject } from '../../lib/storage.js';
import { env } from '../../config/env.js';
import { authenticate, requirePermissions, type AuthContext } from '../../middleware/auth.js';
import { EXPORT_CATALOGUE, EXPORT_TYPES, MAX_ROWS, RETENTION_HOURS, exportInfo, runExportJob } from './exports.service.js';

const JobDto = z.object({ id: z.uuid(), exportType: z.string(), status: z.string() }).passthrough();
const jobDto = (j: any, requestedByName: string | null = null) => ({
  id: j.id,
  exportType: j.exportType,
  filters: j.filters,
  purpose: j.purpose,
  status: j.status,
  requestedById: j.requestedById,
  requestedByName,
  rowCount: j.rowCount,
  truncated: j.rowCount != null && j.rowCount >= MAX_ROWS,
  error: j.error,
  downloadCount: j.downloadCount,
  expiresAt: iso(j.expiresAt),
  expired: !!(j.expiresAt && j.expiresAt < new Date()),
  startedAt: iso(j.startedAt),
  completedAt: iso(j.completedAt),
  createdAt: j.createdAt.toISOString(),
});

/** Names for the requesters on one page of jobs (the job table has no relation to users on purpose: jobs outlive anonymisation). */
async function requesterNames(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: Array.from(new Set(ids)) } }, select: { id: true, fullName: true } });
  return new Map(users.map((u) => [u.id, u.fullName]));
}

export function exportsRouter(): Router {
  const r = Router();
  const base = '/admin/exports';
  const tags = ['Admin · Exports'];

  defineRoute(r, base, {
    kind: 'list',
    method: 'get',
    path: '',
    summary: 'Export jobs',
    tags,
    permissions: ['exports.read'],
    query: PaginationQuery,
    response: JobDto,
    handler: async ({ query }) => {
      const rows = await prisma.exportJob.findMany({ where: cursorWhere(query.cursor), orderBy: cursorOrderBy(), take: query.limit + 1 });
      const { items, page } = buildPage(rows, query.limit, (j) => j.createdAt);
      const names = await requesterNames(items.map((j) => j.requestedById));
      return { items: items.map((j) => jobDto(j, names.get(j.requestedById) ?? null)), page };
    },
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/options',
    summary: 'Data sets available for export, their filters and limits',
    tags,
    permissions: ['exports.read'],
    response: z.object({
      maxRows: z.number().int(),
      retentionHours: z.number().int(),
      processing: z.enum(['inline', 'background']),
      types: z.array(z.object({ type: z.string(), label: z.string(), description: z.string(), statuses: z.array(z.string()), supportsProvider: z.boolean(), dateField: z.string(), requiresRange: z.boolean(), columns: z.array(z.string()) })),
    }),
    handler: async () => ({ maxRows: MAX_ROWS, retentionHours: RETENTION_HOURS, processing: env.JOBS_ENABLED ? ('background' as const) : ('inline' as const), types: EXPORT_CATALOGUE.map((c) => ({ ...c, statuses: [...c.statuses], columns: [...c.columns] })) }),
  });

  defineRoute(r, base, {
    method: 'post',
    path: '',
    summary: 'Request a CSV export (processed in the background; ≤ 50,000 rows)',
    tags,
    permissions: ['exports.create'],
    body: z.object({
      exportType: z.enum(EXPORT_TYPES),
      purpose: Reason,
      filters: z.object({ from: DateTimeString.optional(), to: DateTimeString.optional(), status: z.string().max(40).optional(), providerId: z.uuid().optional() }).default({}),
    }),
    response: JobDto,
    handler: async ({ body, auth }) => {
      const info = exportInfo(body.exportType);
      const f = body.filters;
      if (f.from && f.to && new Date(f.from) >= new Date(f.to)) throw badRequest('`from` must be before `to`');
      if (info.requiresRange && (!f.from || !f.to)) throw badRequest(`A from/to date range is required for ${info.label} exports`, { field: 'filters.from' });
      if (f.status && !info.statuses.includes(f.status)) throw badRequest(`Unknown status "${f.status}" for ${info.label}`, { field: 'filters.status', allowed: info.statuses });
      if (f.providerId && !info.supportsProvider) throw badRequest(`${info.label} exports cannot be filtered by provider`, { field: 'filters.providerId' });
      if (f.providerId && !(await prisma.provider.findUnique({ where: { id: f.providerId }, select: { id: true } }))) throw notFound('Provider');
      const job = await prisma.exportJob.create({ data: { exportType: body.exportType, purpose: body.purpose, filters: body.filters, requestedById: auth.userId } });
      await audit(prisma, { action: 'export.requested', entityType: 'export_job', entityId: job.id, metadata: { exportType: body.exportType, purpose: body.purpose } });
      // Without a worker (tests, single-process dev) run inline so the job completes.
      if (!env.JOBS_ENABLED) await runExportJob(job.id);
      return jobDto(await prisma.exportJob.findUniqueOrThrow({ where: { id: job.id } }), (await requesterNames([auth.userId])).get(auth.userId) ?? null);
    },
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/:id',
    summary: 'Export job status',
    tags,
    permissions: ['exports.read'],
    params: IdParams,
    response: JobDto,
    handler: async ({ params }) => {
      const j = await prisma.exportJob.findUnique({ where: { id: params.id } });
      if (!j) throw notFound('Export job');
      return jobDto(j, (await requesterNames([j.requestedById])).get(j.requestedById) ?? null);
    },
  });

  r.get(`${base}/:id/download`, authenticate, requirePermissions(['exports.read']), async (req: Request, res: Response) => {
    const auth = res.locals.auth as AuthContext;
    const params = IdParams.safeParse(req.params);
    if (!params.success) throw badRequest('Invalid id');
    const j = await prisma.exportJob.findUnique({ where: { id: params.data.id } });
    if (!j || j.status !== 'COMPLETED' || !j.storageKey) throw notFound('Completed export');
    if (j.expiresAt && j.expiresAt < new Date()) throw conflict('This export has expired; request it again');
    await logSensitiveAccess(prisma, { resourceType: 'EXPORT', resourceId: j.id, purpose: `Download ${j.exportType} export`, granted: true, actorUserId: auth.userId });
    await prisma.exportJob.update({ where: { id: j.id }, data: { downloadCount: { increment: 1 } } });
    const buf = await getObject(j.storageKey);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="carevanta-${j.exportType}-${j.id.slice(0, 8)}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  });

  return r;
}
