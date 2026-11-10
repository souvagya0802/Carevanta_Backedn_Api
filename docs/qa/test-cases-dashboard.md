# Carevanta Super Admin Dashboard — UI test cases and results

Version 2026-11-10. Companion to `docs/qa/test-plan.md` and `docs/qa/test-cases-patient.md`. App: `Carevanta_Super_Admin_Dashboard` (port 3000) against the dev API on port 4000. Account: the super admin from `docs/demo-logins.md`. Synthetic data only; the duplicate-email check reuses an existing address, so nothing is created.

How it was run: Chrome (headless, puppeteer-core). A page sweep opened 34 routes (every admin page, a real and a missing record id, an unknown segment and a 404) at **1280×800 and 360×800** (68 loads) with a DOM audit: horizontal scroll, elements past the viewport or their parent, text overlaps, tap targets, labels not in Title Case, corner radii, truncated text, console errors, failed requests, hydration warnings. Two flow scripts then drove filters, pagination, record dialogs, empty and invalid submits, menus, toasts and the phone drawer.

Priority: **P1** blocks a core admin flow or breaks a founder rule, **P2** wrong or confusing result on one screen, **P3** polish.

Status: Pass / Fail / Fixed (failed first, fixed, re-verified).

## 1. Page sweep (automated audit)

| ID | Page / role | Viewport | Steps | Expected | Actual | Status | Pri |
|---|---|---|---|---|---|---|---|
| DUI-01 | All 34 routes, super admin | 1280 / 360 | Load each page, compare `scrollWidth` with the viewport | No horizontal page scroll | 0 of 68 loads | Pass | P1 |
| DUI-02 | All routes | 1280 / 360 | Measure every visible element against the viewport and its parent | Nothing past the edge | 0 loads with overflow | Pass | P1 |
| DUI-03 | All routes | 1280 / 360 | Pairwise intersection of visible text | No text drawn over other text | 0 overlaps | Pass | P1 |
| DUI-04 | All routes | 1280 / 360 | Watch for hydration warnings | None | None | Pass | P1 |
| DUI-05 | All routes | 360 | Buttons and links under 40 px tall | None | 0 loads with small targets | Pass | P2 |
| DUI-06 | `/catalogue`, `/providers/new` | 1280 / 360 | Read field and button labels | Title Case | "Parent code", "Speciality code", "Add branch" were sentence case | Fixed | P2 |
| DUI-07 | `/roles` | 1280 / 360 | Read the role card counters | Title Case | "permissions" lower-case | Fixed | P3 |
| DUI-08 | `/roles`, `/applications`, `/support`, `/notifications` | 1280 / 360 | Title Case audit | — | Flags are role names, counter cards and template keys (data, not labels) | Pass | P3 |
| DUI-09 | Stat tiles, chart legends, KPI cards | 360 | Look for ellipsised text | Labels readable | Tile descriptions and the phone header title were cut off; now wrap to two lines | Fixed | P2 |
| DUI-10 | Skeletons, checkboxes | 1280 | Check corner radii | 5 px theme token | `rounded` replaced with `rounded-sm` (5 px) | Fixed | P3 |
| DUI-11 | `/users/0000…`, `/applications/0000…`, `/does-not-exist`, `/providers/unknown-segment` | 1280 / 360 | Open a missing id or route | Friendly not-found state, no crash | Not-found states shown; only the expected 404s in the network log | Pass | P2 |
| DUI-12 | `/catalogue` at 360 in a fast sweep | 360 | 68 loads back-to-back | No 429s | API rate limiter returned 429 on `/auth/refresh` once under the sweep; not seen in normal use | Open | P3 |
| DUI-13 | Placeholders | 1280 | Read form placeholders | No region-specific hardcoding | Roles placeholder named a pilot town; made generic | Fixed | P2 |

## 2. Interactive flows

| ID | Page / role | Viewport | Steps | Expected | Actual | Status | Pri |
|---|---|---|---|---|---|---|---|
| DUI-20 | `/users` | 1280 | Type a name in Search | Rows filter | Rows change | Pass | P2 |
| DUI-21 | `/users` | 1280 | Search, then reload | Filter kept in the URL | URL stays `/users`; filter is lost on reload | Open | P3 |
| DUI-22 | `/users` | 1280 | Status filter Suspended | Only suspended rows | Correct | Pass | P2 |
| DUI-23 | `/users` | 1280 | Click Next | Next page loads | Next disabled: one page of demo users (edge, not a bug) | Pass | P3 |
| DUI-24 | `/users` | 1280 | Open a user row | Detail page with profile and roles | Correct | Pass | P1 |
| DUI-25 | `/users` → New User | 1280 | Open the dialog | Shared dialog, black header | Correct | Pass | P1 |
| DUI-26 | New User | 1280 | Submit empty | Inline validation, no request | Correct | Pass | P1 |
| DUI-27 | New User | 1280 | Bad email and phone | Field errors | Correct | Pass | P1 |
| DUI-28 | New User | 1280 | Press Escape | Dialog closes | Correct | Pass | P2 |
| DUI-29 | New User | 1280 | Submit an email that already exists | Error toast with the API message and reference | "A user with this email or mobile number already exists · Reference …" | Pass | P1 |
| DUI-30 | Toast | 1280 | Measure the error toast | Top right, 5 px radius | Top right, but 0 px radius | Fixed | P2 |
| DUI-31 | Toast | 360 | Raise the same error | Top, full width | top 16, left 12, right 348 | Pass | P1 |
| DUI-32 | Toast | 360 | Raise the same error twice | One toast, no duplicate stacking | Two identical toasts stacked (different reference only); now the newer replaces the older | Fixed | P1 |
| DUI-33 | `/roles` → New Role | 1280 | Open, submit empty | Black header, submit blocked | Correct | Pass | P1 |
| DUI-34 | `/roles` → holders | 1280 | Click a role's holder count | Black-header "Who Holds …" dialog | Correct (first run's selector missed it) | Pass | P2 |
| DUI-35 | `/commission-rules` → New Policy | 1280 | Open, submit empty | Full-size black-header dialog, submit blocked | Correct | Pass | P1 |
| DUI-36 | `/catalogue` → Add Speciality | 1280 | Submit empty | Blocked by required fields | Correct | Pass | P2 |
| DUI-37 | `/catalogue` → Conditions & Mappings → Propose Mapping | 1280 | Open with no rationale | Black header, Propose disabled until speciality and 10-character rationale | Correct (first run looked on the wrong tab) | Pass | P2 |
| DUI-38 | `/catalogue` → Edit Words | 1280 | Open | Black header, Add disabled while empty, nothing overflows | Correct | Pass | P2 |
| DUI-39 | `/audit` | 1280 | Next page; long JSON details | Paging works; details stay inside their cell; outcome select text fits | Correct | Pass | P2 |
| DUI-40 | `/support` | 1280 | Open a case | Black-header dialog; Add Note disabled while empty; status buttons | Correct; deep link `?case=` kept | Pass | P1 |
| DUI-41 | `/appointments` | 1280 | Status filter Completed; open a record | Filtered rows; black-header dialog with actions | 5 rows; dialog correct | Pass | P1 |
| DUI-42 | `/affiliations` | 1280 | View an affiliation | Black-header dialog, Suspend / End / Close | Correct | Pass | P2 |
| DUI-43 | `/reviews`, `/applications`, `/verification`, `/commission-rules` | 1280 | Open with nothing waiting | Helpful empty state | Each shows one | Pass | P3 |
| DUI-44 | `/payments` | 1280 | Switch Payments / Refunds / Webhook Events / Reconciliation | Each loads without an error | Correct | Pass | P1 |
| DUI-45 | Header bell and account menu | 1280 | Open each over a full page | Panel above content, inside the viewport | Correct (header has its own stacking layer, `relative z-40`) | Pass | P1 |
| DUI-46 | Phone header | 360 | Read the page title | Not ellipsised | Wrapped to two lines, logo hidden under 640 px | Fixed | P2 |
| DUI-47 | Phone drawer | 360 | Open Menu | Drawer above the header, Close Menu reachable, targets ≥ 40 px | Drawer was under the sticky header (z-40); raised to z-50 | Fixed | P1 |
| DUI-48 | Phone drawer | 360 | Tap Close Menu | Drawer closes | Closes | Pass | P1 |
| DUI-49 | Any dialog | 360 | Open a dialog | Fits the viewport, buttons ≥ 40 px | Correct | Pass | P1 |
| DUI-50 | Console / network during flows | 1280 / 360 | Collect unexpected errors | None | None | Pass | P2 |

## Open items

- DUI-21: the Users search box does not write `?q=` to the URL, so a reload or shared link loses the filter.
- DUI-12: a fast automated sweep can trip the auth refresh rate limit; normal use does not.
