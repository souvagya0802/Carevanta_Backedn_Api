import { prisma, transactionWithRetry } from '../lib/prisma.js';
import { formatIst } from '../lib/time.js';
import { logger } from '../lib/logger.js';
import { getSetting } from '../modules/settings/settings.service.js';
import { enqueueNotification } from '../modules/notifications/notifications.service.js';
import { notifyUsers, type NoticeKind, type NoticeMeta } from '../modules/notifications/events.js';

/**
 * Booking reminders ("you have a booking on …") for patients: in-app row, push
 * (when a device is subscribed) and an EMAIL outbox row rendered from the
 * `booking.reminder` template by the delivery job. Runs every few minutes under
 * the worker lease, so two workers never double-send.
 *
 * Idempotency without a schema change: the in-app row written for a reminder
 * carries `meta: { kind, id, reminder: '24h' | '2h', at }`; before sending, the
 * job looks up existing rows for the same (id, lead time, start time) and skips
 * them. A reschedule produces a new appointment (new id) — or, for a lab order,
 * a new `scheduledAt` — so reminders start afresh for the new time, and the
 * old booking (RESCHEDULED / CANCELLED_*) is no longer CONFIRMED and is ignored.
 */
export const REMINDER_TEMPLATE_KEY = 'booking.reminder';
export const REMINDER_LEAD_HOURS_KEY = 'booking.reminder_lead_hours';
export const REMINDERS_ENABLED_KEY = 'booking.reminders_enabled';
/** Lead times in hours, largest first. The admin setting is a comma-separated string, e.g. "24,2". */
export const DEFAULT_REMINDER_LEAD_HOURS: readonly number[] = [24, 2];
const MAX_LEAD_HOURS = 168;
const PAGE_SIZE = 200;
const MAX_PAGES = 50;

/** Accepts "24,2", [24, 2] or 24; keeps finite values in (0, 168], deduped and sorted largest first. Falls back to the default when nothing is valid. */
export function parseLeadHours(value: unknown): number[] {
  const raw: unknown[] = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : [value];
  const hours = raw
    .map((v) => (typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN))
    .filter((h) => Number.isFinite(h) && h > 0 && h <= MAX_LEAD_HOURS);
  const unique = [...new Set(hours)].sort((a, b) => b - a);
  return unique.length ? unique : [...DEFAULT_REMINDER_LEAD_HOURS];
}

export const reminderLabel = (hours: number): string => `${hours}h`;

/**
 * Which lead time is due at `now` for something starting at `startsAt`, or null.
 * With leads [L0 > L1 > … > Ln] the window for Li is [startsAt − Li, startsAt − Li+1),
 * and the last one runs up to the start itself — so a booking made 90 minutes
 * ahead gets only the 2 h reminder, never a stale 24 h one on top of it.
 */
export function dueLead(startsAt: Date, now: Date, leads: readonly number[]): number | null {
  const sorted = [...leads].sort((a, b) => b - a);
  const untilMs = startsAt.getTime() - now.getTime();
  if (untilMs <= 0) return null;
  for (let i = 0; i < sorted.length; i++) {
    const upper = sorted[i]! * 3_600_000;
    const lower = i + 1 < sorted.length ? sorted[i + 1]! * 3_600_000 : 0;
    if (untilMs <= upper && untilMs > lower) return sorted[i]!;
  }
  return null;
}

/** Whole hours until the start, never below 1 — what the message says ("in about 2 hours"). */
export function hoursUntil(startsAt: Date, now: Date): number {
  return Math.max(1, Math.round((startsAt.getTime() - now.getTime()) / 3_600_000));
}

interface ReminderTarget {
  kind: NoticeKind;
  id: string;
  reference: string;
  startsAt: Date;
  userId: string;
  email: string | null;
  patientName: string;
  doctorName: string;
  locationName: string;
  link: string;
}

export interface ReminderRunResult { scanned: number; sent: number; skipped: number; emails: number }

async function loadReminderSettings(): Promise<{ enabled: boolean; leads: number[] }> {
  const [enabled, leadsRaw] = await Promise.all([getSetting<boolean>(REMINDERS_ENABLED_KEY, true), getSetting<unknown>(REMINDER_LEAD_HOURS_KEY, DEFAULT_REMINDER_LEAD_HOURS.join(','))]);
  return { enabled: enabled !== false, leads: parseLeadHours(leadsRaw) };
}

/** Reminder rows already written for these targets at this lead time, keyed by `${id}|${at}`. */
async function alreadySent(targets: ReminderTarget[], label: string): Promise<Set<string>> {
  if (!targets.length) return new Set();
  const rows = await prisma.notification.findMany({
    where: { channel: 'IN_APP', templateKey: REMINDER_TEMPLATE_KEY, userId: { in: [...new Set(targets.map((t) => t.userId))] } },
    select: { payload: true },
  });
  const done = new Set<string>();
  for (const r of rows) {
    const meta = (r.payload as { meta?: { id?: unknown; reminder?: unknown; at?: unknown } } | null)?.meta;
    if (meta && meta.reminder === label && typeof meta.id === 'string') done.add(`${meta.id}|${typeof meta.at === 'string' ? meta.at : ''}`);
  }
  return done;
}

async function sendReminder(t: ReminderTarget, lead: number, now: Date): Promise<boolean> {
  const label = reminderLabel(lead);
  const when = formatIst(t.startsAt);
  const vars = { patientName: t.patientName, reference: t.reference, when, doctorName: t.doctorName, locationName: t.locationName, hoursBefore: String(hoursUntil(t.startsAt, now)) };
  const title = t.kind === 'diagnostic_order' ? 'Lab booking reminder' : 'Appointment reminder';
  const where = t.locationName ? ` at ${t.locationName}` : '';
  const body = `${t.patientName}, you have a booking with ${t.doctorName} on ${when}${where} (${t.reference}).`;
  // `reminder` and `at` are extra fields on the stored meta; the live stream passes through only kind/id/providerId/status.
  const meta = { kind: t.kind, id: t.id, reminder: label, at: t.startsAt.toISOString() } as unknown as NoticeMeta;
  let emailed = false;
  await transactionWithRetry(async (tx) => {
    await notifyUsers(tx, [t.userId], { key: REMINDER_TEMPLATE_KEY, title, body, link: t.link, level: 'important', meta });
    if (t.email) {
      await enqueueNotification(tx, { userId: t.userId, channel: 'EMAIL', templateKey: REMINDER_TEMPLATE_KEY, recipient: t.email, payload: vars });
      emailed = true;
    }
  });
  return emailed;
}

async function processTargets(targets: ReminderTarget[], now: Date, leads: number[], result: ReminderRunResult): Promise<void> {
  const byLead = new Map<number, ReminderTarget[]>();
  for (const t of targets) {
    result.scanned++;
    const lead = dueLead(t.startsAt, now, leads);
    if (lead == null) continue;
    byLead.set(lead, [...(byLead.get(lead) ?? []), t]);
  }
  for (const [lead, group] of byLead) {
    const done = await alreadySent(group, reminderLabel(lead));
    for (const t of group) {
      if (done.has(`${t.id}|${t.startsAt.toISOString()}`)) {
        result.skipped++;
        continue;
      }
      try {
        if (await sendReminder(t, lead, now)) result.emails++;
        result.sent++;
      } catch (err) {
        logger.error({ err, kind: t.kind, id: t.id, lead }, 'booking reminder failed');
      }
    }
  }
}

/** CONFIRMED appointments whose slot starts within the largest lead time, paged by id. */
async function appointmentTargets(now: Date, horizon: Date, onPage: (targets: ReminderTarget[]) => Promise<void>): Promise<void> {
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await prisma.appointment.findMany({
      where: { status: 'CONFIRMED', slot: { startsAt: { gt: now, lte: horizon } } },
      orderBy: { id: 'asc' },
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        reference: true,
        slot: { select: { startsAt: true } },
        doctor: { select: { displayName: true } },
        location: { select: { name: true } },
        patient: { select: { fullName: true, accountUserId: true, accountHolder: { select: { email: true } } } },
      },
    });
    if (!rows.length) return;
    await onPage(
      rows.map((a) => ({
        kind: 'appointment' as const,
        id: a.id,
        reference: a.reference,
        startsAt: a.slot.startsAt,
        userId: a.patient.accountUserId,
        email: a.patient.accountHolder.email,
        patientName: a.patient.fullName,
        doctorName: a.doctor.displayName,
        locationName: a.location.name,
        link: `/appointments/${a.id}`,
      })),
    );
    if (rows.length < PAGE_SIZE) return;
    cursor = rows[rows.length - 1]!.id;
  }
}

/** CONFIRMED lab orders (centre visit or home collection) with a scheduled time within the horizon. */
async function diagnosticTargets(now: Date, horizon: Date, onPage: (targets: ReminderTarget[]) => Promise<void>): Promise<void> {
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await prisma.diagnosticOrder.findMany({
      where: { status: 'CONFIRMED', scheduledAt: { gt: now, lte: horizon } },
      orderBy: { id: 'asc' },
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        reference: true,
        scheduledAt: true,
        collectionMode: true,
        provider: { select: { displayName: true } },
        location: { select: { name: true } },
        patient: { select: { fullName: true, accountUserId: true, accountHolder: { select: { email: true } } } },
      },
    });
    if (!rows.length) return;
    await onPage(
      rows
        .filter((o) => o.scheduledAt)
        .map((o) => ({
          kind: 'diagnostic_order' as const,
          id: o.id,
          reference: o.reference,
          startsAt: o.scheduledAt!,
          userId: o.patient.accountUserId,
          email: o.patient.accountHolder.email,
          patientName: o.patient.fullName,
          doctorName: o.provider.displayName,
          locationName: o.collectionMode === 'HOME_COLLECTION' ? 'your home (sample collection)' : (o.location?.name ?? ''),
          link: `/orders/lab/${o.id}`,
        })),
    );
    if (rows.length < PAGE_SIZE) return;
    cursor = rows[rows.length - 1]!.id;
  }
}

/**
 * One scheduler pass. `now` is injectable for tests; `leads` overrides the
 * setting. Safe to re-run: already-sent (id, lead, start time) triples are skipped.
 */
export async function sendBookingReminders(now = new Date(), overrides: { leads?: number[] } = {}): Promise<ReminderRunResult> {
  const result: ReminderRunResult = { scanned: 0, sent: 0, skipped: 0, emails: 0 };
  const settings = await loadReminderSettings();
  if (!settings.enabled && !overrides.leads) return result;
  const leads = overrides.leads ? parseLeadHours(overrides.leads) : settings.leads;
  const horizon = new Date(now.getTime() + leads[0]! * 3_600_000);
  const onPage = (targets: ReminderTarget[]) => processTargets(targets, now, leads, result);
  await appointmentTargets(now, horizon, onPage);
  await diagnosticTargets(now, horizon, onPage);
  if (result.sent) logger.info({ ...result, leads }, 'booking reminders sent');
  return result;
}
