import { PrismaClient, Prisma } from '../../generated/prisma/client.js';
import { env } from '../config/env.js';
import { withExplicitNulls } from './prisma-null-defaults.js';

/**
 * Database access goes through Prisma's MongoDB connector against a replica set
 * (Atlas in staging/production, mongodb-memory-server in tests). A replica set
 * is required: every multi-step write runs inside an interactive `$transaction`,
 * which MongoDB only supports with replication.
 *
 * Dates are stored as BSON dates (UTC instants), so no server time-zone setting
 * is involved; the driver keeps sockets alive and reconnects on its own.
 */
function createClient(): PrismaClient {
  const client = new PrismaClient({
    datasourceUrl: withDatabase(env.MONGODB_URI, env.MONGODB_DB),
    log: [
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
    ],
    transactionOptions: { maxWait: 5_000, timeout: Math.max(15_000, env.DB_STATEMENT_TIMEOUT_MS) },
  });
  // A connection can be closed by the server or the network between requests. Retry READS once on a fresh
  // connection; writes are never retried here, so nothing is applied twice.
  // Audit trails are append-only: PostgreSQL enforced this with triggers, here the client refuses the
  // operation before it reaches the database (and the database user should not hold delete rights either).
  return client.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (APPEND_ONLY_MODELS.has(model) && MUTATING_OPERATIONS.has(operation)) {
            throw new Error(`${model} is append-only: ${operation} is not allowed`);
          }
          const restricted = RESTRICTED_UPDATES[model];
          if (restricted && MUTATING_OPERATIONS.has(operation)) {
            // upsert is the idempotent "post once" pattern (create if absent); only its update half is checked.
            const data = (operation === 'upsert' ? (args as { update?: Record<string, unknown> }).update : (args as { data?: Record<string, unknown> }).data) ?? {};
            const illegal = operation.startsWith('delete') || Object.keys(data).some((k) => !restricted.has(k));
            if (illegal) throw new Error(`${model} is immutable apart from ${[...restricted].join(', ')}: ${operation} rejected`);
          }
          // Omitted optional fields are stored as explicit null so SQL-style `null` filters keep working.
          if (!READ_OPERATIONS.has(operation)) return query(withExplicitNulls(model, operation, args) as typeof args);
          try {
            return await query(args);
          } catch (err) {
            if (!isDroppedConnection(err)) throw err;
            return query(args);
          }
        },
      },
    },
  }) as unknown as PrismaClient;
}

const READ_OPERATIONS = new Set(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy', 'findRaw', 'aggregateRaw']);
export const APPEND_ONLY_MODELS = new Set(['AuditEvent', 'SensitiveAccessLog']);
const MUTATING_OPERATIONS = new Set(['update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete', 'deleteMany']);
/**
 * Financial facts that may only move forward: a commission snapshot can be
 * reversed (status/reversedAt/reversalReason), never recalculated or deleted;
 * a ledger entry can only be attached to a settlement item. PostgreSQL enforced
 * this with triggers; the extension enforces it before the write.
 */
const RESTRICTED_UPDATES: Record<string, Set<string>> = {
  CommissionSnapshot: new Set(['status', 'reversedAt', 'reversalReason', 'reversedById']),
  ProviderLedgerEntry: new Set(['settlementItemId']),
};

/** The connection died under us (not a query error): safe to retry a read. */
export function isDroppedConnection(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | null)?.code;
  return (
    /closed the connection|Connection terminated|ECONNRESET|socket hang up|Can't reach database server|Server selection timeout|MongoNetworkError|PoolClearedError|connection .* was closed/i.test(msg) ||
    code === 'P1017' ||
    code === 'P1001'
  );
}

/**
 * Ensure the URI names a database. Atlas connection strings are usually copied
 * without one (`mongodb+srv://user:pw@cluster.mongodb.net/`), in which case
 * MONGODB_DB is inserted; a database already present in the URI wins.
 * Works for SRV and multi-host URIs, which `new URL()` cannot parse.
 */
export function withDatabase(uri: string, db: string): string {
  const m = /^(mongodb(?:\+srv)?:\/\/[^/?]+)(\/[^?]*)?(\?.*)?$/.exec(uri);
  if (!m) return uri;
  const [, head, path = '', query = ''] = m;
  const hasDb = path.length > 1;
  return `${head}${hasDb ? path : `/${db}`}${query}`;
}

const globalForPrisma = globalThis as unknown as { __carevantaPrisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.__carevantaPrisma ?? createClient();
if (env.APP_ENV !== 'production') globalForPrisma.__carevantaPrisma = prisma;

export type Tx = Prisma.TransactionClient;
export type Db = PrismaClient | Tx;

/**
 * MongoDB aborts one of two transactions that write the same document
 * (snapshot isolation + write conflicts) instead of blocking it like a row
 * lock would. Prisma reports that as P2034. Such a transaction is safe to rerun
 * from the start, so money- and capacity-critical flows go through this helper.
 */
export async function transactionWithRetry<T>(fn: (tx: Tx) => Promise<T>, options: { maxWait?: number; timeout?: number } = {}, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(fn, options);
    } catch (err) {
      if (attempt >= attempts || !isWriteConflict(err)) throw err;
      await new Promise((r) => setTimeout(r, 15 * attempt + Math.floor(Math.random() * 25)));
    }
  }
}

/**
 * Serialise money flows on one service transaction (replaces `SELECT … FOR UPDATE`):
 * bumping `version` inside the transaction makes any concurrent writer conflict,
 * and transactionWithRetry reruns the loser against the committed state.
 * A missing id is not an error here; callers report not-found after their own read.
 */
export async function lockTransaction(tx: Tx, id: string): Promise<void> {
  await tx.serviceTransaction.updateMany({ where: { id }, data: { version: { increment: 1 } } });
}

/** Transient transaction conflict: another writer touched the same document first. */
export function isWriteConflict(err: unknown): boolean {
  const e = err as { code?: unknown; message?: string } | null;
  return e?.code === 'P2034' || /write conflict|WriteConflict|TransientTransactionError|NoSuchTransaction/i.test(e?.message ?? '');
}

/** MongoDB Extended JSON date literal for `$runCommandRaw` filters and updates. */
export const bsonDate = (d: Date = new Date()) => ({ $date: d.toISOString() });

/** Duplicate-key error from MongoDB (unique or partial unique index), surfaced by Prisma as P2002 or raw code 11000. */
export function isDuplicateKey(err: unknown): boolean {
  const e = err as { code?: unknown; message?: string } | null;
  return e?.code === 'P2002' || e?.code === 11000 || /E11000|duplicate key/i.test(e?.message ?? '');
}

export { Prisma };
