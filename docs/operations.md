# Operations runbook

## Local setup

```bash
npm install                    # .npmrc sets legacy-peer-deps (npm 10 peer-resolution bug)
cp .env.example .env           # fill DATABASE_URL, DIRECT_URL, JWT_SECRET, DATA_ENCRYPTION_KEY
npm run db:migrate:deploy      # apply committed migrations (uses DIRECT_URL)
npm run db:seed                # idempotent reference data (roles, specialities, templates, settings)
BOOTSTRAP_ADMIN_EMAIL=you@example.com npm run admin:bootstrap   # prints a one-time set-password token
npm run dev                    # API on :4000, Swagger at /docs
npm run dev:worker             # background jobs (optional locally; JOBS_ENABLED=false runs exports inline)
```

Generate secrets: `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"` (JWT) and `randomBytes(32)` (encryption key).

No PostgreSQL install is needed for tests or benchmarks: they start an embedded PostgreSQL 18.

## Environment variables

See `.env.example` for the full list with comments. Required: `DATABASE_URL`, `JWT_SECRET` (≥ 32 chars), `DATA_ENCRYPTION_KEY` (32 bytes base64). Production additionally requires `CORS_ORIGINS` and `RAZORPAY_WEBHOOK_SECRET`; startup fails fast on an invalid configuration without printing values.

## Super-admin bootstrap

`scripts/bootstrap-super-admin.ts` creates the first SUPER_ADMIN only if none exists, never sets a password, and prints a 72-hour token for `POST /api/v1/auth/password/reset`. Further admins are created in the dashboard (invite flow, same token mechanism). Keep at least two super-admins; the system refuses to suspend or demote the last one.

## Deployment

1. Build: `npm ci && npm run build` (produces `dist/`). Run `npm run typecheck && npm run lint && npm test` in CI first.
2. Migrate **before** starting the new version: `npm run db:migrate:deploy` with `DIRECT_URL`. Rehearse on a Neon branch of production first; check `prisma migrate status`.
3. Start API instances: `node dist/src/server.js` (set `PORT`, `TRUST_PROXY`). Readiness: `GET /health/ready` (503 while shutting down or DB unreachable); liveness: `GET /health/live`.
4. Start exactly one worker: `node dist/src/worker.js`.
5. Roll instances one at a time; SIGTERM drains connections for up to 25 s.
6. Rollback = redeploy the previous build. Schema changes are backward-compatible by policy (expand/contract), so the previous version runs on the new schema. If a migration must be undone, write a compensating migration; restore a Neon branch/PITR only for data corruption.

Suggested hosts: any Node 22 runtime (Render, Railway, Fly, a VM with systemd/PM2) behind HTTPS; Neon for PostgreSQL. Both API and worker need the same env except the worker prefers `DIRECT_URL`.

## Connection pooling

API uses the Neon pooled host; `DB_POOL_MAX` (default 10) per instance; keep `instances × DB_POOL_MAX` below the Neon pooler limit for your plan. Migrations, `prisma studio` and the worker use the direct host. Long analytics queries are bounded by `DB_STATEMENT_TIMEOUT_MS` (15 s).

## Logging, metrics, alerting

- Logs: JSON to stdout (Pino) with `requestId`, `userId`, route, status, latency; secrets redacted. Ship to your log platform; retain ≥ 90 days (audit rows live in the DB independently).
- Metrics to collect from logs or a sidecar: request rate, p95/p99 latency per route, 5xx rate, 401/403 rates, DB pool wait time, job failures, webhook signature failures, lockouts.
- Alerts (recommended thresholds): 5xx > 1 % for 5 min; p99 > 1 s for 10 min; readiness failing; worker job failure; `webhook.signature_invalid` > 10/h; `auth.account_locked` spike; reconciliation mismatches > 0 after a run; settlement batch PARTIALLY_FAILED.
- Error monitoring: wire Sentry (or similar) in `src/middleware/error-handler.ts` where unhandled errors are logged.

## Backups, restore and disaster recovery

- Neon keeps PITR history per plan; set the retention to ≥ 7 days (30 recommended) and enable scheduled branch snapshots for longer retention.
- Weekly **restore drill**: create a branch at a timestamp, run `prisma migrate status` and a smoke query (`SELECT count(*) FROM appointments`), then delete the branch. Record the outcome.
- Logical backups for off-platform retention: `pg_dump --format=custom` from the direct host into encrypted object storage; test `pg_restore` quarterly.
- Document storage must be backed up separately (object storage versioning).
- RPO/RTO targets for pilot: RPO ≤ 15 min (PITR), RTO ≤ 2 h (restore branch, repoint `DATABASE_URL`, redeploy). Keep a written runbook with the Neon project id and who holds credentials.

## Incident response

1. Detect (alert or report) → open a `security_incidents` record with severity and `personalDataAffected`.
2. Contain: revoke sessions (`/admin/users/:id/sessions/revoke` or all via SQL), suspend providers/users, rotate secrets, block IPs at the edge.
3. Investigate using `audit_events`, `sensitive_access_logs`, request ids in logs.
4. Notify: DPDP Board / affected individuals per counsel's timeline; record `regulatorNotifiedAt`.
5. Recover and close with a post-mortem; add tests for the root cause.

## Manual finance operations (no database access needed)

Everything that normally arrives automatically can be recorded by staff holding `finance.manual.record` (SUPER_ADMIN and FINANCE_APPROVER by default; sensitive):

| Operation | Endpoint | Rules |
|---|---|---|
| Offline payment received by the platform | `POST /admin/finance/transactions/:id/manual-payments` (`receivedBy: PLATFORM`) | amount ≤ due, unique receipt reference, not future-dated; captures a `MANUAL` payment; when fully paid the transaction is PAID and, if already completed, the provider earning is posted |
| Patient paid the provider at the counter | same endpoint, `receivedBy: PROVIDER` | transaction → PAY_AT_PROVIDER; no money held by the platform; commission still owed on completion |
| Abandoned online checkout | `POST /admin/finance/payments/:id/mark-abandoned` | only CREATED payments; frees the transaction for an offline payment |
| Refund paid outside the gateway | `POST /admin/finance/refunds/:id/record-manual` | REQUESTED / APPROVED / FAILED only; recorder ≠ requester (separation of duties); same clawback and commission recalculation as a gateway refund. Approving a refund on a MANUAL payment leaves it APPROVED for this step |
| Ledger adjustment | `POST /admin/finance/providers/:id/adjustments` | signed amount, ≠ 0, ≤ ₹10,00,000 per entry, reason ≥ 10 chars; append-only (undo = opposite entry) |
| Webhook replay | `POST /admin/finance/webhook-events/:id/replay` | FAILED events only; re-runs the same processing with the stored payload |

Nothing is edited in place: each operation appends a payment, refund state or ledger entry with the actor and reason, and writes an audit event (`payment.recorded_manually`, `payment.recorded_at_provider`, `payment.marked_abandoned`, `refund.recorded_manually`, `ledger.adjustment_posted`, `webhook.replayed`).

## Platform settings

Runtime settings live in `platform_settings` and are read through `getSetting(key, fallback)` with a 30 s per-process cache (writes invalidate immediately). `src/modules/settings/settings.meta.ts` is the registry of what a valid value is: label, group, type, unit, min/max, pattern, risk level, operational guidance and the code default. The admin API returns this metadata with every setting, so the dashboard renders typed controls, bounds, "changed from default" and high-impact acknowledgements without hardcoding keys. Every change requires a reason (≥ 5 chars), the version you last saw (409 on a concurrent edit), passes the registry rules (400 with the offending field), and is written to the audit log with the old and new value and the actor. To add a setting: insert the row in the seed, add its metadata entry, and read it with `getSetting` — no dashboard release needed.

## Email (SMTP) and branding

Outbound email is configured at runtime, not in `.env`: **Settings → Email (SMTP)** in the dashboard (`PUT /admin/integrations/smtp`, permission `settings.write`). Host, port, username, from-address and TLS mode are stored as platform settings; the password is encrypted at rest with `DATA_ENCRYPTION_KEY` and never returned by the API (`GET` reports `hasPassword` only). **Send test email** runs `verify()` against the server and sends one message; failures come back as 422 with the transport error so misconfiguration is visible before notifications depend on it. TLS 1.2+ is required. Until SMTP is saved, EMAIL notifications fall back to the log driver.

Branding (platform name, tagline, logo) is also runtime configuration (`PUT /admin/branding`, `PUT /admin/branding/logo` raw PNG/JPEG/WebP ≤ 2 MB, magic-bytes checked). The logo is served publicly at `/public/branding/logo` with a one-hour cache and a content-hash `v=` query so the dashboard and login page update immediately after upload. These keys are rejected by the generic settings endpoint so they can only change through the dedicated screens.

## Reference geography (no hardcoded regions)

Addresses are never typed against a fixed list. `GET /public/geo/countries`, `/states?country=IN` and `/cities?country=IN&state=WB` serve the ISO 3166 dataset bundled with the `country-state-city` package (cached for a day by clients); `GET /public/geo/pincode/:pin` resolves an Indian PIN through the India Post directory (api.postalpincode.in, 6 s timeout, 24 h in-memory cache, 503 when unreachable so the UI falls back to manual entry). The pilot districts (Moyna, Tamluk) exist only as rows in `service_regions`; no default state, district or medical council is baked into code. Going outside India needs a `country` column on locations and regions — the endpoints already take a country code.

## Routine jobs (worker)

| Job | Schedule (IST) | Purpose |
|---|---|---|
| notifications.deliver | every minute | deliver outbox (EMAIL via SMTP once configured in Settings → Email; otherwise, and for SMS/push, the log driver) |
| exports.run | every minute | build queued CSV exports |
| maintenance.credential-expiry | 02:15 daily | expire documents, suspend lapsed providers, ground vehicles |
| maintenance.renewal-reminders | 02:30 daily | open renewal cases 30 days ahead |
| maintenance.cleanup | 03:45 daily | purge expired idempotency rows, tokens, old sessions |
| maintenance.auto-no-show | hourly | mark stale unconfirmed appointments |

## Data retention (to finalise with counsel)

Append-only tables (`audit_events`, `sensitive_access_logs`, ledger, snapshots) are never deleted by the application. Retention purges, when policy is set, run as a dedicated DB role that disables the append-only trigger inside an audited procedure.
