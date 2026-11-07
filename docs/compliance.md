# Indian healthcare compliance checklist and questions register

This is an engineering checklist to drive legal review — **not legal advice**. Items are marked **Confirmed requirement** (the law clearly applies and the system implements a control), **Recommended** (good practice implemented or planned), or **Open** (needs counsel/regulator confirmation). Verify each against the current official text before launch; several instruments have been amended or re-notified recently.

| # | Instrument / topic | Applies to | What the system does | Status |
|---|---|---|---|---|
| C1 | **Digital Personal Data Protection Act, 2023** (and DPDP Rules as notified) | All personal and health data | Consent records with scope/purpose/policy version; data minimisation (bulk exports without contacts); anonymisation (data principal erasure) blocked by legal holds; sensitive-access logging; security incident register with `personalDataAffected` and regulator-notification timestamp; encryption at rest for bank data; audit trail | Confirmed requirement; **Open**: retention periods per record type, consent-manager interface, children's data (guardian verification for dependants), Data Protection Board notification timelines |
| C2 | **IT Act 2000 + SPDI Rules 2011** (until superseded) | Sensitive personal data (health, financial) | Reasonable security practices: encryption in transit/at rest, access control, audit, incident process | Confirmed requirement |
| C3 | **NMC Code of Medical Ethics 2002 §6.4.1/6.4.2** (and 2023 regulations status) | Commissions for referring patients | Commission policies on PROCEDURE/SURGERY cannot activate without recorded legal approval; production requires legal approval for every policy; consultation/diagnostic/pharmacy fees modelled as platform transaction fees, flagged for review | **Open — critical for the revenue model** |
| C4 | **State medical council registration** (West Bengal Medical Council) / NMC National Medical Register | Doctors | `PROFESSIONAL_REGISTRATION` check required before approval; registration number unique per council; verification method and source reference recorded; auto-suspension on expiry | Confirmed requirement; **Open**: no public API — manual lookup today; ABDM HPR integration later |
| C5 | **West Bengal Clinical Establishments (Registration, Regulation and Transparency) Act 2017** | Hospitals, clinics, labs, imaging centres | `FACILITY_REGISTRATION` check required; registration number/authority fields; documents with expiry | Confirmed requirement; **Open**: exact applicability per establishment size in Purba Medinipur |
| C6 | **Drugs and Cosmetics Act 1940 & Rules 1945** (Schedules H/H1/X, Form 20/21 retail licence) | Pharmacies | Drug licence check required; pharmacist registration captured; scheduled medicines require an APPROVED prescription reviewed by the dispensing pharmacist; no automatic substitution; batch/expiry tracking; Schedule H1 register needs are not automated | Confirmed requirement; **Open**: home delivery of prescription medicines (e-pharmacy rules status), Schedule H1 register format |
| C7 | **PC-PNDT Act 1994** | Ultrasound services | `pcpndtRegistrationNo` captured for diagnostic providers | **Open**: whether listing USG online needs additional disclosures |
| C8 | **AERB licensing** (Atomic Energy (Radiation Protection) Rules) | X-ray, CT | `RADIOLOGY_LICENSE` check required for imaging centres | Confirmed requirement |
| C9 | **NABL accreditation claims** | Labs | Certificate number and scope text stored; marketing must not generalise scope | Recommended |
| C10 | **Telemedicine Practice Guidelines 2020** | Teleconsultation | Not enabled; `mode` field exists | **Open** (phase 2) |
| C11 | **Motor Vehicles Act / state ambulance permits; 108/112 ERSS** | Ambulance operators | Vehicle registration, insurance and fitness validity enforced (auto out-of-service on expiry); 112 shown first; live dispatch off by default; operator acceptance required; TEST drills separated | Confirmed requirement; **Open**: liability and SLA with partner operators, integration with 108 |
| C12 | **RBI Payment Aggregator / Payment Gateway guidelines; nodal/escrow account** | Collecting patient money and paying providers | Gateway (Razorpay) collects; platform records ledger and settles by bank transfer with UTR evidence; separation of duties | **Open — architecture may need Razorpay Route or a licensed PA** |
| C13 | **GST** | Platform fee, provider services | `taxRateBps` per policy; commission tax in snapshots; GSTIN validated by format only | **Open**: rate/classification, who invoices, GST verification API access |
| C14 | **Consumer Protection (E-Commerce) Rules 2020** | Marketplace | Support cases with SLAs, provider verification transparency, refund workflow | **Open**: grievance officer designation, mandatory disclosures on listings |
| C15 | **ABDM (ABHA, HPR, HFR, health records)** | Health records interoperability | Not integrated | **Open** (phase 4) |
| C16 | **Data residency** | Hosting | Atlas cluster region (check in the Atlas project) today | **Open**: move to an India-adjacent region before real patient data; payment data stays at the gateway (RBI localisation) |
| C17 | **Medical records retention** (e.g., 3-year OPD record retention norms; state rules) | Reports, prescriptions | Versioned reports retained; legal holds | **Open**: define retention schedule |
| C18 | **Clinical content and advertising** (no diagnosis, no superlative claims) | Search, listings | Discovery returns "not a diagnosis" disclaimer; mappings need clinical reviewer approval; red-flag terms route to emergency guidance | Recommended |

## Manual verification workflows (where no reliable API exists)

For each check the officer records `method`, a `sourceReference` (registry URL/search id or inspection note) and/or an ACCEPTED evidence document. Suggested procedures:

1. **Doctor registration** — search the WBMC/NMC public register by name and registration number; record the register URL and date; reject on mismatch of name/qualification year.
2. **Clinical establishment** — compare the certificate number and validity with the state CEA portal (where available) or request a stamped copy; record the authority name.
3. **Drug licence** — verify Form 20/21 numbers with the Directorate of Drugs Control, West Bengal; capture validity date (drives auto-suspension).
4. **GSTIN** — format check is automatic; confirm the legal name via the GST portal search; record the result.
5. **Vehicle** — RC, insurance, fitness via Parivahan/VAHAN public search; record validity dates.
6. **Bank account** — penny-drop or cancelled cheque; verifier must differ from the person who added the account.

## Re-verification

Nightly job (`maintenance.credential-expiry`) expires documents, suspends providers whose required licence/registration lapsed, grounds vehicles with expired insurance/fitness, and opens RENEWAL verification cases; a reminder case is opened 30 days ahead.
