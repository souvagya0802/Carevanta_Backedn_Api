import { prisma, Prisma } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, notFound, preconditionFailed } from '../../lib/errors.js';
import { istDateRange, istToUtc } from '../../lib/time.js';
import { isoDate, minor } from '../../http/dto.js';
import type { AuthContext } from '../../middleware/auth.js';

export interface ScheduleInput {
  doctorProviderId: string;
  locationId: string;
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
  slotMinutes: number;
  capacityPerSlot: number;
  feeMinor?: number;
  validFrom: string;
  validTo?: string;
}

/**
 * A doctor may hold schedules at (a) their own practice locations, or (b) a
 * facility location covered by an ACTIVE affiliation. Fee defaults cascade:
 * explicit → affiliation fee → doctor default fee.
 */
async function resolvePracticeContext(doctorProviderId: string, locationId: string) {
  const [doctor, location] = await Promise.all([
    prisma.provider.findUnique({ where: { id: doctorProviderId }, include: { doctorProfile: true } }),
    prisma.providerLocation.findUnique({ where: { id: locationId }, include: { provider: true } }),
  ]);
  if (!doctor || doctor.type !== 'DOCTOR' || !doctor.doctorProfile) throw badRequest('doctorProviderId must reference a doctor');
  if (!location || !location.isActive) throw badRequest('Location not found or inactive');
  if (location.providerId === doctorProviderId) return { doctor, location, affiliation: null };
  const affiliation = await prisma.doctorAffiliation.findFirst({
    where: {
      doctorProviderId,
      facilityProviderId: location.providerId,
      status: 'ACTIVE',
      OR: [{ locationId: null }, { locationId }],
    },
  });
  if (!affiliation) throw preconditionFailed('The doctor has no ACTIVE affiliation covering this location');
  return { doctor, location, affiliation };
}

export async function createSchedule(actor: AuthContext, input: ScheduleInput) {
  if (input.endMinute <= input.startMinute) throw badRequest('endMinute must be after startMinute');
  if ((input.endMinute - input.startMinute) % input.slotMinutes !== 0) {
    throw badRequest('The session length must be a whole number of slots');
  }
  const ctx = await resolvePracticeContext(input.doctorProviderId, input.locationId);
  const fee = input.feeMinor ?? minor(ctx.affiliation?.consultationFeeMinor) ?? minor(ctx.doctor.doctorProfile!.defaultFeeMinor);
  if (fee == null) throw badRequest('No fee given and no default fee on the affiliation or doctor profile');
  return prisma.$transaction(async (tx) => {
    const s = await tx.doctorSchedule.create({
      data: {
        doctorProviderId: input.doctorProviderId,
        locationId: input.locationId,
        affiliationId: ctx.affiliation?.id ?? null,
        dayOfWeek: input.dayOfWeek,
        startMinute: input.startMinute,
        endMinute: input.endMinute,
        slotMinutes: input.slotMinutes,
        capacityPerSlot: input.capacityPerSlot,
        feeMinor: BigInt(fee),
        validFrom: new Date(input.validFrom),
        validTo: input.validTo ? new Date(input.validTo) : null,
        createdById: actor.userId,
      },
    });
    await audit(tx, { action: 'schedule.created', entityType: 'doctor_schedule', entityId: s.id, metadata: { doctorProviderId: input.doctorProviderId, locationId: input.locationId } });
    return scheduleDto(s);
  });
}

export function scheduleDto(s: {
  id: string;
  doctorProviderId: string;
  locationId: string;
  affiliationId: string | null;
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
  slotMinutes: number;
  capacityPerSlot: number;
  feeMinor: bigint | null;
  validFrom: Date;
  validTo: Date | null;
  isActive: boolean;
  createdAt: Date;
}) {
  return {
    id: s.id,
    doctorProviderId: s.doctorProviderId,
    locationId: s.locationId,
    affiliationId: s.affiliationId,
    dayOfWeek: s.dayOfWeek,
    startMinute: s.startMinute,
    endMinute: s.endMinute,
    slotMinutes: s.slotMinutes,
    capacityPerSlot: s.capacityPerSlot,
    feeMinor: minor(s.feeMinor),
    validFrom: isoDate(s.validFrom)!,
    validTo: isoDate(s.validTo),
    isActive: s.isActive,
    createdAt: s.createdAt.toISOString(),
  };
}

/**
 * Materialise slots for a date range (max 62 days). Uses INSERT … ON CONFLICT
 * DO NOTHING, which also covers the EXCLUDE constraint — so a slot that would
 * overlap the same doctor's time at another facility is skipped, never
 * double-booked. Returns created and skipped counts.
 */
export async function generateSlots(actor: AuthContext, scheduleId: string, from: string, to: string) {
  const days = istDateRange(from, to);
  if (days.length === 0) throw badRequest('`to` must not be before `from`');
  if (days.length > 62) throw badRequest('Generate at most 62 days at a time');
  const s = await prisma.doctorSchedule.findUnique({ where: { id: scheduleId } });
  if (!s || !s.isActive) throw notFound('Active schedule');
  if (s.affiliationId) {
    const a = await prisma.doctorAffiliation.findUnique({ where: { id: s.affiliationId } });
    if (a?.status !== 'ACTIVE') throw preconditionFailed('The affiliation for this schedule is not ACTIVE');
  }
  const validFrom = isoDate(s.validFrom)!;
  const validTo = isoDate(s.validTo);
  const now = Date.now();
  const rows: Prisma.Sql[] = [];
  for (const day of days) {
    if (day < validFrom || (validTo && day > validTo)) continue;
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (weekday !== s.dayOfWeek) continue;
    for (let m = s.startMinute; m + s.slotMinutes <= s.endMinute; m += s.slotMinutes) {
      const startsAt = istToUtc(day, m);
      if (startsAt.getTime() <= now) continue;
      const endsAt = new Date(startsAt.getTime() + s.slotMinutes * 60_000);
      rows.push(
        Prisma.sql`(${s.doctorProviderId}::uuid, ${s.locationId}::uuid, ${s.affiliationId}::uuid, ${s.id}::uuid, ${startsAt}::timestamptz, ${endsAt}::timestamptz, ${s.capacityPerSlot}::smallint, ${s.feeMinor ?? 0n}::bigint)`,
      );
    }
  }
  if (rows.length === 0) return { created: 0, skipped: 0 };
  if (rows.length > 5000) throw badRequest('Too many slots in one request; use a shorter range');
  const created = await prisma.$executeRaw`
    INSERT INTO appointment_slots (doctor_provider_id, location_id, affiliation_id, schedule_id, starts_at, ends_at, capacity, fee_minor, updated_at)
    SELECT v.*, now() FROM (VALUES ${Prisma.join(rows)}) AS v
    ON CONFLICT DO NOTHING`;
  await audit(prisma, { action: 'schedule.slots_generated', entityType: 'doctor_schedule', entityId: s.id, actorUserId: actor.userId, metadata: { from, to, created, skipped: rows.length - created } });
  return { created, skipped: rows.length - created };
}

export async function listSlots(q: { doctorProviderId?: string; locationId?: string; from: Date; to: Date; status?: 'OPEN' | 'BLOCKED' | 'CANCELLED' }) {
  if (q.to.getTime() - q.from.getTime() > 62 * 86_400_000) throw badRequest('Range too large (max 62 days)');
  const slots = await prisma.appointmentSlot.findMany({
    where: {
      ...(q.doctorProviderId ? { doctorProviderId: q.doctorProviderId } : {}),
      ...(q.locationId ? { locationId: q.locationId } : {}),
      ...(q.status ? { status: q.status } : {}),
      startsAt: { gte: q.from, lt: q.to },
    },
    orderBy: { startsAt: 'asc' },
    take: 1000,
    include: { location: { select: { name: true } } },
  });
  return slots.map(slotDto);
}

export function slotDto(s: {
  id: string;
  doctorProviderId: string;
  locationId: string;
  affiliationId: string | null;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  bookedCount: number;
  status: string;
  feeMinor: bigint;
  currency: string;
  location?: { name: string };
}) {
  return {
    id: s.id,
    doctorProviderId: s.doctorProviderId,
    locationId: s.locationId,
    locationName: s.location?.name ?? null,
    affiliationId: s.affiliationId,
    startsAt: s.startsAt.toISOString(),
    endsAt: s.endsAt.toISOString(),
    capacity: s.capacity,
    bookedCount: s.bookedCount,
    status: s.status,
    feeMinor: minor(s.feeMinor)!,
    currency: s.currency,
  };
}

export async function setSlotStatus(actor: AuthContext, slotId: string, status: 'OPEN' | 'BLOCKED') {
  return prisma.$transaction(async (tx) => {
    const s = await tx.appointmentSlot.findUnique({ where: { id: slotId } });
    if (!s) throw notFound('Slot');
    if (s.status === 'CANCELLED') throw conflict('Cancelled slots cannot be changed');
    if (s.status === status) throw conflict(`Slot is already ${status}`);
    const updated = await tx.appointmentSlot.update({ where: { id: slotId }, data: { status, version: { increment: 1 } } });
    await audit(tx, { action: status === 'BLOCKED' ? 'slot.blocked' : 'slot.opened', entityType: 'appointment_slot', entityId: slotId, actorUserId: actor.userId, metadata: { bookedCount: s.bookedCount } });
    return slotDto(updated);
  });
}

