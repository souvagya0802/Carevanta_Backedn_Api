import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '../../generated/prisma/client.js';
import { env } from '../config/env.js';

/**
 * Runtime database access goes through Neon's pooled endpoint (PgBouncer in
 * transaction mode). node-postgres uses unnamed prepared statements, which are
 * compatible with transaction pooling. Each API instance keeps a small local
 * pool; total connections ≈ instances × DB_POOL_MAX and must stay below the
 * Neon pooler limit (see docs/operations.md).
 */
function createClient(): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: env.DATABASE_URL,
    max: env.DB_POOL_MAX,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
    application_name: 'carevanta-api',
  });
  return new PrismaClient({
    adapter,
    log: [
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
    ],
    transactionOptions: { maxWait: 5_000, timeout: 15_000 },
  });
}

const globalForPrisma = globalThis as unknown as { __carevantaPrisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.__carevantaPrisma ?? createClient();
if (env.APP_ENV !== 'production') globalForPrisma.__carevantaPrisma = prisma;

export type Tx = Prisma.TransactionClient;
export type Db = PrismaClient | Tx;

export { Prisma };
