import { MongoClient } from 'mongodb';
import { env } from '../config/env.js';
import { withDatabase } from './prisma.js';

/**
 * A native MongoDB driver client for the few things Prisma cannot do: change
 * streams (live notifications). Same URI and database as Prisma, small pool,
 * opened on first use and closed on shutdown.
 */
let client: MongoClient | null = null;

export function mongoClient(): MongoClient {
  client ??= new MongoClient(withDatabase(env.MONGODB_URI, env.MONGODB_DB), { maxPoolSize: 5, serverSelectionTimeoutMS: 10_000, appName: 'carevanta-api-stream' });
  return client;
}

/** The application database (name taken from the URI, falling back to MONGODB_DB). */
export function mongoDb() {
  return mongoClient().db();
}

export async function closeMongoClient(): Promise<void> {
  const c = client;
  client = null;
  await c?.close().catch(() => undefined);
}
