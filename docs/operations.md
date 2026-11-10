# Operations runbook

## Local setup

```bash
npm install                    # .npmrc sets legacy-peer-deps (npm 10 peer-resolution bug)
cp .env.example .env           # fill MONGODB_URI, JWT_SECRET, DATA_ENCRYPTION_KEY
npm run db:sync                # create every collection index (also done automatically at API start)
npm run db:seed                # idempotent reference data (roles, specialities, templates, settings)
BOOTSTRAP_ADMIN_EMAIL=you@example.com npm run admin:bootstrap   # prints a one-time set-password token
npm run dev                    # API on :4000, Swagger at /docs
npm run dev:worker             # background jobs (optional locally; JOBS_ENABLED=false runs exports inline)
```

Generate secrets: `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"` (JWT) and `randomBytes(32)` (encryption key).

No MongoDB install is needed for tests: they start an in-memory MongoDB replica set (binary downloaded once to `~/.cache/mongodb-binaries`).

## Environment variables

See `.env.example` for the full list with comments. Required: `MONGODB_URI` (Atlas SRV string or any replica-set URI), `JWT_SECRET` (≥ 32 chars), `DATA_ENCRYPTION_KEY` (32 bytes base64). Production additionally requires `CORS_ORIGINS` and `RAZORPAY_WEBHOOK_SECRET`; startup fails fast on an invalid configuration without printing values. Optional: `REDIS_URL` (see *Redis (slot-booking lock)* below; required once there are two or more API instances).

## Super-admin bootstrap

`scripts/bootstrap-super-admin.ts` creates the first SUPER_ADMIN only if none exists, never sets a password, and prints a 72-hour token for `POST /api/v1/auth/password/reset`. Further admins are created in the dashboard (invite flow, same token mechanism). Keep at least two super-admins; the system refuses to suspend or demote the last one.

## Deployment

1. Build: `npm ci && npm run build` (produces `dist/`). Run `npm run typecheck && npm run lint && npm test` in CI first.
2. Sync indexes **before** starting the new version: `npm run db:sync` (additive; new indexes build online). Rehearse against a cluster restored from an Atlas snapshot first.
3. Start API instances: `node dist/src/server.js` (set `PORT`, `TRUST_PROXY`). Readiness: `GET /health/ready` (503 while shutting down or DB unreachable); liveness: `GET /health/live`.
4. Start exactly one worker: `node dist/src/worker.js`.
5. Roll instances one at a time; SIGTERM drains connections for up to 25 s.
6. Rollback = redeploy the previous build. Schema changes are backward-compatible by policy (expand/contract), so the previous version runs on the new schema. If a schema change must be undone, ship a compensating change; use an Atlas point-in-time restore only for data corruption.

### Containers

`Dockerfile` builds one image for both processes (multi-stage: dependencies → TypeScript build → production dependencies → `node:22-bookworm-slim` runtime as the unprivileged `node` user, `HEALTHCHECK` on `/health/ready`). The default command is the API; the worker is the same image with `node dist/src/worker.js`. Documents are written under `/data/storage` (declare it as a volume or switch `STORAGE_DRIVER` once object storage lands). Nothing is baked in: every setting is an environment variable, and `.dockerignore` keeps `.env`, tests, docs and local storage out of the build context.

```bash
docker build -t carevanta-api .
docker run --rm -p 4000:4000 --env-file .env carevanta-api                       # API
docker run --rm --env-file .env carevanta-api node dist/src/worker.js            # worker
docker compose up --build                                                        # local stack: api + worker + mongo (rs0) + redis
```

`docker-compose.yml` is for laptops and CI only (its MongoDB is a single-node replica set so transactions work). Staging and production use Atlas. Signals: the API answers `/health/ready` with 503 the moment SIGTERM arrives, finishes in-flight requests, closes SSE and keep-alive sockets after `SHUTDOWN_DRAIN_MS` (default 10 s; portal tabs reconnect automatically) and exits; the hard stop is 25 s, so give the container at least 30 s grace.

### Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request: manifest freshness check, typecheck, lint, unit and integration tests (in-memory MongoDB), build, `npm audit` (high/critical, non-blocking), then a container build that boots the image and checks it runs as non-root and answers `/health/live`. The three frontends are separate repositories; the `frontends` matrix job checks each out with the `FRONTEND_REPO_TOKEN` secret (read-only fine-grained PAT) and runs typecheck, lint, tests and `next build`. Without that secret the job is skipped; the same steps can be dropped into each frontend repository as its own workflow.

Suggested hosts: any Node 22 runtime (Render, Railway, Fly, a VM with systemd/PM2) behind HTTPS; MongoDB Atlas (a dedicated tier with continuous backup). API and worker share the same env.

## Connection pooling

The MongoDB driver keeps a connection pool per process (default max 100); keep `instances × pool size` under the Atlas connection limit for the tier. `DB_STATEMENT_TIMEOUT_MS` bounds one transaction. Prisma Studio works against the same `MONGODB_URI`.

## Redis (slot-booking lock)

When several patients book the same slot of the same doctor at the same moment, the API takes a per-slot lock (`src/lib/slot-lock.ts`) so they queue in arrival order: the first one books, the next re-reads the slot, finds it full and gets `409 SLOT_UNAVAILABLE`. The lock is advisory; the version compare-and-set on `appointment_slots` inside the booking transaction is still the final guard, so a lost or expired lock can never over-book.

- `REDIS_URL` unset or empty → in-process lock. Correct for **one** API instance; the API logs one warning at start-up (`REDIS_URL is not set …`).
- Two or more instances → `REDIS_URL` is **required** (each instance would otherwise only serialise its own requests). Format: `redis://[:PASSWORD@]HOST:PORT[/DB]`, or `rediss://…` for TLS (Upstash, Redis Cloud, ElastiCache in-transit encryption). Keep it in `.env` only; the logs print the host, never the credentials. Any Redis ≥ 6 works; the API uses `SET NX PX` and one `EVAL` (compare-and-delete), no modules, no persistence needed.
- Keys: `carevanta:slot-lock:<slotId>`, TTL 20 s (longer than any booking transaction with retries). A waiter gives up after 4 s with `409 SLOT_BUSY` ("try again in a moment") only if the slot still has room; a slot that filled up while waiting answers `SLOT_UNAVAILABLE` at once.
- Redis down while configured: the request falls back to the in-process lock and a warning is logged at most once a minute; bookings keep working under the database guard. Alert on that warning when running more than one instance.
- Shutdown closes the client (`QUIT`) after the HTTP server drains. Tests never need a Redis server (`APP_ENV=test` ignores `REDIS_URL`; the Redis path is tested with `ioredis-mock`).
- The rate limiter is still per instance; moving it to the same Redis is the documented next step once there are ≥ 2 instances.

## Logging, metrics, alerting

- Logs: JSON to stdout (Pino) with `requestId`, `userId`, route, status, latency; secrets redacted outright and personal identifiers masked (`email` → `a***@domain`, `phone` → `•••45`; keys listed in `src/lib/logger.ts`). Ship to your log platform; retain ≥ 90 days (audit rows live in the DB independently).
- Metrics: `GET /metrics` (Prometheus text, enabled with `METRICS_ENABLED=true` and read with `Authorization: Bearer $METRICS_TOKEN`) exposes per-instance request counts by method/route template/status class, latency histograms per route, in-flight requests, uptime and RSS. Scrape every 15–30 s and alert on the figures below. Also derive from logs: DB pool wait time, job failures, webhook signature failures, lockouts.
- Alerts (recommended thresholds): 5xx > 1 % for 5 min; p99 > 1 s for 10 min; readiness failing; worker job failure; `webhook.signature_invalid` > 10/h; `auth.account_locked` spike; reconciliation mismatches > 0 after a run; settlement batch PARTIALLY_FAILED.
- Error monitoring: wire Sentry (or similar) in `src/middleware/error-handler.ts` where unhandled errors are logged.

## Backups, restore and disaster recovery

- Atlas Cloud Backup: enable continuous backup (point-in-time restore) with ≥ 7 days retention (30 recommended) plus daily snapshots.
- Weekly **restore drill**: restore a snapshot into a temporary cluster, run `npm run db:sync` and a smoke query (count of `appointments`), then delete the cluster. Record the outcome.
- Logical backups for off-platform retention: `mongodump --uri "$MONGODB_URI" --gzip --archive=carevanta-$(date +%F).gz` from a bastion into encrypted object storage (never from a laptop with the production URI); test `mongorestore --gzip --archive=… --nsFrom 'carevanta.*' --nsTo 'carevanta_restore.*'` quarterly, then `npm run db:sync` against the restored database.
- Restore procedure (Atlas): Project → Clusters → Backup → choose snapshot or point in time → restore to a **new** cluster → run `npm run db:sync` with that cluster's URI → smoke test (`demo:smoke` against it) → repoint `MONGODB_URI` on API and worker → redeploy → verify `/health/ready` and the worker log → delete the old cluster only after the retention window.
- Document storage must be backed up separately (object storage versioning).
- RPO/RTO targets for pilot: RPO ≤ 15 min (PITR), RTO ≤ 2 h (restore snapshot, repoint `MONGODB_URI`, redeploy). Keep a written runbook with the Atlas project id and who holds credentials.

## Incident response

1. Detect (alert or report) → open a `security_incidents` record with severity and `personalDataAffected`.
2. Contain: revoke sessions (`/admin/users/:id/sessions/revoke`; for everyone, rotate `JWT_SECRET` and set `revokedAt` on the `sessions` collection from a bastion), suspend providers/users, rotate secrets, block IPs at the edge.
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

## Place search and reverse geocoding

`GET /public/geo/search?q=&lat=&lng=` and `GET /public/geo/reverse?lat=&lng=` proxy a free OpenStreetMap-based geocoder so browsers never call it directly and no key reaches a frontend. `GEOCODER_PROVIDER=nominatim` (default) needs no key but is limited to one request per second (the API serialises calls) and requires `GEOCODER_CONTACT_EMAIL` in the User-Agent per the Nominatim usage policy; `GEOCODER_PROVIDER=locationiq` uses the LocationIQ free tier (5,000 requests/day) with `GEOCODER_API_KEY`. Results are restricted to India, biased to the caller's position, cached in memory for 24 hours and limited to 30 requests per minute per IP; when the upstream fails the API answers 503 "Place search is unavailable right now" and the apps keep working without suggestions. The PIN lookup uses the same geocoder to refine a district-level point to the PIN centre. Keys are never logged.

## Routine jobs (worker)

| Job | Schedule (IST) | Purpose |
|---|---|---|
| notifications.deliver | every minute | deliver outbox (EMAIL via SMTP once configured in Settings → Email; otherwise, and for SMS/push, the log driver) |
| exports.run | every minute | build queued CSV exports |
| maintenance.credential-expiry | 02:15 daily | expire documents, suspend lapsed providers, ground vehicles |
| maintenance.renewal-reminders | 02:30 daily | open renewal cases 30 days ahead |
| maintenance.cleanup | 03:45 daily | purge expired idempotency rows, tokens, old sessions |
| maintenance.auto-no-show | hourly | mark stale unconfirmed appointments |
| bookings.reminders | every 5 minutes | patient reminders before confirmed appointments and scheduled lab bookings (in-app + push + email outbox) |
| catalogue.cdci_sync | 03:30 IST on the 1st of each month (lease 30 min) | check for a new CDCI medicine list release; validate, apply, discontinue removed brands, notify catalogue admins |

### Booking reminders

`bookings.reminders` (`src/jobs/reminders.ts`) finds CONFIRMED appointments whose slot starts within the largest lead time, and CONFIRMED diagnostic orders with a `scheduledAt` in that window, and writes one reminder per lead time: an IN_APP row (and a PUSH row when the patient has a subscribed device) through `notifyUsers`, plus an EMAIL outbox row with template key `booking.reminder` (variables `patientName`, `reference`, `when` in IST, `doctorName`, `locationName`, `hoursBefore`) that `notifications.deliver` renders and sends on its next minute tick. Lead times come from the platform setting `booking.reminder_lead_hours` (default `24,2`; comma-separated hours, each value one reminder) and `booking.reminders_enabled` switches the job off. Windows do not overlap: with `24,2` the 24 h reminder is sent while the booking is 2–24 h away and the 2 h reminder inside the last two hours, so a booking made 90 minutes ahead gets a single reminder. Idempotent without extra schema: the in-app row stores `meta: { kind, id, reminder: '24h', at }` and the job skips any (booking, lead time, start time) it has already written, across restarts and worker replacements; the `job_leases` lease stops two workers running the pass at once. Cancelled, rejected, no-show and RESCHEDULED bookings are never CONFIRMED and are skipped; a reschedule is a new appointment (new id) and a re-timed lab order changes `at`, so both get fresh reminders for the new time. Ambulance dispatches have no scheduled time and are not reminded. Email delivery retries once a minute up to 5 attempts, then the row is FAILED (visible in the dashboard outbox); if the `booking.reminder` EMAIL template is missing or inactive, delivery fails with "No active template" until one is activated under Settings → Notification Templates.

### Medicine list sync (CDCI)

`catalogue.cdci_sync` (`src/jobs/cdci-sync.ts`) keeps the medicine list current with no manual work.
- **Schedule:** monthly, 03:30 IST on the 1st, under the `job_leases` lease (30 min). The admin trigger uses the same lease, so two runs never overlap.
- **Source:** setting `catalogue.cdci_source_base_url` (default the CC BY mirror `https://raw.githubusercontent.com/ohcnetwork/cdci/main/data/source`; the NRCeS server fails TLS from some networks, and TLS checks are never disabled). A new release is detected from the latest GitHub commit for that folder (`api.github.com/repos/ohcnetwork/cdci/commits?path=data/source&per_page=1`); for a non-GitHub source the release id is a SHA-256 of the files. The last applied release is in setting `catalogue.cdci_last_release` ({ sha, date, appliedAt, counts, durations }); the last run outcome is in `catalogue.cdci_last_run`.
- **Safety:** the 8 files (BrandMaster, GenericMaster, ProductMaster, SupplierMaster, DrugFormMaster, RouteOfAdministrationMaster, SubstanceMaster, License) are downloaded with a 2 min timeout, a 50 MB cap per file and one retry. The update is blocked, and the current data kept, when a file is missing, a header lacks an expected column, BrandMaster has under 80% of the previous row count (under 50,000 on a first run), or License.txt no longer says "Creative Commons Attribution 4.0". Rows are upserted by CDCI code; schedule, prescription flag and active flag set by admins are kept. CDCI brands missing from the new release are set inactive (never deleted): hidden from stock search, patient search and new orders, while existing stock and order history still resolve. `PROVIDER` and `MANUAL` medicines are never touched.
- **Notifications:** everyone with `catalogue.manage` gets IN_APP + EMAIL (`catalogue.medicines_synced`): "Medicine list updated: X added, Y updated, Z discontinued" or "Medicine list update blocked: reason".
- **Kill switch:** `catalogue.cdci_sync_enabled` = false stops scheduled and manual runs.
- **Force a sync:** `POST /api/v1/admin/catalogue/medicines/sync` with `{ "force": true }` (permission `catalogue.manage`, audited, 6 per hour) returns 202 and runs in the background; `GET /api/v1/admin/catalogue/medicines/sync-status` shows the last release and run.
- **Attribution:** "Medicine names from Common Drug Codes for India (CDCI), © C-DAC / NRCeS, MoHFW, CC BY 4.0." (included in the email template).

## Medicine catalogue (CDCI)

Pharmacies pick medicines from the Government of India **Common Drug Codes for India (CDCI)** list (C-DAC / NRCeS, MoHFW). NRCeS publishes a new flat-file release about twice a year (latest 2026-08-31).

- **Refresh:** download the new package (NRCeS national releases page, or the CC BY mirror github.com/ohcnetwork/cdci, folder `data/source`), put the `*.txt` files in `data/cdci/` (git-ignored, ~19 MB), then run `npm run medicines:import` (or `npm run medicines:import -- <folder>`) against the target database. It is idempotent: rows are upserted by CDCI brand code (`medicines.code`, partial unique index) in batches of 1000 (one raw unordered `update` command per batch through Prisma, outside any transaction), and it prints read / inserted / updated / unchanged / skipped counts. The first full load of ~93k brands to Atlas took about N minutes; a refresh is similar.
- **What a refresh changes:** name, composition, strength, dosage form, generic name, route, manufacturer and the search key. It never overwrites `schedule`, `requiresPrescription` or `isActive` once a row exists, so admin edits survive. Brands whose License Status says withdrawn / cancelled are skipped (the 2026-08 release marks every row UNKNOWN). Brands dropped from a release are not deleted; deactivate them by hand if needed.
- **Schedules:** CDCI has no drug-schedule data, so new rows start as Schedule H1 with prescription required. Admins relax individual medicines in the dashboard (Catalogue → Medicines → Edit, audited with a reason).
- **Pharmacy-added medicines:** a pharmacy that cannot find a medicine adds it from the stock screen (`POST /portal/providers/:providerId/medicines`, source `PROVIDER`). It is usable at once by every pharmacy and visible to patients; there is no approval step. Duplicates of the same name + strength + form are refused, additions are rate limited and audited, and admins can filter Source = Pharmacy Added to review or edit them.
- **Attribution (CC BY 4.0, required):** show “Medicine names from Common Drug Codes for India (CDCI), © C-DAC / NRCeS, MoHFW, CC BY 4.0.” wherever the list is shown (portal stock picker, dashboard medicines list). Brand names belong to their owners.

## Data retention (to finalise with counsel)

Append-only collections (`audit_events`, `sensitive_access_logs`, ledger, snapshots) are never deleted by the application. Retention purges, when policy is set, run as a dedicated database user from a bastion inside an audited, scripted procedure (never from the API's credentials, which hold no delete right on those collections once the Atlas role split in `docs/security.md` is applied).

What the application does today, and what must still be decided with counsel before real patient data:

| Data | Today | To decide |
|---|---|---|
| Idempotency rows, OTP/reset tokens, expired sessions | purged nightly by `maintenance.cleanup` (24 h / on expiry / 30 d) | — |
| Audit events, sensitive-access logs | kept forever (append-only) | retention period (suggest ≥ 7 y for finance-linked events, 3 y otherwise) |
| Health records (reports, prescriptions, orders) | versioned, never deleted; legal holds block erasure | retention per record type (`docs/compliance.md` C17; OPD norms ≥ 3 y), who may purge, and whether purged files are shredded from object storage |
| Patient profiles and accounts | data-principal erasure = anonymisation endpoint (`POST /admin/users/:id/anonymise`), blocked while a legal hold or open money exists | timeline for honouring requests (DPDP), guardian handling for dependants |
| Notification payloads (OTPs) | encrypted at rest, wiped after delivery | — |
| Application logs | shipped to the log platform; masked identifiers only | log retention (suggest 90 d hot, 1 y cold) |
| Backups | Atlas snapshots per the schedule above | snapshot retention must not exceed the agreed record retention by more than the restore window |
