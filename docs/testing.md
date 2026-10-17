# Test strategy and results

## Approach

- **Real database in every test.** `tests/global-setup.ts` starts an embedded PostgreSQL 18 (same major as Neon) on port 54331, creates an empty database, applies the committed migrations with `prisma migrate deploy`, runs the reference seed twice (proving idempotency), and tears everything down. Tests refuse to run unless `DATABASE_URL` points at that local database, so they can never touch Neon.
- **Integration tests through HTTP** (Supertest) exercise validation, auth, permissions, transactions, constraints and audit together — the way clients will use the API. Unit tests cover pure logic (money, commission maths, redaction, encryption, state machines, cursors, IST time, upload validation).
- **Concurrency is tested for real**: parallel bookings on one slot, parallel refresh-token use, parallel affiliation invites, parallel login failures, parallel settlement batch creation.
- **Synthetic data only**: fake names, `*.test.carevanta.local` emails, `98000xxxxx` numbers, `%PDF-` stub files.

## Layout

```
tests/unit/money.test.ts         rounding, commission invariants (exhaustive sweep), JSON money helpers
tests/unit/security.test.ts      redaction, AES-GCM, constant-time compare, state machines, uploads, cursors, IST, password policy, role separation
tests/integration/auth.test.ts            login, lockout (incl. concurrent), tokens, rotation/reuse, reset, registration/OTP, pending accounts
tests/integration/users-roles.test.ts     user admin, pagination, permission enforcement, escalation protections, audit immutability, anonymisation
tests/integration/providers.test.ts       all provider types, validation, doctor dedupe, optimistic concurrency, verification workflow, SoD, documents, payout accounts, IDOR
tests/integration/affiliations.test.ts    multi-facility doctor, duplicate/concurrent invites, side restrictions, verification preconditions, transitions
tests/integration/discovery.test.ts       reviewed mappings only, relevance (no eye hospital for liver), distance, suspension, red flags
tests/integration/bookings.test.ts        IST slot generation, EXCLUDE overlap, schedule rights, booking, concurrency (cap 1 and 3), idempotency, IDOR, lifecycle, cancel/release, reschedule, walk-in
tests/integration/finance.test.ts         policies (maker-checker, overlap, legal gate), webhooks (forged/mismatch/duplicate/failed), completion → snapshot → ledger, policy change immutability, walk-in exclusion, refunds, settlements, reconciliation
tests/integration/operations.test.ts      diagnostics (coverage, report versions, access), pharmacy (FEFO, prescriptions, release), dispatch (112, acceptance, vehicle state, drills), support, settings, audit, exports
tests/integration/maintenance.test.ts     credential expiry, renewal reminders, cleanup, seed idempotency
```

## Commands and last results (2026-10-17, Windows 11, Node 22.23)

| Command | Result |
|---|---|
| `npm run typecheck` | pass (TypeScript 6.0, strict) |
| `npm run lint` | pass (0 problems) |
| `npm test` | **11 files, 113 tests passed** (99–164 s depending on machine load; includes migration from empty DB + seed) |
| `npm run build` | pass; `dist/` imports cleanly |
| `npm run openapi:generate` | 198 paths, 238 operations |
| `prisma migrate deploy` on Neon | 4 migrations applied, status up to date |
| `prisma migrate diff` (DB vs schema) after deploy | empty migration (no drift) |

## Coverage of the brief's required scenarios

| Scenario group | Covered | Not yet |
|---|---|---|
| Authentication & permissions | valid/invalid login, expired/revoked session, wrong password, lockout + recovery, missing auth, insufficient permission, escalation attempts, object-level violations, suspended access | MFA (not implemented) |
| Providers | valid registration, missing fields, duplicates, invalid credentials data, all states, unauthorised approval, multi-facility doctor, duplicate/concurrent affiliations, invalid transitions | government API integration (none exists) |
| Bookings | success, invalid slot, provider unavailable, double booking, concurrent same slot, invalid transitions, repeated cancel, idempotent retries, rejection (reason required), reschedule conflicts, attribution/eligibility | provider-initiated rejection flow end-to-end in portal (covered via admin) |
| Finance | commission calc, effective-date change, refund calc, duplicate webhook, invalid signature, failure, mismatch, settlement retry, duplicate settlement prevention, rounding edge cases (exhaustive sweep) | live Razorpay sandbox (simulated gateway used) |
| Database & performance | migration from empty DB, seed reruns, referential integrity, unique constraints, cursor pagination, search, concurrent writes | query-plan assertions are in the benchmark script, not unit tests; connection-failure recovery tested manually only |
| Admin UI | — | see the dashboard repository's test suite |

## Running

```bash
npm test                      # everything
npm run test:unit
npm run test:integration
npx vitest run tests/integration/finance.test.ts   # one file
```

The first run downloads the PostgreSQL binaries (~30 MB) via `embedded-postgres`. On Windows the data directory is `.tmp/pg-test` and is recreated each run.
