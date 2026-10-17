import { prisma, type Tx } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { AppError, badRequest, conflict, isPgError, notFound, preconditionFailed } from '../../lib/errors.js';
import { assertTransition, type TransitionMap } from '../../lib/state-machine.js';
import { makeReference, REF } from '../../lib/reference.js';
import { buildPage, cursorOrderBy, cursorWhere } from '../../lib/pagination.js';
import { iso, minor } from '../../http/dto.js';
import { formatIst } from '../../lib/time.js';
import { getSetting } from '../settings/settings.service.js';
import { enqueueNotification } from '../notifications/notifications.service.js';
import { createTransaction, onServiceCompleted, onSourceCancelled } from '../finance/commission.service.js';
import type { AppointmentStatus, Attribution, BookingSource, Prisma } from '../../../generated/prisma/client.js';

export const APPOINTMENT_TRANSITIONS: TransitionMap<AppointmentStatus> = {
  REQUESTED: ['CONFIRMED', 'REJECTED', 'CANCELLED_BY_PATIENT', 'CANCELLED_BY_PROVIDER', 'CANCELLED_BY_PLATFORM', 'RESCHEDULED'],
  CONFIRMED: ['CHECKED_IN', 'NO_SHOW', 'CANCELLED_BY_PATIENT', 'CANCELLED_BY_PROVIDER', 'CANCELLED_BY_PLATFORM', 'RESCHEDULED'],
  CHECKED_IN: ['COMPLETED', 'CANCELLED_BY_PROVIDER'],
  COMPLETED: [],
  CANCELLED_BY_PATIENT: [],
  CANCELLED_BY_PROVIDER: [],
  CANCELLED_BY_PLATFORM: [],
  REJECTED: [],
  NO_SHOW: [],
  RESCHEDULED: [],
};

const LIVE: AppointmentStatus[] = ['REQUESTED', 'CONFIRMED', 'CHECKED_IN'];
const MIN_LEAD_MS = 15 * 60_000; // cannot book a slot starting in < 15 minutes

const include = {
  patient: { select: { id: true, fullName: true, relationship: true } },
  doctor: { select: { id: true, displayName: true } },
  facility: { select: { id: true, displayName: true, type: true } },
  location: { select: { id: true, name: true, city: true } },
  slot: { select: { startsAt: true, endsAt: true } },
  transaction: { select: { id: true, reference: true, status: true, commissionEligible: true } },
} satisfies Prisma.AppointmentInclude;

type Loaded = Prisma.AppointmentGetPayload<{ include: typeof include }>;

export function appointmentDto(a: Loaded) {
  return {
    id: a.id,
    reference: a.reference,
    status: a.status,
    mode: a.mode,
    source: a.source,
    attribution: a.attribution,
    patient: a.patient,
    bookedByUserId: a.bookedByUserId,
    doctor: a.doctor,
    facility: a.facility,
    location: a.location,
    startsAt: a.slot.startsAt.toISOString(),
    endsAt: a.slot.endsAt.toISOString(),
    feeMinor: minor(a.feeMinor)!,
    currency: a.currency,
    statusReason: a.statusReason,
    rescheduledFromId: a.rescheduledFromId,
    confirmedAt: iso(a.confirmedAt),
    checkedInAt: iso(a.checkedInAt),
    completedAt: iso(a.completedAt),
    cancelledAt: iso(a.cancelledAt),
    transaction: a.transaction,
    version: a.version,
    createdAt: a.createdAt.toISOString(),
  };
}

export async function getAppointment(id: string) {
  const a = await prisma.appointment.findUnique({ where: { id }, include });
  if (!a) throw notFound('Appointment');
  return appointmentDto(a);
}

/**
 * Atomically claim one unit of slot capacity. The conditional UPDATE is the
 * concurrency control: under any interleaving at most `capacity` claims
 * succeed, because each one re-checks `booked_count < capacity` on the locked
 * row. The CHECK constraint (booked_count <= capacity) is a second safety net.
 */
async function claimSlot(tx: Tx, slotId: string) {
  const claimed = await tx.$queryRaw<{ id: string }[]>`
    UPDATE appointment_slots
       SET booked_count = booked_count + 1, version = version + 1, updated_at = now()
     WHERE id = ${slotId}::uuid
       AND status = 'OPEN'
       AND booked_count < capacity
       AND starts_at > now() + interval '15 minutes'
    RETURNING id`;
  if (claimed.length !== 1) throw new AppError(409, 'SLOT_UNAVAILABLE', 'This slot is no longer available');
}

async function releaseSlot(tx: Tx, slotId: string) {
  await tx.$executeRaw`
    UPDATE appointment_slots SET booked_count = booked_count - 1, version = version + 1, updated_at = now()
     WHERE id = ${slotId}::uuid AND booked_count > 0`;
}

export interface BookingInput {
  slotId: string;
  patientProfileId: string;
  bookedByUserId: string;
  source: BookingSource;
  attribution: Attribution;
  reasonForVisit?: string;
  payAtProvider: boolean;
  idempotencyKey?: string;
  actorKind: 'PATIENT' | 'PROVIDER' | 'PLATFORM';
  rescheduledFromId?: string;
}

async function bookInTx(tx: Tx, input: BookingInput) {
  const slot = await tx.appointmentSlot.findUnique({
    where: { id: input.slotId },
    include: { doctor: true, location: { include: { provider: true } }, affiliation: true },
  });
  if (!slot) throw notFound('Slot');
  if (slot.startsAt.getTime() - Date.now() < MIN_LEAD_MS) throw new AppError(409, 'SLOT_UNAVAILABLE', 'This slot has already started or is too soon to book');
  if (slot.doctor.status !== 'APPROVED') throw preconditionFailed('This doctor is not currently accepting bookings');
  if (slot.location.provider.status !== 'APPROVED' || !slot.location.isActive) throw preconditionFailed('This location is not currently accepting bookings');
  if (slot.affiliation && slot.affiliation.status !== 'ACTIVE') throw preconditionFailed('The doctor no longer practises at this facility');

  const patient = await tx.patientProfile.findUnique({ where: { id: input.patientProfileId } });
  if (!patient || !patient.isActive) throw notFound('Patient profile');

  await claimSlot(tx, slot.id);
  const requireConfirmation = await getSetting<boolean>('booking.require_provider_confirmation', true);
  const status: AppointmentStatus = requireConfirmation ? 'REQUESTED' : 'CONFIRMED';
  const appt = await tx.appointment.create({
    data: {
      reference: makeReference(REF.appointment),
      patientProfileId: patient.id,
      bookedByUserId: input.bookedByUserId,
      doctorProviderId: slot.doctorProviderId,
      facilityProviderId: slot.location.providerId,
      locationId: slot.locationId,
      slotId: slot.id,
      affiliationId: slot.affiliationId,
      status,
      source: input.source,
      attribution: input.attribution,
      feeMinor: slot.feeMinor,
      currency: slot.currency,
      reasonForVisit: input.reasonForVisit,
      idempotencyKey: input.idempotencyKey,
      rescheduledFromId: input.rescheduledFromId,
      confirmedAt: status === 'CONFIRMED' ? new Date() : null,
    },
  });
  await tx.appointmentEvent.create({ data: { appointmentId: appt.id, fromStatus: null, toStatus: status, actorUserId: input.bookedByUserId, actorKind: input.actorKind } });
  // The earning belongs to the practice where care happens (the facility; or
  // the doctor's own practice when the location is the doctor's own).
  await createTransaction(tx, {
    sourceType: 'APPOINTMENT',
    sourceId: appt.id,
    providerId: slot.location.providerId,
    patientProfileId: patient.id,
    grossMinor: slot.feeMinor,
    attribution: input.attribution,
    payAtProvider: input.payAtProvider,
  });
  await audit(tx, {
    action: 'appointment.created',
    entityType: 'appointment',
    entityId: appt.id,
    actorUserId: input.bookedByUserId,
    metadata: { slotId: slot.id, source: input.source, attribution: input.attribution, status },
  });
  return appt.id;
}

export async function book(input: BookingInput): Promise<string> {
  try {
    return await prisma.$transaction((tx) => bookInTx(tx, input));
  } catch (err) {
    if (isPgError(err, '23505')) {
      throw conflict('This patient already has a booking for this slot (or this request was already processed)');
    }
    throw err;
  }
}

export type AppointmentAction = 'CONFIRM' | 'REJECT' | 'CHECK_IN' | 'COMPLETE' | 'NO_SHOW' | 'CANCEL';

/**
 * Apply a lifecycle action. `actorKind` decides which cancellation status is
 * used and which actions are allowed (patients may only cancel).
 */
export async function act(
  id: string,
  action: AppointmentAction,
  actor: { userId: string; kind: 'PATIENT' | 'PROVIDER' | 'PLATFORM' },
  reason?: string,
) {
  if (actor.kind === 'PATIENT' && action !== 'CANCEL') throw new AppError(403, 'FORBIDDEN', 'Patients can only cancel');
  if ((action === 'REJECT' || action === 'CANCEL') && actor.kind !== 'PATIENT' && !reason) throw badRequest('A reason is required');

  return prisma.$transaction(async (tx) => {
    const a = await tx.appointment.findUnique({ where: { id }, include: { slot: true, transaction: true } });
    if (!a) throw notFound('Appointment');
    const to: AppointmentStatus =
      action === 'CONFIRM'
        ? 'CONFIRMED'
        : action === 'REJECT'
          ? 'REJECTED'
          : action === 'CHECK_IN'
            ? 'CHECKED_IN'
            : action === 'COMPLETE'
              ? 'COMPLETED'
              : action === 'NO_SHOW'
                ? 'NO_SHOW'
                : actor.kind === 'PATIENT'
                  ? 'CANCELLED_BY_PATIENT'
                  : actor.kind === 'PROVIDER'
                    ? 'CANCELLED_BY_PROVIDER'
                    : 'CANCELLED_BY_PLATFORM';
    assertTransition('Appointment', APPOINTMENT_TRANSITIONS, a.status, to);

    const now = new Date();
    if (action === 'NO_SHOW' && a.slot.startsAt > now) throw conflict('A no-show can only be recorded after the slot start time');
    if ((action === 'CHECK_IN' || action === 'COMPLETE') && a.slot.startsAt.getTime() - now.getTime() > 6 * 3600_000) {
      throw conflict('Check-in/completion is only possible on the day of the appointment');
    }
    if (action === 'CANCEL' && actor.kind === 'PATIENT') {
      const cutoffMin = await getSetting<number>('booking.patient_cancellation_cutoff_minutes', 120);
      if (a.slot.startsAt.getTime() - now.getTime() < cutoffMin * 60_000) {
        throw conflict(`Appointments can be cancelled up to ${cutoffMin} minutes before the start time`);
      }
    }

    // Optimistic concurrency: only one concurrent transition from `a.status` wins.
    const res = await tx.appointment.updateMany({
      where: { id, status: a.status, version: a.version },
      data: {
        status: to,
        statusReason: reason ?? null,
        version: { increment: 1 },
        ...(to === 'CONFIRMED' ? { confirmedAt: now } : {}),
        ...(to === 'CHECKED_IN' ? { checkedInAt: now } : {}),
        ...(to === 'COMPLETED' ? { completedAt: now } : {}),
        ...(to.startsWith('CANCELLED') || to === 'REJECTED' ? { cancelledAt: now } : {}),
      },
    });
    if (res.count !== 1) throw conflict('The appointment changed concurrently; reload and retry');
    await tx.appointmentEvent.create({ data: { appointmentId: id, fromStatus: a.status, toStatus: to, actorUserId: actor.userId, actorKind: actor.kind, note: reason } });

    let refundRequestedMinor = 0n;
    if (to.startsWith('CANCELLED') || to === 'REJECTED') {
      await releaseSlot(tx, a.slotId);
      if (a.transaction) refundRequestedMinor = (await onSourceCancelled(tx, a.transaction.id, actor.userId, reason ?? to)).refundRequestedMinor;
    }
    if (to === 'COMPLETED' && a.transaction) await onServiceCompleted(tx, a.transaction.id, actor.userId);
    if (to === 'NO_SHOW' && a.transaction && a.transaction.status === 'PENDING_PAYMENT') {
      await tx.serviceTransaction.update({ where: { id: a.transaction.id }, data: { status: 'CANCELLED', eligibilityReason: 'No-show without payment' } });
    }

    const holder = await tx.patientProfile.findUniqueOrThrow({ where: { id: a.patientProfileId }, include: { accountHolder: true } });
    const phone = holder.accountHolder.phone;
    if (phone && (to === 'CONFIRMED' || to.startsWith('CANCELLED') || to === 'REJECTED')) {
      await enqueueNotification(tx, {
        userId: holder.accountUserId,
        channel: 'SMS',
        templateKey: to === 'CONFIRMED' ? 'booking.confirmed' : 'booking.cancelled',
        recipient: phone,
        payload: { reference: a.reference, when: formatIst(a.slot.startsAt) },
      });
    }
    await audit(tx, { action: `appointment.${action.toLowerCase()}`, entityType: 'appointment', entityId: id, actorUserId: actor.userId, metadata: { from: a.status, to, refundRequestedMinor: refundRequestedMinor.toString() } });
    return { refundRequestedMinor: Number(refundRequestedMinor) };
  });
}

/**
 * Reschedule = book the new slot and mark the old appointment RESCHEDULED in a
 * single transaction, so the patient never holds zero or two live bookings.
 */
export async function reschedule(id: string, newSlotId: string, actor: { userId: string; kind: 'PATIENT' | 'PROVIDER' | 'PLATFORM' }) {
  try {
    return await prisma.$transaction(async (tx) => {
      const a = await tx.appointment.findUnique({ where: { id }, include: { transaction: true } });
      if (!a) throw notFound('Appointment');
      assertTransition('Appointment', APPOINTMENT_TRANSITIONS, a.status, 'RESCHEDULED');
      if (newSlotId === a.slotId) throw badRequest('Choose a different slot');
      const newSlot = await tx.appointmentSlot.findUnique({ where: { id: newSlotId } });
      if (!newSlot || newSlot.doctorProviderId !== a.doctorProviderId) throw badRequest('The new slot must be with the same doctor');
      if (newSlot.feeMinor !== a.feeMinor) throw conflict('The new slot has a different fee; cancel and rebook instead');

      const res = await tx.appointment.updateMany({ where: { id, status: a.status, version: a.version }, data: { status: 'RESCHEDULED', version: { increment: 1 }, cancelledAt: new Date() } });
      if (res.count !== 1) throw conflict('The appointment changed concurrently; reload and retry');
      await tx.appointmentEvent.create({ data: { appointmentId: id, fromStatus: a.status, toStatus: 'RESCHEDULED', actorUserId: actor.userId, actorKind: actor.kind } });
      await releaseSlot(tx, a.slotId);

      const newId = await bookInTx(tx, {
        slotId: newSlotId,
        patientProfileId: a.patientProfileId,
        bookedByUserId: a.bookedByUserId,
        source: a.source,
        attribution: a.attribution,
        reasonForVisit: a.reasonForVisit ?? undefined,
        payAtProvider: a.transaction?.status === 'PAY_AT_PROVIDER',
        actorKind: actor.kind,
        rescheduledFromId: a.id,
      });
      // Carry any payment over: move payments to the new transaction.
      if (a.transaction) {
        const newTxn = await tx.serviceTransaction.findUniqueOrThrow({ where: { appointmentId: newId } });
        await tx.payment.updateMany({ where: { transactionId: a.transaction.id }, data: { transactionId: newTxn.id } });
        await tx.serviceTransaction.update({ where: { id: newTxn.id }, data: { status: a.transaction.status, refundedMinor: 0n } });
        await tx.serviceTransaction.update({ where: { id: a.transaction.id }, data: { status: 'CANCELLED', eligibilityReason: 'Rescheduled' } });
      }
      await audit(tx, { action: 'appointment.rescheduled', entityType: 'appointment', entityId: id, actorUserId: actor.userId, metadata: { newAppointmentId: newId, newSlotId } });
      return newId;
    });
  } catch (err) {
    if (isPgError(err, '23505')) throw conflict('The patient already holds a booking in the new slot');
    throw err;
  }
}

export async function listAppointments(q: {
  limit: number;
  cursor?: string;
  status?: AppointmentStatus;
  doctorProviderId?: string;
  facilityProviderId?: string;
  patientAccountUserId?: string;
  from?: Date;
  to?: Date;
}) {
  const where: Prisma.AppointmentWhereInput = {
    ...(q.status ? { status: q.status } : {}),
    ...(q.doctorProviderId ? { doctorProviderId: q.doctorProviderId } : {}),
    ...(q.facilityProviderId ? { facilityProviderId: q.facilityProviderId } : {}),
    ...(q.patientAccountUserId ? { patient: { accountUserId: q.patientAccountUserId } } : {}),
    ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lt: q.to } : {}) } } : {}),
    ...cursorWhere(q.cursor),
  };
  const rows = await prisma.appointment.findMany({ where, include, orderBy: cursorOrderBy(), take: q.limit + 1 });
  const { items, page } = buildPage(rows, q.limit, (a) => a.createdAt);
  return { items: items.map(appointmentDto), page };
}

export { LIVE as LIVE_APPOINTMENT_STATUSES };
