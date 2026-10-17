/**
 * Synthetic benchmark dataset, generated inside PostgreSQL with generate_series
 * (orders of magnitude faster than row-by-row inserts). All data is fake.
 *
 *   BENCH_CONFIRM=yes BENCH_SCALE=medium npx tsx scripts/bench-seed.ts
 *
 * Scales (approximate total rows):
 *   small  ≈ 0.2 M   (CI / laptop smoke)
 *   medium ≈ 4 M     (default local benchmark)
 *   large  ≈ 12 M    (10-million-record target; needs a real server)
 *
 * Refuses to run in production or without BENCH_CONFIRM=yes. Never run this
 * against a database that holds real data.
 */
import 'dotenv/config';
import pg from 'pg';

const SCALES = {
  small: { users: 10_000, doctors: 1_000, slotsPerDoctor: 50, appointments: 20_000, audit: 50_000 },
  medium: { users: 100_000, doctors: 10_000, slotsPerDoctor: 100, appointments: 500_000, audit: 1_000_000 },
  large: { users: 1_000_000, doctors: 50_000, slotsPerDoctor: 100, appointments: 2_000_000, audit: 3_000_000 },
} as const;

const scaleName = (process.env.BENCH_SCALE ?? 'medium') as keyof typeof SCALES;
const S = SCALES[scaleName];
if (!S) throw new Error(`Unknown BENCH_SCALE ${scaleName}`);
if (process.env.APP_ENV === 'production') throw new Error('Refusing to seed benchmark data in production');
if (process.env.BENCH_CONFIRM !== 'yes') throw new Error('Set BENCH_CONFIRM=yes to acknowledge this inserts millions of synthetic rows');
const url = process.env.BENCH_DATABASE_URL ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL missing');

const c = new pg.Client({ connectionString: url });
await c.connect();
await c.query('SET statement_timeout = 0');
await c.query("SET synchronous_commit = off");

async function step(name: string, sql: string) {
  const t = Date.now();
  const r = await c.query(sql);
  console.log(`${name.padEnd(28)} ${String(r.rowCount ?? 0).padStart(9)} rows  ${((Date.now() - t) / 1000).toFixed(1)}s`);
}

const existing = await c.query("SELECT count(*)::int AS n FROM users WHERE email LIKE 'bench-%@bench.invalid'");
if (existing.rows[0].n > 0) {
  console.log(`Benchmark data already present (${existing.rows[0].n} users). Delete it first or use a fresh database.`);
  await c.end();
  process.exit(0);
}
const specs = await c.query('SELECT count(*)::int AS n FROM specialities');
if (specs.rows[0].n === 0) throw new Error('Run the reference seed first (npm run db:seed)');

console.log(`Seeding scale=${scaleName}: ${S.users} users, ${S.doctors} doctors, ${S.doctors * S.slotsPerDoctor} slots, ${S.appointments} appointments, ${S.audit} audit events`);
const t0 = Date.now();

await step('users (patients)', `
  INSERT INTO users (email, full_name, status, email_verified_at, updated_at, created_at)
  SELECT 'bench-'||g||'@bench.invalid', 'Bench Patient '||g, 'ACTIVE', now(), now(), now() - (random()*365)*interval '1 day'
  FROM generate_series(1, ${S.users}) g`);

await step('patient_profiles', `
  INSERT INTO patient_profiles (account_user_id, full_name, relationship, updated_at)
  SELECT id, full_name, 'SELF', now() FROM users WHERE email LIKE 'bench-%@bench.invalid'`);

await step('doctor users', `
  INSERT INTO users (email, full_name, status, email_verified_at, updated_at)
  SELECT 'bench-dr-'||g||'@bench.invalid', 'Dr Bench '||g, 'ACTIVE', now(), now() FROM generate_series(1, ${S.doctors}) g`);

await step('doctor providers', `
  INSERT INTO providers (type, status, legal_name, display_name, slug, is_listed, approved_at, updated_at, created_at)
  SELECT 'DOCTOR', 'APPROVED', 'Dr Bench '||g, 'Dr Bench '||g, 'bench-doctor-'||g, true, now(), now(), now() - (random()*365)*interval '1 day'
  FROM generate_series(1, ${S.doctors}) g`);

await c.query(`CREATE TEMP TABLE bench_doctors AS
  SELECT row_number() OVER (ORDER BY p.slug) AS n, p.id AS provider_id, u.id AS user_id
  FROM providers p JOIN users u ON u.email = replace(p.slug, 'bench-doctor-', 'bench-dr-')||'@bench.invalid'
  WHERE p.slug LIKE 'bench-doctor-%'`);
await c.query('CREATE INDEX ON bench_doctors (n)');

await step('doctor_profiles', `
  INSERT INTO doctor_profiles (provider_id, user_id, default_fee_minor, updated_at)
  SELECT provider_id, user_id, 30000 + (n % 10) * 5000, now() FROM bench_doctors`);

await step('doctor_specialities', `
  INSERT INTO doctor_specialities (doctor_provider_id, speciality_id, is_primary, verified)
  SELECT d.provider_id, s.id, true, true
  FROM bench_doctors d JOIN (SELECT id, row_number() OVER (ORDER BY code) - 1 AS k, count(*) OVER () AS total FROM specialities WHERE is_active) s
    ON s.k = (d.n % s.total)`);

// Doctors spread over a ~60 km box around Tamluk so radius searches have realistic selectivity.
await step('provider_locations', `
  INSERT INTO provider_locations (provider_id, name, address_line1, city, district, state, pincode, latitude, longitude, is_primary, updated_at)
  SELECT provider_id, 'Chamber', 'Bench Road '||n, CASE WHEN n % 2 = 0 THEN 'Tamluk' ELSE 'Moyna' END, 'Purba Medinipur', 'West Bengal',
         '7216'||lpad(((n % 90) + 10)::text, 2, '0'), 22.30 + (random() - 0.5) * 0.6, 87.92 + (random() - 0.5) * 0.6, true, now()
  FROM bench_doctors`);

await c.query(`CREATE TEMP TABLE bench_locations AS SELECT d.n, d.provider_id, l.id AS location_id FROM bench_doctors d JOIN provider_locations l ON l.provider_id = d.provider_id`);
await c.query('CREATE INDEX ON bench_locations (n)');

const totalSlots = S.doctors * S.slotsPerDoctor;
await step('appointment_slots', `
  INSERT INTO appointment_slots (doctor_provider_id, location_id, starts_at, ends_at, capacity, booked_count, status, fee_minor, updated_at)
  SELECT l.provider_id, l.location_id,
         ts, ts + interval '30 minutes', 1, 0, 'OPEN', 40000, now()
  FROM generate_series(1, ${totalSlots}) g
  JOIN bench_locations l ON l.n = ((g - 1) % ${S.doctors}) + 1
  CROSS JOIN LATERAL (SELECT date_trunc('hour', now()) - interval '60 days' + (((g - 1) / ${S.doctors}) * interval '30 minutes') * 1 + (((g - 1) / ${S.doctors}) / 16) * interval '16 hours' AS ts) t`);

await c.query(`CREATE TEMP TABLE bench_slots AS SELECT row_number() OVER (ORDER BY id) AS n, id, doctor_provider_id, location_id, starts_at FROM appointment_slots WHERE fee_minor = 40000 AND status = 'OPEN'`);
await c.query('CREATE INDEX ON bench_slots (n)');
await c.query(`CREATE TEMP TABLE bench_patients AS SELECT row_number() OVER (ORDER BY id) AS n, id, account_user_id FROM patient_profiles WHERE full_name LIKE 'Bench Patient %'`);
await c.query('CREATE INDEX ON bench_patients (n)');

await step('appointments', `
  INSERT INTO appointments (reference, patient_profile_id, booked_by_user_id, doctor_provider_id, facility_provider_id, location_id, slot_id, status, source, attribution, fee_minor, confirmed_at, completed_at, updated_at, created_at)
  SELECT 'BEN-'||lpad(g::text, 10, '0'), p.id, p.account_user_id, s.doctor_provider_id, s.doctor_provider_id, s.location_id, s.id,
         st.status, 'PATIENT_APP', (CASE WHEN g % 10 = 0 THEN 'PROVIDER_DIRECT' ELSE 'PLATFORM' END)::"Attribution", 40000,
         CASE WHEN st.status IN ('CONFIRMED','COMPLETED','NO_SHOW') THEN s.starts_at - interval '1 day' END,
         CASE WHEN st.status = 'COMPLETED' THEN s.starts_at + interval '20 minutes' END,
         now(), s.starts_at - interval '2 days'
  FROM generate_series(1, ${Math.min(S.appointments, totalSlots)}) g
  JOIN bench_slots s ON s.n = g
  JOIN bench_patients p ON p.n = ((g::bigint * 7919) % ${S.users}) + 1
  CROSS JOIN LATERAL (SELECT (ARRAY['COMPLETED','COMPLETED','COMPLETED','COMPLETED','COMPLETED','CONFIRMED','CONFIRMED','CANCELLED_BY_PATIENT','REQUESTED','NO_SHOW'])[(g % 10) + 1]::"AppointmentStatus" AS status) st`);

await step('slot booked_count', `
  UPDATE appointment_slots s SET booked_count = 1 FROM appointments a
  WHERE a.slot_id = s.id AND a.status IN ('REQUESTED','CONFIRMED') AND a.reference LIKE 'BEN-%'`);

await step('service_transactions', `
  INSERT INTO service_transactions (reference, source_type, appointment_id, provider_id, patient_profile_id, category, gross_minor, status, attribution, commission_eligible, eligibility_reason, service_completed_at, updated_at, created_at)
  SELECT 'TBN-'||lpad(row_number() OVER ()::text, 10, '0'), 'APPOINTMENT', a.id, a.facility_provider_id, a.patient_profile_id, 'CONSULTATION', a.fee_minor,
         CASE WHEN a.status = 'COMPLETED' THEN 'PAID'::"TransactionStatus" WHEN a.status::text LIKE 'CANCELLED%' THEN 'CANCELLED' ELSE 'PENDING_PAYMENT' END,
         a.attribution, a.status = 'COMPLETED' AND a.attribution = 'PLATFORM', 'bench', a.completed_at, now(), a.created_at
  FROM appointments a WHERE a.reference LIKE 'BEN-%'`);

await step('ledger entries', `
  INSERT INTO provider_ledger_entries (provider_id, transaction_id, entry_type, amount_minor, dedupe_key, created_at)
  SELECT t.provider_id, t.id, e.entry_type::"LedgerEntryType", e.amount, e.prefix||t.id, t.service_completed_at
  FROM service_transactions t
  CROSS JOIN LATERAL (VALUES ('SERVICE_EARNING', t.gross_minor, 'earning:'), ('COMMISSION', -(t.gross_minor / 10), 'commission:')) AS e(entry_type, amount, prefix)
  WHERE t.reference LIKE 'TBN-%' AND t.status = 'PAID' AND t.commission_eligible`);

await step('audit_events', `
  INSERT INTO audit_events (occurred_at, actor_user_id, actor_type, action, entity_type, entity_id, outcome)
  SELECT now() - (random()*180)*interval '1 day', NULL, 'SYSTEM',
         (ARRAY['auth.login','appointment.created','appointment.confirm','provider.updated','access.denied','settings.changed'])[(g % 6) + 1],
         (ARRAY['user','appointment','appointment','provider','endpoint','platform_setting'])[(g % 6) + 1], 'bench-'||g, 'SUCCESS'
  FROM generate_series(1, ${S.audit}) g`);

await step('ANALYZE', 'ANALYZE');
const sizes = await c.query(`SELECT relname, n_live_tup FROM pg_stat_user_tables WHERE n_live_tup > 1000 ORDER BY n_live_tup DESC`);
console.table(sizes.rows);
console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
await c.end();
