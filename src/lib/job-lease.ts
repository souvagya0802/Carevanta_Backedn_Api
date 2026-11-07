import { randomUUID } from 'node:crypto';
import { bsonDate, isDuplicateKey, prisma } from './prisma.js';

/**
 * Distributed lease for scheduled jobs, stored in the `job_leases` collection
 * (one document per job name, `_id` = job name). Replaces pg-boss's
 * single-worker guarantee: a job runs only while its lease is held, so two
 * worker processes (or a restart during a run) never execute the same job at
 * the same time. Leases expire on their own, so a crashed worker releases the
 * job after `ttlMs` without any manual cleanup.
 */
export const WORKER_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;

interface FindAndModifyResult { value?: { _id: string; owner?: string } | null }

/** Try to take the lease for `name` for `ttlMs`. Returns false when another worker holds it. */
export async function acquireLease(name: string, ttlMs: number, owner = WORKER_ID): Promise<boolean> {
  const now = new Date();
  try {
    const res = (await prisma.$runCommandRaw({
      findAndModify: 'job_leases',
      query: { _id: name, $or: [{ locked_until: { $exists: false } }, { locked_until: { $lt: bsonDate(now) } }] },
      update: { $set: { owner, locked_at: bsonDate(now), locked_until: bsonDate(new Date(now.getTime() + ttlMs)) }, $inc: { runs: 1 } },
      upsert: true,
      new: true,
    })) as FindAndModifyResult;
    return res.value?.owner === owner;
  } catch (err) {
    // Upsert raced with another worker that already holds the (unexpired) lease.
    if (isDuplicateKey(err)) return false;
    throw err;
  }
}

/** Release the lease early and record the outcome of the run. */
export async function releaseLease(name: string, outcome: { ok: boolean; ms: number; error?: string }, owner = WORKER_ID): Promise<void> {
  await prisma.$runCommandRaw({
    update: 'job_leases',
    updates: [
      {
        q: { _id: name, owner },
        u: { $set: { locked_until: bsonDate(new Date(0)), last_run_at: bsonDate(), last_ok: outcome.ok, last_ms: outcome.ms, last_error: outcome.error ?? null } },
      },
    ],
  });
}

/** Run `fn` under the lease; returns null when the job was skipped because another worker holds it. */
export async function runWithLease<T>(name: string, ttlMs: number, fn: () => Promise<T>): Promise<T | null> {
  if (!(await acquireLease(name, ttlMs))) return null;
  const started = Date.now();
  try {
    const result = await fn();
    await releaseLease(name, { ok: true, ms: Date.now() - started });
    return result;
  } catch (err) {
    await releaseLease(name, { ok: false, ms: Date.now() - started, error: err instanceof Error ? err.message.slice(0, 500) : String(err) }).catch(() => undefined);
    throw err;
  }
}
