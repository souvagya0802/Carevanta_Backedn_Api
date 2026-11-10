import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { defineRoute } from '../../http/route.js';
import { audit } from '../../lib/audit.js';
import { AppError, conflict } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { bsonDate, prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { getSetting } from '../settings/settings.service.js';
import {
  CDCI_LAST_RUN_KEY,
  CDCI_RELEASE_KEY,
  CDCI_SYNC_ENABLED_KEY,
  CDCI_SYNC_JOB,
  runCdciSyncWithLease,
  type CdciRelease,
  type CdciSyncResult,
} from '../../jobs/cdci-sync.js';

/** A full sync downloads ~20 MB and rewrites the catalogue; a handful of manual triggers per hour is plenty. */
const syncLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 6,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => !env.RATE_LIMIT_ENABLED || (env.APP_ENV === 'test' && process.env.RATE_LIMIT_IN_TESTS !== 'true'),
  handler: (_req, _res, next) => next(new AppError(429, 'RATE_LIMITED', 'Too many requests, please slow down')),
});

let running: Promise<unknown> | null = null;

/** True while any worker or API instance holds the sync lease. */
async function leaseHeld(): Promise<boolean> {
  const res = (await prisma.$runCommandRaw({ find: 'job_leases', filter: { _id: CDCI_SYNC_JOB, locked_until: { $gt: bsonDate(new Date()) } }, limit: 1 })) as unknown as { cursor?: { firstBatch?: unknown[] } };
  return (res.cursor?.firstBatch?.length ?? 0) > 0;
}

/** For tests: resolves when the background sync started by the trigger has finished. */
export const cdciSyncSettled = (): Promise<unknown> => running ?? Promise.resolve();

export function cdciSyncRouter(): Router {
  const r = Router();
  const base = '/admin/catalogue/medicines';
  const tags = ['Admin · Catalogue'];

  defineRoute(r, base, {
    method: 'post',
    path: '/sync',
    summary: 'Sync the medicine list from CDCI now',
    description: 'Starts a sync in the background and returns at once. `force` re-applies the latest release even when it was already applied. The outcome is sent to catalogue admins and shown by sync-status.',
    tags,
    permissions: ['catalogue.manage'],
    middleware: [syncLimiter],
    status: 202,
    body: z.object({ force: z.boolean().default(false) }),
    response: z.object({ status: z.literal('started') }),
    handler: async ({ body, auth }) => {
      if (!(await getSetting<boolean>(CDCI_SYNC_ENABLED_KEY, true))) throw conflict('Medicine list sync is turned off in Settings');
      if (running || (await leaseHeld())) throw conflict('A medicine list sync is already running');
      await audit(prisma, { action: 'catalogue.medicines_sync_started', entityType: 'platform_setting', entityId: CDCI_RELEASE_KEY, actorUserId: auth.userId, metadata: { force: body.force } });
      running = runCdciSyncWithLease({ force: body.force, triggeredBy: auth.userId })
        .then((result) => {
          if (result === null) logger.info({ job: CDCI_SYNC_JOB }, 'cdci sync skipped: lease held elsewhere');
        })
        .catch((err: unknown) => logger.error({ err, job: CDCI_SYNC_JOB }, 'manual cdci sync failed'))
        .finally(() => {
          running = null;
        });
      return { status: 'started' as const };
    },
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/sync-status',
    summary: 'Medicine list sync status',
    description: 'The last CDCI release applied and the outcome of the last sync run.',
    tags,
    permissions: ['catalogue.manage'],
    response: z.object({ running: z.boolean(), enabled: z.boolean(), lastRelease: z.unknown().nullable(), lastRun: z.unknown().nullable() }),
    handler: async () => {
      const [enabled, lastRelease, lastRun, held] = await Promise.all([
        getSetting<boolean>(CDCI_SYNC_ENABLED_KEY, true),
        prisma.platformSetting.findUnique({ where: { key: CDCI_RELEASE_KEY } }).then((s) => (s?.value ?? null) as CdciRelease | null),
        prisma.platformSetting.findUnique({ where: { key: CDCI_LAST_RUN_KEY } }).then((s) => (s?.value ?? null) as CdciSyncResult | null),
        leaseHeld(),
      ]);
      return { running: !!running || held, enabled: enabled !== false, lastRelease, lastRun };
    },
  });

  return r;
}
