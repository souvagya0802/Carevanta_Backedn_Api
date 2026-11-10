import { createServer } from 'node:http';
import { createApp, markIndexesReady, markShuttingDown } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { ensureIndexes } from './lib/mongo-indexes.js';
import { closeMongoClient } from './lib/mongo-client.js';
import { closeRedis, initRedis } from './lib/redis.js';
import { prisma } from './lib/prisma.js';
import { stopNotificationStreams } from './modules/notifications/stream.js';

const app = createApp();
const server = createServer(app);

// Index sync runs after the socket is open so a code reload never leaves the port dark (the sync is a few
// hundred round-trips on Atlas). /health/ready answers 503 "starting" until it has finished, and the
// process exits if it fails: the partial unique indexes enforce "one live row per …" invariants.
// Until the sync succeeds the process keeps retrying (every 30 s) rather than exiting: a transient database
// outage, or a laptop whose IP dropped off the Atlas access list, then heals without a manual restart.
// Production gives up after ten failed attempts so an orchestrator can replace the instance.
const INDEX_RETRY_MS = 30_000;
const MAX_INDEX_ATTEMPTS = env.APP_ENV === 'production' ? 10 : Number.POSITIVE_INFINITY;
async function syncIndexesUntilReady(attempt = 1): Promise<void> {
  try {
    const { created } = await ensureIndexes(prisma);
    markIndexesReady();
    logger.info({ indexes: created, attempt }, 'MongoDB indexes ensured');
  } catch (err) {
    if (attempt >= MAX_INDEX_ATTEMPTS) {
      logger.fatal({ err, attempt }, 'could not create MongoDB indexes; giving up');
      process.exit(1);
    }
    logger.error({ err: err instanceof Error ? err.message : String(err), attempt, retryInMs: INDEX_RETRY_MS }, 'MongoDB index sync failed (database unreachable?); readiness stays 503 "starting" until it succeeds');
    setTimeout(() => void syncIndexesUntilReady(attempt + 1), INDEX_RETRY_MS).unref();
  }
}
void syncIndexesUntilReady();

// Bound slow clients and keep-alive behind a load balancer.
server.requestTimeout = 30_000;
server.headersTimeout = 20_000;
server.keepAliveTimeout = 65_000;

initRedis(); // slot-booking lock backend: Redis when REDIS_URL is set, else one warning and the in-process lock
server.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'carevanta-api listening');
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'shutting down');
  markShuttingDown(); // readiness → 503 so the load balancer drains us
  const force = setTimeout(() => {
    logger.error('forced shutdown after timeout');
    process.exit(1);
  }, 25_000);
  force.unref();
  server.close(async () => {
    await stopNotificationStreams().catch(() => undefined);
    await closeMongoClient().catch(() => undefined);
    await closeRedis();
    await prisma.$disconnect().catch(() => undefined);
    logger.info('shutdown complete');
    process.exit(0);
  });
  server.closeIdleConnections();
  // `server.close` only resolves once every connection has ended. SSE streams (/portal/notifications/stream) and
  // keep-alive sockets never end on their own, so after the drain window they are closed here; EventSource
  // clients reconnect to the next healthy instance (the stream sends `retry: 5000`).
  const drain = setTimeout(() => {
    logger.info({ drainMs: env.SHUTDOWN_DRAIN_MS }, 'drain window over; closing remaining connections');
    server.closeAllConnections();
  }, env.SHUTDOWN_DRAIN_MS);
  drain.unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
// A thrown error outside any request leaves the process in an unknown state: log it and let the orchestrator
// replace the instance (readiness flips to 503 first so the load balancer stops routing here).
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception; exiting');
  markShuttingDown();
  setTimeout(() => process.exit(1), 500).unref();
});
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled promise rejection');
});
