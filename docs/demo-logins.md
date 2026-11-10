# Demo Logins (Development Only)

Every account below works on the local development setup and points at real demo data. They are created by scripts that refuse to run in production.

> **Before going live:** these use gmail.com addresses, which belong to real people. Email is only logged while no mail server is configured. Delete these accounts (or re-run on a fresh database) before connecting SMTP. The short passwords also bypass the 12-character password rule on purpose, for demos only.

## Where Each App Runs

| App | URL |
| --- | --- |
| Super Admin dashboard | http://localhost:3000 |
| Provider portal | http://localhost:3001 |
| Patient app | http://localhost:3002 |
| API | http://localhost:4000 (docs at `/docs`) |

## Super Admin Dashboard (port 3000)

| Email | Password | Role |
| --- | --- | --- |
| carevanta.official2026@gmail.com | Kept by the founder (not written here) | Super Admin (every permission). The old admin@gmail.com was deactivated on 2026-11-10. |

## Provider Portal (port 3001), One Login Per Provider Type

| Provider type | Email | Password | Organisation | What is in it |
| --- | --- | --- | --- | --- |
| Hospital | hospital@gmail.com | Hospital@123 | Tamluk Seva Sadan Hospital | 31 doctors, 8 departments, staff, ~25,000 appointments, payouts, reviews, support cases |
| Clinic | clinic@gmail.com | Clinic@123 | Moyna Family Clinic | 5 visiting doctors, morning OPD, ~1,200 appointments, reviews, earnings |
| Doctor | doctor@gmail.com | Doctor@123 | Dr. Abhijit Maity (Paediatrics) | Own chamber plus the hospital and the clinic, ~1,100 appointments |
| Diagnostic lab | lab@gmail.com | Lab@123 | Moyna Diagnostic Centre | Priced tests, home collection, ~300 orders with reports |
| Imaging centre | imaging@gmail.com | Imaging@123 | Tamluk Imaging & Scan Centre | X-ray, ultrasound, CT, MRI, ECG, echo; ~200 orders with reports |
| Pharmacy | pharmacy@gmail.com | Pharmacy@123 | Tamluk Medical Hall | ~45 medicines in stock, ~400 orders, prescription review |
| Ambulance operator | ambulance@gmail.com | Ambulance@123 | Purba Medinipur Ambulance Service | 2 vehicles, crew, ~90 trips, live dispatch |
| All of the above | provider@gmail.com | Prov@123 | All six organisations | Switch organisation from the account menu |

## Patient App (port 3002)

| Email | Password | Who | What is in it |
| --- | --- | --- | --- |
| user@gmail.com | User@123 | Pooja Patra, with two parents as family profiles | ~75 appointments (past and upcoming), lab and imaging orders with reports, medicine orders, notifications |

## Older Seed Logins (Still Work)

Password for all of these: `Demo-Carevanta-2026`, all at `@demo.carevanta.local`.

| Login | Role |
| --- | --- |
| hospital.owner, hospital.admin, hospital.reception, hospital.desk1–3 | Hospital owner and staff |
| clinic.owner | Clinic owner |
| dr.anjali.maity | Doctor (General Medicine, own chamber + hospital) |
| demo.dr.1 … demo.dr.30 (except demo.dr.9, now doctor@gmail.com) | Hospital doctors |
| lab.owner, imaging.owner, pharmacy.owner, pharmacist, ambulance.owner, dispatcher | Owners and staff |
| riya.das | Patient |

## Recreating Everything

Run in the API folder, in this order, on a database where `npm run db:sync` has been run:

```bash
npm run db:seed                # reference data (catalogue, settings, search words)
npm run demo:seed              # one organisation of each original type + patient
npm run demo:seed:volume       # months of history, 30 doctors, 1,500 patients
npm run demo:seed:more         # clinic and imaging centre with history
npm run demo:approve-search    # approve starter symptom → specialist links (demo only)
npm run demo:accounts          # the gmail.com logins above (safe to re-run; resets passwords)
```
