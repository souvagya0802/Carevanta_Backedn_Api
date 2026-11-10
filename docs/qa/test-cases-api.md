# Carevanta API — test case catalogue (edge and corner cases)

Version 2026-11-10. Companion to `docs/qa/test-plan.md` (browser flows). This catalogue lists the API-level cases, with the emphasis on boundaries, state machines, money, authorisation and concurrency. Every automated case runs in vitest against the in-memory MongoDB (`npm test`); the file names below are under `tests/`. "Manual" cases need a running stack, a real clock or a real gateway.

Priority: **P1** must pass before any release (money, privacy, safety), **P2** core flow correctness, **P3** robustness and polish.

Conventions used in the steps: `admin` = SUPER_ADMIN, `registrar` = PLATFORM_ADMIN, `verifier` = VERIFICATION_OFFICER, `maker`/`checker` = FINANCE_OFFICER / FINANCE_APPROVER, `patient` = a user with a SELF profile. Money is paise. All responses are the `{ data }` / `{ error: { code, message, details, requestId } }` envelope.

## 1. Auth and sessions (`tests/integration/edge-auth.test.ts`, `auth.test.ts`)

| ID | Preconditions | Steps | Expected | Pri | Automated |
|---|---|---|---|---|---|
| AUTH-01 | Active user | Login with the email upper-cased and padded with spaces | 200, same account | P2 | EDGE-AUTH-01 |
| AUTH-02 | User with phone `+91…` | Login with `98xxxxxxxx`, `+91 98xxx xxxxx`, `98xxx-xxxxx`, `(+91) 98…` | 200 each, `/me` returns the same id | P2 | EDGE-AUTH-02 |
| AUTH-03 | — | Login with `098…` (leading zero) or a landline-looking `33…` number | 400 VALIDATION_FAILED, never 500 | P3 | EDGE-AUTH-02 |
| AUTH-04 | — | Identifier of 2 chars; password of 129 chars; empty password; empty body | 400 with one issue per field; 128-char password passes validation (401) | P3 | EDGE-AUTH-03 |
| AUTH-05 | Active user | 4 wrong passwords, 1 correct, 4 wrong, 1 correct, 5 wrong | Counter resets on success; 5th consecutive failure locks (423 ACCOUNT_LOCKED with `lockedUntil`) | P1 | EDGE-AUTH-04 |
| AUTH-06 | Locked user, lock expired | Login with the correct password | 200; `failedLoginCount` 0, `lockedUntil` null | P2 | EDGE-AUTH-05 |
| AUTH-07 | Locked user | `POST /admin/users/:id/unlock`, then login | 204, then 200; unknown id 404 | P2 | EDGE-AUTH-05 |
| AUTH-08 | — | Refresh with 8-char token / 43 random chars | 400 / 401 TOKEN_INVALID | P2 | EDGE-AUTH-06 |
| AUTH-09 | Logged-in user | Logout, then refresh the old token | 401 | P1 | EDGE-AUTH-06 |
| AUTH-10 | Session `expiresAt` in the past | Refresh; use the (still unexpired) access token | 401 both | P1 | EDGE-AUTH-06 |
| AUTH-11 | User SUSPENDED after login | Refresh | 403 ACCOUNT_INACTIVE | P1 | EDGE-AUTH-07 |
| AUTH-12 | Two sessions | `logout { allDevices: true }` from one | Other access token 401, other refresh 401 | P1 | EDGE-AUTH-07 |
| AUTH-13 | Two users | Alice deletes Bob's session id; non-UUID id; Alice deletes her own current session | 404; 400; 204 and her `/me` is 401, Bob unaffected | P1 | EDGE-AUTH-08 |
| AUTH-14 | — | `Authorization: Bearer` (empty), `Basic …`, lower-case `bearer`, 5000-char token, `a.b.c` | 401, never 500 | P2 | EDGE-AUTH-09 |
| AUTH-15 | — | Register with Bengali name padded with spaces, `Reg-X@Test.Carevanta.Local`, phone `98xxx xxxxx` | 201 PENDING_VERIFICATION; name trimmed, email lower-cased, phone `+91…`, SELF profile with the phone | P2 | EDGE-AUTH-10 |
| AUTH-16 | Registered user | Register again with the email in another case, or the phone in E.164 | 409 with the same neutral message for both | P1 | EDGE-AUTH-10 |
| AUTH-17 | — | Name of 1 / 161 chars; phone `09…` / 21 digits; bad email; passwords `aaaaaaaaaaaa`, `carevanta123`, 7 chars, 129 chars; no contact | 400 each; 160-char name and 128-char password accepted | P3 | EDGE-AUTH-11 |
| AUTH-18 | Phone-registered user (OTP queued) | Confirm without `userId`; with another `userId`; wrong code; right code; replay; request SMS again; request EMAIL | 400; 400; 400; 200 ACTIVE; 400; 409 already verified; 400 no email | P1 | EDGE-AUTH-12 |
| AUTH-19 | Forgot-password sent | Expire the token, reset | 400 TOKEN_INVALID, old password still works | P1 | EDGE-AUTH-13 |
| AUTH-20 | DEACTIVATED user / junk identifier | `password/forgot` | 202 both, no notification queued | P1 | EDGE-AUTH-13 |
| AUTH-21 | Signed-in user | Change password to the same one; wrong current; `password123` | 400; 401; 400; session still valid afterwards | P2 | EDGE-AUTH-14 |
| AUTH-22 | — | Refresh-token reuse after the 30 s grace window | Whole family revoked, 401 | P1 | auth.test "detects reuse" |
| AUTH-23 | — | Two concurrent refreshes of one token | Both succeed within the same family | P2 | auth.test "two concurrent refreshes" |
| AUTH-24 | Real clock | 15-minute access token used at 14:59 and 15:01 | 200 then 401 | P2 | manual (expiry covered with a forged `exp` in auth.test) |
| AUTH-25 | `RATE_LIMIT_IN_TESTS=true` or live stack | 21 logins in a minute from one IP | 21st is 429 with `Retry-After: 60`; refresh has its own 300/min budget | P2 | manual |

## 2. HTTP contract, pagination, idempotency, permissions (`edge-http.test.ts`)

| ID | Preconditions | Steps | Expected | Pri | Automated |
|---|---|---|---|---|---|
| HTTP-01 | ≥4 users | `GET /admin/users?limit=` 0, -1, 101, 1.5, abc, empty | 400 VALIDATION_FAILED each | P2 | EDGE-HTTP-01 |
| HTTP-02 | ≥4 users | `limit=1` then follow `nextCursor`; `limit=100` | Page meta `{limit, hasMore, nextCursor}`; second page differs; walking 1-by-1 visits every row exactly once | P2 | EDGE-HTTP-01 |
| HTTP-03 | — | Cursor: garbage, JSON without id, bad date, path-like id, array, 201 chars | 400, never 500 | P2 | EDGE-HTTP-02 |
| HTTP-04 | — | Body `{"identifier": `, `[1,2,3]`, `"string"`; 300 kB body; unknown field on a `.strict()` body | 400 Malformed JSON; 400; 400; 413 PAYLOAD_TOO_LARGE; 400 | P2 | EDGE-HTTP-03 |
| HTTP-05 | — | Unknown route, wrong method, `/api/v2`, `/api/v1/../../etc/passwd` | JSON 404 NOT_FOUND with `requestId` | P3 | EDGE-HTTP-04 |
| HTTP-06 | admin | Every `GET …/:id` route with `123` and with a random UUID (15 routes) | 400 then 404 (or an empty list for sub-collections), never 500 | P1 | EDGE-HTTP-05 |
| HTTP-07 | admin | 17 write routes with a ghost id | 404 before any state check | P2 | EDGE-HTTP-06 |
| HTTP-08 | AUDITOR, LEGAL_REVIEWER, CLINICAL_REVIEWER, OPERATIONS_DISPATCHER, no-role user | Writes outside each role's remit (users, providers, roles, support, policies, catalogue, settlements, vehicles) | 403 FORBIDDEN each; the auditor's reads still 200; no-role list 403 | P1 | EDGE-HTTP-07 |
| HTTP-09 | Patient with a bookable slot | Idempotency-Key empty / 5 chars / spaces / 81 chars / slash / tab | 400 each | P2 | EDGE-HTTP-08 |
| HTTP-10 | Same | Failed attempt (404) with key K, then a good booking with K, replay with K, then K with another slot | key is not burnt; 201; 201 + `Idempotent-Replayed: true` same id; 422 IDEMPOTENCY_CONFLICT | P1 | EDGE-HTTP-08 |
| HTTP-11 | Two patients | Both use the same key string | Keys are per user: both bookings succeed | P2 | EDGE-HTTP-08 |
| HTTP-12 | — | Same key, same body with the JSON keys in another order | Replayed (canonical hash) | P3 | EDGE-HTTP-08 |
| HTTP-13 | Same key in flight twice | Fire two identical requests at once | One 201, the other 201 replay or 409 "still being processed"; never two bookings | P1 | bookings.test "idempotent retries" |
| HTTP-14 | Live stack | 601 requests/min from one IP | 429 on the global limiter | P3 | manual |

## 3. Users and roles (`edge-users-affiliations.test.ts`, `users-roles.test.ts`, `roles.test.ts`)

| ID | Preconditions | Steps | Expected | Pri | Automated |
|---|---|---|---|---|---|
| USER-01 | Verified user | PATCH email to the same address upper-cased | 200, stored lower-case, **stays verified** (bug fixed) | P2 | EDGE-USER-01 |
| USER-02 | User with email only | PATCH `email: null` | 400 "needs an email or mobile" | P2 | EDGE-USER-01 |
| USER-03 | Another user owns phone X | PATCH phone X; phone `09…`; language `fr`; empty body | 409; 400; 400; 200 no-op | P2 | EDGE-USER-01 |
| USER-04 | Verified user | PATCH to a new email | 200, `emailVerified: false` | P2 | EDGE-USER-01 |
| USER-05 | ACTIVE user | status ACTIVE→ACTIVE; reason `bad`; status ANONYMISED via status route | 409 INVALID_STATE_TRANSITION; 400; 400 | P2 | EDGE-USER-02 |
| USER-06 | DEACTIVATED user | → SUSPENDED; → ACTIVE | 409; 200 | P2 | EDGE-USER-02 |
| USER-07 | ACTIVE user | Anonymise with `confirm: YES`; with `ANONYMISE`; again; then any status/edit/role change | 400; 204; 409; 409 each | P1 | EDGE-USER-02 |
| USER-08 | User | Grant unknown role; grant AUDITOR twice; revoke FINANCE_OFFICER not held; revoke AUDITOR twice; grant after revoke; grant to DEACTIVATED user | 404; 200/409; 404; 200/404; 200; 409 | P2 | EDGE-USER-03 |
| USER-09 | Doctor user, provider owner, plain patient | Anonymise each | 422 (professional records); 422 (transfer ownership); 204 — sessions revoked (401) and login impossible (401) | P1 | EDGE-USER-04 |
| USER-10 | Last active super-admin | Suspend / anonymise | 422 | P1 | users-roles.test |
| USER-11 | Admin | Change own status; grant self a role; grant SUPER_ADMIN as PLATFORM_ADMIN | 403 each | P1 | users-roles.test |
| USER-12 | Role manager | Remove `roles.manage` from the only role granting it to themselves; edit a system role; delete a role with history | 409/422; 403; 409 | P2 | roles.test |

## 4. Providers (`edge-providers.test.ts`, `providers.test.ts`, `verification-registries.test.ts`)

| ID | Preconditions | Steps | Expected | Pri | Automated |
|---|---|---|---|---|---|
| PROV-01 | registrar | Register a clinic with PIN `72163`, `0721636`, `721636 `, `ABCDEF`; lat 90.0001; lng -180.0001; lat as string; phone `12345`, 19-digit E.164, `58…`; name 1/201 chars; blank legal name; `owner@`; GSTIN bad check digit; 21 locations; type DENTIST | 400 each | P2 | EDGE-PROV-01 |
| PROV-02 | registrar | Register with Bengali display name, 200-char legal name, lat -90 / lng 180, PIN `100000`, phone `+91…` | 201; slug non-empty; phone stored E.164 | P3 | EDGE-PROV-01 |
| PROV-03 | registrar | Doctor with 6 specialities / unknown code / primary outside the list / no registration / degree year 1949 / fee -1 / fee 100.5 / 71 years experience / no owner | 400 each | P2 | EDGE-PROV-02 |
| PROV-04 | registrar | Doctor with `defaultFeeMinor: 0` | 201, fee 0 (free consultations are legal) | P2 | EDGE-PROV-02 |
| PROV-05 | A doctor registered with council number `wbmc-x` | Register another with `WBMC-X` and with `  wbmc-x  ` | 409 both (upper-cased and trimmed before the unique check — trim is a fix) | P1 | EDGE-PROV-03 |
| PROV-06 | DRAFT clinic | SUSPEND; REACTIVATE; DEACTIVATE with reason `bye`; DEACTIVATE; DEACTIVATE again; REACTIVATE; submit; PATCH; upload document | 409; 409; 400; 200; 409; 409; 409; 409; 409 | P1 | EDGE-PROV-04 |
| PROV-07 | Clinics without location / without contact / with the only location deactivated | Submit | 422 with `details.problems` naming the gap; re-activating the location lets it through; a second submit is 409 | P2 | EDGE-PROV-05 |
| PROV-08 | Approved hospital with an affiliated doctor and open slots | SUSPEND the hospital | Slots at its locations BLOCKED; `/discovery/doctors/:id/slots` empty; booking refused; `/discovery/providers/:id` 404 | P1 | EDGE-PROV-06 |
| PROV-09 | Same, after suspension | REACTIVATE | **Facility slots re-open** (bug fixed), slots listed again, booking succeeds | P1 | EDGE-PROV-06 |
| PROV-10 | Clinic location | Hours: open=close; close<open; overlap on one day (720 vs 719); day 7; open -1; close 1441; 29 windows | 400 each | P2 | EDGE-PROV-07 |
| PROV-11 | Clinic location | Hours: adjacent 540–720 and 720–900; 0–1440; a closed day; then `hours: []` | 200, 4 rows; **empty list clears the week (500 fixed)** | P2 | EDGE-PROV-07 |
| PROV-12 | Two providers | PUT hours on provider B using provider A's location id | 404 | P1 | EDGE-PROV-07 |
| PROV-13 | Lab | Service areas: PIN `72163`; district `P`; purpose DRONE; 201 rows; duplicates; `areas: []` | 400 ×4; duplicates collapsed to 2; **empty clears coverage (500 fixed)** | P2 | EDGE-PROV-08 |
| PROV-14 | Hospital with owner | Add DEACTIVATED user; role JANITOR; ghost user; add staff twice | 400; 400; 400; 201 then 409 | P2 | EDGE-PROV-09 |
| PROV-15 | Same | Remove the only owner; remove yourself | 409 both | P1 | EDGE-PROV-09 |
| PROV-16 | Staff member removed | Remove again; add the same user back as ADMIN | 404; **201 — the row is re-activated with the new role (bug fixed)** | P2 | EDGE-PROV-09 |
| PROV-17 | Hospital | Payout account: 8 or 19 digits; IFSC 5th char not 0; 3-letter bank; spaces in number; 1-char holder | 400 each | P2 | EDGE-PROV-10 |
| PROV-18 | Hospital | Add with `ifsc: sbin0001234` | 201, IFSC upper-cased, full account number never in the response | P1 | EDGE-PROV-10 |
| PROV-19 | Account added by X | X verifies; verifier verifies; verifies again; ghost account | 403 SEPARATION_OF_DUTIES; 200; 409; 404 | P1 | EDGE-PROV-10 |
| PROV-20 | Clinic | Upload PNG bytes as `application/pdf`; PDF bytes as `image/png`; `text/plain`; empty body; `expiresAt` 2020; `expiresAt` `31-12-2030`; unknown documentType; empty fileName; 256-char fileName | 415; 415; 400; 400; 400; 400; 400; 400; 400 | P1 | EDGE-PROV-11 |
| PROV-21 | Clinic | fileName `../../etc/passwd`; a second upload of the same type | 201 with the name sanitised; first becomes SUPERSEDED | P2 | EDGE-PROV-11 |
| PROV-22 | Approved doctor | PATCH `facility` section; `expectedVersion: 0`; stale version; good edit; the old version again | 400; 400; 409; 200 version+1; 409 | P2 | EDGE-PROV-12 |
| PROV-23 | Live stack | Upload of `MAX_UPLOAD_BYTES`+1 (10 MB default) | 413 and the connection is not left hanging | P2 | manual |
| PROV-24 | Open verification case | Registrar records a check / decides; provider member decides; approve with a required check still PENDING; waive without 10-char note; PASSED without evidence | 403 SoD; 403; 422; 400; 400 | P1 | providers.test |
| PROV-25 | GSTIN with a wrong check digit | Register | 400 with the "re-check the number" message | P2 | verification-registries.test |

## 5. Affiliations (`edge-users-affiliations.test.ts`, `affiliations.test.ts`)

| ID | Preconditions | Steps | Expected | Pri | Automated |
|---|---|---|---|---|---|
| AFF-01 | Hospital owner | Invite a hospital as the doctor; a lab; unknown department; another facility's location; fee -1; `2026-13-01`; engagement LOCUM; ghost doctor | 400 each | P2 | EDGE-AFF-01 |
| AFF-02 | Platform admin | Create with a lab as the facility | 400 | P2 | EDGE-AFF-01 |
| AFF-03 | Doctor DEACTIVATED | Invite | 409 | P2 | EDGE-AFF-01 |
| AFF-04 | INVITED | Facility accepts; doctor withdraws; doctor ends; action `bogus` | 409; 403; 409; 400 | P1 | EDGE-AFF-02 |
| AFF-05 | Doctor declined (REJECTED) | Doctor accepts; facility withdraws; admin VERIFY | 409 INVALID_STATE_TRANSITION each (**terminal check now runs before preconditions**) | P2 | EDGE-AFF-02 |
| AFF-06 | After rejection | Doctor requests to join | 201 REQUESTED (not a duplicate) | P2 | EDGE-AFF-02 |
| AFF-07 | REQUESTED | Doctor accepts own request; facility withdraws; doctor withdraws; facility accepts the cancelled one | 409; 403; 200 CANCELLED; 409 | P1 | EDGE-AFF-02 |
| AFF-08 | ACTIVE with open slots | REACTIVATE; VERIFY; action ACCEPT via admin | 409; 409; 400 | P2 | EDGE-AFF-03 |
| AFF-09 | ACTIVE with open slots | SUSPEND; SUSPEND again; REACTIVATE | Slots BLOCKED and hidden; 409; slots OPEN again | P1 | EDGE-AFF-03 |
| AFF-10 | ACTIVE | END with a stale `expectedVersion`; END by the facility; then REACTIVATE / SUSPEND; create a schedule | 409; 200 with `endDate`; 409; refused | P1 | EDGE-AFF-03 |
| AFF-11 | Two concurrent invites for the same pair | Fire together | Exactly one 201, the other 409 | P1 | affiliations.test |
| AFF-12 | Creator of a platform affiliation | VERIFY own creation; verify when a party is not APPROVED | 403; 422 | P1 | affiliations.test |

## 6. Discovery, geo and public search (`edge-discovery-patient.test.ts`, `discovery.test.ts`, `smart-search.test.ts`, `geo.test.ts`)

| ID | Preconditions | Steps | Expected | Pri | Automated |
|---|---|---|---|---|---|
| DISC-01 | — | `q` of 1 / 101 chars; radius 0 / 101; limit 0 / 51; lat 91; lng 181; lat `abc`; blank `q`; no `q` | 400 each | P2 | EDGE-DISC-01 |
| DISC-02 | — | `q` of 100 chars; radius 1 / 100; limit 1 / 50; `(.*+?[]{}^$|\`; `' OR 1=1 --`; `{"$ne":null}`; Bengali; padded | 200 with the disclaimer and arrays | P1 | EDGE-DISC-01 |
| DISC-03 | — | `lat` without `lng` | 200, `radiusKm: null` (no distance filter); both → radius > 0 | P2 | EDGE-DISC-01 |
| DISC-04 | DRAFT doctor and DRAFT clinic with a rare word in the name | `/discovery/suggest?q=word`, `/discovery/providers?q=word` | Neither leaks the unapproved names | P1 | EDGE-DISC-02 |
| DISC-05 | — | Suggest `q` 1 / 121 chars; limit 0 / 21 | 400 | P3 | EDGE-DISC-02 |
| DISC-06 | Approved doctor with slots | Slots for ghost / DRAFT / `123`; `from=2026-11-10`; without offset; `locationId=nope` | 404; 404; 400; 400; 400; 400 | P2 | EDGE-DISC-03 |
| DISC-07 | Same | No params; a window entirely in the past; `to` before `from`; a foreign `locationId` | all slots with `available: 1`; `[]`; `[]`; `[]` | P2 | EDGE-DISC-03 |
| DISC-08 | Same | First slot's `startsAt` | 10:00 IST = 04:30 UTC (IST alignment, no DST) | P2 | EDGE-DISC-03 |
| DISC-09 | Slot starting in < 15 min | List / book | Not offered; booking says so (409) | P1 | qa-fixes.test CROSS-3 |
| DISC-10 | Provider in Delhi | Search from Tamluk with radius 15 | Not shown | P2 | discovery.test |
| DISC-11 | Red-flag words (`chest pain`, `snake bite`) | Search / suggest | Emergency guidance first with the configured number | P1 | discovery.test, smart-search.test |
| GEO-01 | — | `states?country=IND` / `I` / none; `cities` without state / unknown state; PIN `72163`, `7216360`, `72163A`, `0721636`, `721-636`; search `q=ab`, 201 chars, limit 0 / 11; reverse without lng, lng 187, lat -91 | 400 each | P2 | EDGE-GEO-01 |
| GEO-02 | — | `states?country=in`; `countries` | 200, > 30 Indian states/UTs; > 200 countries (nothing hardcoded to one state) | P2 | EDGE-GEO-01 |
| GEO-03 | Geocoder down (injected fetch) | search / reverse / PIN directory | 503 SERVICE_UNAVAILABLE, 404 unknown PIN | P2 | geo.test |
| GEO-04 | Live stack | 31 `/public/geo/search` calls in a minute from one IP | 429 (upstream quota protection) | P3 | manual |

## 7. Appointments and scheduling (owned by other agents; listed for completeness — `bookings.test.ts`, `portal-scheduling.test.ts`, `qa-fixes.test.ts`)

| ID | Preconditions | Steps | Expected | Pri | Automated |
|---|---|---|---|---|---|
| APPT-01 | Capacity-1 slot | 10 patients book at once | Exactly one 201 | P1 | bookings.test |
| APPT-02 | Capacity-3 slot | 10 at once | Exactly three 201 | P1 | bookings.test |
| APPT-03 | Patient A | Book / read with patient B's profile id | 404, never B's data | P1 | bookings.test (IDOR) |
| APPT-04 | REQUESTED appointment | Check-in before confirmation; check-in on another day; complete before check-in | 409 each | P1 | bookings.test |
| APPT-05 | CONFIRMED appointment | Cancel; cancel again | Capacity released; 409 | P1 | bookings.test |
| APPT-06 | Full target slot | Reschedule into it | 409, original untouched | P1 | bookings.test |
| APPT-07 | Weekly schedule 10:00–12:00 at hospital A | Add 11:00–13:00 at clinic B on the same weekday | 409 overlap (even at another place) | P1 | qa-fixes.test PORT-2 |
| APPT-08 | Slot already started | Walk-in on it; walk-in on an ended slot | 201 confirmed; 409 | P2 | qa-fixes.test PORT-4/17 |
| APPT-09 | Schedule crossing IST midnight (e.g. 23:30–00:30) | Generate slots | Slots are dated on the IST day they start; no slot spans two dates incorrectly | P2 | manual |
| APPT-10 | Slot on 31 Dec / 29 Feb | Generate across the year/leap boundary | Correct weekday mapping (IST), no duplicate or missing day | P3 | manual |
| APPT-11 | No-show before the slot starts | Mark NO_SHOW | 409 (only after start) | P2 | manual (check with the appointments agent's tests) |
| APPT-12 | Cancellation window setting | Cancel 1 minute after the cut-off | Refused with a clear message; refund policy applied per settings | P2 | manual |
| APPT-13 | Booked slot | Block it from the portal | 409 | P2 | portal-hardening.test |

## 8. Diagnostics (`edge-orders.test.ts`, `operations.test.ts`, `portal.test.ts`)

| ID | Preconditions | Steps | Expected | Pri | Automated |
|---|---|---|---|---|---|
| DX-01 | Approved lab with LFT | Order with 0 / 31 tests; ghost offering; another (draft) lab's offering; draft lab; HOME_COLLECTION without PIN / with `72163`; mode COURIER; ghost profile; `scheduledAt` without `T` | 400; 400; 400; 400; 422; 400; 400; 400; 404; 400 | P2 | EDGE-DX-01 |
| DX-02 | Patient | `scheduledAt` 1 h ago; 1 h ahead | 400; 201 REQUESTED | P2 | EDGE-DX-01 |
| DX-03 | REQUESTED order | SAMPLE_COLLECTED; REQUESTED; COMPLETED; REJECTED without reason; publish a report | 409; 400; 409; 400; 409 | P1 | EDGE-DX-02 |
| DX-04 | CONFIRMED order | CONFIRMED again; REJECTED with reason | 409; 409 (reject only from REQUESTED) | P2 | EDGE-DX-02 |
| DX-05 | PROCESSING order | CANCELLED with reason; REPORT_READY before any report | 409; 422 "Publish a report first" | P1 | EDGE-DX-02 |
| DX-06 | PROCESSING order | PNG bytes as PDF; PDF as `image/png`; v1; v2 without reason; reason `typo`; v2 with a reason | 415; 400; 201 v1; 400; 400; 201 v2, v1 AMENDED | P1 | EDGE-DX-02 |
| DX-07 | COMPLETED order | Any further status | 409 each | P1 | EDGE-DX-02 |
| DX-08 | Order of lab A | Lab B's owner advances / publishes under B; under A | 404; 404; 403 | P1 | EDGE-DX-02 |
| DX-09 | Report published | Patient A opens; patient B opens; admin without `?purpose=` | 200; 404; 400 | P1 | operations.test |
| DX-10 | Home collection, PIN outside coverage; test not collectable at home | Order | 422 each | P1 | operations.test |

## 9. Pharmacy (`edge-orders.test.ts`, `operations.test.ts`, `portal.test.ts`)

| ID | Preconditions | Steps | Expected | Pri | Automated |
|---|---|---|---|---|---|
| RX-01 | Approved pharmacy | Batch expiring today / yesterday / `2030-02-30`; qty -1 / 1,000,001 / 1.5; batch `` / 65 chars; another pharmacy's location; ghost medicine; MRP -1; selling > MRP | 400 each | P2 | EDGE-RX-01 |
| RX-02 | — | Inventory on a ghost id; on a hospital id | 404; 404 | P2 | EDGE-RX-01 |
| RX-03 | Pharmacy | Selling price = MRP; a batch expiring in 29 days | 200; listed with `available: 0`, `expiringSoon: true`, `onShelf: 5` | P2 | EDGE-RX-01 |
| RX-04 | 4 of 10 reserved | Correct on-hand to 3; to 4; order 1 more than the sellable remainder | 409; 200; 409 insufficient (near-expiry batch is never reserved) | P1 | EDGE-RX-01 |
| RX-05 | Pharmacy that does not deliver; draft pharmacy | Items [] / 51 / qty 0 / 1001; DELIVERY without PIN; DELIVERY with PIN; draft pharmacy; qty 11 of 10; ghost prescription | 400 ×4; 400; 422; 422; 409; 400 | P2 | EDGE-RX-02 |
| RX-06 | PLACED order (2 reserved) | PREPARING; PLACED; DELIVERED; CANCELLED without reason; ACCEPTED; READY_FOR_PICKUP; PREPARING; OUT_FOR_DELIVERY; CANCELLED with reason; RETURNED with reason; DELIVERED | 409; 400; 409; 400; 200; 409; 200; 200; 409; 200 (reserved back to 0, on-hand unchanged); 409 | P1 | EDGE-RX-02 |
| RX-07 | Another PLACED order | ACCEPTED → PREPARING → READY_FOR_PICKUP → DELIVERED; then CANCELLED / RETURNED / ACCEPTED | On-hand 10→8, reserved 0; 409 each | P1 | EDGE-RX-02 |
| RX-08 | PLACED order | Patient cancels; cancels again; a stranger cancels / reads another order | 200 (stock released); 409; 404; 404 | P1 | EDGE-RX-02 |
| RX-09 | Schedule-H medicine, uploaded prescription | Upload PNG as PDF; `issuedOn=31-12-2026`; a stranger uploads for the profile | 415; 400; 404 | P1 | EDGE-RX-03 |
| RX-10 | Order in PRESCRIPTION_REVIEW | ACCEPT before review; review by another pharmacy (own id / this id); decision MAYBE; APPROVED with `validUntil` yesterday; REJECTED; ACCEPT; APPROVED (+30 d); ACCEPT | 422; 404; 403; 400; **400 (fix)**; 200; 422; 200; 200 | P1 | EDGE-RX-03 |
| RX-11 | Pharmacy owner with lapsed drug licence | Maintenance job | Pharmacy SUSPENDED and a renewal case opened | P1 | maintenance.test |
| RX-12 | Patient | `issuedOn` in the future on a prescription upload | Currently accepted (see findings) — should be 400 | P3 | manual |

## 10. Ambulance and emergencies (`edge-orders.test.ts`, `operations.test.ts`, `portal-hardening.test.ts`)

| ID | Preconditions | Steps | Expected | Pri | Automated |
|---|---|---|---|---|---|
| AMB-01 | Approved operator | Registration `WB29AB12345`, `29WB1234`, `WB29ABCD1234`; insurance yesterday; `01/01/2030`; type HELICOPTER; 41 equipment items; hospital as operator; ghost base location | 400 each | P2 | EDGE-AMB-01 |
| AMB-02 | — | Register `wb29ec1234` with an expired fitness date; the same number again | 201 upper-cased; 409 duplicate | P2 | EDGE-AMB-01 |
| AMB-03 | Vehicle with expired fitness | AVAILABLE; fix the date; AVAILABLE; ON_TRIP via the status route | 422; 200; 400 | P1 | EDGE-AMB-01 |
| AMB-04 | Draft operator | Register a vehicle; make it AVAILABLE | 201; 422 operator not approved | P1 | EDGE-AMB-01 |
| AMB-05 | Operator | Driver without licence; licence expired; role PILOT; crew on a hospital | 400; 400; 400; 404 | P2 | EDGE-AMB-01 |
| AMB-06 | Patient | Emergency with phone `12345`; lat 91; 501-char address | 400 each | P2 | EDGE-AMB-02 |
| AMB-07 | Live dispatch disabled | Emergency | 201, `callNow: 112`, `ambulanceConfirmed: false`, message starts "Call 112 now" | P1 | EDGE-AMB-02 |
| AMB-08 | Request by patient A | Patient B reads it | 404 | P1 | EDGE-AMB-02 |
| AMB-09 | Open request | Escalate with note `hmm`; cancel; cancel again; escalate | 400; 200; 409 INVALID_STATE_TRANSITION; 409; patient sees CANCELLED | P1 | EDGE-AMB-02 |
| AMB-10 | Live dispatch on, two operators offered | Both accept at once | One 200, the other 409 "already accepted" | P1 | operations.test |
| AMB-11 | Vehicle ON_TRIP | Operator toggles it OUT_OF_SERVICE in the portal | 409 | P2 | portal-hardening.test |

## 11. Reviews, family profiles, support (`edge-discovery-patient.test.ts`, `support.test.ts`, `qa-fixes.test.ts`)

| ID | Preconditions | Steps | Expected | Pri | Automated |
|---|---|---|---|---|---|
| FAM-01 | Patient | Child born tomorrow; relationship SELF; name `K`; `2020-02-30`; gender BOY | 400 each | P2 | EDGE-FAM-01 |
| FAM-02 | Patient | Child born today; 8 more; the 11th; deactivate one; add one more | 201 (DOB echoed); 201 ×8; 400 (max 10); 200; 201; list shows 10 | P2 | EDGE-FAM-01 |
| FAM-03 | Patient | Deactivate SELF; phone `12345`; DOB tomorrow; `dateOfBirth: null` + Bengali name | 400; 400; 400; 200 cleared | P2 | EDGE-FAM-01 |
| FAM-04 | Two patients | B edits A's profile | 404 | P1 | EDGE-FAM-01 |
| REV-01 | REQUESTED appointment | Review | 409 "once it is completed" | P1 | EDGE-FAM-02 |
| REV-02 | COMPLETED appointment | Rating 0 / 6 / 4.5; 2001-char comment; ghost appointment; a stranger reviews it | 400 ×4; 404; 404 | P1 | EDGE-FAM-02 |
| REV-03 | Same | Review with a padded Bengali comment; review again | 201 PENDING_MODERATION, comment trimmed; 409 | P1 | EDGE-FAM-02 |
| REV-04 | Pending review | Public list; moderate MAYBE; PUBLISHED; PUBLISHED again; HIDDEN | empty; 400; 200 (hospital and doctor rating 5.00 ×1, author shortened, no email); 409; 200 and count back to 0 | P1 | EDGE-FAM-02 |
| SUP-01 | Support agent | Subject 2 / 201 chars; description 4 chars; priority CRITICAL; type PRAISE; category `x`; ghost provider / transaction; reporter `nope` | 400 each | P2 | EDGE-SUP-01 |
| SUP-02 | OPEN case | status OPEN; RESOLVED without note / with `ok`; ESCALATED without note; CLOSED without note; IN_PROGRESS | 409; 400; 400; 400; 400; 200 | P2 | EDGE-SUP-01 |
| SUP-03 | IN_PROGRESS case | Assign ghost; assign self; assign self again | 400; 200; 409 | P2 | EDGE-SUP-01 |
| SUP-04 | RESOLVED case | Reopen; CLOSED without note; CLOSED with a stale version; CLOSED with note; then comment / unassign / patch / reopen | 200; 400; 409; 200; 409 each | P2 | EDGE-SUP-01 |
| SUP-05 | Cases of every priority | Stats and SLA | Breach computed from the priority table served by `/options` | P2 | support.test |

## 12. Finance (`edge-finance.test.ts`, `finance.test.ts`, `finance-manual.test.ts`)

| ID | Preconditions | Steps | Expected | Pri | Automated |
|---|---|---|---|---|---|
| FIN-01 | maker | Policy with min 500 > max 100; `effectiveTo` = / < `effectiveFrom`; code `lower_case` / `A` / `1ABC`; rate 10001 / -1 / 12.5; FLAT without amount; flat -1; tax 10001; date without time; category TIPS; ghost provider | 400 each (**min/max and date order are new server checks — they were PostgreSQL CHECKs**) | P1 | EDGE-FIN-01 |
| FIN-02 | maker | rate 0; rate 10000; FLAT 0; min = max; same code twice | 201 each; versions 1 and 2 | P2 | EDGE-FIN-01 |
| FIN-03 | Author holding both maker and checker roles | Submit ghost; activate a DRAFT; submit; submit again; activate own; plain maker activates | **404 (fix)**; 409; 200; 409; 403 SEPARATION_OF_DUTIES; 403 FORBIDDEN | P1 | EDGE-FIN-02 |
| FIN-04 | ACTIVE policy | Activate again; retire; retire again; submit | 409; 200; 409; 409 | P2 | EDGE-FIN-02 |
| FIN-05 | 33.33 % + 18 % tax policy on a hospital | Preview 10001 / 1 / 0 / 2 / -1 / 2^53+2 | 3333+600 → net 6068; 0/0/1; zeros; 1/0/1 (half-up); 400; 400 | P1 | EDGE-FIN-03 |
| FIN-06 | Slot with fee 0 | Book; payment-order; refund 1 paisa | Transaction PAID at 0; 409 nothing due; 409 nothing captured | P1 | EDGE-FIN-04 |
| FIN-07 | Paid ₹600 booking | Refund 0 / -5 / reason `tiny` | 400 each | P1 | EDGE-FIN-05 |
| FIN-08 | Same | Refund 60001; 50000; 10001; 10000; 1 | 409 `refundableMinor: 60000`; 201; 409 `refundableMinor: 10000`; 201; 409 | P1 | EDGE-FIN-05 |
| FIN-09 | Unpaid booking | Refund 100 | 409 "No captured online payment" | P1 | EDGE-FIN-05 |
| FIN-10 | REQUESTED refund by X (who also may approve) | X approves; note `no`; REJECT; APPROVE after reject; re-request the amount | 403 SoD; 400; 200; 409; 201 (rejected amount released) | P1 | EDGE-FIN-05 |
| FIN-11 | Nothing due | Create batch; approve / cancel ghost; payout with bad UTR; paidAt in the future; ghost item | 422; 404; 404; 400; 400; 404 | P1 | EDGE-FIN-06 |
| FIN-12 | Completed paid visit | Complete twice / replay the webhook | Commission snapshot frozen, ledger posted exactly once | P1 | finance.test |
| FIN-13 | Refund processed | Clawback | Commission recalculated on the remaining base | P1 | finance.test |
| FIN-14 | PROCEDURE/SURGERY policy without legal approval | Activate | 422 (legal gate); in production every policy needs legal review | P1 | finance.test |
| FIN-15 | Manual bank transfer | Duplicate receipt; counter payment; refund recorded by the requester | 409; PAY_AT_PROVIDER; 403 | P1 | finance-manual.test |
| FIN-16 | Two settlement batches at once | Create concurrently | Ledger entries settled once; the loser gets 409 | P1 | finance.test "no double settlement" |
| FIN-17 | Live gateway sandbox | Real Razorpay/Stripe webhook with a wrong secret / replayed event id | 401 signature; duplicate ignored | P1 | manual (simulated in finance.test and payments-push.test) |

## 13. Notifications, platform, exports (owned by other agents — reference only)

| ID | Preconditions | Steps | Expected | Pri | Automated |
|---|---|---|---|---|---|
| NOTIF-01 | Queue with failures | Bulk retry; cancel queued; drain | Counts match | P2 | notifications.test |
| NOTIF-02 | Booking confirmed | Patient SSE stream | Pop-up with level and meta; replay of unread on reconnect | P1 | notifications-live.test |
| PLAT-01 | Setting edited concurrently | Save with a stale version | 409 | P2 | operations.test |
| EXP-01 | Bulk user export | Download | No contact details; download audited | P1 | operations.test |

## 14. Running

```
npm run typecheck && npm run lint
npx vitest run tests/unit/edge-validation.test.ts
npx vitest run tests/integration/edge-auth.test.ts tests/integration/edge-http.test.ts
npx vitest run tests/integration/edge-providers.test.ts tests/integration/edge-users-affiliations.test.ts
npx vitest run tests/integration/edge-finance.test.ts tests/integration/edge-orders.test.ts tests/integration/edge-discovery-patient.test.ts
npm test   # whole suite, about 8–10 minutes on the dev laptop
```

Each `edge-*.test.ts` file resets the database in `beforeAll` and builds its own providers, so files can run alone or in any order. Heavy cases (several approved providers) declare a 120 s timeout.
