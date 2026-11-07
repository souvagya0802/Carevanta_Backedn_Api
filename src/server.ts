import { createServer } from 'node:http';
import { createApp, markIndexesReady, markShuttingDown } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { ensureIndexes } from './lib/mongo-indexes.js';
import { prisma } from './lib/prisma.js';

const app = createApp();
const server = createServer(app);

// Index sync runs after the socket is open so a code reload never leaves the port dark (the sync is a few
// hundred round-trips on Atlas). /health/ready answers 503 "starting" until it has finished, and the
// process exits if it fails: the partial unique indexes enforce "one live row per …" invariants.
void ensureIndexes(prisma)
  .then(({ created }) => {
    markIndexesReady();
    logger.info({ indexes: created }, 'MongoDB indexes ensured');
  })
  .catch((err: unknown) => {
    logger.fatal({ err }, 'could not create MongoDB indexes');
    process.exit(1);
  });

// Bound slow clients and keep-alive behind a load balancer.
server.requestTimeout = 30_000;
server.headersTimeout = 20_000;
server.keepAliveTimeout = 65_000;

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
    await prisma.$disconnect().catch(() => undefined);
    logger.info('shutdown complete');
    process.exit(0);
  });
  server.closeIdleConnections();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled promise rejection');
});
