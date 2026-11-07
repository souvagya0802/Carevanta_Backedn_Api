# Performance: benchmark method, measurements and limitations

> **Historical.** These measurements were taken on PostgreSQL 18 before the 2026-11-07 move to MongoDB Atlas. The PostgreSQL benchmark scripts (`bench-seed`, `bench-run`, `explain`) were removed with the migration; the harness must be rebuilt against MongoDB before new numbers are claimed. Nothing in this file should be quoted as a MongoDB result.

**Summary.** On a developer laptop with a 3.6-million-row synthetic dataset, 10 of 11 HTTP scenarios met the agreed targets (p95 ≤ 250 ms, p99 ≤ 600 ms, error rate ≤ 0.1 %) at 25 concurrent connections, and all 14 critical queries use index paths except one that is correctly a sequential scan for this dataset. This is **not** a production capacity statement: the environment, dataset shape and single-instance setup are described below so the numbers can be interpreted, and the harness is reproducible so they can be re-measured on real infrastructure.

## Workload assumptions

| Dimension | Pilot (Moyna + Tamluk) | 12-month target used for design |
|---|---|---|
| Patients | ≤ 20 000 | 1 M users |
| Providers | ≤ 200 | 50 k |
| Appointments | ≤ 500 / day | 2 M rows / year |
| Slots | ≤ 20 000 open at a time | 5 M rows |
| Audit events | ≤ 50 k / month | 3 M rows / year |
| Peak API load | < 5 req/s | 100–300 req/s on 2–3 instances |

"10 million records" in the brief is a database-size target (rows across tables), not 10 million concurrent users; the `large` seed profile (≈ 12 M rows) exists for a server-class run.

## Harness (reproducible)

`node load/local-bench.mjs` (`BENCH_SCALE=small|medium|large`, `BENCH_SECONDS`, `BENCH_CONNECTIONS`):

1. starts an embedded PostgreSQL 18 on a unique port (same major version as Neon), applies all migrations with `prisma migrate deploy`, seeds reference data;
2. `scripts/bench-seed.ts` generates synthetic data **inside PostgreSQL** with `generate_series` (no real data; fake names, `*.bench.invalid` emails);
3. starts the API (`tsx src/server.ts`, `RATE_LIMIT_ENABLED=false` because a single-IP load generator would otherwise be throttled — production refuses that setting);
4. `scripts/bench-run.ts` runs autocannon scenarios and writes `load/results/<timestamp>.{json,md}`;
5. `scripts/explain.ts` runs `EXPLAIN (ANALYZE, BUFFERS)` twice per critical query (reporting the warm run) and flags sequential scans on tables > 50 k rows into `load/results/query-plans.md`.

## Environment of the recorded run (2026-10-17 08:15 UTC)

Windows 11 laptop, 8 logical cores, 16 GB RAM; PostgreSQL 18.4 embedded (`shared_buffers=512MB`, `fsync=off` — faster than production disks) running on the same machine as the API and the load generator; API executed through `tsx` (TypeScript transpiled on the fly, slower than the compiled `dist/` build); Node 22.23; one API instance; 25 connections, 15 s per scenario.

Dataset (`medium`): 110 001 users · 10 000 approved doctors with locations around Tamluk/Moyna · 1 000 000 slots · 500 000 appointments (50 % completed, 20 % confirmed, 15 % cancelled, 10 % requested, 5 % no-show) · 500 000 transactions · 400 000 ledger entries · 1 000 001 audit events — ≈ 3.6 M rows, seeded in 229 s.

## HTTP results

| Scenario | req/s | p50 | p95 | p99 | max | errors | vs target |
|---|---:|---:|---:|---:|---:|---:|---|
| `GET /auth/me` (session validation path used by every authenticated request) | 147 | 150 | **313** | 408 | 1017 | 0 % | review |
| `GET /admin/users` cursor page | 154 | 151 | 277 | 348 | 382 | 0 % | pass (p95 slightly over, p99 within) |
| `GET /admin/users?q=` trigram name search | 150 | 157 | 246 | 313 | 348 | 0 % | pass |
| `GET /admin/providers?type=&status=` | 176 | 139 | 188 | 211 | 245 | 0 % | pass |
| `GET /admin/verification-cases` queue | 185 | 129 | 227 | 247 | 317 | 0 % | pass |
| `GET /discovery/search` condition + radius (public) | 388 | 59 | 114 | 140 | 221 | 0 % | pass |
| `GET /discovery/doctors/:id/slots` (public) | 356 | 66 | 96 | 138 | 200 | 0 % | pass |
| `GET /admin/appointments?status=` | 117 | 209 | 278 | 320 | 343 | 0 % | pass |
| `GET /admin/finance/transactions?commissionEligible=true` | 167 | 145 | 225 | 288 | 360 | 0 % | pass |
| `GET /admin/analytics/overview` (15 aggregates, 30-day window) | 243 | 90 | 152 | 226 | 1498 | 0 % | pass (cache; first fill ≈ 1.5 s) |
| `GET /admin/audit-events?action=` | 187 | 128 | 194 | 212 | 248 | 0 % | pass |

The harness marks a scenario "pass" when p97.5 ≤ 300 ms, p99 ≤ 600 ms and errors ≤ 0.1 %; the table above also shows the stricter 250 ms p95 target for transparency.

Throughput is bounded by the laptop (API, PostgreSQL and the load generator share 8 cores). Per-request latency under this concurrency is dominated by Node CPU (JSON, Prisma query building, `tsx` transpile overhead), not by the database: the matching SQL plans execute in well under 20 ms (next section).

### The one review item: `auth.me`

The database side is 0.09 ms (unique index on `sessions.id`). The cost is in Prisma issuing several round-trips for the nested include (session → user → active roles → role permissions → permissions) on **every** authenticated request, followed by the `/me` handler's own query. Recommended fix before scale-out: replace `loadAuthContext` with one SQL statement that returns the session, user status and the permission list (`array_agg`), cutting 5–6 round-trips to 1. Revocation stays immediate because the lookup still happens per request. (Caching the auth context would also work but would delay suspension/revocation by the cache TTL and is therefore not recommended.)

## Query-plan review (warm execution)

| Query | ms | Plan |
|---|---:|---|
| session lookup | 0.09 | index |
| users cursor page | 17.0 | index (`created_at DESC, id DESC`) |
| users trigram search | 7.8 | GIN trigram |
| providers by type + status | 0.08 | composite index |
| appointments by status, cursor (page 200) | 5.1 | index; a cold run right after bulk load was 1 752 ms — write-back of dirty buffers, not a plan problem |
| appointments for a doctor | 0.05 | index |
| open slots for a doctor | 0.04 | partial index |
| slot claim | 0.06 | primary key |
| geo discovery (bbox + speciality) | 1.0 | index on `(latitude, longitude)` + speciality join |
| commission-eligible transactions | 0.12 | index |
| **unsettled ledger per provider** | 149 | **seq scan** — correct for this dataset: 100 % of the 400 k entries are unsettled, so the partial index `WHERE settlement_item_id IS NULL` covers the whole table and the planner rightly scans. In production, settled entries dominate and the partial index becomes selective. Settlement batching is a daily back-office job, not a request path. |
| audit search by action | 0.10 | index |
| analytics: appointments by status (30 d) | 0.06 | index |
| analytics: GTV + commission (30 d) | 0.05 | index (**fixed** — see below) |

## Changes made because of the measurements

1. `20261017000200_completed_at_index` — the GTV/commission aggregate filtered on `service_completed_at` without `commission_eligible`, so the original partial index was unusable (591 ms seq scan over 500 k rows); widened the index.
2. `20261017000300_slot_starts_at_index` — the "appointments today" aggregate joined 500 k appointments to 1 M slots by time with no `starts_at` index (overview p50 5.1 s → 0.98 s before caching).
3. User search now matches **one** field inferred from the query (email if it contains `@`, phone if digits, else name): the previous `OR` over three `contains` clauses forced email/phone scans on every name search (p95 793 ms → 246 ms).
4. 30-second in-process TTL cache for analytics overview/series (p95 1 621 ms → 152 ms; first fill still pays ≈ 1.5 s).
5. `RATE_LIMIT_ENABLED` switch (production refuses `false`) — the first recorded run was invalid because the per-IP limiter rejected ~100 % of load-generator requests.

Two further runs were discarded as invalid: one where a PostgreSQL process from a crashed run blocked `initdb` (Windows shared-memory key), and one where a leftover API server on port 4100 answered the load instead of the freshly started one. The harness now uses unique ports and data directories per run and cleans up after itself.

## Limitations and extrapolation risks

- Single machine, single API instance, PostgreSQL without network latency and with `fsync=off`: production Neon adds ~1–3 ms per round-trip and real fsync; the pooled connection adds PgBouncer hops. Expect higher absolute latencies but the same plan shapes.
- `tsx` dev runtime: the compiled build is faster; re-run against `node dist/src/server.js`.
- Dataset shape: slots and appointments are concentrated in a 10-day window, 50 % completion; real data is spread over time, which generally makes time-window indexes *more* selective.
- 3.6 M rows measured; the 10 M-row `large` profile has not been run on this machine (seed alone would take ~15 min and the laptop's disk is the bottleneck). Nothing in the plans is O(n) on the request path, so growth should affect cold-cache I/O rather than CPU, but that is a projection until measured.
- Write-path concurrency (booking the same slot, settlement batching, webhook duplicates) is verified by the integration tests, not by this load run.

## What to do next (by measurement, in order)

1. Compile the API (`npm run build`) and re-run the harness against `dist/` on the target host; record results in `load/results/`.
2. Implement the single-query `loadAuthContext` and re-measure `auth.me`.
3. Run `BENCH_SCALE=large` on a server with ≥ 32 GB RAM and SSD; compare plan shapes.
4. When ≥ 2 API instances exist, move rate limiting to a shared store or the edge.
5. Revisit PostGIS when discovery spans multiple districts (bbox + haversine stays under 1 ms at 10 k providers today).
6. Consider monthly partitioning of `audit_events` beyond ~50 M rows and archiving per the retention policy.
