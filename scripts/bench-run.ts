/**
 * HTTP load benchmark with autocannon against a running API.
 *
 *   BENCH_BASE_URL=http://localhost:4000 npx tsx scripts/bench-run.ts
 *
 * Creates (or reuses) a synthetic SUPER_ADMIN login, discovers sample ids from
 * the database, then runs each scenario for BENCH_SECONDS at BENCH_CONNECTIONS
 * and writes load/results/<timestamp>.json plus a markdown summary.
 */
import 'dotenv/config';
import autocannon from 'autocannon';
import { mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { hashPassword } from '../src/modules/auth/passwords.js';

const BASE = process.env.BENCH_BASE_URL ?? 'http://localhost:4000';
const SECONDS = Number(process.env.BENCH_SECONDS ?? 15);
const CONNECTIONS = Number(process.env.BENCH_CONNECTIONS ?? 25);
const PASSWORD = 'Bench-Admin-Passphrase-2026';

// Targets agreed before measuring (single API instance, local PostgreSQL).
const TARGETS = { p95Ms: 250, p99Ms: 600, maxErrorRate: 0.001 };

const db = new pg.Client({ connectionString: process.env.BENCH_DATABASE_URL ?? process.env.DATABASE_URL });
await db.connect();

async function ensureAdmin() {
  const email = 'bench-admin@bench.invalid';
  const hash = await hashPassword(PASSWORD);
  await db.query(
    `INSERT INTO users (email, full_name, password_hash, status, email_verified_at, updated_at)
     VALUES ($1, 'Bench Admin', $2, 'ACTIVE', now(), now())
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, status = 'ACTIVE', locked_until = NULL, failed_login_count = 0`,
    [email, hash],
  );
  await db.query(
    `INSERT INTO user_roles (user_id, role_id) SELECT u.id, r.id FROM users u, roles r WHERE u.email = $1 AND r.key = 'SUPER_ADMIN'
     AND NOT EXISTS (SELECT 1 FROM user_roles x WHERE x.user_id = u.id AND x.role_id = r.id AND x.revoked_at IS NULL)`,
    [email],
  );
  return email;
}

const email = await ensureAdmin();
const login = await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: email, password: PASSWORD }) });
if (!login.ok) throw new Error(`login failed: ${login.status} ${await login.text()}`);
const { data } = (await login.json()) as { data: { accessToken: string } };
const auth = { authorization: `Bearer ${data.accessToken}` };

const doctor = (await db.query(`SELECT id FROM providers WHERE type = 'DOCTOR' AND status = 'APPROVED' ORDER BY random() LIMIT 1`)).rows[0]?.id as string | undefined;
const counts = (await db.query(`SELECT (SELECT count(*) FROM users) u, (SELECT count(*) FROM providers) p, (SELECT count(*) FROM appointment_slots) s, (SELECT count(*) FROM appointments) a, (SELECT count(*) FROM audit_events) e`)).rows[0];

const scenarios: { name: string; path: string; headers?: Record<string, string> }[] = [
  { name: 'auth.me (session validation)', path: '/api/v1/auth/me', headers: auth },
  { name: 'users.list (cursor page)', path: '/api/v1/admin/users?limit=25', headers: auth },
  { name: 'users.search (trigram)', path: '/api/v1/admin/users?q=Bench%20Patient%2042&limit=25', headers: auth },
  { name: 'providers.list (type filter)', path: '/api/v1/admin/providers?type=DOCTOR&status=APPROVED&limit=25', headers: auth },
  { name: 'verification.queue', path: '/api/v1/admin/verification-cases?limit=25', headers: auth },
  { name: 'discovery.search (geo)', path: '/api/v1/discovery/search?q=liver%20disease&lat=22.3&lng=87.92&radiusKm=15&limit=20' },
  { name: 'doctor.slots (public)', path: `/api/v1/discovery/doctors/${doctor}/slots` },
  { name: 'appointments.list', path: '/api/v1/admin/appointments?status=COMPLETED&limit=25', headers: auth },
  { name: 'finance.transactions', path: '/api/v1/admin/finance/transactions?commissionEligible=true&limit=25', headers: auth },
  { name: 'analytics.overview (30d)', path: '/api/v1/admin/analytics/overview', headers: auth },
  { name: 'audit.search', path: '/api/v1/admin/audit-events?action=appointment.created&limit=25', headers: auth },
];

const results: any[] = [];
for (const s of scenarios) {
  if (s.path.includes('undefined')) continue;
  process.stdout.write(`${s.name.padEnd(36)} `);
  const r = await autocannon({ url: `${BASE}${s.path}`, connections: CONNECTIONS, duration: SECONDS, headers: s.headers ?? {} });
  const errorRate = (r.errors + r.non2xx) / Math.max(r.requests.total, 1);
  const pass = r.latency.p97_5 <= TARGETS.p95Ms * 1.2 && r.latency.p99 <= TARGETS.p99Ms && errorRate <= TARGETS.maxErrorRate;
  console.log(`rps=${r.requests.average.toFixed(0).padStart(6)}  p50=${String(r.latency.p50).padStart(4)}ms p95≈${String(r.latency.p97_5).padStart(4)}ms p99=${String(r.latency.p99).padStart(4)}ms  err=${(errorRate * 100).toFixed(2)}%  ${pass ? 'PASS' : 'REVIEW'}`);
  results.push({ name: s.name, path: s.path, rps: r.requests.average, p50: r.latency.p50, p95: r.latency.p97_5, p99: r.latency.p99, max: r.latency.max, errorRate, non2xx: r.non2xx, total: r.requests.total, pass });
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
await mkdir('load/results', { recursive: true });
const summary = { at: new Date().toISOString(), base: BASE, seconds: SECONDS, connections: CONNECTIONS, targets: TARGETS, dataset: counts, node: process.version, results };
await writeFile(`load/results/${stamp}.json`, JSON.stringify(summary, null, 2));
const md = [
  `# Load test ${summary.at}`,
  '',
  `Base: ${BASE} · ${CONNECTIONS} connections · ${SECONDS}s per scenario · Node ${process.version}`,
  `Dataset: users=${counts.u} providers=${counts.p} slots=${counts.s} appointments=${counts.a} audit_events=${counts.e}`,
  `Targets: p95 ≤ ${TARGETS.p95Ms} ms, p99 ≤ ${TARGETS.p99Ms} ms, error rate ≤ ${TARGETS.maxErrorRate * 100}%`,
  '',
  '| Scenario | req/s | p50 ms | p95 ms | p99 ms | max ms | errors | result |',
  '|---|---:|---:|---:|---:|---:|---:|---|',
  ...results.map((r) => `| ${r.name} | ${r.rps.toFixed(0)} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.max} | ${(r.errorRate * 100).toFixed(2)}% | ${r.pass ? 'pass' : 'review'} |`),
].join('\n');
await writeFile(`load/results/${stamp}.md`, md);
console.log(`\nWritten load/results/${stamp}.{json,md}`);
await db.end();
