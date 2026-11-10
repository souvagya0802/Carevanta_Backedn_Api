# Carevanta Patient App — UI test cases and results

Version 2026-11-10. Companion to `docs/qa/test-plan.md` (approach, severities, UI checklist) and `docs/qa/test-cases-api.md`. App: `Carevanta_User_Frontend` (port 3002) against the dev API on port 4000. Account: the demo patient from `docs/demo-logins.md`. Synthetic records created by this run start with `QA ` (family member `QA Test Child`; booking notes, cancel reasons and the ambulance request say "QA synthetic … ignore").

How it was run: Chrome (headless, puppeteer-core) opened **every route under `src/app/`** signed out and signed in at **360×800, 320×640 and 1280×800** (38 routes × 2 × 3 = 228 page loads), with a DOM audit on each page (horizontal overflow, elements past the viewport, text overlaps, clipped text, tap targets under 44 px, labels not in Title Case, corner radii off the theme tokens, open dialogs and their header colour, toast position and duplicates, fixed bottom navigation covering content, broken images), console errors, hydration warnings and 4xx/5xx requests. Flows were then driven end to end with the same browser. Scripts and screenshots live in the QA scratch folder (`qa/patient-crawl.mjs`, `qa/patient-flows.mjs`, `qa/patient-checks.mjs`, `qa/shots/patient/`). Lines marked **Fixed** were failing on the first pass and pass after the fix on the re-run.

Priority: **P1** blocks a core patient flow or a founder rule on every screen, **P2** wrong or confusing result on one screen, **P3** polish.

Status: Pass / Fail / Fixed (failed first, fixed in this run, re-verified).

## 1. Every route, three viewports (automated audit)

| ID | Page(s) | Viewport | Steps | Expected | Actual | Status | Pri |
|---|---|---|---|---|---|---|---|
| PUI-01 | All 38 routes, signed out and in | 360 / 320 / 1280 | Load each page, measure `scrollWidth` and every visible element's right edge | No horizontal scroll, nothing past the viewport edge | 0 pages with overflow in all 228 loads | Pass | P1 |
| PUI-02 | All routes | 360 / 320 / 1280 | Collect console errors on first and second render | None | Only the 404s of the deliberately missing ids (PUI-30) and `navigator.vibrate` blocked before the first tap (PUI-18) | Fixed | P2 |
| PUI-03 | All routes | 360 / 320 / 1280 | Watch for React hydration warnings ("did not match", "server rendered HTML") | None | None in 228 loads | Pass | P1 |
| PUI-04 | All routes | 360 / 320 / 1280 | Record every request with status ≥ 400 | Only the intentionally missing ids | Exactly those (`/discovery/providers/0000…`, `/patient/emergency/0000…`, `/no-such-page`) | Pass | P2 |
| PUI-05 | All routes | 360 / 320 | Scroll to the bottom; compare the last content element with the floating bottom navigation | Content never hidden under the nav (`pb-28` on `main`) | 0 pages covered | Pass | P2 |
| PUI-06 | All routes | 360 / 320 / 1280 | Pairwise intersection of visible text leaves | No two texts drawn on top of each other | None, apart from the full-screen critical live alert sitting over the doctor page's Book bar (by design) | Pass | P2 |
| PUI-07 | All routes | 360 / 320 | `white-space: nowrap` text wider than its box without ellipsis | None | None | Pass | P3 |
| PUI-08 | All routes | 360 / 320 / 1280 | Measure every button, link-button, input, chip and radio | At least 44 × 44 px | First pass: 40 px tall `Button size="sm"`, chips, back buttons, location pill, header Sign In, bell, password eye, toast close, cart ± and Leaflet zoom (30 px). Second pass: all 44 px; the only remaining < 44 px items are inline text links inside sentences ("See all", "Open the Provider Portal") | Fixed | P2 |
| PUI-09 | All routes | 360 / 1280 | Collect form labels, buttons, tabs, chips, nav items, page titles and short section headings | Title Case (founder rule) | First pass: 90+ sentence-case labels ("Mobile number or email", "Date of birth", "Cancel appointment", "Find care", "My care", "Top-rated doctors", "Change password", …). Second pass: all Title Case; sentences and questions ("How was your visit?") left as prose | Fixed | P2 |
| PUI-10 | All routes | 360 / 1280 | Histogram of computed `border-radius` values that are not pills/circles | Only the theme tokens (`--radius-sm…4xl`: 10/14/18/22/26/30/36 px) plus the hero/nav 28–32 px arbitrary values | Only Leaflet's zoom control (4 px / 2 px) was off-token; now styled with `--radius-md` | Fixed | P3 |
| PUI-11 | Every page with a modal (Filters, Where Are You?, Add a Family Member, Pick a New Time, Cancel This Appointment?, Rate, Upload a Prescription, choose pharmacy, Change Password, Add to Home Screen) | 360 / 1280 | Open the modal, read the computed header background | Shared Dialog with the black header (founder rule) | First pass: the patient `Sheet` had a white header. Second pass: header `rgb(11,27,58)` ink with white title/description/close on all 10 sheets; still a bottom sheet on phones and centred on desktop | Fixed | P1 |
| PUI-12 | Every toast (booking, errors, cancel, profile added, prescription uploaded, basket, order placed) | 360 / 1280 | Measure the toast box | Top right; full width on phones; never two identical toasts | `top` 16–24 px, `left/right` 12 px at 360 (full width), right-aligned `max-w-md` at 1280; forced double error (screen `onError` + hook) shows one toast | Pass | P1 |
| PUI-13 | Home `/home`, landing `/` | 360 / 320 | Type "fever" in the hero search | Suggestion list opens below the box, over the content, not clipped by the hero's rounded corners | Listbox 288 × 482 px extends 80 px below the hero; five hit-tests inside it all land on the listbox; 6 options; Enter goes to `/search?q=fever` | Pass | P1 |
| PUI-14 | Home `/home` | 768 / 1024 / 1280 | Measure the search pill and the "Find a Doctor" / "Book a Lab Test" actions | Same row from `md` up | Centres within 1 px of the search pill at all three widths; stacked below it at 360/320 | Pass | P2 |
| PUI-15 | Home, search, doctor, tests, cart, account, notifications, family | 320 | Visual review of screenshots | Nothing cut, nothing wrapped mid-word | OK; the only mid-word wrap is the configurable landing stat label ("Pilot district: Purba Medinipur") which is admin content | Pass | P3 |
| PUI-16 | Search `/search` | 1280 | Speciality chip row | Readable on desktop | Chips scrolled off the right edge in one line; now wrap at `lg` (still a swipe row on phones) | Fixed | P3 |
| PUI-17 | Doctor `/doctors/[id]`, provider `/providers/[id]` with a missing id | 360 | Open a non-existent id | Error state with a way back | "Could not load this / Provider not found" with Try Again but no Back button and the top bar hidden; a Back button is now shown above the error | Fixed | P2 |
| PUI-18 | Any page while a live alert arrives before the first tap | 360 | Receive an important/critical alert on a freshly loaded page | No console error | Chrome logged "Blocked call to navigator.vibrate because user hasn't tapped" on every alert; vibration is now attempted only after user activation | Fixed | P3 |
| PUI-19 | Emergency `/emergency` | all | Read the pickup address placeholder | Nothing region-specific hardcoded (founder rule) | Placeholder said "Near Moyna bus stand…"; now "Near the bus stand, opposite the school" | Fixed | P2 |
| PUI-20 | `/no-such-page` | 360 / 320 / 1280 | Open an unknown route signed out and in | Branded 404 inside the app shell | Was Next's bare "404 / This page could not be found."; now "Page Not Found" with Go Home / Find Care inside the shell with navigation | Fixed | P2 |
| PUI-21 | Book, doctor | 360 × 420 (keyboard open) | Focus the "Reason for Visit" textarea; check fixed bars | Field not hidden under the fixed Book bar / bottom nav | Textarea 162–258 px, nav from 335 px; doctor page Book bar 256–312 px above the nav at 335 px | Pass | P2 |
| PUI-22 | All phone pages | 360 / 320 | Safe-area insets | Top bar `pt-[max(10px,env(safe-area-inset-top))]`, nav `bottom-[max(10px,env(safe-area-inset-bottom))]`, sheet footer `pb-[max(16px,env(safe-area-inset-bottom))]`, toasts `top-[max(16px,env(safe-area-inset-top))]` | Present in the DOM; cannot be exercised in headless Chrome (no notch) | Pass | P3 |
| PUI-23 | Map views: doctor, provider, appointment, search (Map toggle), emergency, location sheet | 360 / 1280 | Open each map | Map renders with markers, no overflow, rounded on the token | Renders (OSM tiles), markers placed; zoom buttons now 44 px; attribution visible | Pass | P2 |

## 2. Flows (signed in as the demo patient unless stated)

| ID | Page | Viewport | Steps | Expected | Actual | Status | Pri |
|---|---|---|---|---|---|---|---|
| PFL-01 | `/search?q=feevr` | 360 | Typo search | "Showing results for Fever", doctors listed | 5 doctor cards | Pass | P1 |
| PFL-02 | `/search?q=chest pain` | 360 | Symptom search | Understood symptom → specialist list | "Results for Chest Pain", 5 cards | Pass | P1 |
| PFL-03 | `/search?q=cardiology` | 360 | Speciality search | Cardiology doctors | 2 cards | Pass | P1 |
| PFL-04 | `/search?q=child doctor` | 360 | Local phrase | Mapped ("child doctor means Paediatrics") | 2 cards | Pass | P2 |
| PFL-05 | `/search?q=xyzzy nothing` | 360 | Nonsense | Empty state with Clear Search | "No matches yet" | Pass | P2 |
| PFL-06 | Location pill → "Where Are You?" | 360 | Type PIN 721636 | PIN resolved to a place, Go → map, Save enabled | "East Midnapore, West Bengal" shown, Go opens the map, footer "Choose a place first" until a spot is chosen | Pass | P2 |
| PFL-07 | `/doctors/[id]` → Book | 360 | Pick a day chip, a slot, the family member, add a note, Confirm Booking | Request sent; step bar: 3 ticks and "Confirm" highlighted (not green) because the clinic has not accepted | Toast "Request sent — the clinic will confirm shortly" at the top; steps `Place: done, Time: done, Patient: done, Confirm: current` | Pass | P1 |
| PFL-08 | Book, slot taken (API answers 409 SLOT_UNAVAILABLE, simulated) | 360 | Confirm Booking | One toast "That slot was just taken. Pick another time.", slot selection cleared, slots refetched | Exactly one toast at top (22 px), selection cleared | Pass | P1 |
| PFL-09 | `/appointments/[id]` → Reschedule | 360 | Pick a New Time sheet, choose a slot, Move Appointment | New appointment id, navigated to it, toast "Appointment moved" | Moved to the new id; old one kept as RESCHEDULED | Pass | P1 |
| PFL-10 | Cancel outside the window (API answers 409, simulated) | 360 | Cancel → Cancel Appointment | One error toast with the API message; sheet stays open so the person can close it | "The free cancellation window has closed…" once; sheet still open | Pass | P1 |
| PFL-11 | Cancel inside the window | 360 | Cancel with a reason | Status "Cancelled by you", toast | Toast "Appointment cancelled"; badge CANCELLED BY YOU | Pass | P1 |
| PFL-12 | `/tests/LAB_LIPID` home collection | 360 | Choose the lab, Home Sample Collection, PIN "12" then "110001" (not covered), Book Test | Button disabled for a short PIN; uncovered PIN shows an inline field error, no toast | Disabled on "12"; "Home collection is not available at this PIN code" under the field; no toast | Pass | P1 |
| PFL-13 | `/tests/LAB_LIPID` centre visit | 360 | Visit the Centre, Book Test | Order created; steps `Choose Lab: done, Details: done, Confirm: current` until the lab confirms | As expected; order visible under Orders | Pass | P1 |
| PFL-14 | `/tests/IMG_CT_HEAD` (needs a prescription) | 360 | Choose the centre → Upload a Prescription sheet → pick a PNG → Upload | Upload succeeds, attached to the booking, Book Scan enabled | Toast "Prescription uploaded / It is attached to this booking."; Book Scan enabled | Pass | P1 |
| PFL-15 | `/pharmacy` → cart | 360 | Search "para", pick a medicine, choose the pharmacy, Add, open `/cart`, Pick Up at the Store, Place Order | Basket toast, order placed, Track Order link | "Crocin Advance 500 mg added to your basket", then "Order placed"; order page opens | Pass | P1 |
| PFL-16 | `/emergency` | 360 | Type a district and address ("QA synthetic test request"), Request an Ambulance | Request opened, detail page with timeline | Navigated to `/emergency/[id]`: "No Provider Available — Call 112" timeline (no operator covers the synthetic district) | Pass | P1 |
| PFL-17 | Live alert (critical) | 360 / 320 / 1280 | After PFL-16, open any page in a new session | Full-screen critical alert "No ambulance available right now" with Call 112 / Track Ambulance / Got It, repeated until acknowledged | Shown on every page load until Got It (persists via `/portal/notifications/read`); dismissing it once clears it for later sessions | Pass | P1 |
| PFL-18 | Live alert (important) | 360 | Book for `QA Test Child`, then confirm it as the provider through the API (`POST /portal/providers/:id/appointments/:id/actions {action: CONFIRM}`) while the patient app sits on My Care | Pop-up "Appointment confirmed" with View Appointment / Got It within seconds; appointment page shows CONFIRMED | Alert card appeared over My Care; appointment page CONFIRMED | Pass | P1 |
| PFL-19 | `/family` | 360 | Add → fill `QA Test Child`, Child, DOB → Add Profile | Toast "Profile added", member listed | As expected | Pass | P1 |
| PFL-20 | Book for the family member | 360 | In PFL-07 choose `QA Test Child` | Appointment created for that profile | Appointment page "For: QA Test Child" | Pass | P1 |
| PFL-21 | `/orders`, `/orders/lab/[id]`, `/orders/medicine/[id]`, `/records` | 360 | Open each | Lists and detail pages render; reports listed | Orders list shows the new lab order (REQUESTED) and past ones; records lists reports and prescriptions | Pass | P2 |
| PFL-22 | `/notifications` | 360 | Open | Unread count, Mark All Read, list | "3 unread", list with links; header badge "3" | Pass | P2 |
| PFL-23 | `/account` → Change Password sheet | 360 | Open the sheet, Escape | Sheet on the black header; closes on Escape | As expected | Pass | P2 |
| PFL-24 | Sign Out → reload `/account` | 360 | Sign Out, open `/account` and `/` | Signed-out state everywhere | "Sign In to Continue" card; header shows Sign In | Pass | P1 |
| PFL-25 | Login persistence | 360 | Sign in, reload `/account` | Still signed in (refresh token restore) | Account page with Sign Out after reload | Pass | P1 |
| PFL-26 | Deep link while signed out | 360 | Open `/appointments/[id]` → Sign In → log in | Redirect back to the same appointment | `/login?next=%2Fappointments%2F…`, then back on the appointment page | Pass | P1 |
| PFL-27 | 404 | 360 / 1280 | Open `/no-such-page` | Branded page with navigation | See PUI-20 | Fixed | P2 |
| PFL-28 | My Care → Upcoming | 360 | Look at the Upcoming tab the day after a REQUESTED appointment's time | Past-dated requests are not "upcoming" | They were listed under Upcoming (filter was status-only); now Upcoming = live status and not yet over (1 h grace) | Fixed | P2 |

## 3. Edge cases exercised

| ID | Case | Result |
|---|---|---|
| PED-01 | Double tap on Confirm Booking / Book Test / Place Order / Request an Ambulance | One request each (`useAttempt` idempotency key); no duplicate records seen in the lists |
| PED-02 | Booking signed out | Slot picking works; the patient/payment section is replaced by the "Sign In to Continue" card and the Sign In button carries `next` back to the booking |
| PED-03 | Slot that disappears between choosing and confirming | Handled (PFL-08) |
| PED-04 | Home collection PIN: 2 digits, leading zero, 6 digits outside coverage | Button disabled / disabled / inline error from the API |
| PED-05 | Delivery PIN in the cart | Same regex as PED-04; Place Order disabled until 6 valid digits |
| PED-06 | Scan without a prescription | Book Scan stays disabled with "Add the prescription above to continue." |
| PED-07 | Pharmacy basket: medicine from a second pharmacy | Basket is replaced with a toast "Started a new basket at …" (one basket, one pharmacy) |
| PED-08 | Cancel after the clinic's cut-off | API error shown once; nothing changes (PFL-10) |
| PED-09 | Missing ids on doctor, provider and emergency detail pages | Error state with Try Again (now with Back) |
| PED-10 | Critical alert across sessions and devices | Reappears on every page until acknowledged; acknowledgement is stored server-side |
| PED-11 | Viewport 360 × 420 (keyboard open) on the booking form | Field above the fixed bars (PUI-21) |
| PED-12 | 320 px on every route | No overflow; names truncate with ellipsis; nav shrinks to five columns |

## 4. Fixes made in this run (patient app)

| Area | Change |
|---|---|
| Shared `Sheet` (`src/components/ui/primitives.tsx`) | Black (ink) header with white title, description and close button on every modal; grab handle inside the header on phones |
| Tap targets | `Button size="sm"`, `Chip`, back/edit/cart/bell/eye/toast-close icon buttons, location pill, header Sign In, search and pharmacy inputs, search view toggle, recent/popular search chips, Directions/Call links and Leaflet zoom controls raised to 44 px |
| Title Case | Form labels, buttons, chips, tabs, sheet titles, step names, page titles and short section headings across all screens |
| `src/app/not-found.tsx` (new) | Branded 404 inside the app shell |
| `src/app/care/page.tsx` | Upcoming tab is time-aware (live status and not yet over) |
| `src/app/doctors/[id]`, `src/app/providers/[id]` | Back button in the error state |
| `src/app/emergency/page.tsx` | Region-neutral address placeholder |
| `src/app/search/page.tsx` | Chip rows wrap on desktop |
| `src/lib/live-alerts.ts` | Vibrate only after user activation (no console error) |
| `src/app/globals.css` | Leaflet zoom bar on the radius token, 44 px buttons |

## 5. Not changed (needs the founder)

- Patient-app corner radii are the bright-theme tokens (10–36 px, pills) that the founder asked for on 2026-11-07, not the 5 px of the admin/portal; this run only checked that every radius comes from those tokens.
- Inline text links inside sentences ("See all", "All tests", "Open the Provider Portal") stay at line height; making them 44 px tall would add visible gaps in the copy.
- Landing stat labels (e.g. "Pilot district") are super-admin content; long words wrap mid-word at 320 px in the three-column stat grid.
- The critical "No ambulance available" alert re-opens on every page until acknowledged; that is intentional for an SOS, but it is worth confirming the behaviour for an alert that is hours old.
