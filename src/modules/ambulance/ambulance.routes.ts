import { notifyProviderStaffMany, notifyUsers, notifyUsersWithPermission, type NoticeLevel } from '../notifications/events.js';
import { emailUsers, titleCaseStatus } from '../notifications/email-events.js';
import { Router } from 'express';
import { z } from 'zod';
import { defineRoute, IdParams } from '../../http/route.js';
import { prisma, type Tx } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, isPgError, notFound, preconditionFailed } from '../../lib/errors.js';
import { assertTransition, type TransitionMap } from '../../lib/state-machine.js';
import { buildPage, cursorOrderBy, cursorWhere, PaginationQuery } from '../../lib/pagination.js';
import { makeReference, REF } from '../../lib/reference.js';
import { DateString, Phone, Reason, dec, iso, isoDate } from '../../http/dto.js';
import { getSetting } from '../settings/settings.service.js';
import { assertProviderAccess } from '../providers/provider-access.js';
import type { DispatchStatus, Prisma } from '../../../generated/prisma/client.js';

/**
 * Emergency dispatch — safety rules:
 *  1. Every emergency response tells the caller to dial 112 first. Carevanta
 *     is not a replacement for the public emergency service.
 *  2. A request is only ACCEPTED when an ambulance operator confirms it
 *     (operator app action, or an operator phone confirmation recorded by an
 *     authorised dispatcher). Nothing else can produce "ambulance assigned".
 *  3. When live dispatch is disabled (default) or no operator covers the area,
 *     the request is recorded as NO_PROVIDER_AVAILABLE and the response says so.
 *  4. TEST-mode requests (drills) never notify operators and are labelled.
 */
export const DISPATCH_TRANSITIONS: TransitionMap<DispatchStatus> = {
  RECEIVED: ['SEARCHING', 'NO_PROVIDER_AVAILABLE', 'CANCELLED', 'ESCALATED'],
  SEARCHING: ['OFFERED', 'NO_PROVIDER_AVAILABLE', 'CANCELLED', 'ESCALATED'],
  OFFERED: ['ACCEPTED', 'NO_PROVIDER_AVAILABLE', 'CANCELLED', 'ESCALATED'],
  ACCEPTED: ['EN_ROUTE', 'CANCELLED', 'ESCALATED'],
  EN_ROUTE: ['ARRIVED', 'CANCELLED', 'ESCALATED'],
  ARRIVED: ['PATIENT_ONBOARD', 'COMPLETED', 'CANCELLED'],
  PATIENT_ONBOARD: ['AT_DESTINATION', 'ESCALATED'],
  AT_DESTINATION: ['COMPLETED'],
  NO_PROVIDER_AVAILABLE: ['ESCALATED', 'SEARCHING', 'CANCELLED'],
  ESCALATED: ['SEARCHING', 'OFFERED', 'ACCEPTED', 'COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

const Passthrough = z.object({ id: z.uuid() }).passthrough();

const DISPATCH_QUIET: readonly DispatchStatus[] = ['RECEIVED', 'SEARCHING', 'OFFERED'];

async function moveDispatch(tx: Tx, id: string, to: DispatchStatus, actor: { userId: string | null; kind: string }, note?: string) {
  const d = await tx.dispatchRequest.findUnique({ where: { id } });
  if (!d) throw notFound('Dispatch request');
  assertTransition('Dispatch', DISPATCH_TRANSITIONS, d.status, to);
  const res = await tx.dispatchRequest.updateMany({
    where: { id, status: d.status, version: d.version },
    data: {
      status: to,
      version: { increment: 1 },
      ...(to === 'ESCALATED' ? { escalatedAt: new Date(), escalationNote: note ?? null } : {}),
      ...(to === 'COMPLETED' || to === 'CANCELLED' ? { closedAt: new Date(), closeReason: note ?? null } : {}),
    },
  });
  if (res.count !== 1) throw conflict('The request changed concurrently');
  await tx.dispatchEvent.create({ data: { requestId: id, fromStatus: d.status, toStatus: to, actorUserId: actor.userId, actorKind: actor.kind, note } });
  await notifyDispatchChange(tx, { id, reference: d.reference, requestedByUserId: d.requestedByUserId }, to);
  // The requester is emailed on every step that matters to them (not the seconds-long search/offer phase).
  if (!DISPATCH_QUIET.includes(to)) await emailUsers(tx, [d.requestedByUserId], 'dispatch.status_changed', { reference: d.reference, status: titleCaseStatus(to) }, actor.userId);
  return d;
}

const DISPATCH_PATIENT_MESSAGES: Partial<Record<DispatchStatus, { title: string; body: string; level: NoticeLevel }>> = {
  ARRIVED: { title: 'Ambulance has arrived', body: 'The ambulance is at the pickup point.', level: 'critical' },
  COMPLETED: { title: 'Trip completed', body: 'Your emergency trip is complete. We hope everyone is safe.', level: 'light' },
  NO_PROVIDER_AVAILABLE: { title: 'No ambulance available right now', body: 'Please call 112 immediately. We will keep trying to find an operator.', level: 'critical' },
  ESCALATED: { title: 'Your request was escalated', body: 'Carevanta support is handling it. If the situation worsens, call 112.', level: 'critical' },
};

/** The patient follows the trip live; platform staff are pulled in when nobody can respond. */
async function notifyDispatchChange(tx: Tx, d: { id: string; reference: string; requestedByUserId: string | null }, to: DispatchStatus) {
  const meta = { kind: 'dispatch' as const, id: d.id, status: to };
  const m = DISPATCH_PATIENT_MESSAGES[to];
  if (m && d.requestedByUserId) await notifyUsers(tx, [d.requestedByUserId], { key: `dispatch.${to.toLowerCase()}`, title: m.title, body: `${m.body} (${d.reference})`, link: `/emergency/${d.id}`, level: m.level, meta });
  if (to === 'NO_PROVIDER_AVAILABLE' || to === 'ESCALATED') {
    await notifyUsersWithPermission(tx, 'dispatch.manage', { key: 'admin.dispatch_attention', title: to === 'ESCALATED' ? `Emergency escalated · ${d.reference}` : `No ambulance available · ${d.reference}`, body: 'An emergency request needs a human now.', link: '/dispatch', level: 'critical', meta });
  }
}

const include = {
  assignments: { include: { operator: { select: { id: true, displayName: true } }, vehicle: { select: { id: true, registrationNumber: true, vehicleType: true } } }, orderBy: { offeredAt: 'asc' as const } },
  events: { orderBy: { createdAt: 'asc' as const } },
} satisfies Prisma.DispatchRequestInclude;

export function dispatchDto(d: Prisma.DispatchRequestGetPayload<{ include: typeof include }>) {
  const accepted = d.assignments.find((a) => a.status === 'ACCEPTED' || a.status === 'COMPLETED');
  return {
    id: d.id,
    reference: d.reference,
    mode: d.mode,
    isTest: d.mode === 'TEST',
    status: d.status,
    pickupDistrict: d.pickupDistrict,
    pickupLatitude: dec(d.pickupLatitude),
    pickupLongitude: dec(d.pickupLongitude),
    pickupAddress: d.pickupAddress ?? null,
    requiredVehicleType: d.requiredVehicleType,
    // Only true when an operator confirmed — never inferred.
    ambulanceConfirmed: !!accepted,
    confirmedBy: accepted ? { operator: accepted.operator, vehicle: accepted.vehicle, confirmationSource: accepted.confirmationSource, etaMinutes: accepted.etaMinutes } : null,
    escalatedAt: iso(d.escalatedAt),
    escalationNote: d.escalationNote,
    closedAt: iso(d.closedAt),
    createdAt: d.createdAt.toISOString(),
    assignments: d.assignments.map((a) => ({
      id: a.id,
      operator: a.operator,
      vehicle: a.vehicle,
      status: a.status,
      confirmationSource: a.confirmationSource,
      offeredAt: a.offeredAt.toISOString(),
      respondedAt: iso(a.respondedAt),
      etaMinutes: a.etaMinutes,
    })),
    events: d.events.map((e) => ({ fromStatus: e.fromStatus, toStatus: e.toStatus, actorKind: e.actorKind, note: e.note, createdAt: e.createdAt.toISOString() })),
  };
}

export async function loadDispatch(id: string) {
  const d = await prisma.dispatchRequest.findUnique({ where: { id }, include });
  if (!d) throw notFound('Dispatch request');
  return dispatchDto(d);
}

async function openRequest(input: {
  mode: 'LIVE' | 'TEST';
  requestedByUserId: string | null;
  callerPhone?: string;
  latitude?: number;
  longitude?: number;
  address?: string;
  district?: string;
  requiredVehicleType?: 'BLS' | 'ALS' | 'PATIENT_TRANSPORT' | 'NEONATAL' | 'MORTUARY';
}) {
  const liveEnabled = await getSetting<boolean>('emergency.live_dispatch_enabled', false);
  return prisma.$transaction(async (tx) => {
    const req = await tx.dispatchRequest.create({
      data: {
        reference: makeReference(REF.dispatch),
        mode: input.mode,
        requestedByUserId: input.requestedByUserId,
        callerPhone: input.callerPhone,
        pickupLatitude: input.latitude,
        pickupLongitude: input.longitude,
        pickupAddress: input.address,
        pickupDistrict: input.district,
        requiredVehicleType: input.requiredVehicleType,
        emergencyGuidanceShownAt: new Date(),
      },
    });
    await tx.dispatchEvent.create({ data: { requestId: req.id, toStatus: 'RECEIVED', actorUserId: input.requestedByUserId, actorKind: input.requestedByUserId ? 'PATIENT' : 'SYSTEM' } });

    let offers = 0;
    if ((input.mode === 'LIVE' && liveEnabled) || input.mode === 'TEST') {
      await moveDispatch(tx, req.id, 'SEARCHING', { userId: null, kind: 'SYSTEM' });
      const operators = input.district
        ? await tx.provider.findMany({
            where: {
              type: 'AMBULANCE_OPERATOR',
              status: 'APPROVED',
              serviceAreas: { some: { purpose: 'AMBULANCE', district: { equals: input.district, mode: 'insensitive' } } },
              vehicles: { some: { status: 'AVAILABLE', ...(input.requiredVehicleType ? { vehicleType: input.requiredVehicleType } : {}) } },
            },
            select: { id: true },
            take: 10,
          })
        : [];
      if (input.mode === 'LIVE') {
        for (const op of operators) {
          await tx.dispatchAssignment.create({ data: { requestId: req.id, operatorProviderId: op.id } });
          offers++;
        }
      }
      if (offers > 0) await moveDispatch(tx, req.id, 'OFFERED', { userId: null, kind: 'SYSTEM' }, `${offers} operator(s) notified`);
      if (offers > 0) await notifyProviderStaffMany(tx, operators.map((o) => o.id), 'manage_dispatch', { key: 'portal.dispatch_offer', level: 'critical', meta: { kind: 'dispatch', id: req.id, status: 'OFFERED' }, title: 'Emergency request — accept now', body: `${req.reference} · ${input.district ?? 'location pending'}`, link: '/dispatch', urgent: true });
      else await moveDispatch(tx, req.id, 'NO_PROVIDER_AVAILABLE', { userId: null, kind: 'SYSTEM' }, input.mode === 'TEST' ? 'Test drill: no operators notified' : 'No covering operator with an available vehicle');
    } else {
      await moveDispatch(tx, req.id, 'NO_PROVIDER_AVAILABLE', { userId: null, kind: 'SYSTEM' }, 'Live dispatch is not enabled; caller directed to 112');
    }
    await audit(tx, { action: 'dispatch.request_opened', entityType: 'dispatch_request', entityId: req.id, actorUserId: input.requestedByUserId, metadata: { mode: input.mode, liveEnabled, offers } });
    return { id: req.id, offers };
  });
}

// ── Fleet helpers shared by the admin console and the operator portal ──────
export const vehicleDto = (v: any) => ({
    id: v.id,
    operatorProviderId: v.operatorProviderId,
    operatorName: v.operator?.displayName,
    registrationNumber: v.registrationNumber,
    vehicleType: v.vehicleType,
    status: v.status,
    equipment: v.equipment,
    insuranceValidUntil: isoDate(v.insuranceValidUntil),
    fitnessValidUntil: isoDate(v.fitnessValidUntil),
    documentsExpired: !!((v.insuranceValidUntil && v.insuranceValidUntil < new Date()) || (v.fitnessValidUntil && v.fitnessValidUntil < new Date())),
    verifiedAt: iso(v.verifiedAt),
    lastLocationAt: iso(v.lastLocationAt),
    createdAt: v.createdAt.toISOString(),
  });

export const VehicleTypeEnum = z.enum(['BLS', 'ALS', 'PATIENT_TRANSPORT', 'NEONATAL', 'MORTUARY']);
export const VehicleInput = z.object({
  registrationNumber: z.string().toUpperCase().regex(/^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$/, 'Indian registration format, e.g. WB29AB1234'),
  vehicleType: VehicleTypeEnum,
  equipment: z.array(z.string().max(64)).max(40).default([]),
  insuranceValidUntil: DateString,
  fitnessValidUntil: DateString.optional(),
  baseLocationId: z.uuid().optional(),
});
export const CrewInput = z.object({ fullName: z.string().trim().min(2).max(160), role: z.enum(['DRIVER', 'EMT', 'PARAMEDIC', 'NURSE']), licenseNumber: z.string().max(64).optional(), licenseValidUntil: DateString.optional() });

export async function listVehicles(operatorProviderId: string) {
  const rows = await prisma.ambulanceVehicle.findMany({ where: { operatorProviderId }, include: { operator: { select: { displayName: true } } }, orderBy: { createdAt: 'asc' } });
  return rows.map(vehicleDto);
}

/** New vehicles start PENDING_VERIFICATION; only the platform can make them AVAILABLE. */
export async function registerVehicle(actorUserId: string, operatorProviderId: string, body: z.infer<typeof VehicleInput>) {
  const op = await prisma.provider.findUnique({ where: { id: operatorProviderId } });
  if (!op || op.type !== 'AMBULANCE_OPERATOR') throw badRequest('Provider must be an ambulance operator');
  if (new Date(body.insuranceValidUntil) < new Date()) throw badRequest('Vehicle insurance has expired');
  if (body.baseLocationId && !(await prisma.providerLocation.findFirst({ where: { id: body.baseLocationId, providerId: op.id } }))) throw badRequest('Base location does not belong to this operator');
  try {
    const v = await prisma.$transaction(async (tx) => {
      const created = await tx.ambulanceVehicle.create({
        data: {
          operatorProviderId: op.id,
          registrationNumber: body.registrationNumber,
          vehicleType: body.vehicleType,
          equipment: body.equipment,
          insuranceValidUntil: new Date(body.insuranceValidUntil),
          fitnessValidUntil: body.fitnessValidUntil ? new Date(body.fitnessValidUntil) : null,
          baseLocationId: body.baseLocationId,
        },
        include: { operator: { select: { displayName: true } } },
      });
      await audit(tx, { action: 'ambulance.vehicle_registered', entityType: 'ambulance_vehicle', entityId: created.id, actorUserId, metadata: { registrationNumber: body.registrationNumber } });
      return created;
    });
    return vehicleDto(v);
  } catch (err) {
    if (isPgError(err, '23505')) throw conflict('A vehicle with this registration number already exists');
    throw err;
  }
}

export async function listCrew(operatorProviderId: string) {
  return (await prisma.ambulanceCrewMember.findMany({ where: { operatorProviderId }, orderBy: { createdAt: 'asc' } })).map((c) => ({
    id: c.id,
    fullName: c.fullName,
    role: c.role,
    licenseNumber: c.licenseNumber,
    licenseValidUntil: isoDate(c.licenseValidUntil),
    licenseExpired: !!(c.licenseValidUntil && c.licenseValidUntil < new Date()),
    isActive: c.isActive,
  }));
}

export async function addCrew(actorUserId: string, operatorProviderId: string, body: z.infer<typeof CrewInput>) {
  const op = await prisma.provider.findUnique({ where: { id: operatorProviderId } });
  if (!op || op.type !== 'AMBULANCE_OPERATOR') throw notFound('Ambulance operator');
  if (body.role === 'DRIVER' && !body.licenseNumber) throw badRequest('Drivers need a driving licence number');
  if (body.licenseValidUntil && new Date(body.licenseValidUntil) < new Date()) throw badRequest('The licence has already expired');
  const c = await prisma.ambulanceCrewMember.create({ data: { operatorProviderId: op.id, ...body, licenseValidUntil: body.licenseValidUntil ? new Date(body.licenseValidUntil) : null } });
  await audit(prisma, { action: 'ambulance.crew_added', entityType: 'provider', entityId: op.id, actorUserId, metadata: { crewId: c.id, role: c.role } });
  return { id: c.id, fullName: c.fullName, role: c.role };
}

export function ambulanceRouter(): Router {
  const r = Router();
  const tags = ['Admin · Ambulance'];

  // ── Vehicles & crew ────────────────────────────────────────────────────
  defineRoute(r, '/admin/ambulance', {
    kind: 'list',
    method: 'get',
    path: '/vehicles',
    summary: 'Ambulance vehicles',
    tags,
    permissions: ['ambulance.read'],
    query: PaginationQuery.extend({ operatorProviderId: z.uuid().optional(), status: z.enum(['PENDING_VERIFICATION', 'AVAILABLE', 'ON_TRIP', 'OUT_OF_SERVICE', 'SUSPENDED']).optional() }),
    response: Passthrough,
    handler: async ({ query }) => {
      const rows = await prisma.ambulanceVehicle.findMany({
        where: { ...(query.operatorProviderId ? { operatorProviderId: query.operatorProviderId } : {}), ...(query.status ? { status: query.status } : {}), ...cursorWhere(query.cursor) },
        include: { operator: { select: { displayName: true } } },
        orderBy: cursorOrderBy(),
        take: query.limit + 1,
      });
      const { items, page } = buildPage(rows, query.limit, (v) => v.createdAt);
      return { items: items.map(vehicleDto), page };
    },
  });

  defineRoute(r, '/admin/ambulance', {
    method: 'post',
    path: '/vehicles',
    summary: 'Register an ambulance vehicle',
    tags,
    permissions: ['ambulance.manage'],
    body: VehicleInput.extend({ operatorProviderId: z.uuid() }),
    response: Passthrough,
    handler: ({ body, auth }) => {
      const { operatorProviderId, ...vehicle } = body;
      return registerVehicle(auth.userId, operatorProviderId, vehicle);
    },
  });

  defineRoute(r, '/admin/ambulance', {
    method: 'post',
    path: '/vehicles/:id/status',
    summary: 'Verify, suspend or take a vehicle out of service',
    description: 'A vehicle can only become AVAILABLE when its operator is APPROVED and its insurance/fitness documents are current.',
    tags,
    status: 200,
    permissions: ['ambulance.manage'],
    params: IdParams,
    body: z.object({ status: z.enum(['AVAILABLE', 'OUT_OF_SERVICE', 'SUSPENDED']), reason: z.string().max(500).optional() }),
    response: Passthrough,
    handler: async ({ params, body, auth }) =>
      prisma.$transaction(async (tx) => {
        const v = await tx.ambulanceVehicle.findUnique({ where: { id: params.id }, include: { operator: true } });
        if (!v) throw notFound('Vehicle');
        if (body.status === 'AVAILABLE') {
          if (v.operator.status !== 'APPROVED') throw preconditionFailed('Operator is not approved');
          const now = new Date();
          if ((v.insuranceValidUntil && v.insuranceValidUntil < now) || (v.fitnessValidUntil && v.fitnessValidUntil < now)) throw preconditionFailed('Vehicle documents have expired');
        }
        const updated = await tx.ambulanceVehicle.update({
          where: { id: v.id },
          data: { status: body.status, ...(body.status === 'AVAILABLE' && !v.verifiedAt ? { verifiedAt: new Date(), verifiedById: auth.userId } : {}) },
          include: { operator: { select: { displayName: true } } },
        });
        await audit(tx, { action: 'ambulance.vehicle_status', entityType: 'ambulance_vehicle', entityId: v.id, metadata: { from: v.status, to: body.status, reason: body.reason } });
        return vehicleDto(updated);
      }),
  });

  defineRoute(r, '/admin/ambulance', {
    method: 'get',
    path: '/operators/:id/crew',
    summary: 'Crew of an ambulance operator',
    tags,
    permissions: ['ambulance.read'],
    params: IdParams,
    response: z.array(Passthrough),
    handler: ({ params }) => listCrew(params.id),
  });

  defineRoute(r, '/admin/ambulance', {
    method: 'post',
    path: '/operators/:id/crew',
    summary: 'Add a crew member',
    tags,
    permissions: ['ambulance.manage'],
    params: IdParams,
    body: CrewInput,
    response: Passthrough,
    handler: ({ params, body, auth }) => addCrew(auth.userId, params.id, body),
  });

  // ── Dispatch: patient entry point ──────────────────────────────────────
  defineRoute(r, '/patient', {
    method: 'post',
    path: '/emergency',
    summary: 'Emergency request — always returns 112 guidance first',
    description: 'Records the request and, only if live dispatch is enabled, offers it to covering operators. `ambulanceConfirmed` is true only after an operator accepts.',
    tags: ['Patient app'],
    status: 201,
    body: z.object({
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
      address: z.string().max(500).optional(),
      district: z.string().max(80).optional(),
      callbackPhone: Phone.optional(),
    }),
    response: z.object({
      callNow: z.string(),
      message: z.string(),
      requestId: z.uuid(),
      reference: z.string(),
      status: z.string(),
      ambulanceConfirmed: z.boolean(),
      operatorsNotified: z.number().int(),
    }),
    handler: async ({ body, auth }) => {
      const number = await getSetting<string>('emergency.public_number', '112');
      const { id, offers } = await openRequest({ mode: 'LIVE', requestedByUserId: auth.userId, callerPhone: body.callbackPhone, latitude: body.latitude, longitude: body.longitude, address: body.address, district: body.district });
      const d = await loadDispatch(id);
      return {
        callNow: number,
        message:
          offers > 0
            ? `Call ${number} now. We have also alerted nearby ambulance operators — this is NOT a confirmed dispatch until an operator accepts.`
            : `Call ${number} now. Carevanta could not reach an ambulance operator for this request.`,
        requestId: id,
        reference: d.reference,
        status: d.status,
        ambulanceConfirmed: d.ambulanceConfirmed,
        operatorsNotified: offers,
      };
    },
  });

  // ── Dispatch: operations console ───────────────────────────────────────
  const ops = '/admin/dispatch';
  const opsTags = ['Admin · Dispatch'];

  defineRoute(r, ops, {
    kind: 'list',
    method: 'get',
    path: '',
    summary: 'Dispatch requests (live first)',
    tags: opsTags,
    permissions: ['dispatch.read'],
    query: PaginationQuery.extend({ mode: z.enum(['LIVE', 'TEST']).optional(), status: z.string().max(32).optional() }),
    response: Passthrough,
    handler: async ({ query }) => {
      const rows = await prisma.dispatchRequest.findMany({
        where: { ...(query.mode ? { mode: query.mode } : {}), ...(query.status ? { status: query.status as DispatchStatus } : {}), ...cursorWhere(query.cursor) },
        include,
        orderBy: cursorOrderBy(),
        take: query.limit + 1,
      });
      const { items, page } = buildPage(rows, query.limit, (d) => d.createdAt);
      return { items: items.map(dispatchDto), page };
    },
  });

  defineRoute(r, ops, {
    method: 'get',
    path: '/:id',
    summary: 'Dispatch request with assignments and timeline',
    tags: opsTags,
    permissions: ['dispatch.read'],
    params: IdParams,
    response: Passthrough,
    handler: ({ params }) => loadDispatch(params.id),
  });

  defineRoute(r, ops, {
    method: 'post',
    path: '/test',
    summary: 'Open a TEST (drill) request — never notifies operators',
    tags: opsTags,
    permissions: ['dispatch.manage'],
    body: z.object({ district: z.string().max(80).optional(), requiredVehicleType: VehicleTypeEnum.optional() }),
    response: Passthrough,
    handler: async ({ body, auth }) => loadDispatch((await openRequest({ mode: 'TEST', requestedByUserId: auth.userId, ...body })).id),
  });

  defineRoute(r, ops, {
    method: 'post',
    path: '/:id/escalate',
    summary: 'Escalate (e.g. hand over to 108/112 control room)',
    tags: opsTags,
    status: 200,
    permissions: ['dispatch.manage'],
    params: IdParams,
    body: z.object({ note: Reason }),
    response: Passthrough,
    handler: async ({ params, body, auth }) => {
      await prisma.$transaction(async (tx) => {
        await moveDispatch(tx, params.id, 'ESCALATED', { userId: auth.userId, kind: 'PLATFORM' }, body.note);
        await audit(tx, { action: 'dispatch.escalated', entityType: 'dispatch_request', entityId: params.id, metadata: { note: body.note } });
      });
      return loadDispatch(params.id);
    },
  });

  defineRoute(r, ops, {
    method: 'post',
    path: '/:id/cancel',
    summary: 'Cancel / close a request',
    tags: opsTags,
    status: 200,
    permissions: ['dispatch.manage'],
    params: IdParams,
    body: z.object({ reason: Reason }),
    response: Passthrough,
    handler: async ({ params, body, auth }) => {
      await prisma.$transaction(async (tx) => {
        await moveDispatch(tx, params.id, 'CANCELLED', { userId: auth.userId, kind: 'PLATFORM' }, body.reason);
        await tx.dispatchAssignment.updateMany({ where: { requestId: params.id, status: { in: ['OFFERED', 'ACCEPTED'] } }, data: { status: 'CANCELLED' } });
        await audit(tx, { action: 'dispatch.cancelled', entityType: 'dispatch_request', entityId: params.id, metadata: { reason: body.reason } });
      });
      return loadDispatch(params.id);
    },
  });

  defineRoute(r, ops, {
    method: 'post',
    path: '/:id/assignments/:assignmentId/phone-confirmation',
    summary: 'Record an operator’s acceptance confirmed by phone',
    description: 'Use only when the operator verbally confirmed a specific vehicle. The dispatcher’s identity and the person spoken to are recorded.',
    tags: opsTags,
    status: 200,
    permissions: ['dispatch.manage'],
    params: z.object({ id: z.uuid(), assignmentId: z.uuid() }),
    body: z.object({ vehicleId: z.uuid(), etaMinutes: z.number().int().min(1).max(240), confirmedWith: z.string().trim().min(2).max(160) }),
    response: Passthrough,
    handler: async ({ params, body, auth }) => {
      await acceptAssignment(params.id, params.assignmentId, { vehicleId: body.vehicleId, etaMinutes: body.etaMinutes, userId: auth.userId, source: 'OPERATOR_PHONE_CONFIRMED', note: `Confirmed by phone with ${body.confirmedWith}` });
      return loadDispatch(params.id);
    },
  });

  // ── Operator portal ────────────────────────────────────────────────────
  const op = '/portal/providers/:providerId/dispatch';
  const opTags = ['Ambulance app · Dispatch'];

  defineRoute(r, op, {
    method: 'get',
    path: '/offers',
    summary: 'Open dispatch offers for this operator',
    tags: opTags,
    params: z.object({ providerId: z.uuid() }),
    response: z.array(Passthrough),
    handler: async ({ params, auth }) => {
      await assertProviderAccess(auth, params.providerId, { capability: 'manage_dispatch' });
      const rows = await prisma.dispatchAssignment.findMany({
        where: { operatorProviderId: params.providerId, status: 'OFFERED', request: { mode: 'LIVE' } },
        include: { request: true },
        orderBy: { offeredAt: 'desc' },
        take: 50,
      });
      return rows.map((a) => ({
        id: a.id,
        requestId: a.requestId,
        reference: a.request.reference,
        pickupDistrict: a.request.pickupDistrict,
        pickupLatitude: dec(a.request.pickupLatitude),
        pickupLongitude: dec(a.request.pickupLongitude),
        requiredVehicleType: a.request.requiredVehicleType,
        offeredAt: a.offeredAt.toISOString(),
      }));
    },
  });

  defineRoute(r, op, {
    method: 'get',
    path: '/active',
    summary: 'Trips this operator has accepted and not yet completed (survives an app reload)',
    tags: opTags,
    params: z.object({ providerId: z.uuid() }),
    response: z.array(Passthrough),
    handler: async ({ params, auth }) => {
      await assertProviderAccess(auth, params.providerId, { capability: 'manage_dispatch' });
      const rows = await prisma.dispatchAssignment.findMany({
        where: { operatorProviderId: params.providerId, status: 'ACCEPTED', request: { status: { in: ['ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'PATIENT_ONBOARD', 'AT_DESTINATION'] } } },
        select: { requestId: true },
        orderBy: { respondedAt: 'asc' },
        take: 20,
      });
      const trips = await prisma.dispatchRequest.findMany({ where: { id: { in: rows.map((a) => a.requestId) } }, include, orderBy: { createdAt: 'asc' } });
      // The accepted operator needs to reach the caller and find the pickup; these fields are never on the public DTO.
      return trips.map((t) => ({ ...dispatchDto(t), callerPhone: t.callerPhone, pickupAddress: t.pickupAddress }));
    },
  });

  defineRoute(r, op, {
    method: 'post',
    path: '/assignments/:assignmentId/accept',
    summary: 'Accept a dispatch with a specific available vehicle',
    tags: opTags,
    status: 200,
    params: z.object({ providerId: z.uuid(), assignmentId: z.uuid() }),
    body: z.object({ vehicleId: z.uuid(), etaMinutes: z.number().int().min(1).max(240) }),
    response: Passthrough,
    handler: async ({ params, body, auth }) => {
      await assertProviderAccess(auth, params.providerId, { capability: 'manage_dispatch' });
      const a = await prisma.dispatchAssignment.findUnique({ where: { id: params.assignmentId } });
      if (!a || a.operatorProviderId !== params.providerId) throw notFound('Assignment');
      await acceptAssignment(a.requestId, a.id, { ...body, userId: auth.userId, source: 'OPERATOR_APP' });
      return loadDispatch(a.requestId);
    },
  });

  defineRoute(r, op, {
    method: 'post',
    path: '/assignments/:assignmentId/decline',
    summary: 'Decline a dispatch offer',
    tags: opTags,
    status: 200,
    params: z.object({ providerId: z.uuid(), assignmentId: z.uuid() }),
    body: z.object({ reason: z.string().max(500).optional() }),
    response: Passthrough,
    handler: async ({ params, body, auth }) => {
      await assertProviderAccess(auth, params.providerId, { capability: 'manage_dispatch' });
      const a = await prisma.dispatchAssignment.findUnique({ where: { id: params.assignmentId } });
      if (!a || a.operatorProviderId !== params.providerId) throw notFound('Assignment');
      await prisma.$transaction(async (tx) => {
        const res = await tx.dispatchAssignment.updateMany({ where: { id: a.id, status: 'OFFERED' }, data: { status: 'DECLINED', respondedAt: new Date(), note: body.reason } });
        if (res.count !== 1) throw conflict('Offer is no longer open');
        const open = await tx.dispatchAssignment.count({ where: { requestId: a.requestId, status: { in: ['OFFERED', 'ACCEPTED'] } } });
        if (open === 0) await moveDispatch(tx, a.requestId, 'NO_PROVIDER_AVAILABLE', { userId: null, kind: 'SYSTEM' }, 'All notified operators declined');
      });
      return loadDispatch(a.requestId);
    },
  });

  defineRoute(r, op, {
    method: 'post',
    path: '/requests/:requestId/progress',
    summary: 'Report trip progress (en route, arrived, onboard, at destination, completed)',
    tags: opTags,
    status: 200,
    params: z.object({ providerId: z.uuid(), requestId: z.uuid() }),
    body: z.object({ status: z.enum(['EN_ROUTE', 'ARRIVED', 'PATIENT_ONBOARD', 'AT_DESTINATION', 'COMPLETED']), note: z.string().max(500).optional() }),
    response: Passthrough,
    handler: async ({ params, body, auth }) => {
      await assertProviderAccess(auth, params.providerId, { capability: 'manage_dispatch' });
      const accepted = await prisma.dispatchAssignment.findFirst({ where: { requestId: params.requestId, operatorProviderId: params.providerId, status: 'ACCEPTED' } });
      if (!accepted) throw forbidden('Only the operator that accepted this request can update it');
      await prisma.$transaction(async (tx) => {
        await moveDispatch(tx, params.requestId, body.status, { userId: auth.userId, kind: 'OPERATOR' }, body.note);
        if (body.status === 'COMPLETED') {
          await tx.dispatchAssignment.update({ where: { id: accepted.id }, data: { status: 'COMPLETED' } });
          if (accepted.vehicleId) await tx.ambulanceVehicle.update({ where: { id: accepted.vehicleId }, data: { status: 'AVAILABLE' } });
        }
      });
      return loadDispatch(params.requestId);
    },
  });

  return r;
}

async function acceptAssignment(
  requestId: string,
  assignmentId: string,
  input: { vehicleId: string; etaMinutes: number; userId: string; source: 'OPERATOR_APP' | 'OPERATOR_PHONE_CONFIRMED'; note?: string },
) {
  try {
    await prisma.$transaction(async (tx) => {
      const a = await tx.dispatchAssignment.findFirst({ where: { id: assignmentId, requestId } });
      if (!a) throw notFound('Assignment');
      const vehicle = await tx.ambulanceVehicle.findFirst({ where: { id: input.vehicleId, operatorProviderId: a.operatorProviderId } });
      if (!vehicle) throw badRequest('Vehicle does not belong to this operator');
      // Claim the vehicle atomically so it cannot be sent on two trips.
      const v = await tx.ambulanceVehicle.updateMany({ where: { id: vehicle.id, status: 'AVAILABLE' }, data: { status: 'ON_TRIP' } });
      if (v.count !== 1) throw conflict('That vehicle is not available');
      const res = await tx.dispatchAssignment.updateMany({
        where: { id: a.id, status: 'OFFERED' },
        data: { status: 'ACCEPTED', vehicleId: vehicle.id, etaMinutes: input.etaMinutes, respondedAt: new Date(), confirmationSource: input.source, confirmedByUserId: input.userId, note: input.note },
      });
      if (res.count !== 1) throw conflict('This offer is no longer open');
      await moveDispatch(tx, requestId, 'ACCEPTED', { userId: input.userId, kind: input.source === 'OPERATOR_APP' ? 'OPERATOR' : 'PLATFORM' }, input.note);
      // Withdraw competing offers.
      await tx.dispatchAssignment.updateMany({ where: { requestId, status: 'OFFERED', id: { not: a.id } }, data: { status: 'EXPIRED' } });
      await audit(tx, { action: 'dispatch.accepted', entityType: 'dispatch_request', entityId: requestId, actorUserId: input.userId, metadata: { assignmentId, vehicleId: vehicle.id, source: input.source } });
      const reqRow = await tx.dispatchRequest.findUnique({ where: { id: requestId }, select: { reference: true, requestedByUserId: true } });
      if (reqRow?.requestedByUserId) {
        await notifyUsers(tx, [reqRow.requestedByUserId], {
          key: 'dispatch.accepted',
          title: 'Ambulance confirmed',
          body: `${vehicle.registrationNumber} is on its way · about ${input.etaMinutes} min (${reqRow.reference})`,
          link: `/emergency/${requestId}`,
          level: 'critical',
          meta: { kind: 'dispatch', id: requestId, providerId: a.operatorProviderId, status: 'ACCEPTED' },
        });
      }
    });
  } catch (err) {
    if (isPgError(err, '23505')) throw conflict('Another operator already accepted this request');
    throw err;
  }
}
