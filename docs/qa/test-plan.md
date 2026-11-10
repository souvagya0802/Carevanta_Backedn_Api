# Carevanta End-to-End Test Plan

Scope: the three products (Super Admin dashboard, Provider portal, Patient app) and the flows that connect them through the one API. Version: 2026-11-07, development build against the Neon dev database with demo data.

## 1. Approach

| Item | Decision |
| --- | --- |
| Method | Real browser (Chrome, headless via puppeteer-core) driving the running apps, plus direct API calls to confirm what the UI claims. Every case is executed, not inferred. |
| Viewports | Phone 360 × 800 (Galaxy A-series, the main target), small phone 320 × 640, desktop 1280 × 800. Every screen is opened at 360 and 1280; key screens also at 320. |
| Accounts | From `docs/demo-logins.md`. Each tester signs in once per app and reuses the session. |
| Data | Shared dev database. Testers create their own records (bookings, orders, providers) and never delete demo records. Names created by testers start with `QA ` so they can be found later. |
| Evidence | Screenshot for every failure and for every screen at 360 px; console errors captured on every page; API status for every failed action. |
| Not a bug | `429 Too many requests` after many sign-ins (rate limit: 20 logins/min per address); slow first load (dev database is in the US, ~300 ms per query). Record only if it breaks the flow. |

### Severity

| Level | Meaning | Example |
| --- | --- | --- |
| S1 Blocker | A core flow cannot be completed, data is lost or wrong, security or safety issue | Booking fails; a patient sees another patient's report; emergency number missing |
| S2 Major | Flow works only with a workaround, or wrong result shown | Filter ignored; wrong status after an action; page crashes on one record |
| S3 Minor | Cosmetic or copy issue that does not block | Misaligned button; text cut off; label not in Title Case (admin and portal) |
| S4 Suggestion | Improvement, not a defect | Missing empty-state hint |

### Checks applied to every screen (UI checklist)

| ID | Check |
| --- | --- |
| UI-01 | No horizontal scroll and nothing cut off at 320, 360 and 1280 px |
| UI-02 | No console errors, no hydration warnings, no Next.js error overlay |
| UI-03 | Loading state (skeleton or spinner), empty state with a helpful line, and error state with retry |
| UI-04 | Tap targets at least 40 px on phones; nothing hidden behind the bottom bar or the keyboard |
| UI-05 | Admin and portal: Title Case labels, 5 px radius, dialogs with the black header. Patient app: its own bright design (rounded, gradient) |
| UI-06 | Logo visible and readable in the header on phones |
| UI-07 | Toasts appear at the top of the screen, once, and say what happened |
| UI-08 | Forms: required markers, inline validation messages, buttons disabled while saving, no double submit |
| UI-09 | Dates and times in IST, money as ₹ with two decimals, Indian phone format |
| UI-10 | Keyboard and screen reader basics: focus visible, labels on inputs and icon buttons |

## 2. Super Admin Dashboard (http://localhost:3000, a super-admin login supplied by the founder)

| ID | Area | Steps | Expected |
| --- | --- | --- | --- |
| SA-01 | Sign in | Open /login, sign in; then sign out from the account menu | Lands on the overview; sign-out returns to /login and protected pages redirect to /login |
| SA-02 | Wrong password | Sign in with a wrong password; then empty fields | Clear error, no account details leaked; validation on empty fields |
| SA-03 | Overview | Open / | KPI tiles, charts and activity load with real numbers; nothing says NaN or undefined |
| SA-04 | Provider lists | Open each list: doctors, hospitals, clinics, labs, imaging, pharmacies, ambulance | Each lists the demo organisation(s); search and status filter work; counts match |
| SA-05 | Provider detail | Open the hospital, the clinic and the imaging centre | Profile, locations, departments or services, members, documents, verification history shown |
| SA-06 | Register a provider | /providers/new: create "QA Clinic" (clinic) with a location picked on the map | Saved as draft; appears under Clinics; required-field errors shown when empty |
| SA-07 | Verification | Submit QA Clinic for verification; as the same admin try to approve your own case | Case opens; maker-checker or required checks prevent a single person from skipping steps, with a clear message |
| SA-08 | Applications | /applications and /applications/[id] | Pending applications listed and openable |
| SA-09 | Affiliations | /affiliations: filter, open one | Lists hospital and clinic affiliations; verify action works on a pending one |
| SA-10 | Users | /users: search a demo user; open /users/[id]; try suspending and re-activating a QA user you create | Changes need a reason, are audited, and the admin cannot lock themselves out |
| SA-11 | Roles | /roles: open the role matrix; change a permission on a custom role with a reason | Saved with audit; system roles protected |
| SA-12 | Catalogue | /catalogue: every tab. Edit Words on "Paediatrics" (add "QA word"); Search Tester: try "QA word", "bukhar", "sugar test", "snake bite" | Words save; tester shows Paediatrics for "QA word"; red flag shown for snake bite |
| SA-13 | Mapping review | Conditions & mappings: switch queue filters; propose a mapping on a QA condition | Proposer cannot approve own mapping |
| SA-14 | Appointments | /appointments: filters (status, date, provider), open one | Real appointments from hospital and clinic; filters change the list |
| SA-15 | Lab and pharmacy orders | /diagnostic-orders and /pharmacy-orders | Lab and imaging orders both listed; pharmacy orders with statuses |
| SA-16 | Ambulance | /ambulance and /dispatch | Fleet and trips listed; dispatch console loads |
| SA-17 | Finance | /commission-rules, /payments, /settlements, /reports | Rules with legal gate; payments and settlements show demo money; exports download |
| SA-18 | Support | /support: open a case, add a note, change status | Status changes with history |
| SA-19 | Notifications | /notifications | Templates and delivery log; email shows as "log" driver (no SMTP) |
| SA-20 | Settings | /settings every tab: Branding (logo), Email, Payments (Razorpay, Stripe), Push, Provider Portal, Patient App (edit hero title, Popular Searches) | Each tab loads; Patient App save needs a reason and then shows in the patient app (see X-05) |
| SA-21 | Audit | /audit: filter by the super-admin account used for testing | Shows the changes made in this test session |
| SA-22 | Verification queue | /verification | Open cases listed; checks and decision UI work |
| SA-23 | Change password | /account/password: wrong current password; mismatch; valid change and change back | Clear errors; success toast |
| SA-24 | Mobile | Every page above at 360 px | Menu opens and closes; tables scroll inside their card; dialogs fit the screen |

## 3. Provider Portal (http://localhost:3001)

### 3.1 Common to every provider type

| ID | Area | Steps | Expected |
| --- | --- | --- | --- |
| PP-01 | Sign in / out | Sign in as each provider login in turn; sign out | Opens on that organisation's home; the words and menu match the type (hospital vs lab vs pharmacy …) |
| PP-02 | Forgot password | /forgot-password with a known email, then unknown | Same neutral message both times |
| PP-03 | Home | Open / | KPIs and today's work load with real numbers |
| PP-04 | Profile & locations | /profile, /locations: edit a phone number, opening hours, coverage area | Saves with toast; invalid PIN rejected |
| PP-05 | Staff | /staff: invite "QA Staff" as STAFF; change role; remove | Owner cannot remove the last owner or themselves |
| PP-06 | Documents & verification | /documents, /verification | Uploaded documents and verification state shown |
| PP-07 | Finance | /finance: earnings, ledger, payouts; print an invoice/receipt; raise a refund request on a paid transaction | Numbers match transactions; print view opens; one open refund request at a time |
| PP-08 | Notifications | Bell dropdown and /notifications; push toggle; install card | Bell opens fully on screen; unread count updates after marking read |
| PP-09 | Analytics | /analytics | Daily series render for that type |
| PP-10 | All-providers login | provider@gmail.com: switch between all six organisations | Menu, words and data change with the organisation |
| PP-11 | Mobile | Every page at 360 px, menu drawer, bottom navigation | No overflow, logo visible, bottom bar not covering content |

### 3.2 Hospital (hospital@gmail.com) and Clinic (clinic@gmail.com)

| ID | Steps | Expected |
| --- | --- | --- |
| HC-01 | /affiliations: list, filter by department and speciality, open a doctor | Doctor detail shows specialities, qualifications, schedules, stats; filters work |
| HC-02 | Invite a doctor (pick an existing doctor not yet affiliated) | Invitation appears as pending |
| HC-03 | /schedules: add a weekly schedule for a doctor; generate slots; try an overlapping schedule | Slots created; overlap refused with a clear message |
| HC-04 | Block a free slot; try blocking a slot that is booked | Free slot blocked; booked slot refused (409 message) |
| HC-05 | /appointments: filters (doctor, department, status, date, search by patient name/phone/reference); queue view | Filters narrow the list; queue shows today in order |
| HC-06 | Open an appointment; confirm a REQUESTED one; check in; complete; mark another NO_SHOW; reject one with a reason | Status flow enforced; patient sees each change (X-02) |
| HC-07 | Walk-in booking for a new phone number | Appointment created as walk-in, pay at counter |
| HC-08 | Clinic only: departments are General Medicine, Paediatrics, Obstetrics & Gynaecology; 5 doctors listed | Matches the seed |

### 3.3 Doctor (doctor@gmail.com)

| ID | Steps | Expected |
| --- | --- | --- |
| DR-01 | Home and /affiliations | Shows practices at the hospital, the clinic and own chamber |
| DR-02 | Own schedule at own chamber: add, generate slots | Works; cannot create a schedule that overlaps a hospital session |
| DR-03 | /appointments for the doctor: today, filters | Only this doctor's appointments, across places |
| DR-04 | Accept or decline a pending invitation if any | Status changes |

### 3.4 Diagnostic lab (lab@gmail.com) and Imaging centre (imaging@gmail.com)

| ID | Steps | Expected |
| --- | --- | --- |
| LB-01 | /services: change a price; turn home collection on/off; add a test from the catalogue | Saved; patient app shows the new price (X-03) |
| LB-02 | /diagnostic-orders: filters; open a REQUESTED order; confirm; collect sample; processing; publish a report (upload a PDF) | Each step moves the status; report visible to the patient (X-03) |
| LB-03 | Publish a correction (new version) with a reason | Old version kept and marked superseded |
| LB-04 | Imaging only: services are scans and ECG/echo, no home collection | Matches the seed |

### 3.5 Pharmacy (pharmacy@gmail.com)

| ID | Steps | Expected |
| --- | --- | --- |
| PH-01 | /inventory: add a batch; edit quantity; a near-expiry batch is flagged | Selling price cannot exceed MRP; expiry validation |
| PH-02 | /prescriptions: review an uploaded prescription (approve / reject with reason) | Status changes; patient sees it |
| PH-03 | /pharmacy-orders: accept, prepare, ready / out for delivery, delivered; reject one with a reason | Stock reserved and released correctly |
| PH-04 | Pharmacist role: sign in as pharmacist@demo.carevanta.local / Demo-Carevanta-2026 | Can review prescriptions; cannot see finance |

### 3.6 Ambulance operator (ambulance@gmail.com)

| ID | Steps | Expected |
| --- | --- | --- |
| AM-01 | /fleet: vehicle availability toggle; crew list | Toggle saves; a vehicle on a trip cannot be taken out of service |
| AM-02 | /dispatch: active offers and trips; accept an offer created by X-06 | Trip moves through en route, arrived, patient on board, completed |
| AM-03 | Incident report on a trip | Saved as a support case |

## 4. Patient App (http://localhost:3002)

| ID | Area | Steps | Expected |
| --- | --- | --- | --- |
| PA-01 | Landing (signed out) | Open / | Hero, search box, categories, how it works, trust, emergency; content matches Settings → Patient App |
| PA-02 | Sign up | /signup with phone; with email; bad phone; short password; no consent | Validation messages; success goes to verify |
| PA-03 | Sign in / out | user@gmail.com / User@123; wrong password; sign out | Home with greeting and next appointment; errors clear |
| PA-04 | Forgot / reset | /forgot-password | Neutral message |
| PA-05 | Smart search | Type: fever, fevr, bukhar, pet dard, child doctor, skin specialist, sugar test, mri, paracitamol, a doctor's first name, "my son has fever since 2 days", snake bite, zzzz | Correct understanding line, specialists with doctors, tests, medicines; emergency first for snake bite; helpful "no match" |
| PA-06 | Search results page | Submit "fever"; switch tabs; speciality chips; filters (sort, distance); set location by PIN 721636 | Lists change accordingly; distances appear after location is set |
| PA-07 | Doctor profile | Open a doctor | Specialities, qualifications, places, next slot, reviews |
| PA-08 | Book a doctor | Book a slot for self; for a family member; pay at clinic; try the same slot twice | Booked; second attempt refused; appointment appears in My Care |
| PA-09 | Appointment detail | Reschedule to another slot; cancel with reason; review a completed visit | New appointment after reschedule; cancel releases slot; review only once |
| PA-10 | Lab test booking | /tests → a test → choose lab → home collection with PIN 721636 → book; then a PIN outside coverage | Booked; outside coverage refused with a clear message |
| PA-11 | Imaging booking | Search "mri" → book at the imaging centre (centre visit) | Booked; shows in Orders |
| PA-12 | Medicines | /pharmacy: search paracetamol; add from one pharmacy; add a prescription medicine; checkout without prescription; upload a prescription; delivery to PIN outside coverage | Basket rules enforced; prescription required; delivery coverage checked |
| PA-13 | Orders | /orders, lab detail (open report PDF), medicine detail (cancel when allowed) | Timeline correct; report opens; cancel only in allowed states |
| PA-14 | Records | Reports and prescriptions tabs; upload a prescription | Upload works up to 8 MB; wrong file type refused |
| PA-15 | Family | Add, edit, remove a family member; future date of birth | Validation; own profile cannot be removed |
| PA-16 | Emergency | /emergency signed out and signed in; request an ambulance with PIN/district; open status page | Call 112 first; request created; status updates (X-06) |
| PA-17 | Notifications & account | Bell count, inbox, mark read; push toggle; install card; change password | Works; toasts at top |
| PA-18 | Mobile & PWA | All pages at 320 and 360; bottom bar; install manifest; offline page | No overflow; app installable; offline page shown when the API is down |

## 5. Cross-Product Flows

| ID | Flow | Expected |
| --- | --- | --- |
| X-01 | Patient books at the clinic → clinic portal sees it REQUESTED → confirms | Patient app shows CONFIRMED and gets an in-app notification |
| X-02 | Hospital marks a patient's appointment COMPLETED → patient leaves a review → admin sees the review for moderation | Review flows through |
| X-03 | Patient books a lab test → lab confirms, collects, publishes report → patient opens the PDF | Report downloadable only by that patient |
| X-04 | Patient orders medicine with a prescription → pharmacy approves prescription → delivers | Statuses match on both sides; stock decreases |
| X-05 | Admin changes the patient app hero title and Popular Searches → patient app reloads | New text and chips appear; revert afterwards |
| X-06 | Patient requests an ambulance → ambulance operator accepts → patient status page shows the vehicle and ETA | Confirmed only after the operator accepts |
| X-07 | Admin adds an everyday word to a test → patient search finds it within seconds | Vocabulary refresh works |
| X-08 | Admin suspends QA Clinic → it disappears from patient search | Only approved, listed providers are public |
| X-09 | Privacy: patient A cannot open patient B's appointment, order or report by URL | 404 / not found, never the data |
| X-10 | Two tabs: patient app open in two tabs for 20 minutes, reload both | Stays signed in (refresh-token grace) |

## 6. Exit Criteria

- Every case above executed and marked Pass, Fail (with severity and evidence) or Blocked (with reason).
- No open S1. S2 fixed or accepted by the founder.
- Results recorded in `docs/qa/test-report.md` with the bug list, screenshots path and the fixes made.
