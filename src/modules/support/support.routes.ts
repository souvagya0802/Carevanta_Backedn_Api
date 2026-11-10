import { Router } from 'express';
import { notifyUsersWithPermission } from '../notifications/events.js';
import { emailUsers } from '../notifications/email-events.js';
import { z } from 'zod';
import { defineRoute, IdParams } from '../../http/route.js';
import { prisma } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { assertTransition, type TransitionMap } from '../../lib/state-machine.js';
import { buildPage, cursorOrderBy, cursorWhere, PaginationQuery } from '../../lib/pagination.js';
import { makeReference, REF } from '../../lib/reference.js';
import { DateTimeString, SearchText, iso } from '../../http/dto.js';
import type { Prisma, SupportCasePriority, SupportCaseStatus, SupportCaseType } from '../../../generated/prisma/client.js';

export const SUPPORT_TRANSITIONS: TransitionMap<SupportCaseStatus> = {
  OPEN: ['IN_PROGRESS', 'AWAITING_REPORTER', 'ESCALATED', 'RESOLVED', 'CLOSED'],
  IN_PROGRESS: ['AWAITING_REPORTER', 'ESCALATED', 'RESOLVED', 'CLOSED'],
  AWAITING_REPORTER: ['IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  ESCALATED: ['IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  RESOLVED: ['CLOSED', 'IN_PROGRESS'], // reopen
  CLOSED: [],
};

/** Hours to first resolution, by priority. Served to the UI so it never guesses. */
const SLA_HOURS: Record<SupportCasePriority, number> = { LOW: 120, MEDIUM: 72, HIGH: 24, URGENT: 4 };

/** Suggested categories per type — operators may still type their own. */
const CATEGORIES: Record<SupportCaseType, string[]> = {
  COMPLAINT: ['LATE_REPORT', 'RUDE_BEHAVIOUR', 'LONG_WAIT', 'WRONG_REPORT', 'HYGIENE', 'NO_SHOW_BY_PROVIDER', 'MISLEADING_LISTING', 'OTHER'],
  DISPUTE: ['OVERCHARGE', 'DOUBLE_CHARGE', 'SERVICE_NOT_PROVIDED', 'PARTIAL_SERVICE', 'COMMISSION_DISPUTE', 'SETTLEMENT_MISMATCH', 'OTHER'],
  SUPPORT: ['LOGIN_ISSUE', 'BOOKING_HELP', 'PROFILE_UPDATE', 'APP_BUG', 'FEATURE_REQUEST', 'OTHER'],
  REFUND_REQUEST: ['CANCELLED_BY_PROVIDER', 'CANCELLED_BY_PATIENT', 'SERVICE_NOT_PROVIDED', 'DUPLICATE_PAYMENT', 'OTHER'],
  PROVIDER_REPORT: ['FAKE_CREDENTIALS', 'UNLICENSED_PRACTICE', 'PATIENT_SAFETY', 'FRAUD', 'OTHER'],
};
/** Statuses that count as "open" for workload and SLA purposes. */
const OPEN_STATUSES: SupportCaseStatus[] = ['OPEN', 'IN_PROGRESS', 'AWAITING_REPORTER', 'ESCALATED'];

const StatusEnum = z.enum(['OPEN', 'IN_PROGRESS', 'AWAITING_REPORTER', 'ESCALATED', 'RESOLVED', 'CLOSED']);
const PriorityEnum = z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']);
const TypeEnum = z.enum(['COMPLAINT', 'DISPUTE', 'SUPPORT', 'REFUND_REQUEST', 'PROVIDER_REPORT']);
const Passthrough = z.object({ id: z.uuid() }).passthrough();

const include = {
  provider: { select: { id: true, displayName: true } },
  transaction: { select: { id: true, reference: true } },
} satisfies Prisma.SupportCaseInclude;

type CaseRow = Prisma.SupportCaseGetPayload<{ include: typeof include }>;

/** Display names for the people on a page of cases (assignee, reporter, creator) in one query. */
async function namesFor(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids.filter((x): x is string => !!x)));
  if (unique.length === 0) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, fullName: true } });
  return new Map(users.map((u) => [u.id, u.fullName]));
}

function caseDto(c: CaseRow, names: Map<string, string>) {
  const now = Date.now();
  const open = OPEN_STATUSES.includes(c.status);
  return {
    id: c.id,
    reference: c.reference,
    type: c.type,
    category: c.category,
    priority: c.priority,
    status: c.status,
    subject: c.subject,
    description: c.description,
    reporterUserId: c.reporterUserId,
    reporterName: c.reporterUserId ? (names.get(c.reporterUserId) ?? null) : null,
    provider: c.provider,
    transaction: c.transaction,
    assignedToId: c.assignedToId,
    assignedToName: c.assignedToId ? (names.get(c.assignedToId) ?? null) : null,
    createdById: c.createdById,
    createdByName: c.createdById ? (names.get(c.createdById) ?? null) : null,
    slaDueAt: iso(c.slaDueAt),
    slaHours: SLA_HOURS[c.priority],
    slaBreached: !!(c.slaDueAt && open && c.slaDueAt.getTime() < now),
    /** Minutes until the SLA is due (negative when overdue); null once the case is no longer open. */
    slaRemainingMinutes: c.slaDueAt && open ? Math.round((c.slaDueAt.getTime() - now) / 60_000) : null,
    resolution: c.resolution,
    resolvedAt: iso(c.resolvedAt),
    resolutionHours: c.resolvedAt ? Math.round(((c.resolvedAt.getTime() - c.createdAt.getTime()) / 3_600_000) * 10) / 10 : null,
    /** Whether the case was resolved inside its SLA (null while still open). */
    resolvedWithinSla: c.resolvedAt && c.slaDueAt ? c.resolvedAt.getTime() <= c.slaDueAt.getTime() : null,
    allowedTransitions: [...SUPPORT_TRANSITIONS[c.status]],
    version: c.version,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

async function load(id: string) {
  const c = await prisma.supportCase.findUnique({ where: { id }, include });
  if (!c) throw notFound('Support case');
  return caseDto(c, await namesFor([c.assignedToId, c.reporterUserId, c.createdById]));
}

export function supportRouter(): Router {
  const r = Router();
  const base = '/admin/support-cases';
  const tags = ['Admin · Support'];

  defineRoute(r, base, {
    kind: 'list',
    method: 'get',
    path: '',
    summary: 'Complaints, disputes and support cases',
    tags,
    permissions: ['support.read'],
    query: PaginationQuery.extend({
      q: SearchText.optional(),
      status: StatusEnum.optional(),
      openOnly: z.enum(['true', 'false']).optional(),
      priority: PriorityEnum.optional(),
      type: TypeEnum.optional(),
      category: z.string().max(64).optional(),
      assignedToMe: z.enum(['true', 'false']).optional(),
      unassignedOnly: z.enum(['true', 'false']).optional(),
      assignedToId: z.uuid().optional(),
      providerId: z.uuid().optional(),
      reporterUserId: z.uuid().optional(),
      transactionId: z.uuid().optional(),
      breachedOnly: z.enum(['true', 'false']).optional(),
      dueWithinHours: z.coerce.number().int().min(1).max(720).optional(),
      from: DateTimeString.optional(),
      to: DateTimeString.optional(),
    }),
    response: Passthrough,
    handler: async ({ query, auth }) => {
      const now = new Date();
      const where: Prisma.SupportCaseWhereInput = {
        ...(query.q ? { OR: [{ reference: { contains: query.q.toUpperCase() } }, { subject: { contains: query.q, mode: 'insensitive' } }] } : {}),
        ...(query.status ? { status: query.status } : query.openOnly === 'true' ? { status: { in: OPEN_STATUSES } } : {}),
        ...(query.priority ? { priority: query.priority } : {}),
        ...(query.type ? { type: query.type } : {}),
        ...(query.category ? { category: query.category.toUpperCase() } : {}),
        ...(query.assignedToMe === 'true' ? { assignedToId: auth.userId } : query.unassignedOnly === 'true' ? { assignedToId: null } : query.assignedToId ? { assignedToId: query.assignedToId } : {}),
        ...(query.providerId ? { providerId: query.providerId } : {}),
        ...(query.reporterUserId ? { reporterUserId: query.reporterUserId } : {}),
        ...(query.transactionId ? { transactionId: query.transactionId } : {}),
        ...(query.breachedOnly === 'true' ? { slaDueAt: { lt: now }, status: { in: OPEN_STATUSES } } : {}),
        ...(query.dueWithinHours ? { slaDueAt: { gte: now, lt: new Date(now.getTime() + query.dueWithinHours * 3_600_000) }, status: { in: OPEN_STATUSES } } : {}),
        ...(query.from || query.to ? { createdAt: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lt: new Date(query.to) } : {}) } } : {}),
        ...cursorWhere(query.cursor),
      };
      const rows = await prisma.supportCase.findMany({ where, include, orderBy: cursorOrderBy(), take: query.limit + 1 });
      const { items, page } = buildPage(rows, query.limit, (c) => c.createdAt);
      const names = await namesFor(items.flatMap((c) => [c.assignedToId, c.reporterUserId, c.createdById]));
      return { items: items.map((c) => caseDto(c, names)), page };
    },
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/options',
    summary: 'Reference data for the support desk: types, categories, priorities with SLA, transitions, and who can be assigned',
    tags,
    permissions: ['support.read'],
    response: z.object({
      types: z.array(z.object({ type: z.string(), categories: z.array(z.string()) })),
      priorities: z.array(z.object({ priority: z.string(), slaHours: z.number().int() })),
      statuses: z.array(z.string()),
      openStatuses: z.array(z.string()),
      transitions: z.record(z.string(), z.array(z.string())),
      agents: z.array(z.object({ id: z.uuid(), fullName: z.string() })),
    }),
    handler: async () => {
      // Anyone holding support.manage through an active role on an active account can be assigned.
      const agents = await prisma.user.findMany({
        where: { status: 'ACTIVE', roles: { some: { revokedAt: null, role: { permissions: { some: { permission: { key: 'support.manage' } } } } } } },
        select: { id: true, fullName: true },
        orderBy: { fullName: 'asc' },
        take: 200,
      });
      return {
        types: TypeEnum.options.map((type) => ({ type, categories: CATEGORIES[type] })),
        priorities: PriorityEnum.options.map((priority) => ({ priority, slaHours: SLA_HOURS[priority] })),
        statuses: StatusEnum.options,
        openStatuses: OPEN_STATUSES,
        transitions: Object.fromEntries(Object.entries(SUPPORT_TRANSITIONS).map(([k, v]) => [k, [...v]])),
        agents,
      };
    },
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/stats',
    summary: 'Support desk health: open workload, SLA breaches, what is due soon, and 7-day resolution figures',
    tags,
    permissions: ['support.read'],
    response: z.object({
      byStatus: z.record(z.string(), z.number().int()),
      byPriorityOpen: z.record(z.string(), z.number().int()),
      open: z.number().int(),
      unassigned: z.number().int(),
      breached: z.number().int(),
      dueWithin4h: z.number().int(),
      mine: z.number().int(),
      resolved7d: z.number().int(),
      resolvedWithinSla7d: z.number().int(),
      avgResolutionHours7d: z.number().nullable(),
    }),
    handler: async ({ auth }) => {
      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
      const openWhere = { status: { in: OPEN_STATUSES } } as const;
      const [byStatus, byPriorityOpen, unassigned, breached, dueSoon, mine, resolved, resolvedRows] = await Promise.all([
        prisma.supportCase.groupBy({ by: ['status'], _count: { _all: true } }),
        prisma.supportCase.groupBy({ by: ['priority'], _count: { _all: true }, where: openWhere }),
        prisma.supportCase.count({ where: { ...openWhere, assignedToId: null } }),
        prisma.supportCase.count({ where: { ...openWhere, slaDueAt: { lt: now } } }),
        prisma.supportCase.count({ where: { ...openWhere, slaDueAt: { gte: now, lt: new Date(now.getTime() + 4 * 3_600_000) } } }),
        prisma.supportCase.count({ where: { ...openWhere, assignedToId: auth.userId } }),
        prisma.supportCase.count({ where: { resolvedAt: { gte: weekAgo } } }),
        prisma.supportCase.findMany({ where: { resolvedAt: { gte: weekAgo } }, select: { createdAt: true, resolvedAt: true, slaDueAt: true } }),
      ]);
      const hours = resolvedRows.map((c) => (c.resolvedAt!.getTime() - c.createdAt.getTime()) / 3_600_000);
      return {
        byStatus: Object.fromEntries(byStatus.map((x) => [x.status, x._count._all])),
        byPriorityOpen: Object.fromEntries(byPriorityOpen.map((x) => [x.priority, x._count._all])),
        open: byStatus.filter((x) => OPEN_STATUSES.includes(x.status)).reduce((s, x) => s + x._count._all, 0),
        unassigned,
        breached,
        dueWithin4h: dueSoon,
        mine,
        resolved7d: resolved,
        resolvedWithinSla7d: resolvedRows.filter((c) => c.slaDueAt && c.resolvedAt!.getTime() <= c.slaDueAt.getTime()).length,
        avgResolutionHours7d: hours.length ? Math.round((hours.reduce((s, h) => s + h, 0) / hours.length) * 10) / 10 : null,
      };
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '',
    summary: 'Open a case',
    tags,
    permissions: ['support.manage'],
    body: z.object({
      type: TypeEnum,
      category: z.string().trim().min(2).max(64),
      priority: PriorityEnum.default('MEDIUM'),
      subject: z.string().trim().min(3).max(200),
      description: z.string().trim().min(5).max(5000),
      reporterUserId: z.uuid().optional(),
      providerId: z.uuid().optional(),
      transactionId: z.uuid().optional(),
    }),
    response: Passthrough,
    handler: async ({ body, auth }) => {
      const id = await prisma.$transaction(async (tx) => {
        if (body.providerId && !(await tx.provider.findUnique({ where: { id: body.providerId }, select: { id: true } }))) throw badRequest('Unknown provider');
        if (body.transactionId && !(await tx.serviceTransaction.findUnique({ where: { id: body.transactionId }, select: { id: true } }))) throw badRequest('Unknown transaction');
        const c = await tx.supportCase.create({
          data: {
            reference: makeReference(REF.supportCase),
            ...body,
            createdById: auth.userId,
            slaDueAt: new Date(Date.now() + SLA_HOURS[body.priority] * 3_600_000),
          },
        });
        await tx.supportCaseEvent.create({ data: { caseId: c.id, authorId: auth.userId, kind: 'STATUS_CHANGE', body: 'Case opened', metadata: { to: 'OPEN' } } });
        await notifyUsersWithPermission(tx, 'support.manage', { key: 'admin.support_case_opened', title: `New support case · ${c.reference}`, body: `${c.subject} · ${String(c.priority).toLowerCase()} priority`, link: `/support?id=${c.id}`, level: 'important', meta: { kind: 'support_case', id: c.id, status: 'OPEN' }, exceptUserId: auth.userId });
        await audit(tx, { action: 'support_case.opened', entityType: 'support_case', entityId: c.id, metadata: { type: body.type, priority: body.priority } });
        return c.id;
      });
      return load(id);
    },
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/:id',
    summary: 'Case details',
    tags,
    permissions: ['support.read'],
    params: IdParams,
    response: Passthrough,
    handler: ({ params }) => load(params.id),
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/:id/events',
    summary: 'Case timeline (comments, status changes, assignments)',
    tags,
    permissions: ['support.read'],
    params: IdParams,
    response: z.array(Passthrough),
    handler: async ({ params }) => {
      if (!(await prisma.supportCase.findUnique({ where: { id: params.id }, select: { id: true } }))) throw notFound('Support case');
      const events = await prisma.supportCaseEvent.findMany({ where: { caseId: params.id }, orderBy: { createdAt: 'asc' } });
      const names = await namesFor(events.flatMap((e) => [e.authorId, (e.metadata as { assigneeId?: string } | null)?.assigneeId]));
      return events.map((e) => {
        const meta = (e.metadata ?? null) as { assigneeId?: string | null; from?: string; to?: string } | null;
        return {
          id: e.id,
          kind: e.kind,
          authorId: e.authorId,
          authorName: e.authorId ? (names.get(e.authorId) ?? null) : null,
          body: e.body,
          isInternal: e.isInternal,
          metadata: meta && meta.assigneeId ? { ...meta, assigneeName: names.get(meta.assigneeId) ?? null } : meta,
          createdAt: e.createdAt.toISOString(),
        };
      });
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/:id/comments',
    summary: 'Add a comment',
    tags,
    permissions: ['support.manage'],
    params: IdParams,
    body: z.object({ body: z.string().trim().min(1).max(5000), isInternal: z.boolean().default(true) }),
    response: Passthrough,
    handler: async ({ params, body, auth }) => {
      const c = await prisma.supportCase.findUnique({ where: { id: params.id } });
      if (!c) throw notFound('Support case');
      if (c.status === 'CLOSED') throw conflict('Case is closed');
      const e = await prisma.$transaction(async (tx) => {
        const ev = await tx.supportCaseEvent.create({ data: { caseId: c.id, authorId: auth.userId, kind: 'COMMENT', body: body.body, isInternal: body.isInternal } });
        // A reply the case owner can see is also emailed to them (internal notes are not).
        if (!body.isInternal) await emailUsers(tx, [c.reporterUserId], 'support.reply', { caseReference: c.reference }, auth.userId);
        return ev;
      });
      return { id: e.id, createdAt: e.createdAt.toISOString() };
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/:id/assign',
    summary: 'Assign a case',
    tags,
    status: 200,
    permissions: ['support.manage'],
    params: IdParams,
    body: z.object({ assigneeId: z.uuid().nullable() }),
    response: Passthrough,
    handler: async ({ params, body, auth }) => {
      await prisma.$transaction(async (tx) => {
        const c = await tx.supportCase.findUnique({ where: { id: params.id } });
        if (!c) throw notFound('Support case');
        if (c.status === 'CLOSED') throw conflict('Case is closed');
        if (body.assigneeId === c.assignedToId) throw conflict(body.assigneeId ? 'Already assigned to that agent' : 'Case is already unassigned');
        if (body.assigneeId) {
          const agent = await tx.user.findFirst({ where: { id: body.assigneeId, status: 'ACTIVE', roles: { some: { revokedAt: null, role: { permissions: { some: { permission: { key: 'support.manage' } } } } } } }, select: { id: true } });
          if (!agent) throw badRequest('Assignee must be an active user who can work support cases');
        }
        await tx.supportCase.update({
          where: { id: c.id },
          data: { assignedToId: body.assigneeId, version: { increment: 1 }, ...(c.status === 'OPEN' && body.assigneeId ? { status: 'IN_PROGRESS' } : {}) },
        });
        await tx.supportCaseEvent.create({ data: { caseId: c.id, authorId: auth.userId, kind: 'ASSIGNMENT', metadata: { assigneeId: body.assigneeId } } });
        await audit(tx, { action: 'support_case.assigned', entityType: 'support_case', entityId: c.id, metadata: { assigneeId: body.assigneeId } });
      });
      return load(params.id);
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/:id/status',
    summary: 'Change case status (resolution text required to resolve)',
    tags,
    status: 200,
    permissions: ['support.manage'],
    params: IdParams,
    body: z.object({ status: StatusEnum.exclude(['OPEN']), note: z.string().max(5000).optional(), expectedVersion: z.number().int().optional() }),
    response: Passthrough,
    handler: async ({ params, body, auth }) => {
      await prisma.$transaction(async (tx) => {
        const c = await tx.supportCase.findUnique({ where: { id: params.id } });
        if (!c) throw notFound('Support case');
        assertTransition('Support case', SUPPORT_TRANSITIONS, c.status, body.status);
        if (body.status === 'RESOLVED' && (body.note?.trim().length ?? 0) < 5) throw badRequest('A resolution note (at least 5 characters) is required', { field: 'note' });
        if (body.status === 'ESCALATED' && (body.note?.trim().length ?? 0) < 5) throw badRequest('Say why the case is being escalated', { field: 'note' });
        if (body.status === 'CLOSED' && c.status !== 'RESOLVED' && (body.note?.trim().length ?? 0) < 5) throw badRequest('Closing without resolving needs a reason', { field: 'note' });
        const res = await tx.supportCase.updateMany({
          where: { id: c.id, status: c.status, ...(body.expectedVersion ? { version: body.expectedVersion } : {}) },
          data: {
            status: body.status,
            version: { increment: 1 },
            ...(body.status === 'RESOLVED' ? { resolution: body.note, resolvedAt: new Date() } : {}),
            ...(body.status === 'IN_PROGRESS' && c.status === 'RESOLVED' ? { resolvedAt: null, resolution: null } : {}),
          },
        });
        if (res.count !== 1) throw conflict('The case changed concurrently');
        await tx.supportCaseEvent.create({
          data: { caseId: c.id, authorId: auth.userId, kind: body.status === 'ESCALATED' ? 'ESCALATION' : 'STATUS_CHANGE', body: body.note, metadata: { from: c.status, to: body.status } },
        });
        await audit(tx, { action: `support_case.${body.status.toLowerCase()}`, entityType: 'support_case', entityId: c.id, metadata: { from: c.status } });
      });
      return load(params.id);
    },
  });

  defineRoute(r, base, {
    method: 'patch',
    path: '/:id',
    summary: 'Edit priority or category',
    tags,
    permissions: ['support.manage'],
    params: IdParams,
    body: z.object({ priority: PriorityEnum.optional(), category: z.string().trim().min(2).max(64).optional() }).strict(),
    response: Passthrough,
    handler: async ({ params, body, auth }) => {
      await prisma.$transaction(async (tx) => {
        const c = await tx.supportCase.findUnique({ where: { id: params.id } });
        if (!c) throw notFound('Support case');
        if (c.status === 'CLOSED') throw conflict('Case is closed');
        await tx.supportCase.update({
          where: { id: c.id },
          data: { ...body, version: { increment: 1 }, ...(body.priority ? { slaDueAt: new Date(c.createdAt.getTime() + SLA_HOURS[body.priority] * 3_600_000) } : {}) },
        });
        await audit(tx, { action: 'support_case.updated', entityType: 'support_case', entityId: c.id, actorUserId: auth.userId, metadata: body });
      });
      return load(params.id);
    },
  });

  // ── Admin notes on any entity ──────────────────────────────────────────
  defineRoute(r, '/admin/notes', {
    method: 'get',
    path: '',
    summary: 'Internal notes on an entity',
    tags,
    permissions: ['support.read'],
    query: z.object({ subjectType: z.string().max(48), subjectId: z.uuid() }),
    response: z.array(Passthrough),
    handler: async ({ query }) =>
      (await prisma.adminNote.findMany({ where: query, orderBy: { createdAt: 'desc' }, take: 200 })).map((n) => ({ id: n.id, authorId: n.authorId, body: n.body, createdAt: n.createdAt.toISOString() })),
  });

  defineRoute(r, '/admin/notes', {
    method: 'post',
    path: '',
    summary: 'Add an internal note',
    tags,
    permissions: ['support.manage'],
    body: z.object({ subjectType: z.enum(['provider', 'user', 'transaction', 'appointment', 'support_case', 'dispatch_request']), subjectId: z.uuid(), body: z.string().trim().min(1).max(5000) }),
    response: Passthrough,
    handler: async ({ body, auth }) => {
      const n = await prisma.adminNote.create({ data: { ...body, authorId: auth.userId } });
      return { id: n.id, createdAt: n.createdAt.toISOString() };
    },
  });

  return r;
}
