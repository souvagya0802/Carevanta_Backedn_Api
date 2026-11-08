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
  { key: 'booking.confirmed', description: 'Appointment confirmed by the provider.', variables: { reference: 'Appointment reference', when: 'Slot date and time (IST)' }, channels: ['SMS'], sample: { reference: 'APT-7K3M9Q', when: 'Sat 25 Oct, 10:30 am' } },
  { key: 'booking.cancelled', description: 'Appointment cancelled by the patient, provider or platform.', variables: { reference: 'Appointment reference', when: 'Slot date and time (IST)' }, channels: ['SMS'], sample: { reference: 'APT-7K3M9Q', when: 'Sat 25 Oct, 10:30 am' } },
  { key: 'provider.status_changed', description: 'Provider application moved to a new status (approved, rejected, changes requested…).', variables: { status: 'New provider status' }, channels: ['EMAIL'], sample: { status: 'APPROVED' } },
];
export const notificationKeyInfo = (key: string) => NOTIFICATION_CATALOGUE.find((k) => k.key === key);

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
async function send(n: { channel: NotificationChannel; recipient: string; subject?: string | null; body: string; link?: string | null; urgent?: boolean; level?: string }) {
  if (n.channel === 'EMAIL' && (await getSmtpConfig())) {
    const { messageId } = await sendEmail(n.recipient, n.subject ?? 'Carevanta', n.body);
    logger.info({ channel: n.channel, to: maskRecipient(n.recipient), messageId }, 'email sent via SMTP');
    return;
  }
  if (n.channel === 'PUSH' && (await getPushConfig())) {
    // For push the recipient is the user id; every subscribed device of theirs gets it.
    const accepted = await sendPushToUser(n.recipient, { title: n.subject ?? 'Carevanta', body: n.body, link: n.link, urgent: n.urgent, level: n.level });
    logger.info({ channel: n.channel, userId: n.recipient, accepted }, 'push sent');
    return;
  }
  if (n.channel === 'IN_APP') return; // stored rows are the delivery
  logger.info({ channel: n.channel, to: maskRecipient(n.recipient), bytes: n.body.length }, 'notification dispatched (log driver)');
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
    const res = (await prisma.$runCommandRaw({
      findAndModify: 'notifications',
      query: { status: 'QUEUED', attempts: { $lt: 5 } },
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
      // Email and SMS are rendered from templates; push and in-app rows already carry their text.
      const templated = n.channel === 'EMAIL' || n.channel === 'SMS';
      const template = templated ? await prisma.notificationTemplate.findFirst({ where: { key: n.templateKey, channel: n.channel, isActive: true }, orderBy: { version: 'desc' } }) : null;
      if (templated && !template) throw new Error(`No active template ${n.templateKey}/${n.channel}`);
      const vars = decryptNotificationPayload(n.payload);
      const raw = (n.payload as { urgent?: unknown } | null)?.urgent === true;
      const level = (n.payload as { level?: unknown } | null)?.level;
      await send({
        channel: n.channel,
        recipient: n.recipient,
        subject: template ? (template.subject ? render(template.subject, vars) : null) : n.title,
        body: template ? render(template.body, vars) : (n.body ?? ''),
        link: n.link,
        urgent: raw,
        level: typeof level === 'string' ? level : undefined,
      });
      // Once delivered, the secret payload is no longer needed — drop it.
      await prisma.notification.update({ where: { id }, data: { status: 'SENT', sentAt: new Date(), payload: {} } });
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
