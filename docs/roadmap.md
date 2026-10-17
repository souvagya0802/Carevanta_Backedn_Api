# Implementation roadmap

## Delivered (phases 1–5 of the brief, backend)

| Phase | Content | State |
|---|---|---|
| 1 Discovery & design | requirements inventory, architecture, schema, API contract, security/threat model, test strategy, open questions | `docs/` |
| 2 Foundation | Express 5 + TS strict, env validation, Pino, error handling, Prisma 7 + Neon, embedded-PG test infra, initial migrations | done |
| 3 Identity & administration | auth, RBAC, users, providers of all types, verification cases, documents, payout accounts | done |
| 4 Healthcare operations | affiliations, catalogue + clinical review, discovery, scheduling, bookings, diagnostics, pharmacy, ambulance dispatch | done |
| 5 Finance & reporting | commission policies, payments/webhooks, refunds, snapshots, ledger, settlements, reconciliation, analytics, exports | done |
| 6 Hardening | full test suite, migration checks, benchmark harness + measurements, security review, ops docs | done (see performance.md) |

## Next (recommended order)

1. **Super-admin dashboard** (`Carevanta_Super_Admin_Dashboard`, Next.js): all 26 navigation areas against these APIs; form validation mirrored from the OpenAPI schemas. *(in progress in this delivery)*
2. **Launch blockers** — legal review of commission policies (Q1–Q3), Razorpay live keys + webhook secret, SMS provider (DLT-registered) in the notification driver, object storage driver, MFA for privileged roles, Neon region decision and credential rotation, retention schedule.
3. **Provider portals** (hospital/clinic, lab, pharmacy): the `/portal/*` endpoints exist; build the web UI in `Carevanta_Provider_Frontend`.
4. **Patient app** (Flutter): registration/OTP, discovery, booking, payments (Razorpay checkout), family profiles, reports, emergency screen (112-first).
5. **Doctor app** (Flutter): affiliations, schedules, slot blocking, appointment actions.
6. **Ambulance app** (Flutter): offers, accept with vehicle, progress updates, live location (`last_known_*` fields exist).
7. **Phase-2 product**: medicine/appointment reminders (notification templates exist), patient journey links (consultation → tests → report → follow-up), provider-published cost estimates, reviews moderation UI, telemedicine (TPG 2020), ABDM integration.
8. **Scale work when measured**: shared rate-limit store, PostGIS, audit partitioning, read replica, integration API for hospital HIS.
