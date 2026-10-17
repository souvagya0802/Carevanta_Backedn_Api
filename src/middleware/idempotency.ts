import type { RequestHandler } from 'express';
import { prisma } from '../lib/prisma.js';
import { AppError, badRequest, isPgError, unauthenticated } from '../lib/errors.js';
import { sha256Hex } from '../lib/crypto.js';
import type { AuthContext } from './auth.js';

const KEY_RE = /^[A-Za-z0-9_\-:.]{8,80}$/;
const LOCK_MS = 30_000;
const RETENTION_MS = 24 * 60 * 60 * 1000;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * HTTP idempotency for retryable writes (bookings, refunds, settlements).
 *  - Same key + same request  → stored response is replayed.
 *  - Same key + different body → 422 IDEMPOTENCY_CONFLICT.
 *  - Same key while in flight  → 409 so the client retries later.
 * Failed (non-2xx) attempts release the key so a corrected retry can proceed.
 */
export function idempotency(scope: string): RequestHandler {
  return async (req, res, next) => {
    const auth = res.locals.auth as AuthContext | undefined;
    if (!auth) return next(unauthenticated());
    const key = req.header('idempotency-key');
    if (!key || !KEY_RE.test(key)) {
      return next(badRequest('A valid Idempotency-Key header (8–80 chars: A–Z a–z 0–9 _ - : .) is required'));
    }
    const requestHash = sha256Hex(`${scope}\n${req.originalUrl}\n${canonicalJson(req.body)}`);
    const now = new Date();

    let recordId: string;
    try {
      const created = await prisma.idempotencyRecord.create({
        data: {
          userId: auth.userId,
          scope,
          key,
          requestHash,
          lockedUntil: new Date(now.getTime() + LOCK_MS),
          expiresAt: new Date(now.getTime() + RETENTION_MS),
        },
        select: { id: true },
      });
      recordId = created.id;
    } catch (err) {
      if (!isPgError(err, '23505')) throw err;
      const existing = await prisma.idempotencyRecord.findUnique({
        where: { userId_scope_key: { userId: auth.userId, scope, key } },
      });
      if (!existing) return next(new AppError(409, 'CONFLICT', 'Please retry the request'));
      if (existing.requestHash !== requestHash) {
        return next(new AppError(422, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used with a different request'));
      }
      if (existing.responseStatus != null) {
        res.setHeader('Idempotent-Replayed', 'true');
        res.status(existing.responseStatus).json(existing.responseBody);
        return;
      }
      if (existing.lockedUntil && existing.lockedUntil > now) {
        return next(new AppError(409, 'CONFLICT', 'A request with this Idempotency-Key is still being processed'));
      }
      // Stale lock from a crashed attempt: take it over.
      const taken = await prisma.idempotencyRecord.updateMany({
        where: { id: existing.id, responseStatus: null, lockedUntil: existing.lockedUntil },
        data: { lockedUntil: new Date(now.getTime() + LOCK_MS) },
      });
      if (taken.count === 0) return next(new AppError(409, 'CONFLICT', 'Please retry the request'));
      recordId = existing.id;
    }

    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      const statusCode = res.statusCode;
      const finish =
        statusCode >= 200 && statusCode < 300
          ? prisma.idempotencyRecord.update({
              where: { id: recordId },
              data: { responseStatus: statusCode, responseBody: body as object, lockedUntil: null },
            })
          : prisma.idempotencyRecord.delete({ where: { id: recordId } });
      finish.catch(() => undefined).finally(() => originalJson(body));
      return res;
    };
    next();
  };
}
