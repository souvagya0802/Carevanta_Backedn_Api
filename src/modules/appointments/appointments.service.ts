import { notifyProviderStaff, notifyUsers } from '../notifications/events.js';
import { prisma, transactionWithRetry, type Tx } from '../../lib/prisma.js';
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
/** Online bookings must start at least this far ahead; the public slot list hides anything sooner. */
export const MIN_LEAD_MS = 15 * 60_000;

const include = {
  patient: { select: { id: true, fullName: true, relationship: true } },
  doctor: { select: { id: true, displayName: true } },
  facility: { select: { id: true, displayName: true, type: true } },
  // Address and coordinates let the patient app show the venue on a map and open directions.
  location: { select: { id: true, name: true, city: true, addressLine1: true, district: true, pincode: true, latitude: true, longitude: true, phone: true } },
  affiliation: { select: { department: { select: { code: true, name: true } } } },
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
    department: a.affiliation?.department ?? null,
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
/** Atomically take one place in a slot. Walk-ins may use a slot that has started but not ended; online bookings need 15 minutes. */
async function claimSlot(tx: Tx, slotId: string, walkIn = false) {
  // Compare-and-set on the slot's version: the conditional updateMany only succeeds if nobody changed the
  // slot since we read it, so under any interleaving at most `capacity` claims succeed. A concurrent writer
  // inside another transaction surfaces as a write conflict, which transactionWithRetry reruns.
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = Date.now();
    const slot = await tx.appointmentSlot.findUnique({ where: { id: slotId }, select: { status: true, bookedCount: true, capacity: true, version: true, startsAt: true, endsAt: true } });
    const timeOk = slot && (walkIn ? slot.endsAt.getTime() > now : slot.startsAt.getTime() > now + MIN_LEAD_MS);
    if (!slot || slot.status !== 'OPEN' || slot.bookedCount >= slot.capacity || !timeOk) break;
    const res = await tx.appointmentSlot.updateMany({
      where: { id: slotId, version: slot.version, status: 'OPEN' },
      data: { bookedCount: { increment: 1 }, version: { increment: 1 } },
    });
    if (res.count === 1) return;
  }
  throw new AppError(409, 'SLOT_UNAVAILABLE', 'This slot is no longer available');
}

async function releaseSlot(tx: Tx, slotId: string) {
  await tx.appointmentSlot.updateMany({
    where: { id: slotId, bookedCount: { gt: 0 } },
    data: { bookedCount: { decrement: 1 }, version: { increment: 1 } },
  });
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
  // A walk-in patient is at the desk, so staff may use the slot that is running now; everyone else needs MIN_LEAD_MS notice.
  const walkIn = input.source === 'WALK_IN';
  if (walkIn ? slot.endsAt.getTime() <= Date.now() : slot.startsAt.getTime() - Date.now() < MIN_LEAD_MS) {
    throw new AppError(409, 'SLOT_UNAVAILABLE', walkIn ? 'This slot has already ended; pick the current or a later one' : 'This slot starts too soon to book online; please pick a later time');
  }
  if (slot.doctor.status !== 'APPROVED') throw preconditionFailed('This doctor is not currently accepting bookings');
  if (slot.location.provider.status !== 'APPROVED' || !slot.location.isActive) throw preconditionFailed('This location is not currently accepting bookings');
  if (slot.affiliation && slot.affiliation.status !== 'ACTIVE') throw preconditionFailed('The doctor no longer practises at this facility');

  const patient = await tx.patientProfile.findUnique({ where: { id: input.patientProfileId } });
  if (!patient || !patient.isActive) throw notFound('Patient profile');

  await claimSlot(tx, slot.id, walkIn);
  const requireConfirmation = await getSetting<boolean>('booking.require_provider_confirmation', true);
  // Staff booking a walk-in at the desk have already accepted the patient.
  const status: AppointmentStatus = requireConfirmation && !walkIn ? 'REQUESTED' : 'CONFIRMED';
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
  // The front desk hears about it at once: everyone at the facility who manages bookings (the doctor themselves at their own chamber).
  await notifyProviderStaff(tx, slot.location.providerId, 'manage_bookings', {
    key: 'portal.appointment_booked',
    title: input.source === 'WALK_IN' ? 'Walk-in recorded' : status === 'CONFIRMED' ? 'New appointment' : 'New appointment request',
    body: `${patient.fullName} · ${slot.doctor.displayName} · ${formatIst(slot.startsAt)}`,
    link: `/appointments?id=${appt.id}`,
    exceptUserId: input.actorKind === 'PROVIDER' ? input.bookedByUserId : null,
  });
  return appt.id;
}

export async function book(input: BookingInput): Promise<string> {
  try {
    return await transactionWithRetry((tx) => bookInTx(tx, input));
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

  return transactionWithRetry(async (tx) => {
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
    // Tell the patient in the app (and by push when enabled) whenever someone else changes the booking.
    if (actor.kind !== 'PATIENT') await notifyPatientOfChange(tx, a, to, reason);
    await audit(tx, { action: `appointment.${action.toLowerCase()}`, entityType: 'appointment', entityId: id, actorUserId: actor.userId, metadata: { from: a.status, to, refundRequestedMinor: refundRequestedMinor.toString() } });
    return { refundRequestedMinor: Number(refundRequestedMinor) };
  });
}

/** In-app (and push) message to the patient's account holder about a change made by the provider or the platform. */
async function notifyPatientOfChange(
  tx: Prisma.TransactionClient,
  a: { id: string; reference: string; patientProfileId: string; doctorProviderId: string; slot: { startsAt: Date } },
  to: AppointmentStatus | 'RESCHEDULED',
  reason?: string | null,
) {
  const [holder, doctor] = await Promise.all([
    tx.patientProfile.findUnique({ where: { id: a.patientProfileId }, select: { accountUserId: true, fullName: true } }),
    tx.provider.findUnique({ where: { id: a.doctorProviderId }, select: { displayName: true } }),
  ]);
  if (!holder) return;
  const who = doctor?.displayName ?? 'your doctor';
  const when = formatIst(a.slot.startsAt);
  const why = reason ? ` Reason: ${reason}` : '';
  const messages: Partial<Record<AppointmentStatus | 'RESCHEDULED', { title: string; body: string; urgent?: boolean }>> = {
    CONFIRMED: { title: 'Appointment confirmed', body: `Your visit with ${who} on ${when} is confirmed (${a.reference}).` },
    REJECTED: { title: 'Appointment not accepted', body: `${who} could not accept the booking for ${when}.${why} Any payment will be refunded.`, urgent: true },
    CANCELLED_BY_PROVIDER: { title: 'Appointment cancelled by the clinic', body: `Your visit with ${who} on ${when} was cancelled.${why} Any payment will be refunded.`, urgent: true },
    CANCELLED_BY_PLATFORM: { title: 'Appointment cancelled', body: `Your visit with ${who} on ${when} was cancelled by Carevanta support.${why} Any payment will be refunded.`, urgent: true },
    CHECKED_IN: { title: 'You are checked in', body: `Checked in for ${who}. Please wait to be called.` },
    COMPLETED: { title: 'Visit completed', body: `Your visit with ${who} is complete. Tell others how it went: rate this visit.` },
    NO_SHOW: { title: 'Missed appointment', body: `You were marked as not attending the visit with ${who} on ${when}.` },
    RESCHEDULED: { title: 'Appointment moved', body: `Your visit with ${who} is now on ${when} (${a.reference}).`, urgent: true },
  };
  const m = messages[to];
  if (!m) return;
  await notifyUsers(tx, [holder.accountUserId], { key: `appointment.${to.toLowerCase()}`, title: m.title, body: m.body, link: `/appointments/${a.id}`, urgent: m.urgent });
}

/**
 * Reschedule = book the new slot and mark the old appointment RESCHEDULED in a
 * single transaction, so the patient never holds zero or two live bookings.
 */
export async function reschedule(id: string, newSlotId: string, actor: { userId: string; kind: 'PATIENT' | 'PROVIDER' | 'PLATFORM' }) {
  try {
    return await transactionWithRetry(async (tx) => {
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
      if (actor.kind !== 'PATIENT') await notifyPatientOfChange(tx, { ...a, id: newId, slot: newSlot }, 'RESCHEDULED');
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
  departmentCode?: string;
  q?: string;
  from?: Date;
  to?: Date;
  /** Filter on the slot start (when the visit happens), not on when it was booked. */
  startsFrom?: Date;
  startsTo?: Date;
}) {
  const where: Prisma.AppointmentWhereInput = {
    ...(q.status ? { status: q.status } : {}),
    ...(q.doctorProviderId ? { doctorProviderId: q.doctorProviderId } : {}),
    ...(q.facilityProviderId ? { facilityProviderId: q.facilityProviderId } : {}),
    ...(q.patientAccountUserId ? { patient: { accountUserId: q.patientAccountUserId } } : {}),
    ...(q.departmentCode ? { affiliation: { department: { code: q.departmentCode } } } : {}),
    ...(q.q ? { OR: [{ patient: { fullName: { contains: q.q, mode: 'insensitive' } } }, { reference: { equals: q.q.toUpperCase() } }, { patient: { phone: { contains: q.q } } }] } : {}),
    ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lt: q.to } : {}) } } : {}),
    ...(q.startsFrom || q.startsTo ? { slot: { startsAt: { ...(q.startsFrom ? { gte: q.startsFrom } : {}), ...(q.startsTo ? { lt: q.startsTo } : {}) } } } : {}),
    ...cursorWhere(q.cursor),
  };
  const rows = await prisma.appointment.findMany({ where, include, orderBy: cursorOrderBy(), take: q.limit + 1 });
  const { items, page } = buildPage(rows, q.limit, (a) => a.createdAt);
  return { items: items.map(appointmentDto), page };
}

export { LIVE as LIVE_APPOINTMENT_STATUSES };
