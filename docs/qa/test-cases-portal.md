# Carevanta Provider Portal — UI test cases and results

Version 2026-11-10. Companion to `docs/qa/test-plan.md` and `docs/qa/test-cases-patient.md`. App: `Carevanta_Provider_Frontend` (port 3001) against the dev API on port 4000. Accounts: the doctor, hospital, lab, pharmacy and ambulance demo logins from `docs/demo-logins.md`. Read-only sweep; no records created.

How it was run: Chrome (headless, puppeteer-core) signed in as each of the five provider types, opened every page in that role's sidebar plus one appointment detail, at **1280×800 and 360×800**, opened the bell and account menus and the phone drawer, then typed the URLs of pages the role does not have. Each load ran a DOM audit: horizontal scroll, elements past the viewport, text overlaps, clipped text, tap targets, labels not in Title Case, corner radii, console errors, failed requests, hydration warnings. The sweep ran once before the fixes and once after.

Priority: **P1** blocks a core provider flow or breaks a founder rule, **P2** wrong or confusing result on one screen, **P3** polish.

Status: Pass / Fail / Fixed (failed first, fixed, re-verified).

| ID | Page / role | Viewport | Steps | Expected | Actual | Status | Pri |
|---|---|---|---|---|---|---|---|
| PUI-P01 | Every sidebar page, all 5 roles | 1280 | Load and audit | No overflow, overlap, console error or hydration warning | Clean (one ambulance phone load hit ERR_CONNECTION_REFUSED while the dev server recompiled; transient). One clipped sidebar account line (name + email) is a deliberate ellipsis | Pass | P1 |
| PUI-P02 | Tables (Affiliations, Finance, Notifications, Orders, Stock), all roles | 360 | Load; compare `main` `scrollWidth` with the viewport | Only the table scrolls inside its box; the page does not scroll sideways | The `sr-only` Actions header escaped the scroll box, so the whole page scrolled to 622–629 px. Scroll box made `relative`; re-check: `main` 360 = viewport, table scrolls inside | Fixed | P1 |
| PUI-P03 | `src/components/ui/data-table.tsx` | — | `npx tsc --noEmit`, `eslint` | Builds | Half-applied edit left a JSX comment as a ternary branch (5 TS errors, parse error); comment turned into a plain JS comment | Fixed | P1 |
| PUI-P04 | Stock (pharmacy) | 360 | Load the batch table | Page does not scroll sideways | Same containment fix as P02 on its own table | Fixed | P1 |
| PUI-P05 | Home, Appointments (doctor, hospital) | 360 | Read the time column | "10:30 am" on one line | Time wrapped onto two lines in a 56–64 px column; widened and `whitespace-nowrap` | Fixed | P2 |
| PUI-P06 | Schedules, Services (doctor, hospital, lab) | 360 | Read each row | Name and times readable | Text squeezed to one word per line by badges and buttons; given a 12 rem minimum so the extras wrap below | Fixed | P2 |
| PUI-P07 | Verification (pharmacy, lab) | 1280 / 360 | Read the identifier labels | Title Case | "Retail drug licence (Form 20/21)" came from data in sentence case; shown through new `titleCase()` (unit-tested) | Fixed | P2 |
| PUI-P08 | Home hero, all roles | 1280 / 360 | Read the greeting | Greets the organisation; doctor shows primary speciality | Now "Good evening, Dr. …" with "Speciality · Type · you are owner" | Fixed | P3 |
| PUI-P09 | Bell menu items | 360 | Measure tap targets | ≥ 40 px | Rows were 36 px; `min-h-10` | Fixed | P2 |
| PUI-P10 | Bell and account menus, all roles | 1280 / 360 | Open each | Panel above content, inside the viewport | Panel present and on top in all 20 opens | Pass | P1 |
| PUI-P11 | Phone drawer, all roles | 360 | Open Menu | Drawer above the header, links reachable | Correct. The audit's "header covers main" flag is a measurement artefact (content scrolled under the open drawer) | Pass | P2 |
| PUI-P12 | Schedules, slot buttons | 360 / 1280 | Title Case audit | — | Flags are slot times such as "07:00 am" (values, not labels) | Pass | P3 |
| PUI-P13 | Live alert pop-up (lab, pharmacy) | 360 | Title Case audit | Title Case headings | "New test order", "New medicine order" come from API notification titles in sentence case | Open | P3 |
| PUI-P14 | Phone tap targets, Home / Schedules / Notifications | 360 | Buttons under 40 px | None | 1–2 small icon buttons per page remain | Open | P3 |
| PUI-P15 | Pages outside the role (e.g. doctor opens `/inventory`) | 1280 | Type the URL | A clear "not available" state, no crash, no 500 | No crash and no failed request, but the page shell renders (e.g. a doctor sees the "Orders & Reports" heading and intro) instead of a not-available state | Open | P2 |
| PUI-P16 | Appointment detail (doctor, hospital) | 1280 / 360 | Open from the list | Detail loads, actions visible | Not exercised: no appointment link in the list on the run date | Not Run | P1 |
| PUI-P17 | Toasts | 1280 / 360 | Trigger a save or an error | Top right; full width on phones; no duplicates | Not driven in this pass (the read-only sweep raises no toast) | Not Run | P1 |
| PUI-P18 | Every page | 1280 / 360 | Check corner radii | 5 px tokens | No off-token radii | Pass | P3 |

## Open items

- PUI-P13: notification titles from the API templates are sentence case; change the template titles, not the portal.
- PUI-P15: role-gated pages render their shell when the URL is typed; add a not-available state.
- PUI-P16, PUI-P17: not exercised in this pass.
- PUI-P14: a few icon buttons are 32–36 px on phones.
