import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { resetDatabase } from '../helpers/db.js';
import { actor } from '../helpers/factory.js';
import { actorForUser, affiliatedDoctor, createHospital, staff } from '../helpers/fixtures.js';

beforeAll(resetDatabase);

const nextDate = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe('provider portal — scheduling and reference lists', () => {
  it('lets a facility schedule its affiliated doctors, generate and block slots, and keeps other doctors out', async () => {
    const { hospital, doctor: doc, hospitalOwner: owner, doctorUser: doctor } = await affiliatedDoctor({ specialities: ['GENERAL_MEDICINE'] });
    const doctorId = doc.id;
    const hospitalId = hospital.id;
    const locationId = hospital.locationId;
    const base = `/api/v1/portal/providers/${hospitalId}`;

    const doctors = await owner.get(`${base}/doctors`);
    expect(doctors.status, JSON.stringify(doctors.body)).toBe(200);
    expect(doctors.body.data.map((d: { doctorProviderId: string }) => d.doctorProviderId)).toContain(doctorId);

    // Schedule: Monday 10:00–13:00 in 15-minute slots, fee ₹500.
    const created = await owner.post(`${base}/schedules`, { doctorProviderId: doctorId, locationId, dayOfWeek: 1, startMinute: 600, endMinute: 780, slotMinutes: 15, feeMinor: 50000, validFrom: nextDate(0) });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await owner.post(`${base}/schedules`, { doctorProviderId: doctorId, locationId, dayOfWeek: 1, startMinute: 600, endMinute: 650, slotMinutes: 15, feeMinor: 50000, validFrom: nextDate(0) })).status).toBe(400); // 50 min is not a whole number of slots
    const list = await owner.get(`${base}/schedules`);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ doctorProviderId: doctorId, locationName: expect.any(String), slotMinutes: 15 });

    // Generate two weeks of slots and read them back through the portal.
    const gen = await owner.post(`${base}/schedules/${created.body.data.id}/generate-slots`, { from: nextDate(1), to: nextDate(14) });
    expect(gen.status, JSON.stringify(gen.body)).toBe(200);
    expect(gen.body.data.created).toBeGreaterThanOrEqual(12);
    const slots = await owner.get(`${base}/slots?doctorProviderId=${doctorId}&from=${new Date(Date.now() + 86_400_000).toISOString()}&to=${new Date(Date.now() + 15 * 86_400_000).toISOString()}`);
    expect(slots.status, JSON.stringify(slots.body)).toBe(200);
    expect(slots.body.data.length).toBe(gen.body.data.created);
    expect(slots.body.data[0]).toMatchObject({ status: 'OPEN', bookedCount: 0, doctorName: expect.any(String) });
    expect((await owner.get(`${base}/slots?from=${new Date().toISOString()}&to=${new Date(Date.now() + 90 * 86_400_000).toISOString()}`)).status).toBe(400); // > 62 days

    // Block one slot, reopen it, then stop the template.
    const slotId = slots.body.data[0].id;
    expect((await owner.post(`${base}/slots/${slotId}/status`, { status: 'BLOCKED' })).body.data.status).toBe('BLOCKED');
    expect((await owner.post(`${base}/slots/${slotId}/status`, { status: 'OPEN' })).body.data.status).toBe('OPEN');
    expect((await owner.post(`${base}/schedules/${created.body.data.id}/deactivate`)).body.data.isActive).toBe(false);

    // A doctor who is not affiliated cannot be scheduled here; a different hospital cannot touch these slots.
    const { registrar } = await staff();
    const other = await createHospital(registrar, { name: 'Unrelated Hospital' });
    const otherOwner = await actorForUser(other.ownerUserId);
    expect((await otherOwner.post(`/api/v1/portal/providers/${other.id}/slots/${slotId}/status`, { status: 'BLOCKED' })).status).toBe(404);
    const strangerDoctor = await prisma.provider.findFirst({ where: { type: 'DOCTOR', id: { not: doctorId } }, select: { id: true } });
    if (strangerDoctor) expect((await owner.post(`${base}/schedules`, { doctorProviderId: strangerDoctor.id, locationId, dayOfWeek: 2, startMinute: 600, endMinute: 660, slotMinutes: 15, feeMinor: 50000, validFrom: nextDate(0) })).status).toBe(404);

    // The doctor sees the same schedule from their own practice view.
    const mine = await doctor.get(`/api/v1/portal/providers/${doctorId}/schedules`);
    expect(mine.status).toBe(200);
    expect(mine.body.data.map((s: { id: string }) => s.id)).toContain(created.body.data.id);
  });

  it('serves reference lists to any signed-in provider user without platform permissions', async () => {
    const plain = await actor([]);
    for (const path of ['/portal/catalogue/services?category=DIAGNOSTIC_TEST', '/portal/catalogue/medicines?q=pa','/portal/catalogue/departments', '/portal/catalogue/amenities', '/portal/catalogue/regions']) {
      const res = await plain.get(`/api/v1${path}`);
      expect(res.status, path).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    }
    expect((await plain.get('/api/v1/portal/catalogue/services?category=DIAGNOSTIC_TEST')).body.data.some((s: { code: string }) => s.code === 'LAB_LFT')).toBe(true);
    // Provider search needs at least two characters and only shows approved providers' public fields.
    expect((await plain.get('/api/v1/portal/catalogue/providers?q=a')).status).toBe(400);
    const found = await plain.get('/api/v1/portal/catalogue/providers?q=Hospital');
    expect(found.status).toBe(200);
    for (const p of found.body.data) { expect(p.gstin).toBeUndefined(); expect(p.legalName).toBeUndefined(); }
  });
});
