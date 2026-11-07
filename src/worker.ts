import { Cron } from 'croner';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { ensureIndexes } from './lib/mongo-indexes.js';
import { prisma } from './lib/prisma.js';
import { runWithLease, WORKER_ID } from './lib/job-lease.js';
import { deliverQueuedNotifications } from './modules/notifications/notifications.service.js';
import { runQueuedExports } from './modules/exports/exports.service.js';
import { autoNoShow, cleanupExpired, enforceCredentialExpiry, openRenewalReminders } from './jobs/maintenance.js';

/**
 * Background worker (separate process: `npm run start:worker`). Jobs are
 * scheduled in-process with cron expressions (Asia/Kolkata) and serialised
 * across worker instances with a MongoDB lease per job (src/lib/job-lease.ts),
 * so running two workers is safe: whichever takes the lease runs the job, the
 * other skips that tick. A job that overruns its lease is assumed crashed and
 * may run again on the next tick; every job here is idempotent.
 */
const JOBS: Record<string, { cron: string; leaseMs: number; run: () => Promise<unknown> }> = {
  'notifications.deliver': { cron: '* * * * *', leaseMs: 5 * 60_000, run: () => deliverQueuedNotifications(100) },
  'exports.run': { cron: '* * * * *', leaseMs: 10 * 60_000, run: () => runQueuedExports(5) },
  'maintenance.credential-expiry': { cron: '15 2 * * *', leaseMs: 30 * 60_000, run: () => enforceCredentialExpiry() },
  'maintenance.renewal-reminders': { cron: '30 2 * * *', leaseMs: 30 * 60_000, run: () => openRenewalReminders() },
  'maintenance.cleanup': { cron: '45 3 * * *', leaseMs: 30 * 60_000, run: () => cleanupExpired() },
  'maintenance.auto-no-show': { cron: '0 * * * *', leaseMs: 30 * 60_000, run: () => autoNoShow() },
};

if (!env.JOBS_ENABLED) {
  logger.warn('JOBS_ENABLED=false — worker exiting');
  process.exit(0);
}

await ensureIndexes(prisma);

const schedules = Object.entries(JOBS).map(([name, job]) =>
  new Cron(job.cron, { timezone: 'Asia/Kolkata', protect: true, name }, async () => {
    const started = Date.now();
    try {
      const result = await runWithLease(name, job.leaseMs, job.run);
      if (result === null) logger.debug({ job: name }, 'job skipped: lease held by another worker');
      else logger.info({ job: name, ms: Date.now() - started, result }, 'job completed');
    } catch (err) {
      logger.error({ job: name, err }, 'job failed');
    }
  }),
);
logger.info({ worker: WORKER_ID, jobs: Object.keys(JOBS) }, 'carevanta-worker started');

async function shutdown(signal: string) {
  logger.info({ signal }, 'worker shutting down');
  for (const s of schedules) s.stop();
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
