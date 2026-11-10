import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import RedisMock from 'ioredis-mock';
import { AppError } from '../../src/lib/errors.js';
import { closeRedis, getRedis, redisAvailable, useRedisClient, type RedisLike } from '../../src/lib/redis.js';
import { resetSlotLocksForTests, slotLockBackend, slotLockKey, withSlotLock } from '../../src/lib/slot-lock.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const slot = () => `slot-${Math.random().toString(36).slice(2)}`;

async function expectAppError(p: Promise<unknown>, code: string) {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  expect((err as AppError).status).toBe(409);
}

const backends = [
  { name: 'in-process (no REDIS_URL)', use: () => useRedisClient(null), expected: 'memory' as const },
  { name: 'Redis (ioredis-mock)', use: () => useRedisClient(new RedisMock()), expected: 'redis' as const },
];

describe.each(backends)('withSlotLock — $name', ({ use, expected }) => {
  beforeEach(() => {
    use();
    resetSlotLocksForTests();
  });
  afterAll(() => useRedisClient(null));

  it('reports the backend in use', () => {
    expect(slotLockBackend()).toBe(expected);
    expect(redisAvailable()).toBe(expected === 'redis');
  });

  it('runs concurrent callers for one slot one at a time, in arrival order', async () => {
    const id = slot();
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        withSlotLock(id, async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          order.push(i);
          await sleep(3);
          active -= 1;
        }),
      ),
    );
    expect(maxActive).toBe(1);
    expect(order).toHaveLength(15);
    expect(new Set(order).size).toBe(15);
    // The in-process queue is strictly FIFO; Redis polling keeps arrivals roughly ordered but makes no promise.
    if (expected === 'memory') expect(order).toEqual(Array.from({ length: 15 }, (_, i) => i));
  });

  it('does not make different slots wait for each other', async () => {
    let overlapped = false;
    let inA = false;
    await Promise.all([
      withSlotLock(slot(), async () => {
        inA = true;
        await sleep(40);
        inA = false;
      }),
      (async () => {
        await sleep(5);
        await withSlotLock(slot(), async () => {
          overlapped = inA;
        });
      })(),
    ]);
    expect(overlapped).toBe(true);
  });

  it('a waiter whose slot has filled up fails at once with SLOT_UNAVAILABLE, not a timeout', async () => {
    const id = slot();
    const holder = withSlotLock(id, () => sleep(600));
    await sleep(5);
    const started = Date.now();
    await expectAppError(withSlotLock(id, async () => 'never', { stillWorthWaiting: async () => false, waitMs: 3_000 }), 'SLOT_UNAVAILABLE');
    expect(Date.now() - started).toBeLessThan(1_000);
    await holder;
  });

  it('a waiter that runs out of patience while the slot still has room gets SLOT_BUSY', async () => {
    const id = slot();
    const holder = withSlotLock(id, () => sleep(300));
    await sleep(5);
    await expectAppError(withSlotLock(id, async () => 'never', { waitMs: 60, stillWorthWaiting: async () => true }), 'SLOT_BUSY');
    await holder;
  });

  it('releases the lock when the protected function throws', async () => {
    const id = slot();
    await expect(withSlotLock(id, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(withSlotLock(id, async () => 'next', { waitMs: 50 })).resolves.toBe('next');
  });

  it('an expired holder never releases the next holder\'s lock (compare-and-delete)', async () => {
    const id = slot();
    // A holds for 150 ms but its TTL is only 30 ms, so B takes over while A is still running.
    const a = withSlotLock(id, () => sleep(150), { ttlMs: 30 });
    await sleep(60);
    let bRunning = false;
    const b = withSlotLock(id, async () => {
      bRunning = true;
      await sleep(250);
      bRunning = false;
    }, { waitMs: 50 });
    await a; // A finished and tried to release — but the key now belongs to B.
    expect(bRunning).toBe(true);
    await expectAppError(withSlotLock(id, async () => 'never', { waitMs: 40 }), 'SLOT_BUSY');
    await b;
  });
});

describe('redis client lifecycle', () => {
  afterAll(() => useRedisClient(null));

  it('is absent in tests unless a client is injected; closeRedis quits and forgets it', async () => {
    useRedisClient(null);
    expect(getRedis()).toBeNull();
    const mock = new RedisMock();
    useRedisClient(mock);
    expect(getRedis()).toBe(mock);
    await closeRedis();
    expect(getRedis()).toBeNull();
    expect(slotLockBackend()).toBe('memory');
  });

  it('falls back to the in-process lock when Redis commands fail, and still serialises callers', async () => {
    const broken: RedisLike = {
      set: async () => { throw new Error('ECONNREFUSED'); },
      eval: async () => { throw new Error('ECONNREFUSED'); },
      quit: async () => 'OK',
    };
    useRedisClient(broken);
    resetSlotLocksForTests();
    const id = slot();
    let active = 0;
    let maxActive = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        withSlotLock(id, async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await sleep(3);
          active -= 1;
        }),
      ),
    );
    expect(maxActive).toBe(1);
  });

  it('uses one namespaced key per slot', () => {
    expect(slotLockKey('abc')).toBe('carevanta:slot-lock:abc');
  });
});
