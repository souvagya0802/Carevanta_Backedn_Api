import { notifyProviderStaff, notifyUsers } from '../notifications/events.js';
import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { defineRoute, IdParams } from '../../http/route.js';
import { prisma } from '../../lib/prisma.js';
import { audit, logSensitiveAccess } from '../../lib/audit.js';
import { badRequest, conflict, notFound, preconditionFailed } from '../../lib/errors.js';
import { assertTransition, type TransitionMap } from '../../lib/state-machine.js';
import { buildPage, cursorOrderBy, cursorWhere, PaginationQuery } from '../../lib/pagination.js';
import { makeReference, REF } from '../../lib/reference.js';
import { getObject, putObject } from '../../lib/storage.js';
import { DateTimeString, Pincode, iso, minor } from '../../http/dto.js';
import { env } from '../../config/env.js';
import { authenticate, requirePermissions, type AuthContext } from '../../middleware/auth.js';
import { assertProviderAccess } from '../providers/provider-access.js';
import { createTransaction, onServiceCompleted, onSourceCancelled } from '../finance/commission.service.js';
import type { DiagnosticOrderStatus, Prisma } from '../../../generated/prisma/client.js';

export const DIAGNOSTIC_TRANSITIONS: TransitionMap<DiagnosticOrderStatus> = {
  REQUESTED: ['CONFIRMED', 'REJECTED', 'CANCELLED'],
  CONFIRMED: ['SAMPLE_COLLECTED', 'CANCELLED'],
  SAMPLE_COLLECTED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['REPORT_READY'],
  REPORT_READY: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
  REJECTED: [],
};

const StatusEnum = z.enum(['REQUESTED', 'CONFIRMED', 'SAMPLE_COLLECTED', 'PROCESSING', 'REPORT_READY', 'COMPLETED', 'CANCELLED', 'REJECTED']);
const OrderDto = z.object({ id: z.uuid(), reference: z.string(), status: StatusEnum }).passthrough();

const include = {
  provider: { select: { id: true, displayName: true, type: true } },
  // The centre to visit (null for home collection): address and coordinates for maps and directions.
  location: { select: { id: true, name: true, addressLine1: true, city: true, district: true, pincode: true, latitude: true, longitude: true, phone: true } },
  patient: { select: { id: true, fullName: true } },
  items: true,
  reports: { orderBy: { version: 'asc' as const }, select: { id: true, version: true, status: true, publishedAt: true, correctionReason: true, supersedesId: true } },
  transaction: { select: { id: true, status: true, reference: true } },
} satisfies Prisma.DiagnosticOrderInclude;

function orderDto(o: Prisma.DiagnosticOrderGetPayload<{ include: typeof include }>) {
  return {
    id: o.id,
    reference: o.reference,
    status: o.status,
    provider: o.provider,
    location: o.location ?? null,
    patient: o.patient,
    collectionMode: o.collectionMode,
    collectionPincode: o.collectionPincode,
    scheduledAt: iso(o.scheduledAt),
    source: o.source,
    attribution: o.attribution,
    totalMinor: minor(o.totalMinor)!,
    currency: o.currency,
    statusReason: o.statusReason,
    items: o.items.map((i) => ({ id: i.id, serviceName: i.serviceName, priceMinor: minor(i.priceMinor)! })),
    reports: o.reports.map((r) => ({ ...r, publishedAt: iso(r.publishedAt) })),
    transaction: o.transaction,
    createdAt: o.createdAt.toISOString(),
  };
}

async function load(id: string) {
  const o = await prisma.diagnosticOrder.findUnique({ where: { id }, include });
  if (!o) throw notFound('Diagnostic order');
  return orderDto(o);
}
export const loadDiagnosticOrder = load;

/** Cursor page of orders; `where` is scoped by the caller (admin: any; portal: one lab). */
export async function listDiagnosticOrders(where: Prisma.DiagnosticOrderWhereInput, q: { limit: number; cursor?: string }) {
  const rows = await prisma.diagnosticOrder.findMany({ where: { ...where, ...cursorWhere(q.cursor) }, include, orderBy: cursorOrderBy(), take: q.limit + 1 });
  const { items, page } = buildPage(rows, q.limit, (o) => o.createdAt);
  return { items: items.map(orderDto), page };
}

/** Lab staff set or move the collection / visit time for an order that is still open. */
export async function scheduleDiagnosticOrder(providerId: string, orderId: string, scheduledAt: string, actorUserId: string) {
  const o = await prisma.diagnosticOrder.findFirst({ where: { id: orderId, providerId } });
  if (!o) throw notFound('Diagnostic order');
  if (!['REQUESTED', 'CONFIRMED'].includes(o.status)) throw conflict('Only requested or confirmed orders can be rescheduled');
  const when = new Date(scheduledAt);
  if (when.getTime() < Date.now() - 60_000) throw badRequest('The time must be in the future');
  await prisma.diagnosticOrder.update({ where: { id: orderId }, data: { scheduledAt: when, version: { increment: 1 } } });
  await audit(prisma, { action: 'diagnostic_order.scheduled', entityType: 'diagnostic_order', entityId: orderId, actorUserId, metadata: { scheduledAt: when.toISOString() } });
}

export async function createDiagnosticOrder(input: {
  patientProfileId: string;
  bookedByUserId: string;
  providerId: string;
  providerServiceIds: string[];
  collectionMode: 'CENTRE_VISIT' | 'HOME_COLLECTION';
  collectionPincode?: string;
  scheduledAt?: string;
  prescriptionId?: string;
  source: 'PATIENT_APP' | 'ADMIN_CONSOLE' | 'PROVIDER_PORTAL';
  attribution: 'PLATFORM' | 'ADMIN_ASSISTED' | 'PROVIDER_DIRECT';
  actorUserId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const provider = await tx.provider.findUnique({ where: { id: input.providerId }, include: { diagnosticProfile: true } });
    if (!provider || (provider.type !== 'DIAGNOSTIC_LAB' && provider.type !== 'IMAGING_CENTRE')) throw badRequest('Provider must be a laboratory or imaging centre');
    if (provider.status !== 'APPROVED') throw preconditionFailed('This provider is not accepting bookings');
    const offerings = await tx.providerService.findMany({ where: { id: { in: input.providerServiceIds }, providerId: provider.id, isActive: true }, include: { service: true } });
    if (offerings.length !== new Set(input.providerServiceIds).size) throw badRequest('One or more tests are not offered by this provider');
    if (input.collectionMode === 'HOME_COLLECTION') {
      if (!input.collectionPincode) throw badRequest('collectionPincode is required for home collection');
      if (offerings.some((o) => !o.homeServiceAvailable)) throw preconditionFailed('Some tests cannot be collected at home');
      const covered = await tx.providerServiceArea.count({
        where: { providerId: provider.id, purpose: 'HOME_COLLECTION', OR: [{ pincode: input.collectionPincode }, { pincode: null }] },
      });
      if (!covered) throw preconditionFailed('Home collection is not available at this PIN code');
    }
    if (offerings.some((o) => o.service.requiresPrescription)) {
      if (!input.prescriptionId) throw preconditionFailed('A prescription is required for one or more of these tests');
      const rx = await tx.prescription.findFirst({ where: { id: input.prescriptionId, patientProfileId: input.patientProfileId } });
      if (!rx) throw badRequest('Prescription not found for this patient');
    }
    const total = offerings.reduce((s, o) => s + o.priceMinor, 0n);
    const order = await tx.diagnosticOrder.create({
      data: {
        reference: makeReference(REF.diagnosticOrder),
        patientProfileId: input.patientProfileId,
        bookedByUserId: input.bookedByUserId,
        providerId: provider.id,
        collectionMode: input.collectionMode,
        collectionPincode: input.collectionPincode,
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
        prescriptionId: input.prescriptionId,
        source: input.source,
        attribution: input.attribution,
        totalMinor: total,
        items: { create: offerings.map((o) => ({ providerServiceId: o.id, serviceName: o.service.name, priceMinor: o.priceMinor })) },
      },
    });
    await createTransaction(tx, { sourceType: 'DIAGNOSTIC_ORDER', sourceId: order.id, providerId: provider.id, patientProfileId: input.patientProfileId, grossMinor: total, attribution: input.attribution, payAtProvider: true });
    await audit(tx, { action: 'diagnostic_order.created', entityType: 'diagnostic_order', entityId: order.id, actorUserId: input.actorUserId, metadata: { tests: offerings.length, collectionMode: input.collectionMode } });
    await notifyProviderStaff(tx, provider.id, 'manage_bookings', { key: 'portal.diagnostic_order_placed', title: 'New test order', body: `${order.reference} · ${offerings.length} test(s) · ${input.collectionMode === 'HOME_COLLECTION' ? 'home collection' : 'centre visit'}`, link: `/diagnostic-orders?id=${order.id}` });
    return order.id;
  });
}

export async function diagnosticAction(id: string, to: DiagnosticOrderStatus, actorUserId: string, reason?: string) {
  return prisma.$transaction(async (tx) => {
    const o = await tx.diagnosticOrder.findUnique({ where: { id }, include: { transaction: true, reports: true } });
    if (!o) throw notFound('Diagnostic order');
    assertTransition('Diagnostic order', DIAGNOSTIC_TRANSITIONS, o.status, to);
    if (to === 'REPORT_READY' && !o.reports.some((r) => r.status === 'PUBLISHED')) throw preconditionFailed('Publish a report first');
    if ((to === 'CANCELLED' || to === 'REJECTED') && !reason) throw badRequest('A reason is required');
    const res = await tx.diagnosticOrder.updateMany({
      where: { id, status: o.status, version: o.version },
      data: { status: to, statusReason: reason ?? null, version: { increment: 1 }, ...(to === 'COMPLETED' ? { completedAt: new Date() } : {}) },
    });
    if (res.count !== 1) throw conflict('The order changed concurrently');
    if ((to === 'CANCELLED' || to === 'REJECTED') && o.transaction) await onSourceCancelled(tx, o.transaction.id, actorUserId, reason!);
    if (to === 'COMPLETED' && o.transaction) await onServiceCompleted(tx, o.transaction.id, actorUserId);
    await audit(tx, { action: `diagnostic_order.${to.toLowerCase()}`, entityType: 'diagnostic_order', entityId: id, actorUserId, metadata: { from: o.status, to } });
  });
}

/** Publish a report version. Corrections create v+1 and keep prior versions. */
export async function publishReport(auth: AuthContext, orderId: string, file: Buffer, mimeType: string, correctionReason?: string) {
  const order = await prisma.diagnosticOrder.findUnique({ where: { id: orderId }, include: { reports: { orderBy: { version: 'desc' }, take: 1 } } });
  if (!order) throw notFound('Diagnostic order');
  if (!['PROCESSING', 'REPORT_READY', 'COMPLETED'].includes(order.status)) throw conflict('Reports can be published once the order is PROCESSING');
  const previous = order.reports[0];
  if (previous && !correctionReason) throw badRequest('A correction reason is required to publish a new version');
  const stored = await putObject(`reports/${order.providerId}`, file, mimeType);
  return prisma.$transaction(async (tx) => {
    if (previous) await tx.diagnosticReport.update({ where: { id: previous.id }, data: { status: 'AMENDED' } });
    const report = await tx.diagnosticReport.create({
      data: {
        orderId,
        version: (previous?.version ?? 0) + 1,
        status: 'PUBLISHED',
        storageKey: stored.key,
        sha256: stored.sha256,
        supersedesId: previous?.id ?? null,
        correctionReason: correctionReason ?? null,
        publishedById: auth.userId,
        publishedAt: new Date(),
      },
    });
    await audit(tx, { action: previous ? 'diagnostic_report.corrected' : 'diagnostic_report.published', entityType: 'diagnostic_order', entityId: orderId, metadata: { reportId: report.id, version: report.version } });
    const o = await tx.diagnosticOrder.findUnique({ where: { id: orderId }, select: { reference: true, patient: { select: { accountUserId: true } } } });
    if (o) await notifyUsers(tx, [o.patient.accountUserId], { key: 'patient.report_published', title: previous ? 'Your report was corrected' : 'Your report is ready', body: `Order ${o.reference}`, link: `/orders/${orderId}` });
    return report;
  });
}

export function diagnosticsRouter(): Router {
  const r = Router();
  const base = '/admin/diagnostic-orders';
  const tags = ['Admin · Diagnostics'];

  defineRoute(r, base, {
    kind: 'list',
    method: 'get',
    path: '',
    summary: 'Diagnostic orders',
    tags,
    permissions: ['diagnostics.read'],
    query: PaginationQuery.extend({ status: StatusEnum.optional(), providerId: z.uuid().optional() }),
    response: OrderDto,
    handler: ({ query }) => listDiagnosticOrders({ ...(query.status ? { status: query.status } : {}), ...(query.providerId ? { providerId: query.providerId } : {}) }, query),
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/:id',
    summary: 'Diagnostic order (report metadata only)',
    tags,
    permissions: ['diagnostics.read'],
    params: IdParams,
    response: OrderDto,
    handler: ({ params }) => load(params.id),
  });

  defineRoute(r, base, {
    method: 'post',
    path: '',
    summary: 'Assisted diagnostic booking',
    tags,
    idempotent: true,
    permissions: ['diagnostics.manage'],
    body: z.object({
      patientProfileId: z.uuid(),
      providerId: z.uuid(),
      providerServiceIds: z.array(z.uuid()).min(1).max(30),
      collectionMode: z.enum(['CENTRE_VISIT', 'HOME_COLLECTION']),
      collectionPincode: Pincode.optional(),
      scheduledAt: DateTimeString.optional(),
      prescriptionId: z.uuid().optional(),
    }),
    response: OrderDto,
    handler: async ({ body, auth }) => {
      const patient = await prisma.patientProfile.findUnique({ where: { id: body.patientProfileId } });
      if (!patient) throw notFound('Patient profile');
      const id = await createDiagnosticOrder({ ...body, bookedByUserId: patient.accountUserId, source: 'ADMIN_CONSOLE', attribution: 'ADMIN_ASSISTED', actorUserId: auth.userId });
      return load(id);
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/:id/status',
    summary: 'Advance or cancel a diagnostic order',
    tags,
    status: 200,
    permissions: ['diagnostics.manage'],
    params: IdParams,
    body: z.object({ status: StatusEnum.exclude(['REQUESTED']), reason: z.string().max(1000).optional() }),
    response: OrderDto,
    handler: async ({ params, body, auth }) => {
      await diagnosticAction(params.id, body.status, auth.userId, body.reason);
      return load(params.id);
    },
  });

  // Provider portal: lab staff publish reports for their own orders.
  defineRoute(r, '/portal/providers/:providerId/diagnostic-orders', {
    method: 'post',
    path: '/:id/reports',
    summary: 'Publish (or correct) a report — raw PDF body',
    tags: ['Provider portal · Diagnostics'],
    params: z.object({ providerId: z.uuid(), id: z.uuid() }),
    query: z.object({ correctionReason: z.string().min(5).max(1000).optional() }),
    middleware: [express.raw({ type: ['application/pdf'], limit: env.MAX_UPLOAD_BYTES })],
    response: z.object({ id: z.uuid(), version: z.number().int(), status: z.string() }),
    handler: async ({ params, query, req, auth }) => {
      await assertProviderAccess(auth, params.providerId, { capability: 'publish_reports' });
      const order = await prisma.diagnosticOrder.findUnique({ where: { id: params.id }, select: { providerId: true } });
      if (!order || order.providerId !== params.providerId) throw notFound('Diagnostic order');
      if (!Buffer.isBuffer(req.body)) throw badRequest('Send the PDF as the raw request body');
      const rep = await publishReport(auth, params.id, req.body, 'application/pdf', query.correctionReason);
      return { id: rep.id, version: rep.version, status: rep.status };
    },
  });

  defineRoute(r, '/portal/providers/:providerId/diagnostic-orders', {
    method: 'post',
    path: '/:id/status',
    summary: 'Lab staff: advance an order',
    tags: ['Provider portal · Diagnostics'],
    status: 200,
    params: z.object({ providerId: z.uuid(), id: z.uuid() }),
    body: z.object({ status: StatusEnum.exclude(['REQUESTED']), reason: z.string().max(1000).optional() }),
    response: OrderDto,
    handler: async ({ params, body, auth }) => {
      await assertProviderAccess(auth, params.providerId, { capability: 'manage_bookings' });
      const order = await prisma.diagnosticOrder.findUnique({ where: { id: params.id }, select: { providerId: true } });
      if (!order || order.providerId !== params.providerId) throw notFound('Diagnostic order');
      await diagnosticAction(params.id, body.status, auth.userId, body.reason);
      return load(params.id);
    },
  });

  // Report file: platform reviewers with a stated purpose, or the patient's account holder.
  r.get(`${base}/:id/reports/:reportId/file`, authenticate, requirePermissions(['diagnostics.reports.read']), async (req: Request, res: Response) => {
    const auth = res.locals.auth as AuthContext;
    const params = z.object({ id: z.uuid(), reportId: z.uuid() }).safeParse(req.params);
    const purpose = z.string().trim().min(5).max(300).safeParse(req.query.purpose);
    if (!params.success) throw badRequest('Invalid id');
    if (!purpose.success) throw badRequest('A ?purpose= is required to open a medical report');
    const report = await prisma.diagnosticReport.findFirst({ where: { id: params.data.reportId, orderId: params.data.id } });
    if (!report) throw notFound('Report');
    await logSensitiveAccess(prisma, { resourceType: 'DIAGNOSTIC_REPORT', resourceId: report.id, purpose: purpose.data, granted: true, actorUserId: auth.userId });
    const buf = await getObject(report.storageKey);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="report-v${report.version}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  });

  r.get('/patient/diagnostic-orders/:id/reports/:reportId/file', authenticate, async (req: Request, res: Response) => {
    const auth = res.locals.auth as AuthContext;
    const params = z.object({ id: z.uuid(), reportId: z.uuid() }).safeParse(req.params);
    if (!params.success) throw badRequest('Invalid id');
    const report = await prisma.diagnosticReport.findFirst({
      where: { id: params.data.reportId, orderId: params.data.id, status: { in: ['PUBLISHED', 'AMENDED'] } },
      include: { order: { include: { patient: { select: { accountUserId: true } } } } },
    });
    const allowed = !!report && report.order.patient.accountUserId === auth.userId;
    await logSensitiveAccess(prisma, { resourceType: 'DIAGNOSTIC_REPORT', resourceId: params.data.reportId, purpose: 'Patient viewing own report', granted: allowed, actorUserId: auth.userId });
    if (!report || !allowed) throw notFound('Report');
    const buf = await getObject(report.storageKey);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  });

  return r;
}
