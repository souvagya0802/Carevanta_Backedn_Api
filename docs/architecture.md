# Architecture

## Shape

A **modular monolith**: one Node.js process serves the HTTP API, a second process runs background jobs, both talk to one PostgreSQL database. Modules live under `src/modules/<domain>/` with `*.routes.ts` (HTTP contract) and `*.service.ts` (business rules); they share `src/lib` (database, errors, money, audit, pagination, crypto, state machines) and `src/middleware` (auth, idempotency, rate limit, errors).

```
clients ──HTTPS──▶ API (Express 5, stateless, N instances)
                     │  pooled connection (Neon pooler)
                     ▼
                PostgreSQL 18 (Neon)  ◀── direct connection ── Worker (pg-boss)
                     ▲                                          notifications, exports,
                private object storage (documents, reports)    credential expiry, cleanup
```

Why not microservices: one small team, one database, and every business transaction (book → pay → complete → commission → ledger) wants a single ACID transaction. Module boundaries are explicit so a module can be extracted later if load or team shape demands it.

## Stack and the reasons

| Choice | Reason |
|---|---|
| Node 22 LTS, TypeScript strict, ESM | Brief requirement; Prisma 7 is ESM-only |
| Express 5 + `defineRoute` | Lightweight; one definition drives validation, auth, idempotency, response envelope and OpenAPI so docs cannot drift |
| Zod 4 | Runtime validation for env, params, query, body; OpenAPI via `@asteasolutions/zod-to-openapi` |
| Prisma 7 + `@prisma/adapter-pg` | Typed queries and migrations; raw SQL where Prisma cannot express it (CHECK/EXCLUDE constraints, triggers, conditional updates, geo) |
| PostgreSQL 18 | UUIDv7 primary keys (`uuidv7()`), partial indexes, EXCLUDE constraints with `btree_gist`, `pg_trgm` search, `citext` emails |
| pg-boss | Durable jobs in the same database — no Redis/queue infrastructure |
| Argon2id, `jose` HS256 | Password hashing and access tokens |
| Pino | Structured JSON logs with redaction |
| Vitest + Supertest + embedded-postgres | Real database in every test run; migrations exercised on each run |

## Request lifecycle

1. `X-Request-Id` assigned (or accepted if well-formed) and stored in `AsyncLocalStorage`; it appears in every log line and audit row.
2. Helmet headers, CORS allow-list, JSON body limit 256 kB (webhooks: raw body 256 kB; uploads: raw body ≤ `MAX_UPLOAD_BYTES`).
3. `authenticate`: verifies the JWT, then loads the session + user status + role permissions **from the database** on every request, so revocation and suspension are immediate. Authorisation data is never embedded in the token.
4. `requirePermissions([...])`: platform RBAC. Provider-scoped resources additionally call `assertProviderAccess` (membership + capability for that exact provider) — IDOR protection. Patients are checked against ownership of the profile/appointment and get 404 (not 403) for other people's records so ids cannot be probed.
5. Optional `idempotency` (`Idempotency-Key` header): stored per user+route+body hash; replays return the stored response; conflicting bodies are rejected; in-flight duplicates get 409.
6. Zod parses params/query/body; handler runs inside a transaction where state changes; response is `{ data }` or `{ data, page }`; errors are `{ error: { code, message, details?, requestId } }`.

## Core invariants and where they are enforced

| Invariant | Enforcement |
|---|---|
| A slot never exceeds capacity | conditional `UPDATE … WHERE booked_count < capacity` (serialised on the row) + CHECK constraint |
| A doctor is never bookable in two places at once | EXCLUDE constraint on `(doctor_provider_id, tstzrange(starts_at, ends_at))` |
| At most one live affiliation per doctor+facility | partial unique index on live statuses |
| Status columns move only along the defined graph | `assertTransition` + optimistic `UPDATE … WHERE status = :from AND version = :v` |
| Money is exact | BigInt minor units, `applyBps` half-up integer rounding, CHECK `provider_net = base − commission − tax` |
| Historical commissions never change | `commission_snapshots` immutable via trigger; new policy versions only affect new transactions |
| Ledger is append-only | trigger forbids UPDATE/DELETE of amounts; corrections are compensating entries; `dedupe_key` makes postings idempotent |
| Maker ≠ checker | CHECK constraints (`approved_by_id <> created_by_id`) + service checks for refunds, settlements, policies, verification, document review, payout accounts, mapping review |
| Payment succeeded only on verified webhook | HMAC-SHA256 over raw body; `(gateway, event_id)` unique; amount/currency mismatch recorded as reconciliation exception, never applied |
| Audit trail cannot be altered | trigger on `audit_events` and `sensitive_access_logs`; metadata redacted before insert |
| Emergency never over-promises | `ambulanceConfirmed` derives only from an ACCEPTED assignment; 112 is in every response; live dispatch off by default |

## Data access patterns

- Lists use keyset pagination `(created_at DESC, id DESC)` with matching composite indexes; no OFFSET.
- Search uses `pg_trgm` GIN indexes on names and Prisma `contains` for the pilot volume; the explain script tracks whether the planner picks them.
- Discovery is one SQL query per result type with a bounding-box prefilter on `(latitude, longitude)` and haversine in SQL; results are capped.
- Reports/analytics are bounded aggregates (≤ 366-day ranges) — never full-table loads into memory.
- Bulk operations are capped (slot generation ≤ 62 days / 5 000 rows, exports ≤ 50 000 rows, reconciliation ≤ 5 000 lines).

## Scalability posture

Stateless API instances behind a load balancer; `DB_POOL_MAX × instances` must stay under the Neon pooler limit. Vertical PostgreSQL headroom covers the pilot and the first expansion. Known next steps, triggered by measurement rather than guesses: shared rate-limit store (Redis) once there are ≥ 2 instances, PostGIS for multi-district radius search, `audit_events` partitioning by month once it passes ~50 M rows, read replica for analytics. See `docs/performance.md` for measured numbers and `docs/database.md` for index rationale.

## Repository layout

```
prisma/schema/*.prisma   domain-split schema      prisma/migrations/   versioned SQL
src/config/env.ts        validated environment    src/lib/             shared infrastructure
src/http/                route layer + OpenAPI     src/middleware/      auth, idempotency, limits, errors
src/modules/<domain>/    routes + services         src/jobs/            scheduled maintenance
src/seed/                reference data            scripts/             bootstrap, openapi, bench, explain
tests/unit, tests/integration                       load/                benchmark harness and results
docs/                    this documentation
```
