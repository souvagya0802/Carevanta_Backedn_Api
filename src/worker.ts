import { PgBoss } from 'pg-boss';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { deliverQueuedNotifications } from './modules/notifications/notifications.service.js';
import { runQueuedExports } from './modules/exports/exports.service.js';
import { autoNoShow, cleanupExpired, enforceCredentialExpiry, openRenewalReminders } from './jobs/maintenance.js';

/**
 * Background worker (separate process: `npm run start:worker`). pg-boss keeps
 * its queue in the same PostgreSQL database (schema `pgboss`) with
 * SKIP LOCKED polling, so no extra infrastructure is needed. Run exactly one
 * worker per environment unless jobs are made explicitly concurrent-safe
 * (the maintenance jobs are; notification delivery is).
 */
const JOBS: Record<string, { cron: string; run: () => Promise<unknown> }> = {
  'notifications.deliver': { cron: '* * * * *', run: () => deliverQueuedNotifications(100) },
  'exports.run': { cron: '* * * * *', run: () => runQueuedExports(5) },
  'maintenance.credential-expiry': { cron: '15 2 * * *', run: () => enforceCredentialExpiry() },
  'maintenance.renewal-reminders': { cron: '30 2 * * *', run: () => openRenewalReminders() },
  'maintenance.cleanup': { cron: '45 3 * * *', run: () => cleanupExpired() },
  'maintenance.auto-no-show': { cron: '0 * * * *', run: () => autoNoShow() },
};

if (!env.JOBS_ENABLED) {
  logger.warn('JOBS_ENABLED=false — worker exiting');
  process.exit(0);
}

const boss = new PgBoss({
  connectionString: env.DIRECT_URL ?? env.DATABASE_URL,
  schema: 'pgboss',
  application_name: 'carevanta-worker',
  max: 3,
});
boss.on('error', (err: unknown) => logger.error({ err }, 'pg-boss error'));

await boss.start();
for (const [name, job] of Object.entries(JOBS)) {
  await boss.createQueue(name).catch(() => undefined);
  await boss.work(name, { batchSize: 1 }, async () => {
    const started = Date.now();
    try {
      const result = await job.run();
      logger.info({ job: name, ms: Date.now() - started, result }, 'job completed');
    } catch (err) {
      logger.error({ job: name, err }, 'job failed');
      throw err; // pg-boss records the failure and retries per queue policy
    }
  });
  await boss.schedule(name, job.cron, undefined, { tz: 'Asia/Kolkata' });
}
logger.info({ jobs: Object.keys(JOBS) }, 'carevanta-worker started');

async function shutdown(signal: string) {
  logger.info({ signal }, 'worker shutting down');
  await boss.stop({ graceful: true, timeout: 20_000 }).catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
