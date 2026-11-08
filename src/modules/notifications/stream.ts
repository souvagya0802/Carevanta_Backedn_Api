import type { ChangeStream, ChangeStreamDocument, Document } from 'mongodb';
import type { Request, RequestHandler, Response } from 'express';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { mongoDb } from '../../lib/mongo-client.js';
import { prisma } from '../../lib/prisma.js';
import type { AuthContext } from '../../middleware/auth.js';
import { noticeFields, type NoticeLevel, type NoticeMeta } from './events.js';

/**
 * Live notification stream (Server-Sent Events) for the patient app, the
 * provider portal and the dashboard.
 *
 * Two sources feed the per-user subscribers, deduplicated by notification id:
 *  1. a MongoDB change stream on `notifications` (sub-second; inserts of IN_APP
 *     rows and updates that set `read_at`; fires only after the writing
 *     transaction commits and is visible to every API instance), restarted with
 *     backoff whenever it errors or closes;
 *  2. a safety poll every few seconds for the subscribed users (new rows and
 *     new read-marks since the last poll), so a change stream that is slow to
 *     recover from a database outage never costs a notification.
 * Both run only while someone is connected.
 *
 * Wire format (text/event-stream):
 *   event: notification  data: { id, templateKey, level, title, body, link, meta, createdAt }
 *   event: read          data: { ids: string[] }      — this user marked these read (any device)
 *   : ping               every 25 s
 */
export interface StreamNotification { id: string; templateKey: string; level: NoticeLevel; title: string | null; body: string | null; link: string | null; meta: NoticeMeta | null; createdAt: string }
export type StreamEvent = { event: 'notification'; data: StreamNotification } | { event: 'read'; data: { ids: string[] | 'all' } };
type Listener = (e: StreamEvent) => void;

export const MAX_STREAMS_PER_USER = 5;
const HEARTBEAT_MS = 25_000;
const REPLAY_CAP = 20;
export const POLL_INTERVAL_MS = 3_000;
const POLL_OVERLAP_MS = 2_000;
const DEDUPE_TTL_MS = 10 * 60_000;
const REOPEN_BASE_MS = 1_000;
const REOPEN_MAX_MS = 30_000;

const subscribers = new Map<string, Set<Listener>>();
let changeStream: ChangeStream<Document> | null = null;
let opening = false;
let reopenTimer: NodeJS.Timeout | null = null;
let reopenAttempts = 0;
let pollTimer: NodeJS.Timeout | null = null;
let pollCursor = new Date();
let polling = false;
/** Recently delivered notification ids / read-marks (id → delivered at), so change stream and poll never double-send. */
const sentNotifications = new Map<string, number>();
const sentReads = new Map<string, number>();

interface NotificationDoc { _id: string; user_id?: string | null; channel?: string; template_key?: string; payload?: unknown; title?: string | null; body?: string | null; link?: string | null; created_at?: Date; read_at?: Date | null }

export function toStreamNotification(d: NotificationDoc): StreamNotification {
  const { level, meta } = noticeFields(d.payload);
  return { id: d._id, templateKey: d.template_key ?? '', level, title: d.title ?? null, body: d.body ?? null, link: d.link ?? null, meta, createdAt: (d.created_at ?? new Date()).toISOString() };
}

function remember(map: Map<string, number>, id: string): boolean {
  const now = Date.now();
  if (map.size > 5_000) for (const [k, at] of map) if (now - at > DEDUPE_TTL_MS) map.delete(k);
  if (map.has(id)) return false;
  map.set(id, now);
  return true;
}

function emit(userId: string, event: StreamEvent) {
  const set = subscribers.get(userId);
  if (!set) return;
  for (const fn of set) {
    try { fn(event); } catch (err) { logger.warn({ err }, 'notification stream listener failed'); }
  }
}

function deliverNotification(userId: string, n: StreamNotification) {
  if (!subscribers.has(userId) || !remember(sentNotifications, n.id)) return;
  emit(userId, { event: 'notification', data: n });
}
function deliverRead(userId: string, id: string) {
  if (!subscribers.has(userId) || !remember(sentReads, id)) return;
  emit(userId, { event: 'read', data: { ids: [id] } });
}

/** Route one change-stream event to the user it concerns. Exported for tests. */
export function handleChange(change: ChangeStreamDocument<Document>) {
  if (change.operationType === 'insert') {
    const doc = change.fullDocument as unknown as NotificationDoc;
    if (doc.channel !== 'IN_APP' || !doc.user_id) return;
    deliverNotification(doc.user_id, toStreamNotification(doc));
  } else if (change.operationType === 'update') {
    const updated = change.updateDescription?.updatedFields ?? {};
    if (!('read_at' in updated) || updated.read_at == null) return;
    const doc = change.fullDocument as unknown as NotificationDoc | undefined;
    if (!doc?.user_id) return;
    deliverRead(doc.user_id, String(change.documentKey._id));
  }
}

// ─── Source 1: change stream with backoff ─────────────────────────────────
function openChangeStream(): void {
  if (changeStream || opening || subscribers.size === 0) return;
  opening = true;
  try {
    const pipeline = [{ $match: { $or: [{ operationType: 'insert', 'fullDocument.channel': 'IN_APP' }, { operationType: 'update', 'updateDescription.updatedFields.read_at': { $exists: true } }] } }];
    const cs = mongoDb().collection('notifications').watch(pipeline, { fullDocument: 'updateLookup' });
    cs.on('change', handleChange);
    cs.on('init', () => { reopenAttempts = 0; logger.info('notification change stream open'); });
    cs.on('error', (err) => {
      logger.warn({ err: err.message }, 'notification change stream error; will reopen');
      void closeChangeStream(cs).then(scheduleReopen);
    });
    cs.on('close', () => { if (changeStream === cs) { changeStream = null; scheduleReopen(); } });
    changeStream = cs;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'notification change stream could not be created; will retry');
    scheduleReopen();
  } finally {
    opening = false;
  }
}

function scheduleReopen() {
  if (reopenTimer || subscribers.size === 0) return;
  const delay = Math.min(REOPEN_MAX_MS, REOPEN_BASE_MS * 2 ** Math.min(reopenAttempts, 5));
  reopenAttempts++;
  reopenTimer = setTimeout(() => { reopenTimer = null; openChangeStream(); }, delay);
  reopenTimer.unref();
}

async function closeChangeStream(cs: ChangeStream<Document> | null = changeStream): Promise<void> {
  if (changeStream === cs) changeStream = null;
  if (cs) await cs.close().catch(() => undefined);
}

// ─── Source 2: safety poll ────────────────────────────────────────────────
/** Deliver rows created or read since the last poll for every subscribed user. Exported for tests. */
export async function pollOnce(): Promise<void> {
  if (polling || subscribers.size === 0) return;
  polling = true;
  const since = new Date(pollCursor.getTime() - POLL_OVERLAP_MS);
  const started = new Date();
  try {
    const rows = await prisma.notification.findMany({
      where: { channel: 'IN_APP', userId: { in: [...subscribers.keys()] }, OR: [{ createdAt: { gt: since } }, { readAt: { gt: since } }] },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    for (const n of rows) {
      if (!n.userId) continue;
      if (n.createdAt > since) deliverNotification(n.userId, { id: n.id, templateKey: n.templateKey, ...noticeFields(n.payload), title: n.title, body: n.body, link: n.link, createdAt: n.createdAt.toISOString() });
      if (n.readAt && n.readAt > since) deliverRead(n.userId, n.id);
    }
    pollCursor = started;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'notification poll failed');
  } finally {
    polling = false;
  }
}

function startSources() {
  if (!pollTimer) {
    pollCursor = new Date();
    pollTimer = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
    pollTimer.unref();
  }
  openChangeStream();
}

async function stopSourcesIfIdle(): Promise<void> {
  if (subscribers.size > 0) return;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (reopenTimer) { clearTimeout(reopenTimer); reopenTimer = null; }
  reopenAttempts = 0;
  await closeChangeStream();
}

/** Register a listener for one user; returns the unsubscribe function. Throws 429 above the per-user cap. */
export function subscribe(userId: string, fn: Listener): () => void {
  const set = subscribers.get(userId) ?? new Set<Listener>();
  if (set.size >= MAX_STREAMS_PER_USER) throw new AppError(429, 'RATE_LIMITED', `At most ${MAX_STREAMS_PER_USER} open notification streams per user`);
  set.add(fn);
  subscribers.set(userId, set);
  startSources();
  return () => {
    set.delete(fn);
    if (set.size === 0) subscribers.delete(userId);
    void stopSourcesIfIdle();
  };
}

export const openStreamCount = (userId?: string) => (userId ? (subscribers.get(userId)?.size ?? 0) : [...subscribers.values()].reduce((n, s) => n + s.size, 0));

/** Shutdown hook (server.ts, tests). */
export async function stopNotificationStreams(): Promise<void> {
  subscribers.clear();
  await stopSourcesIfIdle();
  sentNotifications.clear();
  sentReads.clear();
}

const sse = (res: Response, event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

/** GET /portal/notifications/stream — authenticated SSE endpoint; `?since=<ISO>` replays unread rows created after that instant (cap 20). */
export const notificationStreamHandler: RequestHandler = async (req: Request, res: Response, next) => {
  const auth = res.locals.auth as AuthContext;
  const sinceRaw = typeof req.query.since === 'string' ? new Date(req.query.since) : null;
  const since = sinceRaw && !Number.isNaN(sinceRaw.getTime()) ? sinceRaw : null;

  // Replayed rows are marked as sent for this process so the live sources do not repeat them to this user.
  let unsubscribe: () => void;
  try {
    unsubscribe = subscribe(auth.userId, (e) => sse(res, e.event, e.data));
  } catch (err) {
    return next(err);
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx: do not buffer
  res.flushHeaders();
  res.write('retry: 5000\n\n');

  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  const cleanup = () => { clearInterval(heartbeat); unsubscribe(); };
  req.on('close', cleanup);
  res.on('error', cleanup);

  if (since) {
    try {
      const rows = await prisma.notification.findMany({ where: { userId: auth.userId, channel: 'IN_APP', readAt: null, createdAt: { gt: since } }, orderBy: { createdAt: 'asc' }, take: REPLAY_CAP });
      for (const n of rows) {
        remember(sentNotifications, n.id);
        sse(res, 'notification', { id: n.id, templateKey: n.templateKey, ...noticeFields(n.payload), title: n.title, body: n.body, link: n.link, createdAt: n.createdAt.toISOString() });
      }
    } catch (err) {
      logger.warn({ err }, 'notification replay failed');
    }
  }
};
