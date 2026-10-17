/**
 * Reproducible local benchmark: embedded PostgreSQL 18 → migrations →
 * reference seed → synthetic dataset → API server → autocannon → EXPLAIN.
 *
 *   node load/local-bench.mjs            # BENCH_SCALE=medium (≈4M rows)
 *   BENCH_SCALE=small node load/local-bench.mjs
 *
 * Each run uses a fresh data directory (.tmp/pg-bench-<pid>) and removes it
 * afterwards; the medium dataset seeds in about 6 minutes.
 */
import EmbeddedPostgres from 'embedded-postgres';
import { spawn, execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

// Unique ports per run so a server left over from a crashed run can never be hit by mistake.
const PORT = 54000 + (process.pid % 900) + 100;
const API_PORT = 4100 + (process.pid % 900) + 100;
// Unique directory per run: Windows keys PostgreSQL shared memory to the data path,
// so a server left over from a crashed run would block initdb on a fixed path.
const DIR = path.resolve(`.tmp/pg-bench-${process.pid}`);
const DB = 'carevanta_bench';
const url = `postgresql://postgres:postgres@localhost:${PORT}/${DB}`;
const fresh = true;
const env = {
  ...process.env,
  APP_ENV: 'development',
  PORT: String(API_PORT),
  LOG_LEVEL: 'warn',
  DATABASE_URL: url,
  DIRECT_URL: url,
  BENCH_DATABASE_URL: url,
  BENCH_BASE_URL: `http://localhost:${API_PORT}`,
  JWT_SECRET: 'local-bench-only-jwt-secret-0123456789abcdefghijklmnopqrstuvwxyz',
  DATA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  CORS_ORIGINS: 'http://localhost:3000',
  JOBS_ENABLED: 'false',
  RATE_LIMIT_ENABLED: 'false', // single-IP load generator would trip the per-IP limiter
  RAZORPAY_WEBHOOK_SECRET: 'bench',
  DB_POOL_MAX: '20',
  BENCH_CONFIRM: 'yes',
};

const pgServer = new EmbeddedPostgres({
  databaseDir: DIR,
  user: 'postgres',
  password: 'postgres',
  port: PORT,
  persistent: true,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  postgresFlags: ['-c', 'max_connections=100', '-c', 'shared_buffers=512MB', '-c', 'work_mem=32MB', '-c', 'fsync=off', '-c', 'synchronous_commit=off'],
  onLog: () => {},
  onError: () => {},
});
if (fresh) await pgServer.initialise();
await pgServer.start();
if (fresh) await pgServer.createDatabase(DB);

const run = (cmd) => execSync(cmd, { env, stdio: 'inherit' });
try {
  run('npx prisma migrate deploy');
  run('npx tsx prisma/seed.ts');
  run('npx tsx scripts/bench-seed.ts');

  const server = spawn('npx', ['tsx', 'src/server.ts'], { env, stdio: ['ignore', 'inherit', 'inherit'], shell: true });
  server.on('exit', (code) => { if (code && code !== 0) console.error(`API server exited with code ${code}`); });
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    try {
      ready = (await fetch(`http://localhost:${API_PORT}/health/ready`)).ok;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!ready) throw new Error('API did not become ready');
  try {
    run('npx tsx scripts/bench-run.ts');
    run('npx tsx scripts/explain.ts');
  } finally {
    server.kill();
    if (process.platform === 'win32') { try { execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: 'ignore' }); } catch { /* already exited */ } }
  }
} finally {
  await pgServer.stop().catch(() => undefined);
  try { rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* Windows file locks; cleaned next run */ }
}
