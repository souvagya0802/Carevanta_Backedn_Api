import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import { logger } from './logger.js';
import { getRedis, type RedisLike } from './redis.js';

/**
 * Per-slot booking lock.
 *
 * When several patients book the same slot at the same moment, the lock decides who goes first:
 * callers queue (in arrival order) instead of all racing the database and most of them failing.
 * The winner books; the next in line re-reads the slot, sees it is full and gets the usual
 * 409 SLOT_UNAVAILABLE. The lock is advisory — the MongoDB compare-and-set on `appointment_slots.version`
 * inside the booking transaction remains the final guarantee, so a lost or expired lock can never
 * over-book a slot; it can only make losers fail noisily instead of waiting their turn.
 *
 * Backends:
 *  - Redis (`REDIS_URL` set): `SET key token NX PX ttl`, released by a Lua compare-and-delete so a
 *    holder whose TTL already expired never deletes the next holder's lock. Works across API instances.
 *  - In-process (no Redis): a FIFO waiter queue per slot. Correct for ONE instance only.
 *  - If Redis is configured but a command fails (outage), that call falls back to the in-process lock and
 *    a warning is logged (at most once a minute) — bookings keep working, guarded by the database CAS.
 */

export interface SlotLockOptions {
  /** Lock lifetime; must outlast the longest booking transaction (retries included). Default 20 s. */
  ttlMs?: number;
  /** How long a caller waits for its turn before giving up with SLOT_BUSY. Default 4 s. */
  waitMs?: number;
  /**
   * Polled while waiting (about every 150 ms). Return false when there is nothing left to wait for —
   * the slot is already full — and the waiter fails at once with `unavailable()` instead of queueing.
   */
  stillWorthWaiting?: () => Promise<boolean>;
  /** Error for "the slot is gone"; default 409 SLOT_UNAVAILABLE (same as the booking service). */
  unavailable?: () => AppError;
}

export type SlotLockBackend = 'redis' | 'memory';

export const SLOT_LOCK_PREFIX = 'carevanta:slot-lock:';
export const slotLockKey = (slotId: string) => `${SLOT_LOCK_PREFIX}${slotId}`;

const DEFAULT_TTL_MS = 20_000;
const DEFAULT_WAIT_MS = 4_000;
const CHECK_INTERVAL_MS = 150;

export const slotUnavailable = () => new AppError(409, 'SLOT_UNAVAILABLE', 'This slot is no longer available');
export const slotBusy = () => new AppError(409, 'SLOT_BUSY', 'Other patients are booking this slot right now; please try again in a moment');

const RELEASE_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

interface LockStore {
  readonly backend: SlotLockBackend;
  /** SET NX PX semantics: true when this token now holds the key. */
  acquire(key: string, token: string, ttlMs: number): Promise<boolean>;
  /** Compare-and-delete: only the token that holds the key releases it. */
  release(key: string, token: string): Promise<void>;
  /** Wait for the key to be released, or at most `maxMs`. */
  waitForRelease(key: string, maxMs: number): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class RedisLockStore implements LockStore {
  readonly backend = 'redis' as const;
  constructor(private readonly redis: RedisLike) {}
  async acquire(key: string, token: string, ttlMs: number) {
    return (await this.redis.set(key, token, 'PX', ttlMs, 'NX')) === 'OK';
  }
  async release(key: string, token: string) {
    await this.redis.eval(RELEASE_LUA, 1, key, token);
  }
  // Redis has no cheap "wake me on DEL"; short jittered polls keep arrivals roughly in order.
  waitForRelease(_key: string, maxMs: number) {
    return sleep(Math.min(maxMs, 10 + Math.floor(Math.random() * 20)));
  }
}

/** Single-process lock with a strict FIFO queue of waiters per key. */
class MemoryLockStore implements LockStore {
  readonly backend = 'memory' as const;
  private readonly locks = new Map<string, { token: string; expiresAt: number }>();
  private readonly waiters = new Map<string, Array<() => void>>();
  async acquire(key: string, token: string, ttlMs: number) {
    const cur = this.locks.get(key);
    if (cur && cur.expiresAt > Date.now()) return false;
    this.locks.set(key, { token, expiresAt: Date.now() + ttlMs });
    return true;
  }
  async release(key: string, token: string) {
    if (this.locks.get(key)?.token === token) this.locks.delete(key);
    this.wakeNext(key);
  }
  waitForRelease(key: string, maxMs: number) {
    return new Promise<void>((resolve) => {
      const queue = this.waiters.get(key) ?? [];
      this.waiters.set(key, queue);
      let done = false;
      const timer = setTimeout(() => finish(), maxMs);
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const i = queue.indexOf(finish);
        if (i >= 0) queue.splice(i, 1);
        resolve();
      };
      queue.push(finish);
    });
  }
  private wakeNext(key: string) {
    const queue = this.waiters.get(key);
    const next = queue?.[0];
    if (next) next();
    else if (queue) this.waiters.delete(key);
  }
  clear() {
    this.locks.clear();
    this.waiters.clear();
  }
}

const memoryStore = new MemoryLockStore();
let lastRedisFailureLogAt = 0;

function warnRedisFailure(stage: 'acquire' | 'release', err: unknown) {
  if (Date.now() - lastRedisFailureLogAt < 60_000) return;
  lastRedisFailureLogAt = Date.now();
  logger.warn({ err: err instanceof Error ? err.message : String(err), stage }, 'redis slot lock failed; using the in-process lock for this request (database compare-and-set still protects the slot)');
}

/** Which backend a lock taken right now would use. */
export function slotLockBackend(): SlotLockBackend {
  return getRedis() ? 'redis' : 'memory';
}

/** Tests only: forget every in-process lock and waiter. */
export function resetSlotLocksForTests(): void {
  memoryStore.clear();
}

/**
 * Run `fn` while holding the lock for `slotId`. Waits up to `waitMs` for its turn; throws
 * `unavailable()` as soon as `stillWorthWaiting()` reports the slot is gone, or SLOT_BUSY (409) when the
 * wait runs out while the slot still has room.
 */
export async function withSlotLock<T>(slotId: string, fn: () => Promise<T>, opts: SlotLockOptions = {}): Promise<T> {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const unavailable = opts.unavailable ?? slotUnavailable;
  const key = slotLockKey(slotId);
  const token = randomUUID();

  const redis = getRedis();
  let store: LockStore = redis ? new RedisLockStore(redis) : memoryStore;

  const deadline = Date.now() + waitMs;
  let lastCheckAt = Date.now();
  for (;;) {
    let held: boolean;
    try {
      held = await store.acquire(key, token, ttlMs);
    } catch (err) {
      if (store.backend !== 'redis') throw err;
      warnRedisFailure('acquire', err);
      store = memoryStore;
      continue;
    }
    if (held) break;

    const now = Date.now();
    if (opts.stillWorthWaiting && now - lastCheckAt >= CHECK_INTERVAL_MS) {
      lastCheckAt = now;
      if (!(await opts.stillWorthWaiting())) throw unavailable();
    }
    if (now >= deadline) {
      // Last look before giving up: a full slot is "unavailable", a slot with room is merely "busy".
      if (opts.stillWorthWaiting && !(await opts.stillWorthWaiting())) throw unavailable();
      throw slotBusy();
    }
    await store.waitForRelease(key, Math.max(1, Math.min(deadline - now, CHECK_INTERVAL_MS)));
  }

  try {
    return await fn();
  } finally {
    try {
      await store.release(key, token);
    } catch (err) {
      // The TTL will clear it; the next caller waits at most ttlMs.
      warnRedisFailure('release', err);
    }
  }
}
