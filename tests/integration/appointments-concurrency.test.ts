import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import RedisMock from 'ioredis-mock';
import { prisma } from '../../src/lib/prisma.js';
import { useRedisClient } from '../../src/lib/redis.js';
import { resetSlotLocksForTests, slotLockBackend } from '../../src/lib/slot-lock.js';
import { resetDatabase } from '../helpers/db.js';
import { actor, idem } from '../helpers/factory.js';
import { affiliatedDoctor, patient, slotsFor } from '../helpers/fixtures.js';

/**
 * Founder requirement: when many patients book the same slot of the same doctor at the same moment, the API
 * must decide properly who gets it. These tests fire 25 requests at once against one slot for both lock
 * backends (in-process when REDIS_URL is unset; Redis through ioredis-mock) and check the outcome, the slot
 * counters and the absence of duplicate appointments.
 */

beforeAll(resetDatabase);

const LIVE = ['REQUESTED', 'CONFIRMED', 'CHECKED_IN'] as const;
const N = 25;

async function setup(capacity = 1, opts: { startMinute?: number; endMinute?: number } = {}) {
  const ctx = await affiliatedDoctor();
  const scheduler = await actor(['PLATFORM_ADMIN']);
  const { slots } = await slotsFor(scheduler, ctx.doctor.id, ctx.hospital.locationId, { capacity, ...opts });
  return { ...ctx, scheduler, slots };
}

const patients = (n: number) => Promise.all(Array.from({ length: n }, () => patient()));
const book = (p: Awaited<ReturnType<typeof patient>>, slotId: string) => p.post('/api/v1/patient/appointments', { slotId, patientProfileId: p.profileId }, idem());

const backends = [
  { name: 'in-process lock (no REDIS_URL)', use: () => useRedisClient(null), expected: 'memory' as const },
  { name: 'Redis lock (ioredis-mock)', use: () => useRedisClient(new RedisMock()), expected: 'redis' as const },
];

describe.each(backends)('booking one slot under concurrency — $name', ({ use, expected }) => {
  beforeEach(() => {
    use();
    resetSlotLocksForTests();
    expect(slotLockBackend()).toBe(expected);
  });
  afterAll(() => useRedisClient(null));

  it(`${N} patients book the same capacity-1 slot at once: exactly one 201, the rest 409 SLOT_UNAVAILABLE`, async () => {
    const ctx = await setup(1);
    const target = ctx.slots[0]!;
    const ps = await patients(N);
    const results = await Promise.all(ps.map((p) => book(p, target.id)));

    const ok = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);
    expect(ok, JSON.stringify(results.map((r) => [r.status, r.body.error?.code]))).toHaveLength(1);
    expect(conflicts).toHaveLength(N - 1);
    expect(conflicts.every((r) => r.body.error.code === 'SLOT_UNAVAILABLE')).toBe(true);
    expect(results.some((r) => r.status >= 500)).toBe(false);

    const slot = await prisma.appointmentSlot.findUniqueOrThrow({ where: { id: target.id } });
    expect(slot.bookedCount).toBe(1);
    expect(slot.version).toBe(target.version + 1); // exactly one successful compare-and-set
    expect(await prisma.appointment.count({ where: { slotId: target.id } })).toBe(1);
    expect(await prisma.appointment.count({ where: { slotId: target.id, status: { in: [...LIVE] } } })).toBe(1);
    // The winner is a real patient from the batch and holds the only appointment.
    const winner = ps.find((p) => p.profileId === ok[0]!.body.data.patient.id);
    expect(winner).toBeDefined();
    expect(await prisma.appointment.count({ where: { patientProfileId: winner!.profileId } })).toBe(1);
  });

  it(`${N} patients against a capacity-3 slot: exactly three winners, counters consistent`, async () => {
    const ctx = await setup(3);
    const target = ctx.slots[1]!;
    const ps = await patients(N);
    const results = await Promise.all(ps.map((p) => book(p, target.id)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409 && r.body.error.code === 'SLOT_UNAVAILABLE')).toHaveLength(N - 3);
    const slot = await prisma.appointmentSlot.findUniqueOrThrow({ where: { id: target.id } });
    expect(slot.bookedCount).toBe(3);
    expect(slot.version).toBe(target.version + 3);
    expect(await prisma.appointment.count({ where: { slotId: target.id } })).toBe(3);
  });

  it(`${N} patients reschedule into the same free slot at once: one moves, the others keep their original booking`, async () => {
    // 08:00–22:00 in 30-minute slots = 28 slots: slot 0 is the contested target, slots 1..N hold one booking each.
    const ctx = await setup(1, { startMinute: 480, endMinute: 1320 });
    expect(ctx.slots.length).toBeGreaterThan(N);
    const target = ctx.slots[0]!;
    const ps = await patients(N);
    const originals = await Promise.all(ps.map((p, i) => book(p, ctx.slots[i + 1]!.id)));
    expect(originals.every((r) => r.status === 201), JSON.stringify(originals.map((r) => r.status))).toBe(true);
    const apptIds = originals.map((r) => r.body.data.id as string);

    const results = await Promise.all(ps.map((p, i) => p.post(`/api/v1/patient/appointments/${apptIds[i]}/reschedule`, { newSlotId: target.id })));
    const moved = results.filter((r) => r.status === 200);
    const conflicts = results.filter((r) => r.status === 409);
    expect(moved, JSON.stringify(results.map((r) => [r.status, r.body.error?.code]))).toHaveLength(1);
    expect(conflicts).toHaveLength(N - 1);
    expect(conflicts.every((r) => r.body.error.code === 'SLOT_UNAVAILABLE')).toBe(true);

    const slot = await prisma.appointmentSlot.findUniqueOrThrow({ where: { id: target.id } });
    expect(slot.bookedCount).toBe(1);
    expect(slot.version).toBe(target.version + 1);
    expect(await prisma.appointment.count({ where: { slotId: target.id } })).toBe(1);

    // Winner: old appointment RESCHEDULED, its old slot freed, new appointment live in the target slot.
    const winnerIndex = results.findIndex((r) => r.status === 200);
    const winnerOld = await prisma.appointment.findUniqueOrThrow({ where: { id: apptIds[winnerIndex]! } });
    expect(winnerOld.status).toBe('RESCHEDULED');
    expect((await prisma.appointmentSlot.findUniqueOrThrow({ where: { id: ctx.slots[winnerIndex + 1]!.id } })).bookedCount).toBe(0);
    expect(moved[0]!.body.data.rescheduledFromId).toBe(apptIds[winnerIndex]);
    // Losers: nothing changed — original booking still live, original slot still taken, no stray appointment rows.
    for (let i = 0; i < N; i++) {
      if (i === winnerIndex) continue;
      const a = await prisma.appointment.findUniqueOrThrow({ where: { id: apptIds[i]! } });
      expect(a.status).toBe('REQUESTED');
      expect(a.slotId).toBe(ctx.slots[i + 1]!.id);
      expect((await prisma.appointmentSlot.findUniqueOrThrow({ where: { id: ctx.slots[i + 1]!.id } })).bookedCount).toBe(1);
    }
    expect(await prisma.appointment.count({ where: { patientProfileId: { in: ps.map((p) => p.profileId) } } })).toBe(N + 1);
  });

  it('the same patient cannot hold two live bookings in one slot (MongoDB duplicate key → 409)', async () => {
    const ctx = await setup(2);
    const p = await patient();
    const first = await book(p, ctx.slots[2]!.id);
    expect(first.status).toBe(201);
    const again = await book(p, ctx.slots[2]!.id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONFLICT');
    expect(again.body.error.message).toMatch(/already has a booking/);
    expect((await prisma.appointmentSlot.findUniqueOrThrow({ where: { id: ctx.slots[2]!.id } })).bookedCount).toBe(1);
  });
});
