import EmbeddedPostgres from 'embedded-postgres';
import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

/**
 * Starts a throwaway PostgreSQL 18 (same major version as Neon) on a local
 * port, creates a fresh database, and applies the real migration history with
 * `prisma migrate deploy` — so every test run also verifies that migrations
 * work on an empty database. Tests never touch DATABASE_URL from .env.
 */
const PORT = Number(process.env.TEST_PG_PORT ?? 54331);
const DATA_DIR = path.resolve('.tmp/pg-test');
const DB_NAME = 'carevanta_test';

let pgServer: EmbeddedPostgres | undefined;

export async function setup() {
  if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true });
  pgServer = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'postgres',
    password: 'postgres',
    port: PORT,
    persistent: true, // we remove the data dir ourselves (Windows file locks)
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: ['-c', 'max_connections=200', '-c', 'fsync=off', '-c', 'synchronous_commit=off'],
    onLog: () => {},
    onError: () => {},
  });
  await pgServer.initialise();
  await pgServer.start();
  await pgServer.createDatabase(DB_NAME);

  const url = `postgresql://postgres:postgres@localhost:${PORT}/${DB_NAME}`;
  process.env.DATABASE_URL = url;
  process.env.DIRECT_URL = url;

  execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url }, stdio: 'pipe' });

  // Seed reference data once; individual test files reset transactional tables.
  execSync('npx tsx tests/helpers/seed-once.ts', {
    env: {
      ...process.env,
      APP_ENV: 'test',
      DATABASE_URL: url,
      JWT_SECRET: 'test-only-jwt-secret-not-for-any-real-environment-0123456789',
      DATA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    },
    stdio: 'pipe',
  });

  // Sanity check the database is reachable.
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.end();
}

export async function teardown() {
  await pgServer?.stop();
  try {
    if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch {
    // Windows may hold the directory briefly after shutdown; setup() wipes it next run.
  }
}
