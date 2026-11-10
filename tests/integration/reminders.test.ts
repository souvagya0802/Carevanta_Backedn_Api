import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { resetDatabase } from '../helpers/db.js';
import { actor, idem } from '../helpers/factory.js';
import { affiliatedDoctor, patient, slotsFor } from '../helpers/fixtures.js';
import { REMINDER_TEMPLATE_KEY, sendBookingReminders } from '../../src/jobs/reminders.js';
import { acquireLease, releaseLease, runWithLease } from '../../src/lib/job-lease.js';
import { reschedule } from '../../src/modules/appointments/appointments.service.js';
import { deliverQueuedNotifications } from '../../src/modules/notifications/notifications.service.js';
import { invalidateSetting } from '../../src/modules/settings/settings.service.js';

const H = 3_600_000;

type Ctx = Awaited<ReturnType<typeof affiliatedDoctor>> & { slots: Awaited<ReturnType<typeof slotsFor>>['slots'] };
let ctx: Ctx;

beforeAll(async () => {
  await resetDatabase();
  const base = await affiliatedDoctor();
  const scheduler = await actor(['PLATFORM_ADMIN']);
  const { slots } = await slotsFor(scheduler, base.doctor.id, base.hospital.locationId, { capacity: 3, startMinute: 600, endMinute: 900 });
  ctx = { ...base, slots };
  // The email-templates agent seeds the real template; make sure an active EMAIL one exists for delivery here.
  const existing = await prisma.notificationTemplate.findFirst({ where: { key: REMINDER_TEMPLATE_KEY, channel: 'EMAIL', isActive: true } });
  if (!existing) {
    await prisma.notificationTemplate.create({ data: { key: REMINDER_TEMPLATE_KEY, channel: 'EMAIL', locale: 'en', subject: 'Reminder: {{reference}} on {{when}}', body: 'Hi {{patientName}}, you have a booking with {{doctorName}} on {{when}} at {{locationName}} (in about {{hoursBefore}} hours).' } });
  }
  await prisma.platformSetting.deleteMany({ where: { key: { in: ['booking.reminder_lead_hours', 'booking.reminders_enabled'] } } });
  invalidateSetting();
});

async function confirmedBooking(slotIndex: number) {
  const p = await patient();
  const res = await p.post('/api/v1/patient/appointments', { slotId: ctx.slots[slotIndex]!.id, patientProfileId: p.profileId }, idem());
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const id = res.body.data.id as string;
  await prisma.appointment.update({ where: { id }, data: { status: 'CONFIRMED', confirmedAt: new Date() } });
  const startsAt = ctx.slots[slotIndex]!.startsAt;
  return { p, id, startsAt };
}

const reminderRows = (id: string, channel?: 'IN_APP' | 'EMAIL' | 'PUSH') =>
  prisma.notification.findMany({ where: { templateKey: REMINDER_TEMPLATE_KEY, ...(channel ? { channel } : {}) } }).then((rows) => rows.filter((r) => channel === 'EMAIL' ? true : ((r.payload as { meta?: { id?: string } })?.meta?.id === id)));

describe('booking reminders', () => {
  it('sends the 24 h reminder once (in-app + queued email), then the 2 h one once, never twice', async () => {
    const { p, id, startsAt } = await confirmedBooking(0);
    const tooEarly = await sendBookingReminders(new Date(startsAt.getTime() - 30 * H));
    expect(tooEarly.sent).toBe(0);

    const at23h = new Date(startsAt.getTime() - 23 * H);
    const first = await sendBookingReminders(at23h);
    expect(first.sent).toBe(1);
    expect(first.emails).toBe(1);
    const inApp = await reminderRows(id, 'IN_APP');
    expect(inApp).toHaveLength(1);
    expect(inApp[0]!.userId).toBe(p.user.id);
    expect(inApp[0]!.status).toBe('SENT');
    expect(inApp[0]!.payload).toMatchObject({ level: 'important', meta: { kind: 'appointment', id, reminder: '24h', at: startsAt.toISOString() } });
    expect(inApp[0]!.body).toContain('you have a booking');
    const email = await prisma.notification.findMany({ where: { templateKey: REMINDER_TEMPLATE_KEY, channel: 'EMAIL', userId: p.user.id } });
    expect(email).toHaveLength(1);
    expect(email[0]!.status).toBe('QUEUED');
    expect(email[0]!.recipient).toBe(p.user.email);

    // Same tick again (worker restart, overlapping run): nothing new.
    const again = await sendBookingReminders(new Date(at23h.getTime() + 5 * 60_000));
    expect(again.sent).toBe(0);
    expect(again.skipped).toBe(1);
    expect(await reminderRows(id, 'IN_APP')).toHaveLength(1);

    // 2 h window: a second, distinct reminder; then idempotent again.
    const at90m = new Date(startsAt.getTime() - 90 * 60_000);
    expect((await sendBookingReminders(at90m)).sent).toBe(1);
    expect((await sendBookingReminders(new Date(at90m.getTime() + 60_000))).sent).toBe(0);
    const all = await reminderRows(id, 'IN_APP');
    expect(all.map((r) => (r.payload as { meta: { reminder: string } }).meta.reminder).sort()).toEqual(['24h', '2h']);
    expect(await prisma.notification.count({ where: { templateKey: REMINDER_TEMPLATE_KEY, channel: 'EMAIL', userId: p.user.id } })).toBe(2);

    // Nothing once the slot has started.
    expect((await sendBookingReminders(new Date(startsAt.getTime() + 1000))).sent).toBe(0);
  });

  it('the delivery job renders and sends the queued reminder email from the template', async () => {
    const { p, startsAt } = await confirmedBooking(1);
    await sendBookingReminders(new Date(startsAt.getTime() - 20 * H));
    const queued = await prisma.notification.findFirstOrThrow({ where: { templateKey: REMINDER_TEMPLATE_KEY, channel: 'EMAIL', userId: p.user.id } });
    expect(queued.status).toBe('QUEUED');
    expect(await deliverQueuedNotifications(50)).toBeGreaterThanOrEqual(1);
    const sent = await prisma.notification.findUniqueOrThrow({ where: { id: queued.id } });
    expect(sent.status, `attempts=${sent.attempts} lastError=${sent.lastError ?? ''}`).toBe('SENT');
    // Without SMTP (tests) the log driver records it; the delivery job may note that in lastError.
    expect(sent.lastError === null || /SMTP is not configured/.test(sent.lastError)).toBe(true);
    expect((sent.payload as { enc?: unknown }).enc).toBeUndefined(); // variables dropped after delivery
  });

  it('skips cancelled and still-unconfirmed bookings', async () => {
    const cancelled = await confirmedBooking(2);
    await prisma.appointment.update({ where: { id: cancelled.id }, data: { status: 'CANCELLED_BY_PATIENT', cancelledAt: new Date() } });
    const requested = await patient();
    const res = await requested.post('/api/v1/patient/appointments', { slotId: ctx.slots[2]!.id, patientProfileId: requested.profileId }, idem());
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('REQUESTED');
    const r = await sendBookingReminders(new Date(cancelled.startsAt.getTime() - 10 * H));
    expect(await reminderRows(cancelled.id)).toHaveLength(0);
    expect(await reminderRows(res.body.data.id as string)).toHaveLength(0);
    expect(r.scanned).toBeGreaterThanOrEqual(0); // global counts vary: other test files share the database in a full run
  });

  it('a reschedule resets reminders for the new slot time and stops them for the old booking', async () => {
    const { p, id, startsAt } = await confirmedBooking(3);
    await sendBookingReminders(new Date(startsAt.getTime() - 12 * H));
    expect(await reminderRows(id, 'IN_APP')).toHaveLength(1);
    const newSlot = ctx.slots[5]!;
    const newId = await reschedule(id, newSlot.id, { userId: p.user.id, kind: 'PATIENT' });
    expect(newId).not.toBe(id);
    await prisma.appointment.update({ where: { id: newId }, data: { status: 'CONFIRMED', confirmedAt: new Date() } });
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id } })).status).toBe('RESCHEDULED');

    await sendBookingReminders(new Date(newSlot.startsAt.getTime() - 12 * H));
    expect(await reminderRows(id, 'IN_APP')).toHaveLength(1); // old one: nothing new
    const fresh = await reminderRows(newId, 'IN_APP');
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.payload).toMatchObject({ meta: { id: newId, reminder: '24h', at: newSlot.startsAt.toISOString() } });
    expect(fresh[0]!.body).toContain(newSlot.startsAt.getUTCFullYear().toString());
  });

  it('honours the lead-time setting and the kill switch', async () => {
    const { id, startsAt } = await confirmedBooking(4);
    try {
      await prisma.platformSetting.create({ data: { key: 'booking.reminder_lead_hours', value: '48,6' } });
      invalidateSetting();
      // Other confirmed bookings of this file fall in the new 48 h window too (each gets its own '48h' row); this one must be among them.
      expect((await sendBookingReminders(new Date(startsAt.getTime() - 40 * H))).sent).toBeGreaterThanOrEqual(1);
      const mine = await reminderRows(id, 'IN_APP');
      expect(mine).toHaveLength(1);
      expect(mine[0]!.payload).toMatchObject({ meta: { reminder: '48h' } });
      await prisma.platformSetting.create({ data: { key: 'booking.reminders_enabled', value: false } });
      invalidateSetting();
      expect((await sendBookingReminders(new Date(startsAt.getTime() - 5 * H))).scanned).toBe(0);
      expect(await reminderRows(id, 'IN_APP')).toHaveLength(1);
    } finally {
      await prisma.platformSetting.deleteMany({ where: { key: { in: ['booking.reminder_lead_hours', 'booking.reminders_enabled'] } } });
      invalidateSetting();
    }
  });

  it('does not run while another worker holds the lease', async () => {
    const { id, startsAt } = await confirmedBooking(6);
    const now = new Date(startsAt.getTime() - 20 * H);
    expect(await acquireLease('bookings.reminders', 60_000, 'other-worker')).toBe(true);
    expect(await runWithLease('bookings.reminders', 60_000, () => sendBookingReminders(now))).toBeNull();
    expect(await reminderRows(id)).toHaveLength(0);
    await releaseLease('bookings.reminders', { ok: true, ms: 1 }, 'other-worker');
    const result = await runWithLease('bookings.reminders', 60_000, () => sendBookingReminders(now));
    expect(result?.sent).toBeGreaterThanOrEqual(1); // earlier bookings of this file may be due their 24 h reminder at this `now` too
    expect(await reminderRows(id, 'IN_APP')).toHaveLength(1);
  });

  it('reminds scheduled lab bookings (home collection) and re-reminds after the time is moved', async () => {
    const p = await patient();
    const scheduledAt = new Date(Date.now() + 3 * 86_400_000);
    const order = await prisma.diagnosticOrder.create({
      data: { reference: `LAB-${Date.now().toString(36).toUpperCase()}`, patientProfileId: p.profileId, bookedByUserId: p.user.id, providerId: ctx.hospital.id, collectionMode: 'HOME_COLLECTION', scheduledAt, status: 'CONFIRMED', source: 'PATIENT_APP', attribution: 'PLATFORM', totalMinor: 50000n },
    });
    expect((await sendBookingReminders(new Date(scheduledAt.getTime() - 3 * H))).sent).toBe(1);
    const rows = await reminderRows(order.id, 'IN_APP');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ meta: { kind: 'diagnostic_order', id: order.id, reminder: '24h' } });
    expect(rows[0]!.body).toContain('your home');
    expect(rows[0]!.link).toBe(`/orders/lab/${order.id}`);
    expect((await sendBookingReminders(new Date(scheduledAt.getTime() - 3 * H + 60_000))).sent).toBe(0);
    // Moved to a new time: a fresh reminder for the new time only.
    const moved = new Date(scheduledAt.getTime() + 86_400_000);
    await prisma.diagnosticOrder.update({ where: { id: order.id }, data: { scheduledAt: moved } });
    expect((await sendBookingReminders(new Date(moved.getTime() - 3 * H))).sent).toBe(1);
    expect(await reminderRows(order.id, 'IN_APP')).toHaveLength(2);
  });
});
