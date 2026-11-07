# Carevanta — Requirements inventory, functional matrix and open questions

Sources reviewed: the founder's original idea (patient app, provider apps, super-admin), the full product analysis document (sections 1–32: search, location discovery, booking, hospitals, diagnostics, pharmacy, health records, family, emergency, provider onboarding, verification, affiliations, portals, super-admin, payments, privacy, telemedicine, search architecture, technical architecture, data model, risks, business model, MVP phases), the commission-model addendum, and the engineering brief ("Production-Grade Healthcare Marketplace Backend & Super Admin Platform").

Scope of this delivery: **backend foundation + super-admin application**. Patient, doctor and ambulance mobile apps and the provider web portals are out of scope for this phase; the API already exposes the endpoints they will need (`/patient/*`, `/portal/*`).

## 1. Requirements inventory

| # | Area | Requirement (condensed) | Source | Status |
|---|---|---|---|---|
| R1 | Identity | Login identity separate from roles; users may hold several roles; provider membership separate from platform roles | Analysis §22, brief §5A | Done |
| R2 | Identity | Argon2id passwords, short-lived access tokens, refresh rotation with revocation, lockout, password reset, email/phone verification | Brief §3/§7 | Done |
| R3 | Access | Role- and permission-based authorisation enforced server-side; object-level checks (no IDOR) | Brief §7 | Done |
| R4 | Providers | Shared provider core + type-specific profiles for doctor, hospital, clinic, lab, imaging centre, pharmacy, ambulance operator | Brief §5B | Done |
| R5 | Providers | Branches/locations, opening hours, service areas, staff membership, documents, payout accounts, agreements | Brief §5B | Done |
| R6 | Verification | Verification case per provider with per-check status, evidence, method; manual review where no API exists; expiry tracking; re-verification | Analysis §13, brief §5H | Done (manual + registry-lookup methods; no government API integration claimed) |
| R7 | Verification | Separation of duties: registrar ≠ verifier/approver; uploader ≠ document reviewer | Brief §7 | Done |
| R8 | Affiliations | One doctor identity, many facilities; invite/request/accept/verify state machine; facility cannot edit doctor profile | Analysis §14, brief §5C | Done |
| R9 | Catalogue | Controlled taxonomy (specialities, conditions/symptoms, departments, amenities, services/tests, medicines); condition→speciality mappings as reviewed clinical routing, not diagnosis | Analysis §20, brief §5D | Done (mappings require a reviewer ≠ proposer) |
| R10 | Discovery | Search by condition with location filtering and distance ranking; verified providers only; red-flag symptoms show emergency guidance first | Analysis §2 M1–M2 | Done (bounding box + haversine; PostGIS deferred) |
| R11 | Scheduling | Per-location schedules, slot generation, capacity, blocking; a doctor cannot be double-scheduled across facilities | Analysis §3 | Done (DB EXCLUDE constraint) |
| R12 | Booking | Request/confirm/check-in/complete/cancel/reschedule/no-show with explicit transitions; double-booking prevention; idempotent retries; attribution | Brief §5E | Done |
| R13 | Diagnostics | Orders, tests, home collection coverage, prescription requirement, versioned reports with correction reasons, access logging | Analysis §5 | Done (report files in private storage; structured results deferred) |
| R14 | Pharmacy | Catalogue with schedules, batch/expiry inventory, FEFO reservation, prescription review by pharmacist, no automatic substitution | Analysis §6 | Done (delivery requires coverage; legal review flagged) |
| R15 | Ambulance | Operators, vehicles, crew, dispatch lifecycle, operator acceptance only, escalation, TEST mode, 112 guidance first, live dispatch off by default | Analysis §9, brief §5F | Done |
| R16 | Finance | Effective-dated commission policies by category/provider type/provider; immutable snapshots; integer money; webhook-verified payments; refunds; ledger; maker-checker settlements with evidence; reconciliation; idempotency keys | Addendum, brief §5G | Done |
| R17 | Finance | Legal gate for referral-type commissions (surgery/procedures) | Addendum | Done (cannot activate without recorded legal approval; production requires it for all) |
| R18 | Admin | Users, roles, providers, verification, catalogue, bookings, finance, support, notifications, settings, audit, exports, regions, compliance, analytics | Brief §6/§8 | API done; dashboard in `Carevanta_Super_Admin_Dashboard` |
| R19 | Privacy | Consent records, sensitive-access logs, legal holds, anonymisation, incidents, encrypted bank numbers, no secrets/clinical text in audit | Brief §5I | Done |
| R20 | Ops | Structured logs with request ids, redaction, health/readiness, graceful shutdown, background jobs, migrations, backups guidance | Brief §4/§12 | Done (docs/operations.md) |
| R21 | Quality | Automated tests incl. concurrency, auth, finance, migrations; benchmarks with explicit targets; query-plan review | Brief §10/§11 | Done (113 tests; see docs/testing.md and docs/performance.md) |
| R22 | Patient features | Family profiles, reminders, health records, journey tracking, cost estimates | Analysis §7–§10 | Partial: family profiles + report/prescription storage exist; reminders, journeys, estimates deferred |
| R23 | Telemedicine | Video consultations under TPG 2020 | Analysis §19 | Deferred (consultation `mode` field exists; not enabled) |
| R24 | Health records / ABDM | ABDM-compatible records | Analysis §7 | Deferred — needs ABHA/HPR/HFR integration decision |

## 2. Functional requirements matrix (API → permission → audit)

| Capability | Endpoints (prefix `/api/v1`) | Permission / rule | Audited |
|---|---|---|---|
| Sign in / tokens | `POST /auth/login`, `/auth/refresh`, `/auth/logout` | public / own session | login, lockout, reuse detection |
| Self-service account | `/auth/me`, `/auth/password/*`, `/auth/verify/*`, `/auth/sessions` | own account | yes |
| Patient registration | `POST /auth/register` | public, rate-limited | yes |
| User admin | `/admin/users*` | `users.*`, `roles.assign`; anti-escalation rules | yes |
| Roles | `/admin/roles*`, `/admin/permissions` | `roles.read`, `roles.manage` | yes |
| Providers | `/admin/providers*` | `providers.*` | yes (status history + audit) |
| Documents | `/admin/providers/:id/documents*` | `providers.documents.*`; file open needs `?purpose=` | yes + sensitive-access log |
| Payout accounts | `/admin/providers/:id/payout-accounts*` | `providers.payout.*`; verifier ≠ creator | yes |
| Verification | `/admin/verification-cases*` | `providers.verify`, `providers.approve`; registrar ≠ verifier | yes |
| Catalogue | `/admin/catalogue/*` | `catalogue.read/manage`, `catalogue.mappings.review` (reviewer ≠ proposer) | yes |
| Discovery | `GET /discovery/search`, `/discovery/doctors/:id/slots` | public; APPROVED+listed providers; APPROVED mappings | – |
| Affiliations | `/admin/affiliations*`, `/portal/providers/:id/affiliations*`, `/portal/doctor/affiliations*` | platform `affiliations.*`; provider capability `manage_affiliations`; doctor = own profile | yes (event log) |
| Scheduling | `/schedules*`, `/slots*` | `schedules.manage` or own doctor / facility `manage_schedules` | yes |
| Appointments | `/admin/appointments*`, `/portal/providers/:id/appointments*`, `/patient/appointments*` | `bookings.*`; capability `manage_bookings`; patients own profiles only | yes (event log) |
| Payments | `POST /patient/transactions/:id/payment-order`, `POST /webhooks/*` | own transaction; HMAC-verified webhook | yes |
| Commission policies | `/admin/finance/commission-policies*` | `finance.policies.manage/approve/legal_review`; approver ≠ author | yes |
| Refunds | `/admin/finance/refunds*` | `finance.refunds.request/approve`; approver ≠ requester | yes |
| Settlements | `/admin/finance/settlements*`, `/settlement-items/*` | `finance.settlements.create/approve/record`; approver ≠ maker; UTR required | yes |
| Reconciliation | `/admin/finance/reconciliation/*` | `finance.reconcile` | yes |
| Diagnostics | `/admin/diagnostic-orders*`, `/portal/providers/:id/diagnostic-orders/*` | `diagnostics.*`; capability `publish_reports` | yes + sensitive-access log |
| Pharmacy | `/admin/pharmacies/:id/inventory`, `/admin/pharmacy-orders*`, `/portal/.../prescriptions/:id/review` | `pharmacy.*`; capability `review_prescriptions` | yes |
| Ambulance / dispatch | `/admin/ambulance/*`, `/admin/dispatch*`, `/portal/providers/:id/dispatch/*`, `POST /patient/emergency` | `ambulance.*`, `dispatch.*`; capability `manage_dispatch` | yes (event log) |
| Support | `/admin/support-cases*`, `/admin/notes` | `support.*` | yes |
| Settings / audit / notifications / regions / compliance | `/admin/settings*`, `/admin/audit-events*`, `/admin/notifications*`, `/admin/regions*`, `/admin/compliance/*` | respective permissions | yes |
| Analytics | `/admin/analytics/*` | `analytics.read` | – |
| Exports | `/admin/exports*` | `exports.create/read`; downloads logged | yes |

The machine-readable version is `docs/openapi.json` (238 operations) and the live Swagger UI at `/docs`.

## 3. Contradictions and assumptions resolved

| Topic | Decision | Rationale |
|---|---|---|
| Commission on surgery/treatment (founder) vs NMC 6.4.1 (analysis) | Modelled, but un-activatable without recorded legal approval; production requires legal approval for every policy | Keeps the founder's model possible without shipping a potentially unlawful arrangement |
| Launch city: Kolkata vs Hyderabad vs Moyna/Tamluk | Moyna and Tamluk (brief) seeded as PILOT regions | Latest instruction wins; regions are data, not code |
| Express vs NestJS | Express 5 with a typed route layer (`defineRoute`) that generates OpenAPI from Zod | Brief allows Express; the route layer gives the structure NestJS would without the framework weight |
| PostGIS vs plain columns | numeric lat/lng + composite index + bounding-box prefilter | Pilot is two blocks; PostGIS adds an extension dependency with no measurable benefit at this scale — revisit when multi-district search slows (see performance doc) |
| Redis | Not used | No demonstrated need: rate limits are per instance + DB lockout; jobs use cron schedules with MongoDB leases; caching limited to two 30 s in-process TTL caches (platform settings; analytics overview/series) |
| Who owns the appointment fee | Slot carries the fee; schedule fee → affiliation fee → doctor default | Facility-set fees are visible to the doctor at invitation time |
| Who confirms a booking | Provider (setting `booking.require_provider_confirmation`, default on) | Analysis §30 |
| Who issues invoices | Provider is the seller; platform fee invoiced to provider (not implemented as documents yet) | Needs CA confirmation (open question Q3) |
| Walk-in commission | Off by default (`finance.commission_on_provider_direct`) | Provider-direct bookings are not platform-attributed |

## 4. Unresolved business, medical and regulatory questions

| # | Question | Why it matters | Default used meanwhile |
|---|---|---|---|
| Q1 | Can Carevanta lawfully charge a percentage of hospital procedure/surgery bills? (NMC Code of Medical Ethics 2002 §6.4.1 and 2023 regulations status) | Core revenue line | PROCEDURE/SURGERY policies blocked until a lawyer records APPROVED |
| Q2 | Does collecting patient payments and paying providers make Carevanta a payment aggregator under RBI PA/PG guidelines? Should Razorpay Route (split settlements) be used instead of platform-held funds? | Licensing, nodal/escrow account | Gateway collects; ledger tracks; payouts are manual bank transfers with UTR evidence |
| Q3 | GST treatment: is the platform fee a taxable service at 18%? Who invoices whom? | `taxRateBps` on policies, invoicing documents | `taxRateBps` configurable per policy; no invoice PDFs generated |
| Q4 | West Bengal Clinical Establishments Act 2017 registration: which provider types in Moyna/Tamluk must hold it, and how is it verified? | Required check for hospitals, clinics, labs | Manual document review (`FACILITY_REGISTRATION` check) |
| Q5 | Doctor registration verification source: WBMC register (manual lookup) now; NMC NMR / ABDM HPR API access later? | Credential trust | `OFFICIAL_REGISTRY_LOOKUP` method records the reference the officer used |
| Q6 | Pharmacy: may Schedule H medicines be delivered to the home, and under what record-keeping? (Drugs & Cosmetics Rules; e-pharmacy draft rules) | Delivery feature | Delivery only where the pharmacy enables it; pharmacist approval required; flagged for counsel |
| Q7 | Diagnostics: PC-PNDT obligations for ultrasound listings; AERB licence for X-ray/CT | Listing imaging services | Fields captured; `RADIOLOGY_LICENSE` check required for imaging centres |
| Q8 | Ambulance: permits under the Motor Vehicles Act, liability for a failed dispatch, relationship with 108/112 | Safety | Live dispatch disabled; 112 shown first; escalation workflow |
| Q9 | DPDP Act 2023: retention periods per record type, children's data (guardian consent), Data Protection Board breach notification timelines, consent manager | Retention and anonymisation policy | Legal holds + anonymisation implemented; retention periods not set |
| Q10 | Data residency: the Atlas cluster region must be checked in the Atlas UI. Is that acceptable for Indian health data and RBI payment-data rules? | Hosting choice | Payment data stays with the gateway; recommend an India/Singapore region before launch |
| Q11 | Telemedicine (TPG 2020): when (if) to enable teleconsultation | Product phase 2 | `mode` field exists; not enabled |
| Q12 | Consumer Protection (E-Commerce) Rules 2020: grievance officer, mandatory disclosures | Support process | Support cases + SLA implemented; officer not designated |
| Q13 | Business defaults: 120-minute patient cancellation cutoff, 7-day settlement hold, walk-in commission off, 15 km search radius | Revenue and UX | Settings, changeable in admin |
| Q14 | Who sets a doctor's fee at a hospital — the hospital, the doctor, or negotiated? | Affiliation terms | Facility proposes in the invitation; doctor accepts |
| Q15 | Will hospitals integrate existing HIS/scheduling software? | Double-booking across systems | Provider-side portal is the system of record; integration API later |
