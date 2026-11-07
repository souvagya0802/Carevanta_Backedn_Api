# Carevanta API

Backend for Carevanta, a verified healthcare marketplace for India (patients ↔ doctors, hospitals and clinics, laboratories and imaging centres, pharmacies, ambulance operators). Pilot: Moyna and Tamluk, Purba Medinipur, West Bengal. Revenue is commission on eligible completed transactions — modelled as effective-dated policies with a legal-review gate.

Node 22 · TypeScript (strict, ESM) · Express 5 · Prisma 6 (MongoDB connector) · MongoDB 8 (Atlas) · Vitest.

## Quick start

```bash
npm install
cp .env.example .env            # set MONGODB_URI, JWT_SECRET, DATA_ENCRYPTION_KEY
npm run db:sync                 # create every index (also done automatically at API start)
npm run db:seed
BOOTSTRAP_ADMIN_EMAIL=you@example.com npm run admin:bootstrap
npm run dev                      # http://localhost:4000/docs
```

Tests need no database install (an in-memory MongoDB replica set is downloaded once):

```bash
npm run typecheck && npm run lint && npm test
```

## Demo Logins

All demo accounts (Super Admin, one per provider type, patient) with passwords and what data each one sees: see [Carevanta_Backedn_Api/docs/demo-logins.md](docs/demo-logins.md). Development only.

## What is here

- `/api/v1` — 203 documented operations: auth, users/roles, providers + verification, catalogue + clinical review, public discovery, affiliations, scheduling/bookings, finance (policies, payments, refunds, ledger, settlements, reconciliation), diagnostics, pharmacy, ambulance dispatch, support, settings, audit, compliance, analytics, exports; portal endpoints for providers and patient-app endpoints.
- `prisma/` — multi-file MongoDB schema and reference seed; partial unique indexes live in `src/lib/mongo-indexes.ts`.
- `src/worker.ts` — notifications, exports, credential expiry, renewal reminders, cleanup, auto no-show.
- `scripts/` — super-admin bootstrap, OpenAPI generation, benchmark seeding/runner, query-plan review.
- `docs/` — [requirements & open questions](docs/requirements.md) · [architecture](docs/architecture.md) · [database](docs/database.md) · [API guide](docs/api.md) · [security](docs/security.md) · [compliance](docs/compliance.md) · [operations](docs/operations.md) · [testing](docs/testing.md) · [performance](docs/performance.md) · [roadmap](docs/roadmap.md) · [handover](docs/handover.md).

## Non-negotiables built in

Money is integer minor units; payments confirm only via signed webhooks; commissions are frozen per transaction; the ledger and audit log are append-only; maker ≠ checker on every financial and verification decision; provider data is scoped per organisation; emergency responses always show 112 first and never claim an ambulance before an operator accepts; condition search uses clinically reviewed mappings and is never presented as a diagnosis.

## Secrets

Never commit `.env`. The database credential shared during project setup must be rotated before production use.
