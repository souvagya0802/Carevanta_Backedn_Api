import { beforeAll, describe, expect, it } from 'vitest';
import { isDroppedConnection, prisma } from '../../src/lib/prisma.js';
import { resetDatabase } from '../helpers/db.js';
import { actor, api, idem } from '../helpers/factory.js';
import { affiliatedDoctor, istDate, istWeekday, patient, slotsFor } from '../helpers/fixtures.js';

/**
 * Regression tests for bugs found in the end-to-end QA run of 2026-11-07
 * (docs/qa/test-report.md). Each test names the bug it guards.
 */
beforeAll(resetDatabase);
const V = '/api/v1';

/** A slot created directly, for times generate-slots never produces (already running, starting in minutes). */
async function rawSlot(doctorProviderId: string, locationId: string, startsInMinutes: number, lengthMinutes = 30) {
  const startsAt = new Date(Date.now() + startsInMinutes * 60_000);
  const aff = await prisma.doctorAffiliation.findFirst({ where: { doctorProviderId, locationId } });
  return prisma.appointmentSlot.create({
    data: { doctorProviderId, locationId, affiliationId: aff?.id ?? null, startsAt, endsAt: new Date(startsAt.getTime() + lengthMinutes * 60_000), capacity: 1, bookedCount: 0, status: 'OPEN', feeMinor: 50000n },
  });
}

describe('QA fixes — appointments', () => {
  it('CROSS-1: the patient is told in the app when the clinic confirms, and the booking shows reviewed=false', async () => {
    const { hospital, doctor, hospitalOwner } = await affiliatedDoctor();
    const p = await patient();
    const { slots } = await slotsFor(hospitalOwner, doctor.id, hospital.locationId);
    const booked = await p.post(`${V}/patient/appointments`, { slotId: slots[0]!.id, patientProfileId: p.profileId }, idem());
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const id = booked.body.data.id as string;
    expect((await hospitalOwner.post(`${V}/portal/providers/${hospital.id}/appointments/${id}/actions`, { action: 'CONFIRM' })).status).toBe(200);
    const note = await prisma.notification.findFirst({ where: { userId: p.user.id, channel: 'IN_APP', title: 'Appointment confirmed' } });
    expect(note?.link).toBe(`/appointments/${id}`);
    expect(note?.body).toContain(booked.body.data.reference);
    // The patient's own cancel does not notify themselves.
    expect((await p.get(`${V}/patient/appointments/${id}`)).body.data.reviewed).toBe(false);
  });

  it('PORT-4 / PORT-17: a walk-in can take the slot running now and is confirmed at once; an ended slot is refused', async () => {
    const { hospital, doctor, hospitalOwner } = await affiliatedDoctor();
    const running = await rawSlot(doctor.id, hospital.locationId, -5);
    const walk = await hospitalOwner.post(`${V}/portal/providers/${hospital.id}/appointments/walk-in`, { slotId: running.id, patientFullName: 'Walk In', patientPhone: '9800054321' }, idem());
    expect(walk.status, JSON.stringify(walk.body)).toBe(201);
    expect(walk.body.data.status).toBe('CONFIRMED');
    const ended = await rawSlot(doctor.id, hospital.locationId, -45);
    const late = await hospitalOwner.post(`${V}/portal/providers/${hospital.id}/appointments/walk-in`, { slotId: ended.id, patientFullName: 'Late', patientPhone: '9800054322' }, idem());
    expect(late.status).toBe(409);
    expect(late.body.error.message).toMatch(/ended/);
  });

  it('CROSS-3: slots starting within 15 minutes are not offered online, and booking one says so clearly', async () => {
    const { hospital, doctor } = await affiliatedDoctor();
    const soon = await rawSlot(doctor.id, hospital.locationId, 10);
    const later = await rawSlot(doctor.id, hospital.locationId, 120);
    const list = await api().get(`${V}/discovery/doctors/${doctor.id}/slots`);
    const ids = (list.body.data as { id: string }[]).map((s) => s.id);
    expect(ids).not.toContain(soon.id);
    expect(ids).toContain(later.id);
    const p = await patient();
    const res = await p.post(`${V}/patient/appointments`, { slotId: soon.id, patientProfileId: p.profileId }, idem());
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/too soon/);
  });

  it('PORT-2: an overlapping weekly session is refused, even at another place', async () => {
    const { hospital, doctor, hospitalOwner, doctorUser } = await affiliatedDoctor();
    const date = istDate(3);
    await slotsFor(hospitalOwner, doctor.id, hospital.locationId, { date, startMinute: 600, endMinute: 720 });
    // Same doctor, same weekday, overlapping hours at the hospital: refused.
    const same = await hospitalOwner.post(`${V}/schedules`, { doctorProviderId: doctor.id, locationId: hospital.locationId, dayOfWeek: istWeekday(date), startMinute: 690, endMinute: 780, slotMinutes: 30, capacityPerSlot: 1, validFrom: istDate(0) });
    expect(same.status).toBe(409);
    expect(same.body.error.message).toMatch(/overlaps/);
    // At the doctor's own chamber at the same time: also refused (one person, one place).
    if (doctor.locationId) {
      const chamber = await doctorUser.post(`${V}/schedules`, { doctorProviderId: doctor.id, locationId: doctor.locationId, dayOfWeek: istWeekday(date), startMinute: 660, endMinute: 720, slotMinutes: 30, capacityPerSlot: 1, validFrom: istDate(0) });
      expect(chamber.status).toBe(409);
    }
    // Back-to-back is fine.
    const after = await hospitalOwner.post(`${V}/schedules`, { doctorProviderId: doctor.id, locationId: hospital.locationId, dayOfWeek: istWeekday(date), startMinute: 720, endMinute: 780, slotMinutes: 30, capacityPerSlot: 1, validFrom: istDate(0) });
    expect(after.status, JSON.stringify(after.body)).toBe(201);
  });

  it('PORT-3 / PORT-11: the portal filters by when the visit happens (upcoming, past, a given day)', async () => {
    const { hospital, doctor, hospitalOwner } = await affiliatedDoctor();
    const date = istDate(2);
    const { slots } = await slotsFor(hospitalOwner, doctor.id, hospital.locationId, { date });
    const p = await patient();
    const b = await p.post(`${V}/patient/appointments`, { slotId: slots[0]!.id, patientProfileId: p.profileId }, idem());
    const base = `${V}/portal/providers/${hospital.id}/appointments`;
    const ids = async (qs: string) => ((await hospitalOwner.get(`${base}?${qs}`)).body.data as { id: string }[]).map((a) => a.id);
    expect(await ids(`date=${date}`)).toContain(b.body.data.id);
    expect(await ids(`date=${istDate(5)}`)).not.toContain(b.body.data.id);
    expect(await ids(`startsFrom=${encodeURIComponent(new Date().toISOString())}`)).toContain(b.body.data.id);
    expect(await ids(`startsTo=${encodeURIComponent(new Date().toISOString())}`)).not.toContain(b.body.data.id);
  });
});

describe('QA fixes — patient home', () => {
  it('PAT-16: the home screen advertises only fees a patient can actually book (active sessions), never the default or affiliation fee', async () => {
    const { doctor, hospital, hospitalOwner } = await affiliatedDoctor({ feeMinor: 50000 });
    // Default fee ₹300 and an affiliation fee ₹500 exist, but no session yet → nothing is bookable → no fee shown.
    await prisma.doctorProfile.update({ where: { providerId: doctor.id }, data: { defaultFeeMinor: 30000n } });
    await prisma.provider.update({ where: { id: doctor.id }, data: { ratingAverage: 5, ratingCount: 99 } }); // keep it inside the top 8
    const before = await api().get('/api/v1/public/patient-home');
    expect(before.status).toBe(200);
    const noSessions = before.body.data.topDoctors.find((d: { id: string }) => d.id === doctor.id);
    expect(noSessions, 'doctor is listed').toBeTruthy();
    expect(noSessions.feeMinor).toBeNull();
    expect(noSessions.feeIsFrom).toBe(false);

    // One hospital session at ₹500 → the card says ₹500, and it is not a "from" price.
    await slotsFor(hospitalOwner, doctor.id, hospital.locationId, { feeMinor: 50000 });
    const after = await api().get('/api/v1/public/patient-home');
    const withSession = after.body.data.topDoctors.find((d: { id: string }) => d.id === doctor.id);
    expect(withSession).toMatchObject({ feeMinor: 50000, feeIsFrom: false });
  });
});

describe('QA fixes — reviews', () => {
  it('CROSS-2 / PAT-16: reviews are moderated, then shown on the doctor too, with recomputed ratings and short names', async () => {
    const { hospital, doctor, hospitalOwner } = await affiliatedDoctor();
    const { slots } = await slotsFor(hospitalOwner, doctor.id, hospital.locationId);
    const p = await patient();
    await prisma.user.update({ where: { id: p.user.id }, data: { fullName: 'Sunita Ghosh' } });
    const b = await p.post(`${V}/patient/appointments`, { slotId: slots[0]!.id, patientProfileId: p.profileId }, idem());
    await prisma.appointment.update({ where: { id: b.body.data.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
    expect((await p.post(`${V}/patient/reviews`, { appointmentId: b.body.data.id, rating: 5, comment: 'Kind and clear' })).status).toBe(201);
    expect((await p.get(`${V}/patient/appointments/${b.body.data.id}`)).body.data.reviewed).toBe(true);

    // Not public until moderated.
    expect((await api().get(`${V}/discovery/providers/${doctor.id}/reviews`)).body.data).toEqual([]);
    const mod = await actor(['SUPPORT_AGENT']);
    const queue = await mod.get(`${V}/admin/reviews?status=PENDING_MODERATION`);
    expect(queue.status, JSON.stringify(queue.body)).toBe(200);
    const item = (queue.body.data as { id: string; author: string; appointmentReference: string; doctor: { id: string } }[]).find((x) => x.appointmentReference === b.body.data.reference)!;
    expect(item.author).toBe('Sunita G.');
    expect(item.doctor.id).toBe(doctor.id);
    const pub = await mod.post(`${V}/admin/reviews/${item.id}/moderate`, { decision: 'PUBLISHED' });
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);
    expect((await mod.post(`${V}/admin/reviews/${item.id}/moderate`, { decision: 'PUBLISHED' })).status).toBe(409);

    // Shown on both the hospital and the doctor, and both ratings follow.
    const onDoctor = (await api().get(`${V}/discovery/providers/${doctor.id}/reviews`)).body.data as { author: string; rating: number }[];
    expect(onDoctor).toEqual([expect.objectContaining({ author: 'Sunita G.', rating: 5 })]);
    expect(((await api().get(`${V}/discovery/providers/${hospital.id}/reviews`)).body.data as unknown[]).length).toBe(1);
    const [docRow, hospRow] = await Promise.all([prisma.provider.findUnique({ where: { id: doctor.id } }), prisma.provider.findUnique({ where: { id: hospital.id } })]);
    expect(Number(docRow!.ratingAverage)).toBe(5);
    expect(docRow!.ratingCount).toBe(1);
    expect(hospRow!.ratingCount).toBe(1);

    // Hiding takes it down again.
    expect((await mod.post(`${V}/admin/reviews/${item.id}/moderate`, { decision: 'HIDDEN', note: 'Contains a phone number' })).status).toBe(200);
    expect((await api().get(`${V}/discovery/providers/${doctor.id}/reviews`)).body.data).toEqual([]);
    expect((await prisma.provider.findUnique({ where: { id: doctor.id } }))!.ratingCount).toBe(0);
    // Patients cannot moderate.
    expect((await p.get(`${V}/admin/reviews`)).status).toBe(403);
  });
});

describe('QA fixes — privacy and resilience', () => {
  it('PORT-15: a provider can open only prescriptions attached to its own orders', async () => {
    const { hospital, hospitalOwner } = await affiliatedDoctor();
    const p = await patient();
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    const up = await p.upload(`${V}/patient/prescriptions?patientProfileId=${p.profileId}`, png, 'image/png');
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const res = await hospitalOwner.get(`${V}/portal/providers/${hospital.id}/prescriptions/${up.body.data.id}/file`);
    expect(res.status).toBe(404); // not attached to any order here
    expect(await prisma.sensitiveAccessLog.count({ where: { resourceId: up.body.data.id, granted: false } })).toBeGreaterThan(0);
  });

  it('PORT-13: a dropped database connection is recognised (reads are retried once)', () => {
    expect(isDroppedConnection(new Error('Server has closed the connection.'))).toBe(true);
    expect(isDroppedConnection(Object.assign(new Error('x'), { code: 'P1017' }))).toBe(true);
    expect(isDroppedConnection(new Error('Unique constraint failed'))).toBe(false);
  });
});
