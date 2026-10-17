# Database design

PostgreSQL 18 on Neon. Schema is Prisma multi-file (`prisma/schema/*.prisma`); constraints Prisma cannot express are in `prisma/migrations/20261017000100_integrity_constraints/migration.sql`.

## Entity overview

```
users ─┬─ user_roles ─ roles ─ role_permissions ─ permissions
       ├─ sessions, login_attempts, verification_tokens
       ├─ provider_members ──────────────┐
       └─ patient_profiles ─┐            │
                            │            ▼
providers ──────────────────┼──── (type-specific) doctor_profiles · facility_profiles · diagnostic_profiles
  │                         │                     pharmacy_profiles · ambulance_operator_profiles
  ├─ provider_locations ─ provider_operating_hours
  ├─ provider_service_areas, provider_documents, verification_cases ─ verification_checks
  ├─ provider_status_history, provider_payout_accounts, provider_agreements, reviews
  ├─ facility_departments ─ departments        provider_amenities ─ amenities
  ├─ provider_services ─ services ─ service_panel_items      doctor_specialities ─ specialities
  │                                                            conditions ─ condition_speciality_mappings
  ├─ doctor_affiliations (doctor ↔ facility) ─ affiliation_events
  ├─ doctor_schedules ─ appointment_slots ─ appointments ─ appointment_events
  ├─ diagnostic_orders ─ diagnostic_order_items · diagnostic_reports (versions) · prescriptions
  ├─ pharmacy_inventory ─ medicines · pharmacy_orders ─ pharmacy_order_items
  ├─ ambulance_vehicles, ambulance_crew_members · dispatch_requests ─ dispatch_assignments · dispatch_events
  └─ service_transactions ─ payments · refunds · commission_snapshots ─ commission_policies
                           └─ provider_ledger_entries ─ settlement_items ─ settlement_batches
payment_webhook_events · reconciliation_records · idempotency_records
support_cases ─ support_case_events · admin_notes · notifications · notification_templates
platform_settings · export_jobs · service_regions
audit_events · sensitive_access_logs · consent_records · legal_holds · security_incidents
```

Key modelling decisions:

- **`providers` is the shared core** (type, status, names, contact, rating); each type has a 1:1 detail table. A doctor is a provider whose `doctor_profiles.user_id` is the doctor's login — one identity reused everywhere.
- **`doctor_affiliations`** is the doctor↔facility relationship with its own terms, confirmations and status; schedules and slots reference it so a suspension blocks the right slots only.
- **`service_transactions`** is the single money anchor for any billable thing (exactly one of four source ids, enforced by CHECK), so finance never branches on source type.
- **Money** is `BIGINT` minor units + `CHAR(3)` currency everywhere; rates are basis points.
- **Soft history, not deletes**: role revocations, status histories, report versions, affiliation events and commission reversals are new rows.

## Primary keys and time

UUIDv7 (`uuidv7()` default) keeps inserts append-mostly in B-trees at high volume and sorts by time; `created_at` + `id` form the pagination cursor. All timestamps are `timestamptz(3)`; opening hours and schedules store minutes-from-midnight interpreted in IST (fixed +05:30).

## Indexes and why each exists

| Index | Supports |
|---|---|
| `users(status, created_at DESC)`, `users(created_at DESC, id DESC)` | user list filters and keyset pagination |
| `users_full_name_trgm_idx` (GIN trigram), `providers_display_name_trgm_idx`, `conditions_name_trgm_idx`, `services_name_trgm_idx`, `medicines_name_trgm_idx` | substring/fuzzy search without sequential scans |
| `user_roles_active_unique` (partial, `revoked_at IS NULL`) | one live grant per user+role while keeping history |
| `sessions(refresh_token_hash)` unique, `sessions(user_id, revoked_at)`, `sessions(family_id)` | refresh, logout-all, reuse detection |
| `providers(type, status, created_at DESC)`, `providers(status, created_at DESC)` | admin lists and verification queue |
| `provider_locations(latitude, longitude)` partial on active rows with coordinates | discovery bounding-box prefilter |
| `provider_locations(district, pincode)`, `provider_service_areas(district, pincode, purpose)` | serviceability checks |
| `provider_documents(expires_at)` partial on accepted docs | nightly expiry job |
| `verification_cases_one_open_per_provider` (partial unique) | prevents duplicate open cases |
| `doctor_affiliations_one_live` (partial unique) | prevents duplicate live affiliations, including under concurrency |
| `appointment_slots(doctor_provider_id, location_id, starts_at)` unique, `appointment_slots_open_by_doctor` partial, `appointment_slots(starts_at)`, `appointment_slots_no_overlap_excl` (GiST EXCLUDE) | idempotent slot generation, public slot listing, time-window reports ("today"), cross-facility overlap prevention |
| `appointments(doctor_provider_id, created_at DESC)`, `(facility_provider_id, …)`, `(status, …)`, `(patient_profile_id, …)`, `(created_at DESC, id DESC)`, `(slot_id)` | every list the portals and admin use |
| `appointments_patient_slot_live` (partial unique) | one live booking per patient per slot |
| `appointments(booked_by_user_id, idempotency_key)` unique | booking idempotency at the data layer |
| `service_transactions(provider_id, created_at DESC)`, `(status, …)`, `service_transactions_completed_at_idx` (partial, `service_completed_at IS NOT NULL`) | finance lists, analytics GTV/commission windows (replaced a narrower partial index the planner could not use — see performance.md) |
| `commission_policies_no_overlap_excl` (EXCLUDE on scope_key + period, ACTIVE only) | no two active policies for one scope/period |
| `commission_snapshots_one_live` (partial unique) | one FINAL snapshot per transaction |
| `provider_ledger_entries(dedupe_key)` unique, `ledger_unsettled_by_provider` partial | idempotent postings, settlement batching |
| `payment_webhook_events(gateway, event_id)` unique | duplicate delivery protection |
| `idempotency_records(user_id, scope, key)` unique | HTTP idempotency |
| `audit_events(entity_type, entity_id, occurred_at DESC)`, `(actor_user_id, …)`, `(action, …)`, `(occurred_at DESC, id DESC)` | audit search |

Deliberately **not** indexed: free-text columns other than names, low-cardinality booleans on small tables, every foreign key on tiny lookup tables. Each new index must name the query it serves.

## Constraints beyond Prisma

CHECK constraints (coordinates, PIN codes, hour ranges, money ≥ 0, `booked_count ≤ capacity`, inventory `reserved ≤ on_hand`, selling price ≤ MRP, policy method/rate/bounds, one transaction source, settlement evidence, maker ≠ checker), two EXCLUDE constraints, a trigger-maintained `scope_key`, and append-only / immutability triggers on `audit_events`, `sensitive_access_logs`, `provider_ledger_entries`, `commission_snapshots`. Error codes `23514`, `23P01`, `P0001` are mapped to safe HTTP responses in `src/lib/errors.ts`.

## Migrations

- Prisma Migrate with a committed history (`prisma/migrations`). `prisma.config.ts` points the CLI at `DIRECT_URL` (non-pooled); the app uses the pooled `DATABASE_URL`.
- Every test run applies the full history to an empty PostgreSQL 18 and then checks `prisma migrate diff` reports no drift.
- Rules: never edit an applied migration; no `migrate reset` or `db push` outside local dev; destructive changes use expand → backfill → contract across releases; adding an index on a large table uses `CREATE INDEX CONCURRENTLY` in a hand-written migration; adding a NOT NULL column means add nullable → backfill in batches → `SET NOT NULL`.
- Rollback: forward-only. Write a compensating migration; restore from a Neon point-in-time branch if data is damaged (see operations).

## Neon specifics

- Pooled host (`-pooler`) for the API (PgBouncer transaction mode; node-postgres unnamed statements are compatible). Direct host for migrations and the worker.
- `DB_POOL_MAX` per instance × instances < pooler client limit; `statement_timeout` 15 s on the API connection.
- Neon branches give free point-in-time copies: use one for migration rehearsal before each production deploy.
- Extensions in use: `citext`, `btree_gist`, `pg_trgm` (all available on Neon; `postgis` available when needed).

## Growth plan (evaluated by measurement)

`audit_events`, `appointment_slots`, `appointments`, `provider_ledger_entries` grow fastest. Options in order: keep (indexes are keyset-friendly) → archive old audit rows to cold storage after the retention period → monthly partitioning of `audit_events` → read replica for analytics. None is needed at pilot scale; `docs/performance.md` records when to revisit.
