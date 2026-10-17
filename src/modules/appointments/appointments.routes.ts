import { Router } from 'express';
import { z } from 'zod';
import { defineRoute, IdParams } from '../../http/route.js';
import { PaginationQuery } from '../../lib/pagination.js';
import { prisma } from '../../lib/prisma.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { DateString, DateTimeString, MoneyInput, Phone } from '../../http/dto.js';
import { audit } from '../../lib/audit.js';
import { assertProviderAccess, getOwnDoctorProviderId } from '../providers/provider-access.js';
import * as appts from './appointments.service.js';
import * as sched from '../scheduling/scheduling.service.js';
import type { AuthContext } from '../../middleware/auth.js';

const StatusEnum = z.enum(['REQUESTED', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'CANCELLED_BY_PATIENT', 'CANCELLED_BY_PROVIDER', 'CANCELLED_BY_PLATFORM', 'REJECTED', 'NO_SHOW', 'RESCHEDULED']);
const AppointmentDto = z.object({ id: z.uuid(), reference: z.string(), status: StatusEnum, version: z.number().int() }).passthrough();
const ScheduleBody = z.object({
  doctorProviderId: z.uuid(),
  locationId: z.uuid(),
  dayOfWeek: z.number().int().min(0).max(6),
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(1).max(1440),
  slotMinutes: z.number().int().min(5).max(240),
  capacityPerSlot: z.number().int().min(1).max(200).default(1),
  feeMinor: MoneyInput.optional(),
  validFrom: DateString,
  validTo: DateString.optional(),
});
const ScheduleDto = z.object({ id: z.uuid(), doctorProviderId: z.uuid(), locationId: z.uuid(), dayOfWeek: z.number().int() }).passthrough();
const SlotDto = z.object({ id: z.uuid(), startsAt: z.string(), endsAt: z.string(), capacity: z.number().int(), bookedCount: z.number().int(), status: z.string() }).passthrough();
const ActionBody = z.object({ action: z.enum(['CONFIRM', 'REJECT', 'CHECK_IN', 'COMPLETE', 'NO_SHOW', 'CANCEL']), reason: z.string().max(1000).optional() });

/** Provider-side access: the caller must manage bookings for a party to this appointment. */
async function assertAppointmentForProvider(auth: AuthContext, providerId: string, appointmentId: string) {
  await assertProviderAccess(auth, providerId, { capability: 'manage_bookings' });
  const a = await prisma.appointment.findUnique({ where: { id: appointmentId }, select: { facilityProviderId: true, doctorProviderId: true } });
  if (!a || (a.facilityProviderId !== providerId && a.doctorProviderId !== providerId)) throw notFound('Appointment');
}

async function assertSchedulingRights(auth: AuthContext, doctorProviderId: string, locationId: string) {
  if (auth.has('schedules.manage')) return;
  const own = await getOwnDoctorProviderId(auth);
  if (own === doctorProviderId) return;
  const loc = await prisma.providerLocation.findUnique({ where: { id: locationId }, select: { providerId: true } });
  if (!loc) throw notFound('Location');
  await assertProviderAccess(auth, loc.providerId, { capability: 'manage_schedules' });
}

export function appointmentsRouter(): Router {
  const r = Router();

  // ── Schedules & slots (admin, doctor, facility) ────────────────────────
  const schedTags = ['Scheduling'];
  defineRoute(r, '/schedules', {
    method: 'post',
    path: '',
    summary: 'Create a weekly schedule template',
    description: 'Allowed for platform schedulers, the doctor themself, or facility staff with manage_schedules at that location. Requires an ACTIVE affiliation for facility locations.',
    tags: schedTags,
    body: ScheduleBody,
    response: ScheduleDto,
    handler: async ({ body, auth }) => {
      await assertSchedulingRights(auth, body.doctorProviderId, body.locationId);
      return sched.createSchedule(auth, body);
    },
  });

  defineRoute(r, '/schedules', {
    method: 'get',
    path: '',
    summary: 'List schedules for a doctor',
    tags: schedTags,
    query: z.object({ doctorProviderId: z.uuid() }),
    response: z.array(ScheduleDto),
    handler: async ({ query, auth }) => {
      if (!auth.has('schedules.manage') && (await getOwnDoctorProviderId(auth)) !== query.doctorProviderId) {
        await assertProviderAccess(auth, query.doctorProviderId, { platformPermission: 'bookings.read' });
      }
      return (await prisma.doctorSchedule.findMany({ where: { doctorProviderId: query.doctorProviderId }, orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }] })).map(sched.scheduleDto);
    },
  });

  defineRoute(r, '/schedules', {
    method: 'post',
    path: '/:id/deactivate',
    summary: 'Deactivate a schedule (existing slots stay)',
    tags: schedTags,
    status: 200,
    params: IdParams,
    response: ScheduleDto,
    handler: async ({ params, auth }) => {
      const s = await prisma.doctorSchedule.findUnique({ where: { id: params.id } });
      if (!s) throw notFound('Schedule');
      await assertSchedulingRights(auth, s.doctorProviderId, s.locationId);
      const updated = await prisma.doctorSchedule.update({ where: { id: s.id }, data: { isActive: false } });
      await audit(prisma, { action: 'schedule.deactivated', entityType: 'doctor_schedule', entityId: s.id });
      return sched.scheduleDto(updated);
    },
  });

  defineRoute(r, '/schedules', {
    method: 'post',
    path: '/:id/generate-slots',
    summary: 'Materialise bookable slots for a date range (≤ 62 days, IST)',
    tags: schedTags,
    status: 200,
    params: IdParams,
    body: z.object({ from: DateString, to: DateString }),
    response: z.object({ created: z.number().int(), skipped: z.number().int() }),
    handler: async ({ params, body, auth }) => {
      const s = await prisma.doctorSchedule.findUnique({ where: { id: params.id } });
      if (!s) throw notFound('Schedule');
      await assertSchedulingRights(auth, s.doctorProviderId, s.locationId);
      return sched.generateSlots(auth, params.id, body.from, body.to);
    },
  });

  defineRoute(r, '/slots', {
    method: 'get',
    path: '',
    summary: 'List slots (admin / scheduler view)',
    tags: schedTags,
    permissions: ['bookings.read'],
    query: z.object({
      doctorProviderId: z.uuid().optional(),
      locationId: z.uuid().optional(),
      from: DateTimeString,
      to: DateTimeString,
      status: z.enum(['OPEN', 'BLOCKED', 'CANCELLED']).optional(),
    }),
    response: z.array(SlotDto),
    handler: ({ query }) => sched.listSlots({ ...query, from: new Date(query.from), to: new Date(query.to) }),
  });

  defineRoute(r, '/slots', {
    method: 'post',
    path: '/:id/status',
    summary: 'Block or reopen a slot',
    tags: schedTags,
    status: 200,
    params: IdParams,
    body: z.object({ status: z.enum(['OPEN', 'BLOCKED']) }),
    response: SlotDto,
    handler: async ({ params, body, auth }) => {
      const s = await prisma.appointmentSlot.findUnique({ where: { id: params.id } });
      if (!s) throw notFound('Slot');
      await assertSchedulingRights(auth, s.doctorProviderId, s.locationId);
      return sched.setSlotStatus(auth, params.id, body.status);
    },
  });

  // ── Admin appointments ─────────────────────────────────────────────────
  const admin = '/admin/appointments';
  const adminTags = ['Admin · Appointments'];

  defineRoute(r, admin, {
    kind: 'list',
    method: 'get',
    path: '',
    summary: 'Search appointments',
    tags: adminTags,
    permissions: ['bookings.read'],
    query: PaginationQuery.extend({
      status: StatusEnum.optional(),
      doctorProviderId: z.uuid().optional(),
      facilityProviderId: z.uuid().optional(),
      from: DateTimeString.optional(),
      to: DateTimeString.optional(),
    }),
    response: AppointmentDto,
    handler: ({ query }) => appts.listAppointments({ ...query, from: query.from ? new Date(query.from) : undefined, to: query.to ? new Date(query.to) : undefined }),
  });

  defineRoute(r, admin, {
    method: 'get',
    path: '/:id',
    summary: 'Appointment details',
    tags: adminTags,
    permissions: ['bookings.read'],
    params: IdParams,
    response: AppointmentDto,
    handler: ({ params }) => appts.getAppointment(params.id),
  });

  defineRoute(r, admin, {
    method: 'get',
    path: '/:id/events',
    summary: 'Appointment status history',
    tags: adminTags,
    permissions: ['bookings.read'],
    params: IdParams,
    response: z.array(z.object({ fromStatus: z.string().nullable(), toStatus: z.string(), actorKind: z.string(), actorUserId: z.string().nullable(), note: z.string().nullable(), createdAt: z.string() })),
    handler: async ({ params }) =>
      (await prisma.appointmentEvent.findMany({ where: { appointmentId: params.id }, orderBy: { createdAt: 'asc' } })).map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
  });

  defineRoute(r, admin, {
    method: 'post',
    path: '',
    summary: 'Book on behalf of a patient (assisted booking)',
    tags: adminTags,
    permissions: ['bookings.manage'],
    idempotent: true,
    body: z.object({ slotId: z.uuid(), patientProfileId: z.uuid(), reasonForVisit: z.string().max(500).optional(), payAtProvider: z.boolean().default(true) }),
    response: AppointmentDto,
    handler: async ({ body, auth }) => {
      const patient = await prisma.patientProfile.findUnique({ where: { id: body.patientProfileId } });
      if (!patient) throw notFound('Patient profile');
      const id = await appts.book({ ...body, bookedByUserId: patient.accountUserId, source: 'ADMIN_CONSOLE', attribution: 'ADMIN_ASSISTED', actorKind: 'PLATFORM' });
      await audit(prisma, { action: 'appointment.assisted_booking', entityType: 'appointment', entityId: id, actorUserId: auth.userId });
      return appts.getAppointment(id);
    },
  });

  defineRoute(r, admin, {
    method: 'post',
    path: '/:id/actions',
    summary: 'Confirm, reject, check in, complete, mark no-show or cancel',
    tags: adminTags,
    status: 200,
    permissions: ['bookings.manage'],
    params: IdParams,
    body: ActionBody,
    response: AppointmentDto.extend({ refundRequestedMinor: z.number().int() }),
    handler: async ({ params, body, auth }) => {
      const res = await appts.act(params.id, body.action, { userId: auth.userId, kind: 'PLATFORM' }, body.reason);
      return { ...(await appts.getAppointment(params.id)), ...res };
    },
  });

  defineRoute(r, admin, {
    method: 'post',
    path: '/:id/reschedule',
    summary: 'Move an appointment to another slot with the same doctor',
    tags: adminTags,
    status: 200,
    permissions: ['bookings.manage'],
    params: IdParams,
    body: z.object({ newSlotId: z.uuid() }),
    response: AppointmentDto,
    handler: async ({ params, body, auth }) => appts.getAppointment(await appts.reschedule(params.id, body.newSlotId, { userId: auth.userId, kind: 'PLATFORM' })),
  });

  // ── Provider portal ────────────────────────────────────────────────────
  const portal = '/portal/providers/:providerId/appointments';
  const portalTags = ['Provider portal · Appointments'];

  defineRoute(r, portal, {
    kind: 'list',
    method: 'get',
    path: '',
    summary: 'Appointments at this provider',
    tags: portalTags,
    params: z.object({ providerId: z.uuid() }),
    query: PaginationQuery.extend({ status: StatusEnum.optional() }),
    response: AppointmentDto,
    handler: async ({ params, query, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'bookings.read', capability: 'manage_bookings' });
      const p = await prisma.provider.findUniqueOrThrow({ where: { id: params.providerId }, select: { type: true } });
      return appts.listAppointments({ ...query, ...(p.type === 'DOCTOR' ? { doctorProviderId: params.providerId } : { facilityProviderId: params.providerId }) });
    },
  });

  defineRoute(r, portal, {
    method: 'post',
    path: '/:id/actions',
    summary: 'Provider action on an appointment',
    tags: portalTags,
    status: 200,
    params: z.object({ providerId: z.uuid(), id: z.uuid() }),
    body: ActionBody,
    response: AppointmentDto.extend({ refundRequestedMinor: z.number().int() }),
    handler: async ({ params, body, auth }) => {
      await assertAppointmentForProvider(auth, params.providerId, params.id);
      const res = await appts.act(params.id, body.action, { userId: auth.userId, kind: 'PROVIDER' }, body.reason);
      return { ...(await appts.getAppointment(params.id)), ...res };
    },
  });

  defineRoute(r, portal, {
    method: 'post',
    path: '/walk-in',
    summary: 'Record a walk-in patient in a slot (provider-direct, not commissionable by default)',
    tags: portalTags,
    idempotent: true,
    params: z.object({ providerId: z.uuid() }),
    body: z.object({ slotId: z.uuid(), patientFullName: z.string().trim().min(2).max(160), patientPhone: Phone }),
    response: AppointmentDto,
    handler: async ({ params, body, auth }) => {
      await assertProviderAccess(auth, params.providerId, { capability: 'manage_bookings' });
      const slot = await prisma.appointmentSlot.findUnique({ where: { id: body.slotId }, include: { location: true } });
      if (!slot || (slot.location.providerId !== params.providerId && slot.doctorProviderId !== params.providerId)) throw notFound('Slot');
      // Find or create a minimal account for the patient so records stay theirs.
      const user =
        (await prisma.user.findUnique({ where: { phone: body.patientPhone } })) ??
        (await prisma.user.create({ data: { fullName: body.patientFullName, phone: body.patientPhone, status: 'PENDING_VERIFICATION', createdById: auth.userId } }));
      const profile =
        (await prisma.patientProfile.findFirst({ where: { accountUserId: user.id, relationship: 'SELF' } })) ??
        (await prisma.patientProfile.create({ data: { accountUserId: user.id, fullName: body.patientFullName, relationship: 'SELF', phone: body.patientPhone } }));
      const id = await appts.book({ slotId: body.slotId, patientProfileId: profile.id, bookedByUserId: user.id, source: 'WALK_IN', attribution: 'PROVIDER_DIRECT', payAtProvider: true, actorKind: 'PROVIDER' });
      return appts.getAppointment(id);
    },
  });

  // ── Patient app ────────────────────────────────────────────────────────
  const patientTags = ['Patient app'];

  const ProfileDto = z.object({ id: z.uuid(), fullName: z.string(), relationship: z.string(), dateOfBirth: z.string().nullable(), gender: z.string().nullable() });
  defineRoute(r, '/patient', {
    method: 'get',
    path: '/profiles',
    summary: 'My patient profiles (self and dependants)',
    tags: patientTags,
    response: z.array(ProfileDto),
    handler: async ({ auth }) =>
      (await prisma.patientProfile.findMany({ where: { accountUserId: auth.userId, isActive: true }, orderBy: { createdAt: 'asc' } })).map((p) => ({
        id: p.id,
        fullName: p.fullName,
        relationship: p.relationship,
        dateOfBirth: p.dateOfBirth?.toISOString().slice(0, 10) ?? null,
        gender: p.gender,
      })),
  });

  defineRoute(r, '/patient', {
    method: 'post',
    path: '/profiles',
    summary: 'Add a family member / dependant',
    tags: patientTags,
    body: z.object({
      fullName: z.string().trim().min(2).max(160),
      relationship: z.enum(['SPOUSE', 'CHILD', 'PARENT', 'SIBLING', 'OTHER']),
      dateOfBirth: DateString.optional(),
      gender: z.enum(['FEMALE', 'MALE', 'OTHER', 'UNDISCLOSED']).optional(),
    }),
    response: ProfileDto,
    handler: async ({ body, auth }) => {
      const count = await prisma.patientProfile.count({ where: { accountUserId: auth.userId, isActive: true } });
      if (count >= 10) throw badRequest('A maximum of 10 profiles per account is allowed');
      const p = await prisma.patientProfile.create({ data: { accountUserId: auth.userId, ...body, dateOfBirth: body.dateOfBirth ? new Date(body.dateOfBirth) : null } });
      await audit(prisma, { action: 'patient.profile_added', entityType: 'patient_profile', entityId: p.id });
      return { id: p.id, fullName: p.fullName, relationship: p.relationship, dateOfBirth: body.dateOfBirth ?? null, gender: p.gender };
    },
  });

  defineRoute(r, '/patient', {
    method: 'post',
    path: '/appointments',
    summary: 'Book an appointment',
    description: 'The patient profile must belong to the signed-in account. Send an Idempotency-Key so retries never double-book.',
    tags: patientTags,
    idempotent: true,
    body: z.object({ slotId: z.uuid(), patientProfileId: z.uuid(), reasonForVisit: z.string().max(500).optional(), payAtProvider: z.boolean().default(false) }),
    response: AppointmentDto,
    handler: async ({ body, auth, req }) => {
      const owned = await prisma.patientProfile.findFirst({ where: { id: body.patientProfileId, accountUserId: auth.userId, isActive: true } });
      if (!owned) throw notFound('Patient profile');
      const id = await appts.book({
        ...body,
        bookedByUserId: auth.userId,
        source: 'PATIENT_APP',
        attribution: 'PLATFORM',
        actorKind: 'PATIENT',
        idempotencyKey: req.header('idempotency-key') ?? undefined,
      });
      return appts.getAppointment(id);
    },
  });

  defineRoute(r, '/patient', {
    kind: 'list',
    method: 'get',
    path: '/appointments',
    summary: 'My appointments (all family profiles)',
    tags: patientTags,
    query: PaginationQuery.extend({ status: StatusEnum.optional() }),
    response: AppointmentDto,
    handler: ({ query, auth }) => appts.listAppointments({ ...query, patientAccountUserId: auth.userId }),
  });

  const assertOwnAppointment = async (auth: AuthContext, id: string) => {
    const a = await prisma.appointment.findUnique({ where: { id }, select: { patient: { select: { accountUserId: true } } } });
    // Same 404 for "missing" and "not yours" so ids cannot be probed.
    if (!a || a.patient.accountUserId !== auth.userId) throw notFound('Appointment');
  };

  defineRoute(r, '/patient', {
    method: 'get',
    path: '/appointments/:id',
    summary: 'One of my appointments',
    tags: patientTags,
    params: IdParams,
    response: AppointmentDto,
    handler: async ({ params, auth }) => {
      await assertOwnAppointment(auth, params.id);
      return appts.getAppointment(params.id);
    },
  });

  defineRoute(r, '/patient', {
    method: 'post',
    path: '/appointments/:id/cancel',
    summary: 'Cancel my appointment',
    tags: patientTags,
    status: 200,
    params: IdParams,
    body: z.object({ reason: z.string().max(500).optional() }),
    response: AppointmentDto.extend({ refundRequestedMinor: z.number().int() }),
    handler: async ({ params, body, auth }) => {
      await assertOwnAppointment(auth, params.id);
      const res = await appts.act(params.id, 'CANCEL', { userId: auth.userId, kind: 'PATIENT' }, body.reason);
      return { ...(await appts.getAppointment(params.id)), ...res };
    },
  });

  defineRoute(r, '/patient', {
    method: 'post',
    path: '/appointments/:id/reschedule',
    summary: 'Reschedule my appointment',
    tags: patientTags,
    status: 200,
    params: IdParams,
    body: z.object({ newSlotId: z.uuid() }),
    response: AppointmentDto,
    handler: async ({ params, body, auth }) => {
      await assertOwnAppointment(auth, params.id);
      return appts.getAppointment(await appts.reschedule(params.id, body.newSlotId, { userId: auth.userId, kind: 'PATIENT' }));
    },
  });

  return r;
}

