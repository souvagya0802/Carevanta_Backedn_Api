# Security and threat model

## Assets

Patient identity and contact data, clinical documents (reports, prescriptions), provider credentials (registration certificates, identity proofs), bank details, payment references, credentials/tokens, the audit trail, and the integrity of money (ledger, commissions, settlements).

## Trust boundaries and actors

Public internet → API (patients, providers, admins, payment gateway webhooks) → MongoDB Atlas + object storage. Actors: anonymous, patient, provider member (scoped to one provider), platform staff (role-based), super-admin, payment gateway, background worker, database operator.

## Threats and controls (STRIDE-style)

| Threat | Control | Verified by |
|---|---|---|
| Credential stuffing / brute force | Argon2id (19 MiB, t=2), per-account lockout after 5 failures (atomic counter), auth rate limit 20/min/IP, identical errors and dummy-hash timing for unknown accounts | `auth.test.ts` lockout + concurrency tests |
| Token theft / replay | 15-min HS256 JWTs bound to a server-side session; opaque 256-bit refresh tokens stored hashed; rotation with **family revocation on reuse**; logout and suspension effective on the next request | `auth.test.ts` rotation/reuse/suspension tests |
| Privilege escalation | Roles only grantable if the grantor holds every permission in them; SUPER_ADMIN grant only by super-admins; no self-grant; system roles immutable; last super-admin cannot be removed; pending accounts have no permissions | `users-roles.test.ts` |
| Broken object-level authorisation (IDOR/BOLA) | Provider resources require membership of *that* provider with the needed capability; patients can only reach profiles/appointments/reports they own; cross-tenant access returns 404; denied attempts audited | provider, booking, diagnostics tests |
| Unauthorised approval / self-approval | Maker-checker on provider verification, document review, payout verification, commission policies, refunds, settlements, clinical mappings (DB CHECK + service) | provider, finance, discovery tests |
| Tampering with money | Integer arithmetic; immutable snapshots and append-only ledger (triggers); idempotent postings; payments only via signature-verified webhooks; amount mismatches quarantined for reconciliation; UTR required to mark payouts | `finance.test.ts`, `money.test.ts` |
| Replayed / forged webhooks | HMAC-SHA256 over raw bytes with constant-time compare; `(gateway, event_id)` unique; payload hash stored | finance tests (forged, duplicate, mismatch) |
| Duplicate submissions | `Idempotency-Key` middleware (per user/route/body hash); DB unique keys on bookings, payments, refunds, ledger | booking + refund tests |
| Injection | Prisma parameterised queries; raw SQL only through tagged templates (`Prisma.sql`) with bound parameters; CSV formula-injection neutralised in exports | code review; export test |
| Malicious uploads | Allow-list PDF/JPEG/PNG, magic-byte check, 10 MB cap, server-generated storage keys (no client paths), private storage, download as attachment with `nosniff` and `no-store` | provider document tests |
| Information disclosure in errors/logs | Generic 500s; Prisma/PG errors mapped to safe codes; Pino redaction of passwords/tokens/bank numbers; health checks expose nothing | error handler, logger config |
| Sensitive data at rest | Bank account numbers AES-256-GCM encrypted (`DATA_ENCRYPTION_KEY`, key id for rotation); notification payloads (OTPs, reset tokens) encrypted and wiped after delivery; only token hashes stored | crypto + auth tests |
| Audit evasion | Audit rows written in the same transaction as the change; append-only triggers; sensitive reads (documents, reports, exports) logged with purpose | `users-roles.test.ts` immutability test |
| Data minimisation failures | Bulk user export excludes contact details; audit metadata redacted (no free text, no secrets); admin lists mask recipients and bank numbers | export test |
| Enumeration | Forgot-password always 202; registration conflict message does not say which field; cross-user 404s | auth tests |
| CSRF / browser attacks | Bearer tokens (no cookies), CORS allow-list with explicit headers, Helmet CSP/HSTS, `X-Content-Type-Options` | app config |
| Denial of service | Body limits, request/headers timeouts, per-IP limits, bounded list sizes, statement timeout 15 s, bulk caps | config |
| Secrets in code | All secrets via validated env; `.env` gitignored; `.env.example` placeholders only; the Neon credential pasted during the brief and the Atlas credential pasted on 2026-11-07 are treated as exposed and must be rotated | repo review |

### Role-management safeguards

Custom-role safeguards: a role may only contain permissions its author holds; a manager cannot remove `roles.manage` from the only role granting it to them (self-lockout guard); every create/edit records a reason and the added/removed diff plus the number of affected holders in the audit log; edits carry `expectedUpdatedAt` so concurrent changes are rejected with 409; roles that were ever granted cannot be deleted.

## Residual risks and recommendations

1. **Rate limiting is per API instance.** With ≥ 2 instances, add a shared store (Redis) or move limits to the load balancer/WAF.
2. **No MFA yet.** Add TOTP or passkeys for roles holding sensitive permissions before production.
3. **Local object storage** is for development/single-node pilots. Production should use encrypted object storage (SSE-KMS) with short-lived signed URLs; the storage interface is isolated in `src/lib/storage.ts`.
4. **Secret rotation**: `DATA_ENCRYPTION_KEY` has a key id (`k1`) so a second key can be introduced for re-encryption; `JWT_SECRET` rotation invalidates access tokens only (15 min).
5. **Dependency hygiene**: run `npm audit` and Dependabot/Renovate; pin versions (done in `package-lock.json`).
6. **Penetration test** before launch, focused on the portal endpoints and file access paths.

### Manual finance operations

`finance.manual.record` lets staff record offline payments, manual refunds, ledger adjustments and webhook replays without database access. Controls: separate sensitive permission (not held by PLATFORM_ADMIN or FINANCE_OFFICER), mandatory reason, append-only effects, duplicate-receipt rejection, amount bounds (≤ due, ≤ ₹10,00,000 per adjustment), separation of duties on manual refunds, and a dedicated audit action per operation. Residual risk: a single holder can post an adjustment without a second approver — recommend dual control (maker–checker) on adjustments above a threshold before production, and a periodic review of `ledger.adjustment_posted` events.

## Security checklist (pre-production)

- [ ] Rotate the Atlas database user password; give the app user `readWrite` on the application database only, and enable Atlas IP allow-listing
- [ ] Set `APP_ENV=production`, real `CORS_ORIGINS`, `TRUST_PROXY`, Razorpay keys and webhook secret
- [ ] Generate fresh `JWT_SECRET` and `DATA_ENCRYPTION_KEY`; store in a secrets manager
- [ ] Replace local storage driver with object storage; verify documents are not publicly reachable
- [ ] Enable MFA for SUPER_ADMIN / finance / verification roles
- [ ] Configure WAF / shared rate limiting; enforce TLS 1.2+ and HSTS at the edge
- [ ] Turn on database backups + PITR, test restore (see operations)
- [ ] Ship logs to a central store with retention; alert on `access.denied` spikes, webhook signature failures, lockouts
- [ ] Review `docs/compliance.md` register with counsel; record outcomes in commission policies' legal review
