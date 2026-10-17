/**
 * EXPLAIN (ANALYZE, BUFFERS) for the queries behind the hottest endpoints.
 * Flags sequential scans on large tables. Output: load/results/query-plans.md
 *
 *   npx tsx scripts/explain.ts
 */
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';

const db = new pg.Client({ connectionString: process.env.BENCH_DATABASE_URL ?? process.env.DATABASE_URL });
await db.connect();
await db.query('SET statement_timeout = 60000');

const doctor = (await db.query(`SELECT id FROM providers WHERE type = 'DOCTOR' AND status = 'APPROVED' ORDER BY random() LIMIT 1`)).rows[0]?.id;
const user = (await db.query(`SELECT id FROM users ORDER BY random() LIMIT 1`)).rows[0]?.id;
const session = (await db.query(`SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1`)).rows[0]?.id ?? '00000000-0000-7000-8000-000000000000';
const cursorRow = (await db.query(`SELECT created_at, id FROM appointments ORDER BY created_at DESC, id DESC OFFSET 5000 LIMIT 1`)).rows[0];
const specIds = (await db.query(`SELECT array_agg(id) AS ids FROM (SELECT id FROM specialities LIMIT 2) s`)).rows[0]?.ids;

const QUERIES: { name: string; endpoint: string; sql: string; params?: unknown[] }[] = [
  { name: 'session lookup (every authenticated request)', endpoint: 'middleware/auth', sql: `SELECT s.user_id, s.revoked_at, s.expires_at, u.status FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1`, params: [session] },
  { name: 'users list, cursor page', endpoint: 'GET /admin/users', sql: `SELECT * FROM users WHERE (created_at < $1 OR (created_at = $1 AND id < $2)) ORDER BY created_at DESC, id DESC LIMIT 26`, params: [cursorRow?.created_at ?? new Date(), cursorRow?.id ?? user] },
  { name: 'users name search (trigram)', endpoint: 'GET /admin/users?q=', sql: `SELECT * FROM users WHERE full_name ILIKE '%' || $1 || '%' ORDER BY created_at DESC, id DESC LIMIT 26`, params: ['Bench Patient 42'] },
  { name: 'providers by type+status', endpoint: 'GET /admin/providers?type=&status=', sql: `SELECT * FROM providers WHERE type = 'DOCTOR' AND status = 'APPROVED' ORDER BY created_at DESC, id DESC LIMIT 26` },
  { name: 'appointments by status, cursor', endpoint: 'GET /admin/appointments?status=', sql: `SELECT * FROM appointments WHERE status = 'COMPLETED' AND (created_at < $1 OR (created_at = $1 AND id < $2)) ORDER BY created_at DESC, id DESC LIMIT 26`, params: [cursorRow?.created_at ?? new Date(), cursorRow?.id ?? user] },
  { name: 'appointments for a doctor', endpoint: 'GET /portal/.../appointments', sql: `SELECT * FROM appointments WHERE doctor_provider_id = $1 ORDER BY created_at DESC, id DESC LIMIT 26`, params: [doctor] },
  { name: 'open slots for a doctor', endpoint: 'GET /discovery/doctors/:id/slots', sql: `SELECT * FROM appointment_slots WHERE doctor_provider_id = $1 AND status = 'OPEN' AND starts_at >= now() AND starts_at <= now() + interval '14 days' ORDER BY starts_at LIMIT 200`, params: [doctor] },
  { name: 'slot claim (booking concurrency)', endpoint: 'POST /patient/appointments', sql: `SELECT id FROM appointment_slots WHERE id = (SELECT id FROM appointment_slots WHERE doctor_provider_id = $1 AND status = 'OPEN' LIMIT 1) AND status = 'OPEN' AND booked_count < capacity`, params: [doctor] },
  {
    name: 'geo discovery: doctors by speciality within bbox',
    endpoint: 'GET /discovery/search',
    sql: `SELECT p.id FROM providers p JOIN doctor_specialities ds ON ds.doctor_provider_id = p.id AND ds.speciality_id = ANY($1::uuid[])
          JOIN provider_locations l ON l.provider_id = p.id AND l.is_active
          WHERE p.type = 'DOCTOR' AND p.status = 'APPROVED' AND p.is_listed
            AND l.latitude BETWEEN 22.165 AND 22.435 AND l.longitude BETWEEN 87.774 AND 88.066 LIMIT 20`,
    params: [specIds],
  },
  { name: 'commission-eligible transactions', endpoint: 'GET /admin/finance/transactions?commissionEligible=true', sql: `SELECT * FROM service_transactions WHERE commission_eligible = true ORDER BY created_at DESC, id DESC LIMIT 26` },
  { name: 'unsettled ledger per provider', endpoint: 'POST /admin/finance/settlements', sql: `SELECT provider_id, SUM(amount_minor) FROM provider_ledger_entries WHERE settlement_item_id IS NULL AND created_at <= now() GROUP BY provider_id HAVING SUM(amount_minor) > 0` },
  { name: 'audit search by action', endpoint: 'GET /admin/audit-events?action=', sql: `SELECT * FROM audit_events WHERE action = 'appointment.created' ORDER BY occurred_at DESC, id DESC LIMIT 26` },
  { name: 'analytics: appointments by status (30d)', endpoint: 'GET /admin/analytics/overview', sql: `SELECT status, count(*) FROM appointments WHERE created_at >= now() - interval '30 days' AND created_at < now() GROUP BY 1` },
  { name: 'analytics: GTV + commission (30d)', endpoint: 'GET /admin/analytics/overview', sql: `SELECT COALESCE(SUM(t.gross_minor - t.refunded_minor),0), COALESCE(SUM(c.commission_minor),0) FROM service_transactions t LEFT JOIN commission_snapshots c ON c.transaction_id = t.id AND c.status = 'FINAL' WHERE t.service_completed_at >= now() - interval '30 days' AND t.service_completed_at < now()` },
];

const BIG = new Set((await db.query(`SELECT relname FROM pg_stat_user_tables WHERE n_live_tup > 50000`)).rows.map((r) => r.relname as string));
const out: string[] = [`# Query plans — ${new Date().toISOString()}`, '', `Large tables (>50k rows): ${[...BIG].join(', ') || 'none'}`, '', 'Each query is executed twice; the warm (second) plan is shown.', ''];
let flagged = 0;
for (const q of QUERIES) {
  // Run twice and report the warm execution: the first run after a bulk load pays
  // for cold reads and dirty-buffer write-back, which is not steady-state cost.
  await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${q.sql}`, q.params);
  const r = await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${q.sql}`, q.params);
  const plan = r.rows.map((x) => x['QUERY PLAN'] as string).join('\n');
  const seqOnBig = [...BIG].filter((t) => new RegExp(`Seq Scan on ${t}\\b`).test(plan));
  const time = /Execution Time: ([\d.]+) ms/.exec(plan)?.[1];
  if (seqOnBig.length) flagged++;
  out.push(`## ${q.name}`, `Endpoint: \`${q.endpoint}\` · execution ${time} ms${seqOnBig.length ? ` · **SEQ SCAN on ${seqOnBig.join(', ')}**` : ' · index path'}`, '', '```', plan, '```', '');
  console.log(`${(seqOnBig.length ? 'SEQ ' : 'ok  ')}${(time ?? '?').padStart(8)} ms  ${q.name}`);
}
await mkdir('load/results', { recursive: true });
await writeFile('load/results/query-plans.md', out.join('\n'));
console.log(`\n${flagged} quer${flagged === 1 ? 'y' : 'ies'} with sequential scans on large tables. Written load/results/query-plans.md`);
await db.end();
