import { Redis } from 'ioredis';
import { env, isTest } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Optional Redis connection (REDIS_URL). Today it backs one thing: the per-slot booking lock
 * (`slot-lock.ts`), so that several API instances agree on who is booking a slot. The client is
 * created lazily on first use and closed by `closeRedis()` during shutdown.
 *
 * REDIS_URL unset or blank → `getRedis()` returns null and callers fall back to an in-process lock,
 * which is correct for exactly ONE API instance. `initRedis()` logs that once at startup so a
 * multi-instance deployment without Redis is visible in the logs rather than silent.
 *
 * Tests never reach a real Redis: `APP_ENV=test` ignores REDIS_URL, and a test injects an
 * `ioredis-mock` instance through `useRedisClient()` to exercise the Redis code path.
 */

/** The subset of the ioredis API the lock uses; `ioredis-mock` satisfies it too. */
export interface RedisLike {
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<'OK' | null>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  quit(): Promise<unknown>;
}

// undefined = not decided yet; null = no Redis configured (or disabled for tests).
let client: RedisLike | null | undefined;
let injected = false;

/** Host part of the URL for logs: never the credentials. */
function describe(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
  } catch {
    return 'redis';
  }
}

function connect(url: string): RedisLike {
  const redis = new Redis(url, {
    // The lock caller handles failures (it falls back to the in-process lock), so commands must fail
    // fast when Redis is down instead of queueing for the whole reconnect back-off.
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    commandTimeout: 2_000,
    enableOfflineQueue: true,
    lazyConnect: false,
  });
  let lastErrorAt = 0;
  redis.on('error', (err: Error) => {
    // ioredis emits one error per failed reconnect; keep the log readable.
    if (Date.now() - lastErrorAt < 30_000) return;
    lastErrorAt = Date.now();
    logger.warn({ err: err.message, redis: describe(url) }, 'redis connection error (slot lock falls back to in-process until it recovers)');
  });
  redis.on('ready', () => logger.info({ redis: describe(url) }, 'redis connected'));
  return redis as unknown as RedisLike;
}

/** The configured Redis client, or null when the deployment runs without Redis. */
export function getRedis(): RedisLike | null {
  if (client !== undefined) return client;
  const url = isTest ? undefined : env.REDIS_URL;
  client = url ? connect(url) : null;
  return client;
}

/** True when REDIS_URL is configured (or a client was injected); false means in-process locks only. */
export function redisAvailable(): boolean {
  return getRedis() !== null;
}

/**
 * Called once at API start-up: connects when REDIS_URL is set, otherwise logs the single-instance
 * warning. Safe to call again (idempotent).
 */
export function initRedis(): void {
  if (getRedis() === null) {
    if (!isTest) logger.warn('REDIS_URL is not set: the slot-booking lock is in-process only. That is correct for a single API instance; set REDIS_URL before running two or more instances.');
    return;
  }
  if (!injected) logger.info({ redis: describe(env.REDIS_URL ?? '') }, 'redis configured for slot-booking locks');
}

/** Graceful shutdown: QUIT waits for in-flight commands, then the socket closes. */
export async function closeRedis(): Promise<void> {
  const c = client;
  client = undefined;
  injected = false;
  if (c) await c.quit().catch(() => undefined);
}

/**
 * Test and bootstrap hook: use this client (for example `new RedisMock()` from `ioredis-mock`) instead of
 * one built from REDIS_URL. Pass null to force the in-process lock. Not used in production code paths.
 */
export function useRedisClient(c: RedisLike | null): void {
  client = c;
  injected = c !== null;
}
