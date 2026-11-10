import type { Db } from '../../lib/prisma.js';
import { prisma } from '../../lib/prisma.js';
import { decryptField, encryptField } from '../../lib/crypto.js';
import { logger } from '../../lib/logger.js';
import type { NotificationChannel } from '../../../generated/prisma/client.js';
import { getSmtpConfig, sendEmail } from '../platform/integrations.service.js';
import { getPushConfig, sendPushToUser } from './push.service.js';
import { env } from '../../config/env.js';

export interface NotificationInput {
  userId?: string | null;
  channel: NotificationChannel;
  templateKey: string;
  recipient: string;
  payload: Record<string, unknown>;
}

/**
 * Transactional outbox: the notification row is committed atomically with the
 * business change. Payloads may contain one-time secrets (reset tokens, OTPs),
 * so they are encrypted at rest; only the delivery worker decrypts them.
 */
export async function enqueueNotification(db: Db, input: NotificationInput) {
  return db.notification.create({
    data: {
      userId: input.userId ?? null,
      channel: input.channel,
      templateKey: input.templateKey,
      recipient: input.recipient,
      payload: { enc: encryptField(JSON.stringify(input.payload)) },
    },
    select: { id: true },
  });
}

export function decryptNotificationPayload(payload: unknown): Record<string, unknown> {
  const enc = (payload as { enc?: unknown } | null)?.enc;
  if (typeof enc !== 'string') return {};
  return JSON.parse(decryptField(enc)) as Record<string, unknown>;
}

export function maskRecipient(recipient: string): string {
  if (recipient.includes('@')) {
    const [local = '', domain = ''] = recipient.split('@');
    return `${local.slice(0, 2)}***@${domain}`;
  }
  return `${recipient.slice(0, 3)}******${recipient.slice(-2)}`;
}

export function render(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, k: string) => String(vars[k] ?? ''));
}

/** Placeholder names used in a template body or subject, in order of first appearance. */
export function placeholders(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

/**
 * Every template key the code enqueues, with the variables it supplies and the
 * channels it uses. Served to the dashboard so templates are authored against
 * what will really be sent — and so missing (key, channel) pairs are visible
 * before a delivery fails with "No active template".
 */
export interface NotificationKeyInfo { key: string; description: string; variables: Record<string, string>; channels: NotificationChannel[]; sample: Record<string, string> }
export const NOTIFICATION_CATALOGUE: readonly NotificationKeyInfo[] = [
  { key: 'auth.account_created', description: 'An administrator created the account; the user sets their own password with the one-time code.', variables: { token: 'One-time password-set code (72 h)' }, channels: ['EMAIL', 'SMS'], sample: { token: 'AbC123xyz' } },
  { key: 'auth.password_reset', description: 'Password reset requested by the user or sent by an administrator.', variables: { token: 'One-time reset code', expiresInMinutes: 'Minutes until the code expires' }, channels: ['EMAIL', 'SMS'], sample: { token: 'AbC123xyz', expiresInMinutes: '60' } },
  { key: 'auth.verify_email', description: 'Email address verification.', variables: { token: 'Verification code' }, channels: ['EMAIL'], sample: { token: '482913' } },
  { key: 'auth.verify_phone', description: 'Mobile number verification.', variables: { token: 'Verification code' }, channels: ['SMS'], sample: { token: '482913' } },
  { key: 'booking.confirmed', description: 'Appointment confirmed by the provider.', variables: { reference: 'Appointment reference', when: 'Slot date and time (IST)', doctorName: 'Doctor or practitioner' }, channels: ['SMS', 'EMAIL'], sample: { reference: 'APT-7K3M9Q', when: 'Sat 25 Oct, 10:30 am', doctorName: 'Dr. Arup Maity' } },
  { key: 'booking.cancelled', description: 'Appointment cancelled or not accepted (by the patient, provider or platform); the person who cancelled is not emailed.', variables: { reference: 'Appointment reference', when: 'Slot date and time (IST)', doctorName: 'Doctor or practitioner' }, channels: ['SMS', 'EMAIL'], sample: { reference: 'APT-7K3M9Q', when: 'Sat 25 Oct, 10:30 am', doctorName: 'Dr. Arup Maity' } },
  { key: 'provider.status_changed', description: 'Provider application moved to a new status (approved, rejected, changes requested…).', variables: { status: 'New provider status' }, channels: ['EMAIL'], sample: { status: 'APPROVED' } },
  { key: 'booking.reminder', description: 'Reminder sent before an upcoming appointment.', variables: { patientName: 'Patient name', reference: 'Appointment reference', when: 'Slot date and time (IST)', doctorName: 'Doctor or practitioner', locationName: 'Clinic / hospital location', hoursBefore: 'Hours until the appointment' }, channels: ['EMAIL', 'PUSH', 'IN_APP'], sample: { patientName: 'Riya Sen', reference: 'APT-7K3M9Q', when: 'Sat 25 Oct, 10:30 am', doctorName: 'Dr. Arup Maity', locationName: 'Tamluk Clinic', hoursBefore: '24' } },
  { key: 'booking.requested', description: 'A new appointment request is waiting for the provider to confirm.', variables: { patientName: 'Patient name', reference: 'Appointment reference', when: 'Requested slot (IST)', doctorName: 'Doctor or practitioner' }, channels: ['EMAIL', 'IN_APP'], sample: { patientName: 'Riya Sen', reference: 'APT-7K3M9Q', when: 'Sat 25 Oct, 10:30 am', doctorName: 'Dr. Arup Maity' } },
  { key: 'booking.rescheduled', description: 'An appointment was moved to a new slot.', variables: { reference: 'Appointment reference', when: 'New slot date and time (IST)', doctorName: 'Doctor or practitioner' }, channels: ['EMAIL', 'IN_APP'], sample: { reference: 'APT-7K3M9Q', when: 'Sun 26 Oct, 11:00 am', doctorName: 'Dr. Arup Maity' } },
  { key: 'order.status_changed', description: 'A diagnostic or pharmacy order moved to a new status.', variables: { reference: 'Order reference', kind: 'Order kind (Lab / Imaging / Pharmacy)', status: 'New order status' }, channels: ['EMAIL', 'IN_APP'], sample: { reference: 'ORD-4H2P7X', kind: 'Lab', status: 'Report Ready' } },
  { key: 'dispatch.status_changed', description: 'An emergency ambulance request moved to a new status.', variables: { reference: 'Emergency request reference', status: 'New request status' }, channels: ['EMAIL', 'IN_APP'], sample: { reference: 'DSP-9Q1M4K', status: 'Arrived' } },
  { key: 'support.reply', description: 'Support replied on a case the user opened.', variables: { caseReference: 'Support case reference' }, channels: ['EMAIL', 'IN_APP'], sample: { caseReference: 'CASE-2026-0042' } },
  { key: 'catalogue.medicines_synced', description: 'The monthly (or manual) medicine list sync from CDCI was applied or blocked; sent to catalogue admins.', variables: { status: 'Updated or Blocked', added: 'Medicines added', updated: 'Medicines updated', discontinued: 'Medicines marked inactive', reason: 'Why the update was blocked (empty when applied)', releaseDate: 'CDCI release date (YYYY-MM-DD)', summary: 'One-line summary, e.g. "Medicine list updated: 120 added, 40 updated, 3 discontinued."' }, channels: ['EMAIL', 'IN_APP'], sample: { status: 'Updated', added: '120', updated: '40', discontinued: '3', reason: '', releaseDate: '2026-08-31', summary: 'Medicine list updated: 120 added, 40 updated, 3 discontinued.' } },
];
export const notificationKeyInfo = (key: string) => NOTIFICATION_CATALOGUE.find((k) => k.key === key);

export const DEFAULT_LOCALE = 'en';
/** Does this template body carry HTML markup (as opposed to plain text)? */
export const isHtml = (text: string): boolean => /<\/?[a-z][a-z0-9-]*(\s[^>]*)?>/i.test(text);
/** Plain-text alternative for an HTML body: block tags become line breaks, the rest is stripped and entities decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*(br|\/p|\/div|\/h[1-6]|\/li|\/tr)\s*\/?>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim();
}

export type TemplateLookup =
  | { status: 'active'; template: { id: string; key: string; channel: NotificationChannel; locale: string; version: number; subject: string | null; body: string } }
  | { status: 'inactive' } // versions exist but none is active (deactivated by an administrator)
  | { status: 'missing' };

/**
 * Resolve the template for a (key, channel) in the recipient's language, falling
 * back to the default locale. Reports whether the miss is "inactive" (someone
 * switched it off) or "missing" (never created), so delivery can say which.
 */
export async function findTemplate(db: Db, key: string, channel: NotificationChannel, locale?: string | null): Promise<TemplateLookup> {
  const locales = locale && locale !== DEFAULT_LOCALE ? [locale, DEFAULT_LOCALE] : [DEFAULT_LOCALE];
  for (const l of locales) {
    const t = await db.notificationTemplate.findFirst({ where: { key, channel, locale: l, isActive: true }, orderBy: { version: 'desc' } });
    if (t) return { status: 'active', template: t };
  }
  const any = await db.notificationTemplate.count({ where: { key, channel, locale: { in: locales } } });
  return any > 0 ? { status: 'inactive' } : { status: 'missing' };
}

/** Render the active template for a key/channel with the given variables (subject/body/text), or null when none is active. */
export async function renderTemplate(db: Db, key: string, channel: NotificationChannel, vars: Record<string, unknown>, locale?: string | null): Promise<{ subject: string | null; body: string; text: string; html: string | null } | null> {
  const found = await findTemplate(db, key, channel, locale);
  if (found.status !== 'active') return null;
  const body = render(found.template.body, vars);
  const html = isHtml(body);
  return { subject: found.template.subject ? render(found.template.subject, vars) : null, body, text: html ? htmlToText(body) : body, html: html ? body : null };
}

/** How each channel is actually delivered right now. Anything on the log driver is recorded, not sent. */
export async function channelDrivers(): Promise<Record<NotificationChannel, 'smtp' | 'log' | 'webpush' | 'inapp'>> {
  const [smtp, push] = await Promise.all([getSmtpConfig(), getPushConfig()]);
  return { EMAIL: smtp ? 'smtp' : 'log', SMS: 'log', PUSH: push ? 'webpush' : 'log', IN_APP: 'inapp' };
}

/**
 * SMS cost and truncation guidance. GSM-7 messages hold 160 characters (153 per
 * part when concatenated); anything outside GSM-7 — Bengali, Hindi, emoji —
 * is sent as UCS-2 at 70 (67 per part).
 */
export function smsSegments(text: string): { encoding: 'GSM-7' | 'UCS-2'; length: number; segments: number } {
  const gsm = /^[A-Za-z0-9@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà\n\r^{}\\[~\]|€]*$/;
  const isGsm = gsm.test(text);
  const extended = isGsm ? (text.match(/[\^{}\\[~\]|€]/g)?.length ?? 0) : 0;
  const length = text.length + extended;
  const single = isGsm ? 160 : 70;
  const multi = isGsm ? 153 : 67;
  return { encoding: isGsm ? 'GSM-7' : 'UCS-2', length, segments: length === 0 ? 0 : length <= single ? 1 : Math.ceil(length / multi) };
}

/**
 * Delivery drivers. EMAIL goes through SMTP when an administrator has configured
 * it (Settings → Email); otherwise, and for SMS/PUSH/IN_APP, a log driver
 * records *that* a message would be sent (masked recipient, template key)
 * without printing the secret contents. Wire an Indian DLT-registered SMS
 * gateway here for SMS.
 */
export type DeliveryDriver = 'smtp' | 'log' | 'webpush' | 'inapp';
async function send(n: { channel: NotificationChannel; recipient: string; subject?: string | null; body: string; link?: string | null; urgent?: boolean; level?: string }): Promise<DeliveryDriver> {
  if (n.channel === 'EMAIL' && (await getSmtpConfig())) {
    const html = isHtml(n.body);
    const { messageId } = await sendEmail(n.recipient, n.subject ?? 'Carevanta', html ? htmlToText(n.body) : n.body, html ? n.body : undefined);
    logger.info({ channel: n.channel, to: maskRecipient(n.recipient), messageId }, 'email sent via SMTP');
    return 'smtp';
  }
  if (n.channel === 'PUSH' && (await getPushConfig())) {
    // For push the recipient is the user id; every subscribed device of theirs gets it.
    const accepted = await sendPushToUser(n.recipient, { title: n.subject ?? 'Carevanta', body: n.body, link: n.link, urgent: n.urgent, level: n.level });
    logger.info({ channel: n.channel, userId: n.recipient, accepted }, 'push sent');
    return 'webpush';
  }
  if (n.channel === 'IN_APP') return 'inapp'; // stored rows are the delivery
  logger.info({ channel: n.channel, to: maskRecipient(n.recipient), bytes: n.body.length }, 'notification dispatched (log driver)');
  return 'log';
}

/**
 * Normally the worker drains the outbox every minute. When `JOBS_ENABLED=false`
 * (single-process pilots, local development) there is no worker, so callers
 * that just queued something user-visible (invites, reset links) ask for an
 * immediate drain. Runs after the response is sent; failures are logged and
 * the row stays QUEUED for a later attempt. No-op in tests.
 */
export function deliverSoon(): void {
  if (env.JOBS_ENABLED || env.APP_ENV === 'test') return;
  setImmediate(() => {
    deliverQueuedNotifications(25).catch((err: unknown) => logger.warn({ err }, 'inline notification delivery failed'));
  });
}

/**
 * Process a batch of queued notifications. Safe to run concurrently: each row is
 * claimed with an atomic findAndModify (status QUEUED, attempts < 5 → attempts+1),
 * so two workers never pick the same notification.
 */
export async function deliverQueuedNotifications(batchSize = 50): Promise<number> {
  const claimed: string[] = [];
  for (let i = 0; i < batchSize; i++) {
    // Claiming only bumps `attempts` (the row stays QUEUED until it is sent or fails), so rows already
    // claimed in this batch must be excluded or the same one is picked again until attempts reaches 5 —
    // which sent every message up to five times, the later copies with an empty payload.
    const res = (await prisma.$runCommandRaw({
      findAndModify: 'notifications',
      query: { status: 'QUEUED', attempts: { $lt: 5 }, ...(claimed.length ? { _id: { $nin: claimed } } : {}) },
      sort: { created_at: 1 },
      update: { $inc: { attempts: 1 } },
      new: true,
      fields: { _id: 1 },
    })) as { value?: { _id: string } | null };
    if (!res.value) break;
    claimed.push(res.value._id);
  }
  let sent = 0;
  for (const id of claimed) {
    const n = await prisma.notification.findUniqueOrThrow({ where: { id } });
    try {
      // Email and SMS are always rendered from templates; push and in-app rows usually carry their own
      // text (notifyUsers) and only fall back to a template when they were queued without any.
      const templated = n.channel === 'EMAIL' || n.channel === 'SMS' || !n.body;
      let template: Extract<TemplateLookup, { status: 'active' }>['template'] | null = null;
      if (templated) {
        const locale = n.userId ? (await prisma.user.findUnique({ where: { id: n.userId }, select: { preferredLanguage: true } }))?.preferredLanguage : null;
        const found = await findTemplate(prisma, n.templateKey, n.channel, locale);
        if (found.status === 'inactive') {
          // Switched off on purpose by an administrator: do not retry, say so, and keep the payload out of the row.
          await prisma.notification.update({ where: { id }, data: { status: 'FAILED', payload: {}, lastError: `Skipped: template ${n.templateKey}/${n.channel} is inactive. Activate a version under Notifications → Templates and retry.` } });
          logger.info({ notificationId: id, templateKey: n.templateKey, channel: n.channel }, 'notification skipped: template inactive');
          continue;
        }
        if (found.status === 'missing') throw new Error(`No active template ${n.templateKey}/${n.channel}`);
        template = found.template;
      }
      const vars = decryptNotificationPayload(n.payload);
      const raw = (n.payload as { urgent?: unknown } | null)?.urgent === true;
      const level = (n.payload as { level?: unknown } | null)?.level;
      const subject = template ? (template.subject ? render(template.subject, vars) : null) : n.title;
      const body = template ? render(template.body, vars) : (n.body ?? '');
      const driver = await send({ channel: n.channel, recipient: n.recipient, subject, body, link: n.link, urgent: raw, level: typeof level === 'string' ? level : undefined });
      // Once delivered, the secret payload is no longer needed — drop it; keep only which driver handled it,
      // and say plainly when an email was merely logged because no mail server is configured. Push / in-app
      // rows rendered from a template keep the rendered text so the in-app feed can show it.
      const logged = driver === 'log' && n.channel === 'EMAIL';
      const inApp = n.channel === 'PUSH' || n.channel === 'IN_APP';
      await prisma.notification.update({
        where: { id },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          payload: { driver, ...(template ? { templateVersion: template.version, locale: template.locale } : {}), ...(inApp && typeof level === 'string' ? { level } : {}) },
          lastError: logged ? 'Not emailed: SMTP is not configured, so the message was only recorded by the log driver.' : null,
          ...(template && inApp ? { title: subject, body } : {}),
        },
      });
      sent++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await prisma.notification.update({
        where: { id },
        data: { lastError: message.slice(0, 1000), status: n.attempts >= 5 ? 'FAILED' : 'QUEUED' },
      });
      logger.warn({ notificationId: id, err: message }, 'notification delivery failed');
    }
  }
  return sent;
}
