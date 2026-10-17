# Engineering handover — Carevanta backend foundation and super-admin dashboard

Date: 2026-10-17 · Repositories: `Carevanta_Backedn_Api` (API, worker, schema, docs, benchmarks) and `Carevanta_Super_Admin_Dashboard` (Next.js admin). Nothing has been committed to git yet; both working trees are complete and ready to commit.

## 1. What was implemented

**Backend (Node 22 · TypeScript strict · Express 5 · Prisma 7.10.1 · PostgreSQL 18 on Neon · pg-boss)** — a modular monolith with 17 modules:

| Module | Delivered |
|---|---|
| Auth | Argon2id, 15-min JWT + 30-day rotating refresh tokens with reuse detection, lockout, reset/verify flows, patient self-registration, session management |
| Access | 62 permissions, 10 system roles (maker/checker separated), custom roles, anti-escalation rules, provider-scoped capabilities |
| Users | search, invite (never sets passwords), status, unlock, session revocation, role grants with history, activity, anonymisation with legal-hold check |
| Providers | all 7 types with type-specific profiles, locations/hours/service areas, staff, documents (magic-byte checked, private storage, purpose-logged access), payout accounts (AES-256-GCM), departments/amenities with verifiable claims, status machine |
| Verification | cases with per-check status/method/evidence, assignment, maker≠checker, approval blocked until required checks pass, renewal cases, nightly credential-expiry enforcement |
| Affiliations | one doctor identity ↔ many facilities, invite/request/accept/verify/suspend/end state machine, portal endpoints for both sides |
| Catalogue | specialities, conditions/symptoms (red flags), clinically reviewed condition→speciality mappings, departments, amenities, services/tests, provider pricing, medicines with schedules |
| Discovery | public condition search with distance filtering, APPROVED mappings only, emergency guidance first for red flags; public open-slot listing |
| Scheduling & bookings | weekly schedules, IST slot generation, DB-level no-overlap, atomic capacity claims, idempotent booking, explicit lifecycle, reschedule, walk-ins, family profiles |
| Finance | effective-dated commission policies (legal gate for surgery/procedures, production requires legal approval), simulated + Razorpay gateway, HMAC-verified webhooks with dedupe and mismatch quarantine, maker-checker refunds, immutable commission snapshots, append-only ledger, settlement batches with UTR evidence and retry, reconciliation runs |
| Diagnostics | orders with coverage/prescription rules, lifecycle, versioned report publishing, patient and purpose-logged admin access |
| Pharmacy | batch/expiry inventory, FEFO reservations with release, pharmacist prescription review, scheduled-drug enforcement |
| Ambulance | operators, vehicles (document validity gates), crew, dispatch with operator-only acceptance, phone-confirmation path, escalation, TEST drills, 112-first responses, live dispatch off by default |
| Support / platform | cases with SLA, timeline and notes; settings with reasons and optimistic locking; audit search; sensitive-access log; notifications outbox + templates; regions; legal holds; incidents |
| Analytics / exports | overview counters, time series, geography, demand; CSV exports (bounded, expiring, download-logged) |
| Worker | notification delivery, exports, credential expiry, renewal reminders, cleanup, auto no-show |

**Dashboard (Next.js 16 · React 19 · Tailwind 4 · TanStack Query/Table · RHF + Zod · Recharts)** — 25 routes covering all 26 required navigation areas, permission-filtered navigation and page gates, real API calls everywhere, cursor-paginated tables, validated forms with server error mapping, confirmation dialogs, loading/empty/error states, monochrome charts, purpose-prompted downloads.

## 2. Architecture and schema summary

See `docs/architecture.md` and `docs/database.md`. Highlights: single PostgreSQL database with UUIDv7 keys; ~70 models across 6 schema files; integrity that Prisma cannot express lives in SQL migrations (CHECK, two EXCLUDE constraints, scope-key trigger, append-only/immutability triggers); money is BigInt minor units; every list is keyset-paginated with a matching composite index.

## 3. APIs completed

238 operations / 198 paths under `/api/v1`, generated into `docs/openapi.json` and served at `/docs`. Catalogue and curl walkthrough in `docs/api.md`. Portal (`/portal/*`) and patient (`/patient/*`) endpoints exist for the future provider portals and mobile apps.

## 4. Admin features completed

All navigation areas from the brief: overview dashboard (welcome banner, colourful KPI cards, revenue bars, live activity feed, quick actions, pending-action tiles, stacked status charts), user management, doctors/hospitals/clinics/labs/imaging/pharmacies/ambulance, provider applications and credential verification, affiliations, departments/specialities/services/medicines, appointments, pharmacy orders, diagnostic orders and reports, dispatch, payments and refunds, commission rules (with preview calculator), settlements, complaints, notifications, reports and exports, roles and permissions, audit logs, platform settings (+ branding with configurable logo, SMTP email configuration with test send, regions, legal holds, incidents). README in the dashboard repo.

## 5. Migrations created

| Migration | Content |
|---|---|
| `20261017000000_init` | complete schema (82 tables, enums, indexes, extensions) |
| `20261017000100_integrity_constraints` | CHECK/EXCLUDE constraints, triggers, maker-checker checks |
| `20261017000200_completed_at_index` | widened completion-time index found via query-plan review |
| `20261017000300_slot_starts_at_index` | `appointment_slots(starts_at)` for time-window reports, found via load test |

Applied to Neon (`prisma migrate status`: up to date) together with the reference seed (24 specialities, 20 conditions with pending clinical mappings, 14 departments, 14 amenities, 12 services, 8 templates, 7 settings, 2 pilot regions). No user accounts exist on Neon; create the first super-admin with `npm run admin:bootstrap` (prints a one-time token; never a password).

## 6. Tests actually executed

| Suite | Command | Result |
|---|---|---|
| Backend type-check | `npm run typecheck` | pass (TypeScript 6.0) |
| Backend lint | `npm run lint` | pass |
| Backend tests (unit + integration on embedded PostgreSQL 18, migrations applied from empty DB each run) | `npm test` | **11 files, 113 tests passed** (164 s) |
| Backend build | `npm run build` | pass |
| Schema drift (`migrate diff` DB vs schema after deploy) | manual | empty |
| Dashboard type-check / lint | `npm run typecheck`, `npm run lint` | pass (2 React-Compiler library warnings) |
| Dashboard tests (Vitest + Testing Library) | `npm test` | **4 files, 14 tests passed** |
| Dashboard build | `npm run build` | pass, 25 routes |

Details and scenario coverage in `docs/testing.md`. Not run: live Razorpay sandbox (simulated gateway used), SMS/email providers (log driver), browser end-to-end tests.

## 7. Performance

Measured with the reproducible harness (`node load/local-bench.mjs`): embedded PostgreSQL 18, ~3.6 M synthetic rows (1 M slots, 500 k appointments, 500 k transactions, 1 M audit events, 110 k users), autocannon at 25 connections, EXPLAIN ANALYZE on 14 critical queries. Result: 10 of 11 scenarios within p95 ≤ 250–300 ms / p99 ≤ 600 ms with 0 % errors; `auth.me` p95 313 ms (fix identified: single-query session lookup); all request-path queries on index plans. Four schema/code fixes came out of the measurements (two indexes, search predicate, analytics cache). Numbers, methodology, invalid runs and limitations are in `docs/performance.md`. This is a single-laptop measurement, not a production capacity claim.

## 8. Security measures

`docs/security.md` has the threat model and pre-production checklist. Implemented: Argon2id, short-lived tokens with server-side session checks, rotation/reuse detection, lockout, RBAC + object-level checks, maker-checker, HMAC webhooks, idempotency, append-only audit, redaction, encrypted bank data, magic-byte upload checks, private file storage with purpose logging, body/time limits, rate limits (`RATE_LIMIT_ENABLED` cannot be false in production), fail-fast env validation. `npm audit`: backend — 3 moderate findings all inside the dev-only load tool `autocannon`; dashboard — 5 high findings all in the dev-only `eslint-config-next` → `braces` chain (no runtime exposure; upstream fix pending).

## 9. Environment, setup and deployment

`docs/operations.md`: local setup, env reference (`.env.example`), bootstrap, deployment order (migrate → API → one worker), Neon pooling, logging/alerting, backups and restore drills, incident response, scheduled jobs. **Rotate the Neon password before any real data** — it was shared in the brief.

## 10. Known gaps and required decisions

Open business/legal questions Q1–Q15 are in `docs/requirements.md` §4 and the compliance register in `docs/compliance.md`. The most consequential: NMC referral-commission rules for surgery/procedures (policies are blocked until counsel approves), RBI payment-aggregator status of platform-collected money (consider Razorpay Route), GST treatment, Neon region (us-east-2 today), DPDP retention periods, pharmacy delivery of Schedule H medicines.

Technical gaps: no MFA; local storage driver (swap for object storage); per-instance rate limiting (shared store needed at ≥2 instances); notification log driver (plug SMS/email providers); no invoice PDFs; no telemedicine/ABDM; PostGIS deferred; audit partitioning deferred until measured.

## 11. Next recommended phase

1. Commit both repos; set up CI (typecheck, lint, test, build, `openapi:generate` diff check).
2. Resolve launch blockers above; create the super-admin; onboard the first Moyna/Tamluk providers through the dashboard.
3. Provider portals (`Carevanta_Provider_Frontend`) against `/portal/*`, then the patient app (Flutter) against `/patient/*` and `/discovery/*`.
4. Revisit `docs/performance.md` once real traffic exists; promote the deferred scale items only on measurement.
