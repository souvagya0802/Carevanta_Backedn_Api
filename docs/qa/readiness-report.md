# Production readiness report — API platform layer

Date: 2026-11-10. Scope: the Express/Node platform layer of the API (HTTP hardening, rate limiting, validation, secrets and logging, operability, data protection operations, deployment packaging, CI). Business modules, the Prisma schema and the frontends were audited by inspection only; findings there are listed with the owner.

Status legend: **Done** (already in place, verified), **Fixed now** (changed in this pass, covered by tests where possible), **Open** (not done; owner named).

Verification run for this report: `npm run typecheck` (clean), `npm run lint` (clean), `npx vitest run tests/unit/middleware-hardening.test.ts tests/integration/hardening.test.ts tests/integration/auth.test.ts tests/integration/qa-fixes.test.ts` (61 passed, 0 failed; the hardening file re-run after the last fix: 18/18). Docker is not installed on the authoring machine, so the image and compose stack were reviewed, YAML-parsed, and left for CI's `docker` job to build and boot.

## Go / no-go checklist

### HTTP hardening

| Item | Status | Evidence / notes |
|---|---|---|
| Helmet security headers (CSP, HSTS, nosniff, frame, referrer), no `X-Powered-By` | Done | `src/app.ts`; `hardening.test.ts` "security headers" |
| CORS allow-list from `CORS_ORIGINS`, no credentials, explicit methods/headers, unknown origin gets no CORS headers, non-browser clients allowed | Done | `hardening.test.ts` "CORS allow-list"; production refuses an empty list (`src/config/env.ts`) |
| Body limit 256 KB JSON / 256 KB raw webhooks / per-route upload caps (`MAX_UPLOAD_BYTES`, magic bytes) | Done | 413 covered by test; uploads in `src/lib/storage.ts` |
| Malformed JSON → 400, strict parser rejects primitives, unsupported charset/encoding → 415, aborted body → 400 | Fixed now | `src/middleware/error-handler.ts`; tests |
| Malformed percent-encoding in a path returned **500** | Fixed now | Express throws a bare `URIError`; now 400 `VALIDATION_FAILED` ("Malformed request path") |
| `trust proxy` from env (`TRUST_PROXY`, 0–5 hops) | Done | must be set to the real hop count in production so rate limits and audit IPs are per client |
| Request id generated or propagated (`X-Request-Id`, validated format), echoed in error bodies and logs | Done | test "request ids" |
| No stack traces, Prisma or driver text in responses; unknown errors are a generic 500 and logged with the id | Done | unit test with a Prisma-style message |
| 404 and all errors share one envelope `{ error: { code, message, details?, requestId } }` | Done | test "error envelope" |
| API responses not cacheable by proxies/browsers unless a handler opts in | Fixed now | `Cache-Control: no-store` default on `/api/v1`; geography/branding keep their public caching (test) |
| Swagger UI / OpenAPI JSON exposed in production by default | Open — ops | set `OPENAPI_ENABLED=false` in production or protect `/docs` at the edge (`src/config/env.ts:68` default is true) |

### Rate limiting and brute force

| Item | Status | Evidence / notes |
|---|---|---|
| Login, registration, OTP, password reset: 20/min/IP; refresh 300/min; global 600/min; geocoder 30/min; sensitive admin ops 60/min | Done | `src/modules/auth/auth.routes.ts` (8 mounts), `geo.routes.ts`, `integrations.routes.ts`, `users.routes.ts` |
| Standard `RateLimit` headers (draft-8) and `Retry-After` on 429 | Done | `hardening.test.ts` "rate limiting" trips the auth limiter |
| Per-account lockout after `LOGIN_MAX_FAILURES` with atomic counter, concurrent-failure safe | Done | `auth.test.ts` (8 lockout cases, pass) |
| Public search and type-ahead have only the global limit | Open — discovery module | `src/modules/discovery/discovery.routes.ts:31` (`/search`) and `:104` (`/suggest`): mount `searchLimiter` (120/min, exported from `src/middleware/rate-limit.ts`) |
| Limits are per instance | Open — ops/infra | with ≥ 2 instances use `rate-limit-redis` on the existing Redis, or the edge/WAF |

### Input validation and output shapes

| Item | Status | Evidence / notes |
|---|---|---|
| Every declared route validates params, query and body with zod through `defineRoute` (23 route files, 0 bypasses) | Done | grep: no raw `router.*` registrations except the ones below |
| Raw registrations (report/prescription/document/export file downloads, SSE stream, webhooks, branding logo, patient hero) validate ids inline with zod and log sensitive access | Done | e.g. `diagnostics.routes.ts:333`, `patient.routes.ts:690`, `portal.routes.ts:1314` |
| IDs are UUIDs (`IdParams`), cursors validated, page size capped at 100 | Done | `src/lib/pagination.ts` |
| Enums validated by zod schemas; money as integer minor units; phone/PIN/GSTIN formats with checksum | Done | `src/http/dto.ts` |
| Output never includes password hashes, token hashes or encrypted settings | Done (by inspection) | user DTO in `users.service.ts:12`; `auth/me` maps fields explicitly; SMTP/gateway `GET` return `hasPassword`/`secretChanged` flags only |
| `response` schema on routes is documentation only (not stripping) | Open — http layer | `src/http/route.ts:168`: consider `def.response.safeParse` in non-production to catch a raw record leaking |

### Secrets, config and logging

| Item | Status | Evidence / notes |
|---|---|---|
| Env validated at boot with zod; failure prints names only, never values; production-only requirements enforced | Done | `src/config/env.ts` |
| `.env.example` complete and placeholder-only | Fixed now | added `METRICS_ENABLED`, `METRICS_TOKEN`, `SHUTDOWN_DRAIN_MS`; Redis key added by the slot-lock work |
| Secrets redacted in logs (passwords, tokens, cookies, bank numbers, gateway secrets, OTPs) | Done / extended | `SECRET_KEYS` in `src/lib/logger.ts` |
| Personal identifiers (email, phone, identifier, recipient, full name) masked in logs | Fixed now | `maskPii`: `a***@domain`, `•••45`; verified through a real pino instance in `middleware-hardening.test.ts` |
| Request logs carry method, path (no query string), status, latency, request id, user id | Done | `pino-http` serializers in `src/app.ts` |
| Audit log coverage of admin actions (141 distinct actions: settings, SMTP, gateways, branding, push keys, roles, users, finance manual ops, verification) | Done | grep of `audit(` call sites; `access.denied` audited |
| Credentials pasted into chat during the project (Neon, Atlas) | Open — founder | rotate before any real data; see `docs/security.md` checklist |

### Operability

| Item | Status | Evidence / notes |
|---|---|---|
| `/health/live` (process up) and `/health/ready` (503 `starting` until index sync, 503 `shutting_down` on SIGTERM, 503 `unavailable` when Mongo ping fails) | Done | semantics covered by `hardening.test.ts` "health" |
| Index sync retried every 30 s; production gives up after 10 attempts so the orchestrator replaces the instance | Done | `src/server.ts` |
| Graceful shutdown drained HTTP but open SSE streams kept `server.close` from completing → every deploy with a portal tab open ended in the 25 s forced exit (exit code 1) | Fixed now | `SHUTDOWN_DRAIN_MS` (10 s) then `closeAllConnections()`; EventSource clients reconnect (`retry: 5000`) |
| No `uncaughtException` handler (process state undefined after a throw outside a request) | Fixed now | logs fatal, flips readiness, exits 1 |
| Worker shutdown does not wait for an in-flight job; a job cut mid-run reruns only after its lease TTL (5–30 min) | Open — worker owner | `src/worker.ts:49–54`: track the running job promise and await it with a bound before `process.exit` |
| Job leases per job name with TTL and outcome recording; two workers safe | Done | `src/lib/job-lease.ts` |
| Structured JSON logs with levels (`LOG_LEVEL`), request timing in every request log | Done | pino / pino-http |
| Metrics endpoint | Fixed now | `GET /metrics` Prometheus text: requests by method/route template/status class, latency histogram per route, in-flight, uptime, RSS; off by default, bearer token required in production |
| Timeouts on outbound HTTP: Razorpay/Stripe 10 s, geocoder 6 s, PIN API 6 s, SMTP connect 10 s / socket 20 s, web-push 10 s, registries 10–12 s; server request/headers timeouts | Done | grep of `AbortSignal.timeout` / transport options |
| Error monitoring (Sentry or similar) | Open — ops | hook point is the "unhandled error" branch in `src/middleware/error-handler.ts`; dependency proposal below |

### Data protection, backups and compliance

| Item | Status | Evidence / notes |
|---|---|---|
| Atlas backup and restore procedure documented (snapshot/PITR → new cluster → `db:sync` → smoke → repoint) and logical `mongodump` off-platform copy | Fixed now | `docs/operations.md` (the previous text still described `pg_dump`/Neon) |
| Weekly restore drill, RPO ≤ 15 min / RTO ≤ 2 h targets | Done (documented) | not yet exercised — Open — ops: record the first drill |
| Retention and anonymisation: what runs today vs what counsel must decide (audit, health records, profiles, logs, backups) | Fixed now | retention table in `docs/operations.md`; aligns with `docs/compliance.md` C1/C17 |
| Data-principal erasure = anonymisation endpoint, blocked by legal holds / open money | Done | `POST /admin/users/:id/anonymise` |
| Indian compliance register (DPDP, SPDI, NMC commission rule, CEA, D&C Act, PC-PNDT, AERB, RBI PA, GST, data residency) | Done (register) | `docs/compliance.md`; the items marked Open there (C3 commissions, C12 payment aggregator, C16 residency) are **blocking for a paid pilot** and need counsel, not code |
| Encryption at rest for bank data, SMTP/gateway secrets, notification payloads | Done | AES-256-GCM, key id for rotation |

### Deployment and CI

| Item | Status | Evidence / notes |
|---|---|---|
| Multi-stage `Dockerfile`, non-root `node` user, `HEALTHCHECK` on `/health/ready`, one image for API and worker, no secrets baked in | Fixed now | `Dockerfile`, `.dockerignore` |
| `docker-compose.yml`: api + worker + MongoDB 8 single-node replica set + Redis, env placeholders only, read-only containers | Fixed now | for laptops/CI; Atlas in staging/production |
| CI: manifest check, typecheck, lint, unit + integration tests, build, audit, container boot test; frontends matrix (typecheck, lint, test, build) via `FRONTEND_REPO_TOKEN` | Fixed now | `.github/workflows/ci.yml`; frontends are separate repositories, so the job is skipped until the token is added (or the steps are copied into each repo) |
| Image built and booted | Open — CI | no Docker on the authoring machine; first pipeline run will prove it |
| Object storage for documents (`STORAGE_DRIVER` supports `local` only) | Open — storage owner | required before multi-instance or any real patient documents; interface isolated in `src/lib/storage.ts` |
| MFA for super-admin / finance / verification roles | Open — auth owner | TOTP or passkeys; see `docs/security.md` |

## What remains before a paid pilot (priority order)

1. **Legal gates (blocking):** NMC commission rule (C3), payment-aggregator structure (C12), Atlas region / data residency (C16), retention schedule for health records (C17). Owner: founder + counsel.
2. **Secrets and tenancy hygiene:** rotate the Atlas (and legacy Neon) credentials; create separate Atlas users for the app and for operations; set `APP_ENV=production`, `CORS_ORIGINS`, `TRUST_PROXY`, `OPENAPI_ENABLED=false`, fresh `JWT_SECRET`/`DATA_ENCRYPTION_KEY` in a secrets manager. Owner: founder/ops.
3. **Object storage driver** (S3-compatible, SSE-KMS, short-lived signed URLs) replacing local disk. Owner: storage.
4. **MFA** for privileged roles. Owner: auth.
5. **Worker drain** on SIGTERM (await the running job, bounded). Owner: worker.
6. **Shared rate limiting** across instances (`rate-limit-redis`) and `searchLimiter` on discovery. Owners: infra, discovery.
7. **Observability wiring:** ship logs, scrape `/metrics`, alerts per `docs/operations.md`, Sentry on the unhandled-error branch. Owner: ops.
8. **First restore drill** from an Atlas snapshot, recorded. Owner: ops.
9. **Penetration test** on portal endpoints and file paths. Owner: founder (external).
10. **Run CI once** with the frontend token to prove the frontend jobs and the container boot step.

## Dependencies proposed (not added)

- `rate-limit-redis` — shared limiter store on the Redis already provisioned.
- `@sentry/node` (or equivalent) — error monitoring from the handler's unhandled-error branch.
- `@aws-sdk/client-s3` (or the chosen provider's SDK) — object storage driver.
- `otplib` or a WebAuthn library — MFA.
