/**
 * Web Push (RFC 8030 + VAPID). The super-admin generates the VAPID key pair
 * once (Settings → Push); browsers and installed web apps subscribe with the
 * public key; the private key is stored encrypted and only used here to sign
 * pushes. Each push carries a small JSON payload (title, body, link) that the
 * service worker turns into a system notification.
 */
import * as webpushNs from 'web-push';
// web-push is CommonJS; depending on the loader the API is the namespace itself or its default export.
const webpush = ((webpushNs as unknown as { default?: typeof webpushNs }).default ?? webpushNs) as typeof webpushNs;
import { prisma, type Db } from '../../lib/prisma.js';
import { decryptField, encryptField } from '../../lib/crypto.js';
import { badRequest } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { setSetting } from '../platform/integrations.service.js';

export interface PushConfig { publicKey: string; privateKey: string; subject: string }
const KEYS = ['push.vapid.public_key', 'push.vapid.private_key', 'push.vapid.subject'] as const;
let cache: { at: number; value: PushConfig | null } | null = null;
export const invalidatePushConfig = () => { cache = null; };

export async function getPushConfig(db: Db = prisma): Promise<PushConfig | null> {
  if (cache && Date.now() - cache.at < 30_000) return cache.value;
  const rows = await db.platformSetting.findMany({ where: { key: { in: [...KEYS] } } });
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  let value: PushConfig | null = null;
  const pub = get('push.vapid.public_key');
  const enc = get('push.vapid.private_key');
  if (typeof pub === 'string' && pub && typeof enc === 'string' && enc) {
    try {
      value = { publicKey: pub, privateKey: decryptField(enc), subject: typeof get('push.vapid.subject') === 'string' && get('push.vapid.subject') ? (get('push.vapid.subject') as string) : 'mailto:support@carevanta.in' };
    } catch (err) {
      logger.error({ err }, 'VAPID private key could not be decrypted — was DATA_ENCRYPTION_KEY rotated?');
    }
  }
  cache = { at: Date.now(), value };
  return value;
}

/** Creates a fresh VAPID pair. Existing subscriptions stop working, so the admin UI warns before calling this. */
export async function generateVapidKeys(db: Db, subject: string, updatedById: string) {
  if (!/^(mailto:[^@\s]+@[^@\s]+|https:\/\/\S+)$/.test(subject)) throw badRequest('Subject must be a mailto: address or an https: URL', { field: 'subject' });
  const keys = webpush.generateVAPIDKeys();
  await setSetting(db, 'push.vapid.public_key', keys.publicKey, 'VAPID public key (browsers subscribe with it)', false, updatedById);
  await setSetting(db, 'push.vapid.private_key', encryptField(keys.privateKey), 'VAPID private key (encrypted)', true, updatedById);
  await setSetting(db, 'push.vapid.subject', subject, 'VAPID contact (push services use it to reach the operator)', false, updatedById);
  // Old subscriptions were made against the previous public key and would be rejected; drop them.
  await db.pushSubscription.deleteMany({});
  invalidatePushConfig();
  return keys.publicKey;
}

export async function setPushSubject(db: Db, subject: string, updatedById: string) {
  if (!/^(mailto:[^@\s]+@[^@\s]+|https:\/\/\S+)$/.test(subject)) throw badRequest('Subject must be a mailto: address or an https: URL', { field: 'subject' });
  await setSetting(db, 'push.vapid.subject', subject, 'VAPID contact (push services use it to reach the operator)', false, updatedById);
  invalidatePushConfig();
}

export async function pushStatus() {
  const [cfg, subscriptions, users] = await Promise.all([getPushConfig(), prisma.pushSubscription.count(), prisma.pushSubscription.groupBy({ by: ['userId'] })]);
  return { configured: !!cfg, publicKey: cfg?.publicKey ?? null, subject: cfg?.subject ?? null, subscriptions, subscribedUsers: users.length };
}

export interface BrowserSubscription { endpoint: string; keys: { p256dh: string; auth: string } }

/** Registers (or re-assigns) a browser subscription to the signed-in user. */
export async function subscribe(userId: string, sub: BrowserSubscription, userAgent: string | null) {
  if (!(await getPushConfig())) throw badRequest('Push notifications are not enabled on this platform yet');
  return prisma.pushSubscription.upsert({
    where: { endpoint: sub.endpoint },
    create: { userId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent },
    update: { userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent, failedAt: null },
    select: { id: true },
  });
}

export async function unsubscribe(userId: string, endpoint: string) {
  await prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
}

export const hasPushSubscription = async (db: Db, userId: string) => (await db.pushSubscription.count({ where: { userId } })) > 0;

export interface PushPayload { title: string; body: string; link?: string | null; tag?: string; urgent?: boolean; level?: string }

/** Sends to every device of a user; dead endpoints are removed. Returns how many pushes the services accepted. */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<number> {
  const cfg = await getPushConfig();
  if (!cfg) throw new Error('Push is not configured');
  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  if (!subs.length) throw new Error('User has no push subscriptions');
  let accepted = 0;
  const body = JSON.stringify({ title: payload.title, body: payload.body, link: payload.link ?? '/', tag: payload.tag ?? payload.link ?? 'carevanta', urgent: !!payload.urgent, level: payload.level ?? (payload.urgent ? 'important' : 'light') });
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, {
        vapidDetails: { subject: cfg.subject, publicKey: cfg.publicKey, privateKey: cfg.privateKey },
        TTL: payload.urgent ? 120 : 3600,
        urgency: payload.urgent ? 'high' : 'normal',
        timeout: 10_000,
      });
      accepted++;
      await prisma.pushSubscription.update({ where: { id: s.id }, data: { lastUsedAt: new Date() } });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => undefined);
        logger.info({ subscriptionId: s.id }, 'push subscription expired and was removed');
      } else {
        await prisma.pushSubscription.update({ where: { id: s.id }, data: { failedAt: new Date() } }).catch(() => undefined);
        logger.warn({ subscriptionId: s.id, status, err: err instanceof Error ? err.message : String(err) }, 'push delivery failed');
      }
    }
  }
  if (!accepted) throw new Error('No push service accepted the message');
  return accepted;
}
