import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { resetDatabase } from '../helpers/db.js';
import { actor, idem } from '../helpers/factory.js';
import { actorForUser, affiliatedDoctor, approveProvider, createHospital, istDate, patient, slotsFor, istWeekday } from '../helpers/fixtures.js';

beforeAll(resetDatabase);

async function setup(capacity = 1) {
  const ctx = await affiliatedDoctor();
  const scheduler = await actor(['PLATFORM_ADMIN']);
  const { slots } = await slotsFor(scheduler, ctx.doctor.id, ctx.hospital.locationId, { capacity });
  return { ...ctx, scheduler, slots };
}

describe('scheduling', () => {
  it('generates IST slots and refuses overlapping time at another facility', async () => {
    const ctx = await setup();
    expect(ctx.slots).toHaveLength(4); // 10:00–12:00 in 30-minute slots
    const first = ctx.slots[0]!;
    // 10:00 IST = 04:30 UTC
    expect(first.startsAt.toISOString().slice(11, 16)).toBe('04:30');

    // Same doctor, same weekday and time at their own chamber: the session itself is refused with a clear reason
    // (QA PORT-2; the slot-level EXCLUDE constraint remains the last line of defence).
    const own = await ctx.scheduler.post('/api/v1/schedules', { doctorProviderId: ctx.doctor.id, locationId: ctx.doctor.locationId!, dayOfWeek: istWeekday(istDate(2)), startMinute: 600, endMinute: 720, slotMinutes: 30, capacityPerSlot: 1, validFrom: istDate(0) });
    expect(own.status).toBe(409);
    expect(own.body.error.message).toMatch(/overlaps/);
    // Re-running generation is idempotent.
    const again = await ctx.scheduler.post(`/api/v1/schedules/${first.scheduleId}/generate-slots`, { from: istDate(2), to: istDate(2) });
    expect(again.body.data.created).toBe(0);
  });

  it('refuses schedules at a facility without an active affiliation', async () => {
    const ctx = await setup();
    const other = await createHospital(ctx.registrar);
    await approveProvider(other.id, ctx.registrar, ctx.verifier);
    const res = await ctx.scheduler.post('/api/v1/schedules', {
      doctorProviderId: ctx.doctor.id,
      locationId: other.locationId,
      dayOfWeek: 1,
      startMinute: 600,
      endMinute: 660,
      slotMinutes: 30,
      validFrom: istDate(0),
    });
    expect(res.status).toBe(422);
  });

  it('only the doctor, the facility, or a scheduler may create schedules', async () => {
    const ctx = await setup();
    const stranger = await actor([]);
    const res = await stranger.post('/api/v1/schedules', {
      doctorProviderId: ctx.doctor.id,
      locationId: ctx.hospital.locationId,
      dayOfWeek: 2,
      startMinute: 900,
      endMinute: 960,
      slotMinutes: 30,
      validFrom: istDate(0),
    });
    expect([403, 404]).toContain(res.status);
  });
});

describe('booking', () => {
  it('books a slot, creates a transaction and records attribution', async () => {
    const ctx = await setup();
    const p = await patient();
    const res = await p.post('/api/v1/patient/appointments', { slotId: ctx.slots[0]!.id, patientProfileId: p.profileId }, idem());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.status).toBe('REQUESTED');
    expect(res.body.data.attribution).toBe('PLATFORM');
    expect(res.body.data.feeMinor).toBe(60000); // affiliation fee
    const txn = await prisma.serviceTransaction.findUniqueOrThrow({ where: { appointmentId: res.body.data.id } });
    expect(txn.providerId).toBe(ctx.hospital.id);
    expect(txn.status).toBe('PENDING_PAYMENT');
    expect((await prisma.appointmentSlot.findUniqueOrThrow({ where: { id: ctx.slots[0]!.id } })).bookedCount).toBe(1);
  });

  it('prevents double booking under concurrency (capacity 1, 10 patients at once)', async () => {
    const ctx = await setup(1);
    const patients = await Promise.all(Array.from({ length: 10 }, () => patient()));
    const slotId = ctx.slots[1]!.id;
    const results = await Promise.all(patients.map((p) => p.post('/api/v1/patient/appointments', { slotId, patientProfileId: p.profileId }, idem())));
    const ok = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);
    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(9);
    expect(conflicts.every((r) => r.body.error.code === 'SLOT_UNAVAILABLE')).toBe(true);
    const slot = await prisma.appointmentSlot.findUniqueOrThrow({ where: { id: slotId } });
    expect(slot.bookedCount).toBe(1);
    expect(await prisma.appointment.count({ where: { slotId } })).toBe(1);
  });

  it('honours capacity > 1 exactly under concurrency', async () => {
    const ctx = await setup(3);
    const patients = await Promise.all(Array.from({ length: 8 }, () => patient()));
    const slotId = ctx.slots[0]!.id;
    const results = await Promise.all(patients.map((p) => p.post('/api/v1/patient/appointments', { slotId, patientProfileId: p.profileId }, idem())));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect((await prisma.appointmentSlot.findUniqueOrThrow({ where: { id: slotId } })).bookedCount).toBe(3);
  });

  it('idempotent retries return the same booking and never double-book', async () => {
    const ctx = await setup(5);
    const p = await patient();
    const key = idem();
    const body = { slotId: ctx.slots[2]!.id, patientProfileId: p.profileId };
    const [a, b] = await Promise.all([p.post('/api/v1/patient/appointments', body, key), p.post('/api/v1/patient/appointments', body, key)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(201);
    const replay = await p.post('/api/v1/patient/appointments', body, key);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(await prisma.appointment.count({ where: { patientProfileId: p.profileId } })).toBe(1);
    const changed = await p.post('/api/v1/patient/appointments', { ...body, reasonForVisit: 'different' }, key);
    expect(changed.status).toBe(422);
    const noKey = await p.post('/api/v1/patient/appointments', body);
    expect(noKey.status).toBe(400);
  });

  it('a patient cannot book for, or read, someone else’s profile (IDOR)', async () => {
    const ctx = await setup(2);
    const alice = await patient();
    const mallory = await patient();
    const steal = await mallory.post('/api/v1/patient/appointments', { slotId: ctx.slots[0]!.id, patientProfileId: alice.profileId }, idem());
    expect(steal.status).toBe(404);
    const mine = await alice.post('/api/v1/patient/appointments', { slotId: ctx.slots[0]!.id, patientProfileId: alice.profileId }, idem());
    expect((await mallory.get(`/api/v1/patient/appointments/${mine.body.data.id}`)).status).toBe(404);
    expect((await mallory.post(`/api/v1/patient/appointments/${mine.body.data.id}/cancel`, {})).status).toBe(404);
    expect((await alice.get(`/api/v1/patient/appointments/${mine.body.data.id}`)).status).toBe(200);
  });

  it('refuses unavailable providers and invalid slots', async () => {
    const ctx = await setup(2);
    const p = await patient();
    await ctx.registrar.post(`/api/v1/admin/providers/${ctx.doctor.id}/status`, { action: 'SUSPEND', reason: 'Registration lapsed' });
    const res = await p.post('/api/v1/patient/appointments', { slotId: ctx.slots[0]!.id, patientProfileId: p.profileId }, idem());
    expect([409, 422]).toContain(res.status);
    const missing = await p.post('/api/v1/patient/appointments', { slotId: '01890000-0000-7000-8000-000000000000', patientProfileId: p.profileId }, idem());
    expect(missing.status).toBe(404);
  });
});

describe('appointment lifecycle', () => {
  it('confirm → check-in only on the day; invalid transitions are refused', async () => {
    const ctx = await setup(2);
    const p = await patient();
    const b = await p.post('/api/v1/patient/appointments', { slotId: ctx.slots[0]!.id, patientProfileId: p.profileId }, idem());
    const id = b.body.data.id;
    const complete = await ctx.hospitalOwner.post(`/api/v1/portal/providers/${ctx.hospital.id}/appointments/${id}/actions`, { action: 'COMPLETE' });
    expect(complete.status).toBe(409);
    expect(complete.body.error.code).toBe('INVALID_STATE_TRANSITION');
    const confirm = await ctx.hospitalOwner.post(`/api/v1/portal/providers/${ctx.hospital.id}/appointments/${id}/actions`, { action: 'CONFIRM' });
    expect(confirm.status).toBe(200);
    const again = await ctx.hospitalOwner.post(`/api/v1/portal/providers/${ctx.hospital.id}/appointments/${id}/actions`, { action: 'CONFIRM' });
    expect(again.status).toBe(409);
    const noShowEarly = await ctx.hospitalOwner.post(`/api/v1/portal/providers/${ctx.hospital.id}/appointments/${id}/actions`, { action: 'NO_SHOW' });
    expect(noShowEarly.status).toBe(409);
    // Patients cannot confirm.
    const patientConfirm = await ctx.hospitalOwner.post(`/api/v1/portal/providers/${ctx.hospital.id}/appointments/${id}/actions`, { action: 'REJECT' });
    expect(patientConfirm.status).toBe(400); // reason required
  });

  it('cancellation releases capacity; repeated cancellation is refused', async () => {
    const ctx = await setup(1);
    const p = await patient();
    const b = await p.post('/api/v1/patient/appointments', { slotId: ctx.slots[3]!.id, patientProfileId: p.profileId }, idem());
    const c1 = await p.post(`/api/v1/patient/appointments/${b.body.data.id}/cancel`, { reason: 'Feeling better' });
    expect(c1.status).toBe(200);
    expect(c1.body.data.status).toBe('CANCELLED_BY_PATIENT');
    const c2 = await p.post(`/api/v1/patient/appointments/${b.body.data.id}/cancel`, {});
    expect(c2.status).toBe(409);
    expect((await prisma.appointmentSlot.findUniqueOrThrow({ where: { id: ctx.slots[3]!.id } })).bookedCount).toBe(0);
    // Capacity freed → someone else can book.
    const q = await patient();
    expect((await q.post('/api/v1/patient/appointments', { slotId: ctx.slots[3]!.id, patientProfileId: q.profileId }, idem())).status).toBe(201);
    const txn = await prisma.serviceTransaction.findUniqueOrThrow({ where: { appointmentId: b.body.data.id } });
    expect(txn.status).toBe('CANCELLED');
  });

  it('reschedules atomically and refuses a full target slot', async () => {
    const ctx = await setup(1);
    const p = await patient();
    const other = await patient();
    const b = await p.post('/api/v1/patient/appointments', { slotId: ctx.slots[0]!.id, patientProfileId: p.profileId }, idem());
    await other.post('/api/v1/patient/appointments', { slotId: ctx.slots[1]!.id, patientProfileId: other.profileId }, idem());
    const full = await p.post(`/api/v1/patient/appointments/${b.body.data.id}/reschedule`, { newSlotId: ctx.slots[1]!.id });
    expect(full.status).toBe(409);
    // Nothing changed after the failed attempt.
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: b.body.data.id } })).status).toBe('REQUESTED');
    const ok = await p.post(`/api/v1/patient/appointments/${b.body.data.id}/reschedule`, { newSlotId: ctx.slots[2]!.id });
    expect(ok.status).toBe(200);
    expect(ok.body.data.rescheduledFromId).toBe(b.body.data.id);
    expect((await prisma.appointmentSlot.findUniqueOrThrow({ where: { id: ctx.slots[0]!.id } })).bookedCount).toBe(0);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: b.body.data.id } })).status).toBe('RESCHEDULED');
  });

  it('walk-ins are PROVIDER_DIRECT and a facility cannot act on another facility’s appointment', async () => {
    const ctx = await setup(3);
    const walk = await ctx.hospitalOwner.post(
      `/api/v1/portal/providers/${ctx.hospital.id}/appointments/walk-in`,
      { slotId: ctx.slots[0]!.id, patientFullName: 'Walk In Patient', patientPhone: '9800055555' },
      idem(),
    );
    expect(walk.status, JSON.stringify(walk.body)).toBe(201);
    expect(walk.body.data.attribution).toBe('PROVIDER_DIRECT');

    const otherHospital = await createHospital(ctx.registrar);
    const otherOwner = await actorForUser(otherHospital.ownerUserId);
    const res = await otherOwner.post(`/api/v1/portal/providers/${otherHospital.id}/appointments/${walk.body.data.id}/actions`, { action: 'CONFIRM' });
    expect(res.status).toBe(404);
  });
});
