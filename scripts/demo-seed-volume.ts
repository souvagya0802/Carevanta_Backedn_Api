/**
 * Realistic operating history for the demo organisations (development only).
 *
 *   npm run demo:seed:volume
 *
 * Run after `npm run demo:seed`. It adds, through typed Prisma calls against
 * MongoDB (inserts batched 1,000 documents at a time):
 *
 *   Hospital   30 affiliated doctors across 8 departments, 6 extra staff, 7
 *              locations' opening hours, documents, amenities, a verified bank
 *              account, ~1,500 patients, ~4 months of appointments (walk-in and
 *              app bookings, completions, no-shows, cancellations), the money
 *              behind them (transactions, ledger, 4 paid-out settlement batches),
 *              published reviews, notifications and support cases.
 *   Doctor     the same history at Dr. Maity's own chamber.
 *   Lab        ~300 orders with published reports.
 *   Pharmacy   40 more medicines, 60 stock batches, ~400 orders.
 *   Ambulance  ~90 completed or cancelled trips.
 *
 * Fixed demo logins (same password as demo:seed): hospital.admin@, hospital.desk1@,
 * demo.dr.1@ … demo.dr.30@ (all @demo.carevanta.local). Refuses to run in
 * production and does nothing when the volume data is already complete.
 *
 * MongoDB caps a multi-document transaction at 60 s, far less than this seed
 * needs, so it does not run in one transaction. Instead every step is
 * idempotent: it looks up what already exists and inserts only the missing
 * rows, so a run that stopped half-way can simply be started again.
 *
 * Slot times are IST wall-clock minutes converted to UTC instants (09:00 IST
 * is stored as 03:30Z); "today" is the IST calendar date.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { prisma, type Prisma } from '../src/lib/prisma.js';
import { hashPassword } from '../src/modules/auth/passwords.js';
import { istToUtc, utcToIstParts } from '../src/lib/time.js';
import type { AppointmentStatus, BookingSource, DiagnosticOrderStatus, DispatchStatus, DocumentType, EngagementType, LedgerEntryType, MedicineSchedule, PharmacyOrderStatus, SupportCasePriority, SupportCaseStatus, SupportCaseType, TransactionStatus } from '../generated/prisma/enums.js';

if (process.env.APP_ENV === 'production') { console.error('Refusing to seed demo data in production.'); process.exit(2); }
const PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo-Carevanta-2026';
const D = 'demo.carevanta.local';
const CHUNK = 1000;

// ── Helpers ──────────────────────────────────────────────────────────────
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = new Date();
const today = utcToIstParts(now).date; // IST calendar date, YYYY-MM-DD
const ago = (days: number) => new Date(now.getTime() - days * DAY);
const plus = (at: Date, ms: number) => new Date(at.getTime() + ms);
/** YYYY-MM-DD shifted by whole days. */
const shiftDate = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const shiftMonths = (date: string, months: number) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1 + months, d)).toISOString().slice(0, 10);
};
/** Date-only values (DATE columns in the old schema) are stored as UTC midnight, as the API does with `new Date('YYYY-MM-DD')`. */
const dateOnly = (date: string) => new Date(`${date}T00:00:00Z`);
const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const ref = (prefix: string, seed: string) => `${prefix}-${md5(seed).slice(0, 10).toUpperCase()}`;
const pad = (n: number, width: number) => String(n).padStart(width, '0');
/** `(random() * max)::int` in Postgres rounds half away from zero. */
const randInt = (max: number) => Math.round(Math.random() * max);
const round2 = (x: number) => Math.round(x * 100) / 100;
/** Zero-based pick that mirrors Postgres' `(ARRAY[...])[1 + (x % len)]`. */
const at = <T>(arr: readonly T[], i: number): T => arr[((i % arr.length) + arr.length) % arr.length]!;
const chunked = <T>(rows: T[]) => { const out: T[][] = []; for (let i = 0; i < rows.length; i += CHUNK) out.push(rows.slice(i, i + CHUNK)); return out; };
const yyyymmdd = (at: Date) => utcToIstParts(at).date.replace(/-/g, '');
const yymm = (at: Date) => yyyymmdd(at).slice(2, 6);
const yymmdd = (at: Date) => yyyymmdd(at).slice(2);

async function step(name: string, fn: () => Promise<number>) {
  const t = Date.now();
  const n = await fn();
  console.log(`${name.padEnd(34)} ${String(n).padStart(7)} rows  ${((Date.now() - t) / 1000).toFixed(1)}s`);
  return n;
}
/** Insert rows in chunks; returns the number inserted. */
async function insert<T>(rows: T[], createMany: (chunk: T[]) => Promise<{ count: number }>) {
  let n = 0;
  for (const chunk of chunked(rows)) n += (await createMany(chunk)).count;
  return n;
}

// ── Preconditions ────────────────────────────────────────────────────────
async function org(displayName: string) {
  const p = await prisma.provider.findFirst({
    where: { displayName },
    include: { locations: { where: { isPrimary: true }, take: 1 }, members: { where: { memberRole: 'OWNER' }, take: 1 }, doctorProfile: true },
  });
  if (!p) return null;
  const ownerId = p.members[0]?.userId ?? p.doctorProfile?.userId;
  if (!ownerId) return null;
  return { id: p.id, locationId: p.locations[0]?.id ?? null, ownerId, userId: p.doctorProfile?.userId ?? ownerId };
}
type Org = NonNullable<Awaited<ReturnType<typeof org>>>;
const hospital = await org('Tamluk Seva Sadan Hospital');
const anjali = await org('Dr. Anjali Maity');
const lab = await org('Moyna Diagnostic Centre');
const pharmacy = await org('Tamluk Medical Hall');
const operator = await org('Purba Medinipur Ambulance Service');
if (!hospital?.locationId || !anjali?.locationId || !lab?.locationId || !pharmacy?.locationId || !operator) {
  throw new Error('Run `npm run demo:seed` first — the demo organisations are missing.');
}
const hospitalLocationId = hospital.locationId;
const labLocationId = lab.locationId;
const pharmacyLocationId = pharmacy.locationId;
// Settlement batches need a maker and a different checker; reuse the internal staff accounts demo:seed left behind.
const staff = {
  maker: (await prisma.user.findUnique({ where: { email: `internal.ops@${D}` } }))?.id ?? lab.ownerId,
  checker: (await prisma.user.findUnique({ where: { email: `internal.registrar@${D}` } }))?.id ?? hospital.ownerId,
};
const alreadyDone = (await prisma.user.count({ where: { email: { startsWith: 'demo.dr.', endsWith: `@${D}` } } })) > 0
  && (await prisma.supportCase.count({ where: { reference: { startsWith: 'DSC-' } } })) > 0;
if (alreadyDone) { console.log('Volume data already present. Nothing to do.'); await prisma.$disconnect(); process.exit(0); }

const hash = await hashPassword(PASSWORD);
const t0 = Date.now();
const ORG_IDS = [hospital.id, anjali.id, lab.id, pharmacy.id, operator.id];

try {
  // ── Hospital: departments, amenities, hours, documents, bank, staff ────
  await step('hospital departments', async () => {
    const departments = await prisma.department.findMany({ where: { isActive: true }, select: { id: true } });
    const have = new Set((await prisma.facilityDepartment.findMany({ where: { providerId: hospital.id }, select: { departmentId: true } })).map((x) => x.departmentId));
    const rows: Prisma.FacilityDepartmentCreateManyInput[] = departments.filter((d) => !have.has(d.id)).map((d) => ({ providerId: hospital.id, departmentId: d.id, isActive: true, verifiedAt: ago(20) }));
    return insert(rows, (c) => prisma.facilityDepartment.createMany({ data: c }));
  });
  await step('hospital amenities', async () => {
    const amenities = await prisma.amenity.findMany({ orderBy: { code: 'asc' }, take: 10, select: { id: true } });
    const have = new Set((await prisma.providerAmenity.findMany({ where: { providerId: hospital.id }, select: { amenityId: true } })).map((x) => x.amenityId));
    const rows: Prisma.ProviderAmenityCreateManyInput[] = amenities.filter((a) => !have.has(a.id)).map((a) => ({ providerId: hospital.id, amenityId: a.id, verifiedAt: ago(20) }));
    return insert(rows, (c) => prisma.providerAmenity.createMany({ data: c }));
  });
  await step('hospital branches', async () => {
    const branches: Prisma.ProviderLocationCreateManyInput[] = [
      { providerId: hospital.id, name: 'Moyna Outreach Clinic', addressLine1: 'Moyna Bazar Road', locality: 'Moyna', city: 'Moyna', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721629', latitude: 22.2715, longitude: 87.7712, phone: '9800100011', isPrimary: false, isActive: true },
      { providerId: hospital.id, name: 'Nandakumar Polyclinic', addressLine1: 'NH-116, Nandakumar', locality: 'Nandakumar', city: 'Nandakumar', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721632', latitude: 22.229, longitude: 87.8695, phone: '9800100012', isPrimary: false, isActive: true },
    ];
    const have = new Set((await prisma.providerLocation.findMany({ where: { providerId: hospital.id }, select: { name: true } })).map((l) => l.name));
    return insert(branches.filter((b) => !have.has(b.name)), (c) => prisma.providerLocation.createMany({ data: c }));
  });
  await step('opening hours', async () => {
    const locations = await prisma.providerLocation.findMany({ where: { providerId: { in: [hospital.id, anjali.id, lab.id, pharmacy.id] } }, select: { id: true } });
    const have = new Set((await prisma.providerOperatingHours.findMany({ where: { locationId: { in: locations.map((l) => l.id) } } })).map((h) => `${h.locationId}|${h.dayOfWeek}|${h.opensAtMin}`));
    const rows: Prisma.ProviderOperatingHoursCreateManyInput[] = [];
    for (const l of locations) for (let d = 0; d <= 6; d++) {
      const opensAtMin = d === 0 ? 540 : 480;
      if (!have.has(`${l.id}|${d}|${opensAtMin}`)) rows.push({ locationId: l.id, dayOfWeek: d, opensAtMin, closesAtMin: d === 0 ? 780 : 1260, isClosed: false });
    }
    return insert(rows, (c) => prisma.providerOperatingHours.createMany({ data: c }));
  });
  await step('documents', async () => {
    const docs: [Org, DocumentType, string][] = [
      [hospital, 'CLINICAL_ESTABLISHMENT_REGISTRATION', 'WB/CEA/PMD/2019/00418'], [hospital, 'GST_CERTIFICATE', '19AABCT1234F1Z5'], [hospital, 'FIRE_NOC', 'FS/PMD/2024/0931'], [hospital, 'TRADE_LICENSE', 'TML/TL/2024/1182'],
      [anjali, 'MEDICAL_REGISTRATION_CERTIFICATE', 'WBMC-DEMO-71234'], [anjali, 'DEGREE_CERTIFICATE', 'MCK/MBBS/2012/0417'], [anjali, 'IDENTITY_PROOF', 'XXXX-XXXX-4417'],
      [lab, 'CLINICAL_ESTABLISHMENT_REGISTRATION', 'WB/CEA/PMD/2021/01177'], [lab, 'NABL_ACCREDITATION', 'MC-4412'], [lab, 'GST_CERTIFICATE', '19AAMCM7788K1ZQ'],
      [pharmacy, 'DRUG_LICENSE', 'WB/PMD/RET/2024/0117'], [pharmacy, 'PHARMACIST_REGISTRATION', 'WBPC-44821'], [pharmacy, 'GST_CERTIFICATE', '19AAHFT5521L1ZD'],
      [operator, 'TRADE_LICENSE', 'TML/TL/2023/0772'], [operator, 'GST_CERTIFICATE', '19AAKCP9911M1ZF'],
    ];
    const rows: Prisma.ProviderDocumentCreateManyInput[] = docs.map(([o, documentType, documentNumber]) => ({
      providerId: o.id, documentType, status: 'ACCEPTED', storageKey: `demo/${o.id}/${documentType.toLowerCase()}.pdf`, fileName: `${documentType.toLowerCase()}.pdf`, mimeType: 'application/pdf',
      sizeBytes: 240000 + randInt(300000), sha256: md5(o.id + documentType) + md5(documentType + o.id), documentNumber,
      issuedAt: dateOnly(shiftMonths(today, -14)), expiresAt: dateOnly(shiftMonths(today, 22)), uploadedById: o.ownerId, reviewedAt: ago(20), reviewNote: 'Checked against the issuing authority (demo)', createdAt: ago(25),
    }));
    const have = new Set((await prisma.providerDocument.findMany({ where: { storageKey: { in: rows.map((r) => r.storageKey) } }, select: { storageKey: true } })).map((d) => d.storageKey));
    return insert(rows.filter((r) => !have.has(r.storageKey)), (c) => prisma.providerDocument.createMany({ data: c }));
  });
  await step('bank accounts', async () => {
    const providers = await prisma.provider.findMany({ where: { id: { in: ORG_IDS }, payoutAccounts: { none: {} } }, select: { id: true, legalName: true } });
    const rows: Prisma.ProviderPayoutAccountCreateManyInput[] = providers.map((p) => ({
      providerId: p.id, accountHolderName: p.legalName, accountNumberEncrypted: `demo:not-a-real-ciphertext:${p.id}`, accountNumberLast4: pad(1000 + randInt(8999), 4), ifsc: 'SBIN0001234', status: 'VERIFIED', verifiedAt: ago(18), createdAt: ago(24),
    }));
    return insert(rows, (c) => prisma.providerPayoutAccount.createMany({ data: c }));
  });
  const STAFF: [string, string][] = [[`hospital.admin@${D}`, 'Arindam Ghosh'], [`hospital.desk1@${D}`, 'Sumana Bera'], [`hospital.desk2@${D}`, 'Koushik Pramanik'], [`hospital.desk3@${D}`, 'Rina Mondal'], [`hospital.billing@${D}`, 'Debasish Sahoo'], [`hospital.opd@${D}`, 'Tanushree Das']];
  await step('hospital staff users', async () => {
    const have = new Set((await prisma.user.findMany({ where: { email: { in: STAFF.map(([e]) => e) } }, select: { email: true } })).map((u) => u.email));
    const rows: Prisma.UserCreateManyInput[] = STAFF.filter(([e]) => !have.has(e)).map(([email, fullName]) => ({ email, fullName, passwordHash: hash, status: 'ACTIVE', emailVerifiedAt: now, createdAt: ago(20) }));
    return insert(rows, (c) => prisma.user.createMany({ data: c }));
  });
  await step('hospital staff members', async () => {
    const users = await prisma.user.findMany({ where: { email: { in: STAFF.map(([e]) => e) } }, select: { id: true, email: true } });
    const have = new Set((await prisma.providerMember.findMany({ where: { providerId: hospital.id }, select: { userId: true } })).map((m) => m.userId));
    const admins = new Set([`hospital.admin@${D}`, `hospital.billing@${D}`]);
    const rows: Prisma.ProviderMemberCreateManyInput[] = users.filter((u) => !have.has(u.id)).map((u) => ({
      providerId: hospital.id, userId: u.id, memberRole: admins.has(u.email!) ? 'ADMIN' : 'STAFF', status: 'ACTIVE', invitedById: hospital.ownerId, joinedAt: ago(19), createdAt: ago(20),
    }));
    return insert(rows, (c) => prisma.providerMember.createMany({ data: c }));
  });

  // ── 30 doctors affiliated with the hospital ────────────────────────────
  const FIRST = ['Sourav', 'Priyanka', 'Arnab', 'Moumita', 'Debojyoti', 'Sanchita', 'Kaushik', 'Ipsita', 'Abhijit', 'Rupa', 'Soumen', 'Paramita', 'Subrata', 'Nandini', 'Tanmoy', 'Sharmila', 'Pritam', 'Anwesha', 'Dibyendu', 'Jayati', 'Saikat', 'Madhumita', 'Avik', 'Rituparna', 'Sandip', 'Chandrima', 'Bikash', 'Sulagna', 'Partha', 'Shreya'];
  const LAST = ['Chakraborty', 'Sen', 'Bhattacharya', 'Mukherjee', 'Banerjee', 'Ghosh', 'Das', 'Roy', 'Maity', 'Jana', 'Samanta', 'Pal', 'Dutta', 'Bera', 'Adhikari', 'Mandal', 'Sahoo', 'Pradhan', 'Giri', 'Patra', 'Kar', 'Nayak', 'Hazra', 'Saha', 'Bose', 'Mishra', 'Dey', 'Panda', 'Naskar', 'Sarkar'];
  const doctorEmail = (n: number) => `demo.dr.${n}@${D}`;
  const doctorSlug = (n: number) => `demo-dr-${n}`;
  const DOCTOR_NS = Array.from({ length: 30 }, (_, i) => i + 1);
  await step('doctor users', async () => {
    const have = new Set((await prisma.user.findMany({ where: { email: { in: DOCTOR_NS.map(doctorEmail) } }, select: { email: true } })).map((u) => u.email));
    const rows: Prisma.UserCreateManyInput[] = DOCTOR_NS.filter((n) => !have.has(doctorEmail(n))).map((n) => ({
      email: doctorEmail(n), fullName: `Dr. ${FIRST[n - 1]} ${LAST[n - 1]}`, passwordHash: hash, status: 'ACTIVE', emailVerifiedAt: now, createdAt: ago(120 + n),
    }));
    return insert(rows, (c) => prisma.user.createMany({ data: c }));
  });
  const doctorUsers = new Map((await prisma.user.findMany({ where: { email: { in: DOCTOR_NS.map(doctorEmail) } } })).map((u) => [u.email!, u]));
  await step('doctor providers', async () => {
    const have = new Set((await prisma.provider.findMany({ where: { slug: { in: DOCTOR_NS.map(doctorSlug) } }, select: { slug: true } })).map((p) => p.slug));
    const rows: Prisma.ProviderCreateManyInput[] = [];
    for (const n of DOCTOR_NS) {
      const u = doctorUsers.get(doctorEmail(n));
      if (!u || have.has(doctorSlug(n))) continue;
      rows.push({
        type: 'DOCTOR', status: 'APPROVED', legalName: u.fullName, displayName: u.fullName, slug: doctorSlug(n), contactPhone: `98001${pad(2000 + n, 5)}`, isListed: true,
        submittedAt: plus(u.createdAt, 2 * DAY), approvedAt: plus(u.createdAt, 5 * DAY), ratingAverage: round2(3.6 + Math.random() * 1.4), ratingCount: 10 + randInt(180), createdAt: u.createdAt,
      });
    }
    return insert(rows, (c) => prisma.provider.createMany({ data: c }));
  });
  /** The demo doctors: n (1–30), provider id, user id — the old temp table `demo_doctors`. */
  const demoDoctors = (await prisma.provider.findMany({ where: { slug: { in: DOCTOR_NS.map(doctorSlug) } }, select: { id: true, slug: true } }))
    .map((p) => { const n = Number(p.slug.slice('demo-dr-'.length)); return { n, providerId: p.id, userId: doctorUsers.get(doctorEmail(n))!.id }; })
    .sort((a, b) => a.n - b.n);
  const demoDoctorIds = demoDoctors.map((d) => d.providerId);
  await step('doctor profiles', async () => {
    const have = new Set((await prisma.doctorProfile.findMany({ where: { providerId: { in: demoDoctorIds } }, select: { providerId: true } })).map((p) => p.providerId));
    const rows: Prisma.DoctorProfileCreateManyInput[] = demoDoctors.filter((d) => !have.has(d.providerId)).map((d) => ({
      providerId: d.providerId, userId: d.userId, gender: d.n % 2 === 0 ? 'FEMALE' : 'MALE', yearsOfExperience: 4 + (d.n * 7) % 26, languages: ['bn', 'en', 'hi'], defaultFeeMinor: BigInt(30000 + (d.n % 6) * 10000), bio: 'Consultant at Tamluk Seva Sadan Hospital.',
    }));
    return insert(rows, (c) => prisma.doctorProfile.createMany({ data: c }));
  });
  await step('doctor memberships', async () => {
    const have = new Set((await prisma.providerMember.findMany({ where: { providerId: { in: demoDoctorIds } }, select: { providerId: true, userId: true } })).map((m) => `${m.providerId}|${m.userId}`));
    const rows: Prisma.ProviderMemberCreateManyInput[] = demoDoctors.filter((d) => !have.has(`${d.providerId}|${d.userId}`)).map((d) => ({ providerId: d.providerId, userId: d.userId, memberRole: 'OWNER', status: 'ACTIVE', joinedAt: ago(100) }));
    return insert(rows, (c) => prisma.providerMember.createMany({ data: c }));
  });
  // Specialities offered through the active departments, in department-code order: doctor n gets the (n mod total)-th.
  const departments = await prisma.department.findMany({ where: { isActive: true, specialityId: { not: null } }, orderBy: { code: 'asc' }, select: { id: true, specialityId: true } });
  const departmentBySpeciality = new Map<string, string>();
  for (const d of departments) if (!departmentBySpeciality.has(d.specialityId!)) departmentBySpeciality.set(d.specialityId!, d.id);
  await step('doctor specialities', async () => {
    if (departments.length === 0) return 0;
    const have = new Set((await prisma.doctorSpeciality.findMany({ where: { doctorProviderId: { in: demoDoctorIds } }, select: { doctorProviderId: true } })).map((s) => s.doctorProviderId));
    const rows: Prisma.DoctorSpecialityCreateManyInput[] = demoDoctors.filter((d) => !have.has(d.providerId)).map((d) => ({ doctorProviderId: d.providerId, specialityId: at(departments, d.n).specialityId!, isPrimary: true, verified: true }));
    return insert(rows, (c) => prisma.doctorSpeciality.createMany({ data: c }));
  });
  await step('doctor qualifications', async () => {
    const have = new Set((await prisma.doctorQualification.findMany({ where: { doctorProviderId: { in: demoDoctorIds } }, select: { doctorProviderId: true } })).map((q) => q.doctorProviderId));
    const rows: Prisma.DoctorQualificationCreateManyInput[] = demoDoctors.filter((d) => !have.has(d.providerId)).flatMap((d) => [
      { doctorProviderId: d.providerId, degree: 'MBBS', institution: 'Medical College Kolkata', yearAwarded: 2000 + (d.n * 3) % 18, verified: true },
      { doctorProviderId: d.providerId, degree: 'MD', institution: 'IPGMER & SSKM Hospital', yearAwarded: 2000 + (d.n * 3) % 18, verified: true },
    ]);
    return insert(rows, (c) => prisma.doctorQualification.createMany({ data: c }));
  });
  await step('doctor registrations', async () => {
    const have = new Set((await prisma.professionalRegistration.findMany({ where: { doctorProviderId: { in: demoDoctorIds } }, select: { doctorProviderId: true } })).map((r) => r.doctorProviderId));
    const rows: Prisma.ProfessionalRegistrationCreateManyInput[] = demoDoctors.filter((d) => !have.has(d.providerId)).map((d) => ({
      doctorProviderId: d.providerId, council: 'West Bengal Medical Council', registrationNumber: `WBMC-DEMO-${60000 + d.n * 37}`, registrationYear: 2000 + (d.n * 3) % 18 + 1, verifiedAt: ago(90),
    }));
    return insert(rows, (c) => prisma.professionalRegistration.createMany({ data: c }));
  });
  await step('own chambers (10 of 30)', async () => {
    const have = new Set((await prisma.providerLocation.findMany({ where: { providerId: { in: demoDoctorIds } }, select: { providerId: true } })).map((l) => l.providerId));
    const rows: Prisma.ProviderLocationCreateManyInput[] = demoDoctors.filter((d) => d.n % 3 === 0 && !have.has(d.providerId)).map((d) => ({
      providerId: d.providerId, name: 'Chamber', addressLine1: `Ward ${d.n}, Tamluk`, city: 'Tamluk', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721636',
      latitude: 22.3 + (Math.random() - 0.5) * 0.05, longitude: 87.92 + (Math.random() - 0.5) * 0.05, isPrimary: true, isActive: true,
    }));
    return insert(rows, (c) => prisma.providerLocation.createMany({ data: c }));
  });
  const ENGAGEMENTS: EngagementType[] = ['FULL_TIME', 'VISITING', 'PART_TIME', 'CONSULTANT'];
  await step('affiliations', async () => {
    const have = new Set((await prisma.doctorAffiliation.findMany({ where: { doctorProviderId: { in: demoDoctorIds }, facilityProviderId: hospital.id }, select: { doctorProviderId: true } })).map((a) => a.doctorProviderId));
    const primary = new Map((await prisma.doctorSpeciality.findMany({ where: { doctorProviderId: { in: demoDoctorIds }, isPrimary: true } })).map((s) => [s.doctorProviderId, s.specialityId]));
    const rows: Prisma.DoctorAffiliationCreateManyInput[] = [];
    for (const d of demoDoctors) {
      const departmentId = departmentBySpeciality.get(primary.get(d.providerId) ?? '');
      if (have.has(d.providerId) || !departmentId) continue;
      rows.push({
        doctorProviderId: d.providerId, facilityProviderId: hospital.id, locationId: hospitalLocationId, departmentId, roleTitle: d.n % 4 === 0 ? 'Senior Consultant' : 'Consultant',
        engagementType: at(ENGAGEMENTS, d.n), consultationFeeMinor: BigInt(40000 + (d.n % 5) * 10000), status: 'ACTIVE', initiatedBy: 'FACILITY',
        doctorConfirmedAt: ago(95), facilityConfirmedAt: ago(96), verifiedAt: ago(94), startDate: dateOnly(shiftDate(today, -94)), createdAt: ago(96),
      });
    }
    return insert(rows, (c) => prisma.doctorAffiliation.createMany({ data: c }));
  });
  await step('affiliation events', async () => {
    const affiliations = await prisma.doctorAffiliation.findMany({ where: { doctorProviderId: { in: demoDoctorIds }, facilityProviderId: hospital.id, events: { none: {} } } });
    const rows: Prisma.AffiliationEventCreateManyInput[] = affiliations.flatMap((a) => [
      { affiliationId: a.id, fromStatus: null, toStatus: 'INVITED', actorKind: 'FACILITY', createdAt: a.createdAt },
      { affiliationId: a.id, fromStatus: 'INVITED', toStatus: 'PENDING_VERIFICATION', actorKind: 'DOCTOR', createdAt: a.doctorConfirmedAt ?? a.createdAt },
      { affiliationId: a.id, fromStatus: 'PENDING_VERIFICATION', toStatus: 'ACTIVE', actorKind: 'PLATFORM', createdAt: a.verifiedAt ?? a.createdAt },
    ]);
    return insert(rows, (c) => prisma.affiliationEvent.createMany({ data: c }));
  });

  // ── Schedules and slots (past 120 days + next 21) ──────────────────────
  const scheduleKey = (s: { doctorProviderId: string; locationId: string; dayOfWeek: number }) => `${s.doctorProviderId}|${s.locationId}|${s.dayOfWeek}`;
  await step('hospital schedules', async () => {
    const affiliations = await prisma.doctorAffiliation.findMany({ where: { doctorProviderId: { in: demoDoctorIds }, facilityProviderId: hospital.id } });
    const have = new Set((await prisma.doctorSchedule.findMany({ where: { doctorProviderId: { in: demoDoctorIds }, locationId: hospitalLocationId } })).map(scheduleKey));
    const rows: Prisma.DoctorScheduleCreateManyInput[] = [];
    for (const d of demoDoctors) {
      const a = affiliations.find((x) => x.doctorProviderId === d.providerId);
      if (!a) continue;
      const days = d.n % 3 === 0 ? [1, 3, 5] : d.n % 3 === 1 ? [2, 4, 6] : [1, 2, 4, 5];
      for (const dayOfWeek of days) {
        const row = { doctorProviderId: d.providerId, locationId: hospitalLocationId, dayOfWeek };
        if (have.has(scheduleKey(row))) continue;
        rows.push({ ...row, affiliationId: a.id, startMinute: d.n % 2 === 0 ? 600 : 1020, endMinute: d.n % 2 === 0 ? 780 : 1200, slotMinutes: 15, capacityPerSlot: 1, feeMinor: a.consultationFeeMinor, validFrom: dateOnly(shiftDate(today, -120)), isActive: true, createdById: hospital.ownerId });
      }
    }
    return insert(rows, (c) => prisma.doctorSchedule.createMany({ data: c }));
  });
  await step('chamber schedules', async () => {
    const chambers = await prisma.providerLocation.findMany({ where: { providerId: { in: demoDoctorIds } } });
    const have = new Set((await prisma.doctorSchedule.findMany({ where: { locationId: { in: chambers.map((l) => l.id) } } })).map(scheduleKey));
    const rows: Prisma.DoctorScheduleCreateManyInput[] = [];
    for (const l of chambers) {
      const d = demoDoctors.find((x) => x.providerId === l.providerId)!;
      for (const dayOfWeek of [1, 2, 3, 4, 5, 6]) {
        const row = { doctorProviderId: l.providerId, locationId: l.id, dayOfWeek };
        if (have.has(scheduleKey(row))) continue;
        rows.push({ ...row, startMinute: d.n % 2 === 0 ? 1020 : 600, endMinute: d.n % 2 === 0 ? 1140 : 720, slotMinutes: 15, capacityPerSlot: 1, feeMinor: BigInt(30000 + (d.n % 6) * 10000), validFrom: dateOnly(shiftDate(today, -120)), isActive: true });
      }
    }
    return insert(rows, (c) => prisma.doctorSchedule.createMany({ data: c }));
  });
  // Generate slots for every active schedule of the demo doctors (incl. Dr. Maity) over the window, skipping ones that exist.
  const slotDoctorIds = [...demoDoctorIds, anjali.id];
  await step('slots', async () => {
    const schedules = await prisma.doctorSchedule.findMany({ where: { doctorProviderId: { in: slotDoctorIds }, isActive: true } });
    const from = shiftDate(today, -120);
    const to = shiftDate(today, 21);
    const have = new Set((await prisma.appointmentSlot.findMany({ where: { doctorProviderId: { in: slotDoctorIds }, startsAt: { gte: istToUtc(from, 0), lt: istToUtc(shiftDate(to, 1), 0) } }, select: { doctorProviderId: true, locationId: true, startsAt: true } }))
      .map((s) => `${s.doctorProviderId}|${s.locationId}|${s.startsAt.getTime()}`));
    const rows: Prisma.AppointmentSlotCreateManyInput[] = [];
    for (let day = from; day <= to; day = shiftDate(day, 1)) {
      const dayOfWeek = new Date(`${day}T00:00:00Z`).getUTCDay();
      for (const s of schedules) {
        if (s.dayOfWeek !== dayOfWeek) continue;
        for (let m = s.startMinute; m + s.slotMinutes <= s.endMinute; m += s.slotMinutes) {
          const startsAt = istToUtc(day, m);
          const key = `${s.doctorProviderId}|${s.locationId}|${startsAt.getTime()}`;
          if (have.has(key)) continue;
          have.add(key);
          rows.push({
            doctorProviderId: s.doctorProviderId, locationId: s.locationId, affiliationId: s.affiliationId, scheduleId: s.id, startsAt, endsAt: plus(startsAt, s.slotMinutes * MIN),
            capacity: s.capacityPerSlot, bookedCount: 0, status: 'OPEN', feeMinor: s.feeMinor ?? 40000n, createdAt: new Date(Math.min(now.getTime(), startsAt.getTime() - 14 * DAY)),
          });
        }
      }
    }
    return insert(rows, (c) => prisma.appointmentSlot.createMany({ data: c }));
  });

  // ── Patients ───────────────────────────────────────────────────────────
  const PATIENT_FIRST = ['Riya', 'Amit', 'Sunita', 'Rajesh', 'Pooja', 'Biplab', 'Mithu', 'Swapan', 'Lakshmi', 'Gopal', 'Anita', 'Sanjay', 'Rekha', 'Tapan', 'Mamata', 'Dipak', 'Shampa', 'Ranjit', 'Kajal', 'Uttam', 'Sabita', 'Nirmal', 'Jhuma', 'Haradhan', 'Basanti', 'Prasanta', 'Aparna', 'Bablu', 'Chhaya', 'Sukumar', 'Malati', 'Ashok', 'Puja', 'Bapi', 'Sima', 'Ratan', 'Dola', 'Manik', 'Rina', 'Kartik'];
  const PATIENT_LAST = ['Das', 'Maity', 'Jana', 'Bera', 'Samanta', 'Pal', 'Ghosh', 'Mondal', 'Sahoo', 'Giri', 'Adhikari', 'Pradhan', 'Patra', 'Kar', 'Hazra', 'Manna', 'Dinda', 'Bhunia', 'Mahapatra', 'Shit'];
  const patientEmail = (g: number) => `demo.patient.${g}@${D}`;
  const PATIENT_GS = Array.from({ length: 1500 }, (_, i) => i + 1);
  await step('patient users', async () => {
    const have = new Set((await prisma.user.findMany({ where: { email: { startsWith: 'demo.patient.', endsWith: `@${D}` } }, select: { email: true } })).map((u) => u.email));
    const rows: Prisma.UserCreateManyInput[] = PATIENT_GS.filter((g) => !have.has(patientEmail(g))).map((g) => ({
      email: patientEmail(g), phone: `+9198${pad(10000000 + g, 8)}`, fullName: `${at(PATIENT_FIRST, g * 7)} ${at(PATIENT_LAST, g * 11)}`, passwordHash: hash, status: 'ACTIVE',
      emailVerifiedAt: now, phoneVerifiedAt: now, createdAt: new Date(now.getTime() - Math.random() * 150 * DAY),
    }));
    return insert(rows, (c) => prisma.user.createMany({ data: c }));
  });
  const patientUsers = await prisma.user.findMany({ where: { email: { startsWith: 'demo.patient.', endsWith: `@${D}` } } });
  await step('patient profiles', async () => {
    const have = new Set((await prisma.patientProfile.findMany({ where: { accountUserId: { in: patientUsers.map((u) => u.id) } }, select: { accountUserId: true } })).map((p) => p.accountUserId));
    const rows: Prisma.PatientProfileCreateManyInput[] = patientUsers.filter((u) => !have.has(u.id)).map((u) => ({
      accountUserId: u.id, fullName: u.fullName, relationship: 'SELF', dateOfBirth: dateOnly(shiftDate(shiftMonths(today, -12 * (18 + randInt(62))), -randInt(364))),
      gender: Math.random() < 0.5 ? 'FEMALE' : 'MALE', phone: u.phone, createdAt: u.createdAt,
    }));
    return insert(rows, (c) => prisma.patientProfile.createMany({ data: c }));
  });
  /** The old temp table `demo_patients`: the seeded patients in id order; index = (hash % count). */
  const demoPatients = (await prisma.patientProfile.findMany({ where: { accountUserId: { in: patientUsers.map((u) => u.id) } }, orderBy: { id: 'asc' }, select: { id: true, accountUserId: true } }));
  const patientAt = (k: number) => at(demoPatients, k);

  // ── Appointments on past slots (~72 % fill) and a few upcoming ─────────
  const REASONS = ['Fever and body ache', 'Follow-up', 'Chest discomfort', 'Routine check-up', 'Abdominal pain', 'Back pain', 'Headache', 'Diabetes review', 'Blood pressure review', 'Cough and cold'];
  const UPCOMING: AppointmentStatus[] = ['REQUESTED', 'CONFIRMED', 'CONFIRMED'];
  const PAST: AppointmentStatus[] = ['COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'NO_SHOW', 'CANCELLED_BY_PATIENT', 'CANCELLED_BY_PROVIDER', 'REJECTED', 'COMPLETED'];
  const CONFIRMED_LIKE = new Set<AppointmentStatus>(['CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'NO_SHOW', 'CANCELLED_BY_PATIENT', 'CANCELLED_BY_PROVIDER']);
  await step('appointments', async () => {
    const slots = await prisma.appointmentSlot.findMany({ where: { doctorProviderId: { in: slotDoctorIds }, bookedCount: 0 }, orderBy: [{ startsAt: 'asc' }, { id: 'asc' }] });
    const booked = new Set((await prisma.appointment.findMany({ where: { doctorProviderId: { in: slotDoctorIds } }, select: { slotId: true } })).map((a) => a.slotId));
    const facilityByAffiliation = new Map((await prisma.doctorAffiliation.findMany({ where: { doctorProviderId: { in: slotDoctorIds } }, select: { id: true, facilityProviderId: true } })).map((a) => [a.id, a.facilityProviderId]));
    const rows: Prisma.AppointmentCreateManyInput[] = [];
    slots.forEach((s, i) => {
      const n = i + 1;
      const past = s.startsAt < now;
      if (!((past && n % 100 < 72) || (!past && n % 100 < 35)) || booked.has(s.id)) return;
      const p = patientAt(n * 7919);
      const source: BookingSource = n % 7 === 0 ? 'WALK_IN' : n % 11 === 0 ? 'PROVIDER_PORTAL' : 'PATIENT_APP';
      const status = past ? at(PAST, n) : at(UPCOMING, n);
      rows.push({
        reference: ref('DEM', s.id), patientProfileId: p.id, bookedByUserId: p.accountUserId, doctorProviderId: s.doctorProviderId,
        facilityProviderId: (s.affiliationId && facilityByAffiliation.get(s.affiliationId)) || s.doctorProviderId, locationId: s.locationId, slotId: s.id, affiliationId: s.affiliationId,
        status, source, attribution: source === 'WALK_IN' ? 'PROVIDER_DIRECT' : 'PLATFORM', feeMinor: s.feeMinor, reasonForVisit: at(REASONS, n), idempotencyKey: `demo:${s.id}`,
        confirmedAt: CONFIRMED_LIKE.has(status) ? plus(s.startsAt, -2 * DAY) : null,
        checkedInAt: status === 'CHECKED_IN' || status === 'COMPLETED' ? plus(s.startsAt, -10 * MIN) : null,
        completedAt: status === 'COMPLETED' ? plus(s.startsAt, 18 * MIN) : null,
        cancelledAt: status.startsWith('CANCELLED') ? plus(s.startsAt, -DAY) : null,
        createdAt: plus(s.startsAt, -3 * DAY),
      });
    });
    return insert(rows, (c) => prisma.appointment.createMany({ data: c }));
  });
  await step('slot booked counts', async () => {
    const live = await prisma.appointment.findMany({ where: { reference: { startsWith: 'DEM-' }, status: { in: ['REQUESTED', 'CONFIRMED', 'CHECKED_IN'] } }, select: { slotId: true } });
    let n = 0;
    for (const chunk of chunked(live.map((a) => a.slotId))) n += (await prisma.appointmentSlot.updateMany({ where: { id: { in: chunk } }, data: { bookedCount: 1 } })).count;
    return n;
  });
  await step('appointment events', async () => {
    const appointments = await prisma.appointment.findMany({ where: { reference: { startsWith: 'DEM-' }, events: { none: {} } } });
    const rows: Prisma.AppointmentEventCreateManyInput[] = [];
    for (const a of appointments) {
      rows.push({ appointmentId: a.id, fromStatus: null, toStatus: 'REQUESTED', actorKind: a.source === 'WALK_IN' ? 'PROVIDER' : 'PATIENT', createdAt: a.createdAt });
      if (a.status !== 'REQUESTED') rows.push({ appointmentId: a.id, fromStatus: 'REQUESTED', toStatus: a.status, actorKind: a.status === 'CANCELLED_BY_PATIENT' ? 'PATIENT' : 'PROVIDER', createdAt: a.completedAt ?? a.cancelledAt ?? a.confirmedAt ?? plus(a.createdAt, HOUR) });
    }
    return insert(rows, (c) => prisma.appointmentEvent.createMany({ data: c }));
  });
  const REVIEW_COMMENTS = ['Doctor listened patiently and explained everything.', 'Short wait, clean OPD.', 'Good experience, billing was clear.', 'Had to wait 40 minutes but the consultation was thorough.', 'Very helpful front desk staff.', null, null];
  await step('reviews', async () => {
    const completed = await prisma.appointment.findMany({ where: { reference: { startsWith: 'DEM-' }, status: 'COMPLETED' }, select: { id: true, facilityProviderId: true, bookedByUserId: true, completedAt: true } });
    const reviewed = new Set((await prisma.review.findMany({ where: { appointmentId: { in: completed.map((a) => a.id) } }, select: { appointmentId: true } })).map((r) => r.appointmentId));
    const rows: Prisma.ReviewCreateManyInput[] = completed.filter((a) => !reviewed.has(a.id) && Math.random() < 0.12).map((a) => ({
      providerId: a.facilityProviderId, authorUserId: a.bookedByUserId, appointmentId: a.id, rating: 3 + randInt(2), comment: at(REVIEW_COMMENTS, randInt(6)), status: 'PUBLISHED',
      moderatedAt: plus(a.completedAt!, DAY), createdAt: plus(a.completedAt!, 6 * HOUR),
    }));
    return insert(rows, (c) => prisma.review.createMany({ data: c }));
  });

  // ── Lab orders with reports ─────────────────────────────────────────────
  const LAB_OPEN: DiagnosticOrderStatus[] = ['REQUESTED', 'CONFIRMED', 'SAMPLE_COLLECTED', 'PROCESSING', 'REPORT_READY'];
  await step('lab orders', async () => {
    const rows: Prisma.DiagnosticOrderCreateManyInput[] = [];
    for (let g = 1; g <= 300; g++) {
      const p = patientAt(g * 613);
      const ts = new Date(now.getTime() - (300 - g) * 0.4 * DAY);
      const status: DiagnosticOrderStatus = g > 290 ? at(LAB_OPEN, g) : g % 17 === 0 ? 'CANCELLED' : 'COMPLETED';
      const reference = ref('DDX', `${g}dx`);
      rows.push({
        reference, patientProfileId: p.id, bookedByUserId: p.accountUserId, providerId: lab.id, locationId: labLocationId, collectionMode: g % 3 === 0 ? 'HOME_COLLECTION' : 'CENTRE_VISIT',
        scheduledAt: plus(ts, DAY), collectionPincode: g % 3 === 0 ? '721629' : null, status, source: g % 9 === 0 ? 'ADMIN_CONSOLE' : 'PATIENT_APP', attribution: g % 9 === 0 ? 'ADMIN_ASSISTED' : 'PLATFORM',
        totalMinor: 0n, idempotencyKey: `demo:${reference}`, completedAt: status === 'COMPLETED' ? plus(ts, 2 * DAY) : null, createdAt: ts,
      });
    }
    const have = new Set((await prisma.diagnosticOrder.findMany({ where: { reference: { in: rows.map((r) => r.reference) } }, select: { reference: true } })).map((o) => o.reference));
    return insert(rows.filter((r) => !have.has(r.reference)), (c) => prisma.diagnosticOrder.createMany({ data: c }));
  });
  await step('lab order items', async () => {
    const orders = await prisma.diagnosticOrder.findMany({ where: { reference: { startsWith: 'DDX-' }, items: { none: {} } }, select: { id: true, reference: true } });
    const offerings = await prisma.providerService.findMany({ where: { providerId: lab.id, isActive: true }, include: { service: { select: { name: true } } } });
    if (offerings.length === 0) return 0;
    const rows: Prisma.DiagnosticOrderItemCreateManyInput[] = orders.flatMap((o) =>
      [...offerings].sort((a, b) => md5(o.id + a.id).localeCompare(md5(o.id + b.id))).slice(0, 1 + (o.reference.charCodeAt(4) % 2))
        .map((ps) => ({ orderId: o.id, providerServiceId: ps.id, serviceName: ps.service.name, priceMinor: ps.priceMinor })));
    return insert(rows, (c) => prisma.diagnosticOrderItem.createMany({ data: c }));
  });
  await step('lab order totals', () => orderTotals('DDX-'));
  await step('lab reports', () => publishReports('DDX-', lab.ownerId));

  // ── Pharmacy catalogue, stock and orders ───────────────────────────────
  const MEDICINES: [string, string, string, string, string, string, MedicineSchedule][] = [
    ['Dolo 650', 'Paracetamol', '650 mg', 'Tablet', '15', 'Micro Labs', 'OTC'], ['Crocin Advance', 'Paracetamol', '500 mg', 'Tablet', '20', 'GSK', 'OTC'], ['Azithral 500', 'Azithromycin', '500 mg', 'Tablet', '5', 'Alembic', 'SCHEDULE_H'],
    ['Augmentin 625 Duo', 'Amoxicillin + Clavulanate', '625 mg', 'Tablet', '10', 'GSK', 'SCHEDULE_H'], ['Pan 40', 'Pantoprazole', '40 mg', 'Tablet', '15', 'Alkem', 'SCHEDULE_H'], ['Omez', 'Omeprazole', '20 mg', 'Capsule', '20', "Dr. Reddy's", 'SCHEDULE_H'],
    ['Metformin SR', 'Metformin', '500 mg', 'Tablet', '20', 'Sun Pharma', 'SCHEDULE_H'], ['Glycomet GP 1', 'Glimepiride + Metformin', '1 mg/500 mg', 'Tablet', '15', 'USV', 'SCHEDULE_H'], ['Telma 40', 'Telmisartan', '40 mg', 'Tablet', '15', 'Glenmark', 'SCHEDULE_H'],
    ['Amlokind 5', 'Amlodipine', '5 mg', 'Tablet', '30', 'Mankind', 'SCHEDULE_H'], ['Atorva 10', 'Atorvastatin', '10 mg', 'Tablet', '15', 'Zydus', 'SCHEDULE_H'], ['Ecosprin 75', 'Aspirin', '75 mg', 'Tablet', '14', 'USV', 'SCHEDULE_H'],
    ['Montair LC', 'Montelukast + Levocetirizine', '10 mg/5 mg', 'Tablet', '15', 'Cipla', 'SCHEDULE_H'], ['Allegra 120', 'Fexofenadine', '120 mg', 'Tablet', '10', 'Sanofi', 'OTC'], ['Levocet', 'Levocetirizine', '5 mg', 'Tablet', '10', 'Hetero', 'OTC'],
    ['Asthalin Inhaler', 'Salbutamol', '100 mcg', 'Inhaler', '200 MDI', 'Cipla', 'SCHEDULE_H'], ['Budecort 200', 'Budesonide', '200 mcg', 'Inhaler', '200 MDI', 'Cipla', 'SCHEDULE_H'], ['Zincovit', 'Multivitamin', '-', 'Tablet', '15', 'Apex', 'OTC'],
    ['Shelcal 500', 'Calcium + Vitamin D3', '500 mg', 'Tablet', '15', 'Torrent', 'OTC'], ['Becosules', 'B-Complex', '-', 'Capsule', '20', 'Pfizer', 'OTC'], ['Electral', 'ORS', '21.8 g', 'Powder', '1', 'FDC', 'OTC'],
    ['Digene', 'Antacid', '-', 'Tablet', '15', 'Abbott', 'OTC'], ['Gelusil MPS', 'Antacid', '-', 'Syrup', '200 ml', 'Pfizer', 'OTC'], ['Cyclopam', 'Dicyclomine + Paracetamol', '20 mg/500 mg', 'Tablet', '10', 'Indoco', 'SCHEDULE_H'],
    ['Meftal Spas', 'Mefenamic acid + Dicyclomine', '250 mg/10 mg', 'Tablet', '10', 'Blue Cross', 'SCHEDULE_H'], ['Brufen 400', 'Ibuprofen', '400 mg', 'Tablet', '15', 'Abbott', 'OTC'], ['Volini Gel', 'Diclofenac', '1%', 'Gel', '30 g', 'Sun Pharma', 'OTC'],
    ['Betadine Ointment', 'Povidone iodine', '5%', 'Ointment', '20 g', 'Win-Medicare', 'OTC'], ['Candid B Cream', 'Clotrimazole + Beclometasone', '-', 'Cream', '20 g', 'Glenmark', 'SCHEDULE_H'], ['Cetaphil Lotion', 'Moisturiser', '-', 'Lotion', '100 ml', 'Galderma', 'OTC'],
    ['Norflox TZ', 'Norfloxacin + Tinidazole', '400 mg/600 mg', 'Tablet', '10', 'Cipla', 'SCHEDULE_H'], ['Ofloxacin 200', 'Ofloxacin', '200 mg', 'Tablet', '10', 'Cipla', 'SCHEDULE_H'], ['Thyronorm 50', 'Levothyroxine', '50 mcg', 'Tablet', '120', 'Abbott', 'SCHEDULE_H'],
    ['Eltroxin 100', 'Levothyroxine', '100 mcg', 'Tablet', '120', 'GSK', 'SCHEDULE_H'], ['Insulin Mixtard 30', 'Human insulin', '40 IU/ml', 'Injection', '10 ml', 'Novo Nordisk', 'SCHEDULE_H'], ['Glucon-D', 'Glucose', '-', 'Powder', '500 g', 'Heinz', 'OTC'],
    ['Alprax 0.5', 'Alprazolam', '0.5 mg', 'Tablet', '15', 'Torrent', 'SCHEDULE_H1'], ['Tramadol 50', 'Tramadol', '50 mg', 'Capsule', '10', 'Sun Pharma', 'SCHEDULE_H1'], ['Cefixime 200', 'Cefixime', '200 mg', 'Tablet', '10', 'Mankind', 'SCHEDULE_H1'], ['Lactogen 1', 'Infant formula', '-', 'Powder', '400 g', 'Nestle', 'OTC'],
  ];
  const medicineKey = (m: { name: string; strength: string | null; dosageForm: string | null; packSize: string | null; manufacturer: string | null }) => [m.name, m.strength, m.dosageForm, m.packSize, m.manufacturer].join('|');
  await step('medicines', async () => {
    const have = new Set((await prisma.medicine.findMany({ where: { name: { in: MEDICINES.map((m) => m[0]) } } })).map(medicineKey));
    const rows: Prisma.MedicineCreateManyInput[] = MEDICINES.map(([name, genericName, strength, dosageForm, packSize, manufacturer, schedule]) => ({ name, genericName, strength, dosageForm, packSize, manufacturer, schedule, requiresPrescription: schedule !== 'OTC' }));
    return insert(rows.filter((r) => !have.has([r.name, r.strength, r.dosageForm, r.packSize, r.manufacturer].join('|'))), (c) => prisma.medicine.createMany({ data: c }));
  });
  await step('stock batches', async () => {
    const stocked = new Set((await prisma.pharmacyInventory.findMany({ where: { providerId: pharmacy.id }, select: { medicineId: true } })).map((i) => i.medicineId));
    const medicines = (await prisma.medicine.findMany({ where: { isActive: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true } })).filter((m) => !stocked.has(m.id));
    const pairs = medicines.flatMap((m) => [1, 2].map((k) => ({ medicineId: m.id, k }))).slice(0, 60);
    const rows: Prisma.PharmacyInventoryCreateManyInput[] = pairs.map(({ medicineId, k }, idx) => {
      const i = idx + 1;
      const expiry = i % 23 === 0 ? shiftDate(today, 20) : i % 29 === 0 ? shiftDate(today, -5) : shiftDate(today, 200 + (i * 17) % 500);
      return {
        providerId: pharmacy.id, locationId: pharmacyLocationId, medicineId, batchNumber: `B${yymm(ago(k * 20))}${pad((i * 13) % 900 + 100, 3)}`, expiryDate: dateOnly(expiry),
        quantityOnHand: 40 + (i * 31) % 300, quantityReserved: 0, mrpMinor: BigInt(2500 + (i * 977) % 45000), sellingPriceMinor: BigInt(2200 + (i * 977) % 45000), createdAt: ago(k * 20),
      };
    });
    return insert(rows, (c) => prisma.pharmacyInventory.createMany({ data: c }));
  });
  const PHARMACY_OPEN: PharmacyOrderStatus[] = ['PLACED', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'PLACED', 'ACCEPTED', 'PREPARING'];
  const createdPharmacyOrders = new Set<string>(); // references inserted by this run — the only ones whose stock gets reserved
  await step('pharmacy orders', async () => {
    const rows: Prisma.PharmacyOrderCreateManyInput[] = [];
    for (let g = 1; g <= 400; g++) {
      const p = patientAt(g * 419);
      const ts = new Date(now.getTime() - (400 - g) * 0.3 * DAY);
      const status: PharmacyOrderStatus = g > 392 ? at(PHARMACY_OPEN, g - 393) : g % 19 === 0 ? 'CANCELLED' : g % 31 === 0 ? 'REJECTED' : 'DELIVERED';
      const reference = ref('DRX', `${g}rx`);
      rows.push({
        reference, patientProfileId: p.id, bookedByUserId: p.accountUserId, providerId: pharmacy.id, locationId: pharmacyLocationId, fulfilment: g % 4 === 0 ? 'DELIVERY' : 'PICKUP', deliveryPincode: g % 4 === 0 ? '721636' : null,
        status, source: 'PATIENT_APP', attribution: 'PLATFORM', totalMinor: 0n, idempotencyKey: `demo:${reference}`, completedAt: status === 'DELIVERED' ? plus(ts, DAY) : null, createdAt: ts,
      });
    }
    const have = new Set((await prisma.pharmacyOrder.findMany({ where: { reference: { in: rows.map((r) => r.reference) } }, select: { reference: true } })).map((o) => o.reference));
    const fresh = rows.filter((r) => !have.has(r.reference));
    for (const r of fresh) createdPharmacyOrders.add(r.reference);
    return insert(fresh, (c) => prisma.pharmacyOrder.createMany({ data: c }));
  });
  await step('pharmacy order items', async () => {
    const orders = await prisma.pharmacyOrder.findMany({ where: { reference: { startsWith: 'DRX-' }, items: { none: {} } }, select: { id: true, reference: true } });
    const stock = await prisma.pharmacyInventory.findMany({ where: { providerId: pharmacy.id, expiryDate: { gt: dateOnly(shiftDate(today, 30)) }, medicine: { requiresPrescription: false } } });
    if (stock.length === 0) return 0;
    const rows: Prisma.PharmacyOrderItemCreateManyInput[] = orders.flatMap((o) =>
      [...stock].sort((a, b) => md5(o.id + a.id).localeCompare(md5(o.id + b.id))).slice(0, 1 + (o.reference.charCodeAt(4) % 3))
        .map((inv, idx) => ({ orderId: o.id, medicineId: inv.medicineId, inventoryId: inv.id, quantity: 1 + (o.reference.length + idx + 1) % 3, unitPriceMinor: inv.sellingPriceMinor })));
    return insert(rows, (c) => prisma.pharmacyOrderItem.createMany({ data: c }));
  });
  await step('pharmacy order totals', async () => {
    const orders = await prisma.pharmacyOrder.findMany({ where: { reference: { startsWith: 'DRX-' } }, include: { items: { select: { quantity: true, unitPriceMinor: true } } } });
    let n = 0;
    for (const o of orders) {
      const total = o.items.reduce((sum, i) => sum + BigInt(i.quantity) * i.unitPriceMinor, 0n);
      if (total !== o.totalMinor) { await prisma.pharmacyOrder.update({ where: { id: o.id }, data: { totalMinor: total } }); n++; }
    }
    return n;
  });
  await step('reserve open pharmacy stock', async () => {
    if (createdPharmacyOrders.size === 0) return 0;
    const open = await prisma.pharmacyOrder.findMany({ where: { reference: { in: [...createdPharmacyOrders] }, status: { in: ['PLACED', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY'] } }, include: { items: true } });
    const reserve = new Map<string, number>();
    for (const o of open) for (const i of o.items) if (i.inventoryId) reserve.set(i.inventoryId, (reserve.get(i.inventoryId) ?? 0) + i.quantity);
    for (const [inventoryId, q] of reserve) await prisma.pharmacyInventory.update({ where: { id: inventoryId }, data: { quantityReserved: { increment: q } } });
    return reserve.size;
  });

  // ── Ambulance trips ────────────────────────────────────────────────────
  const PICKUPS = ['Near Tamluk bus stand', 'Moyna Bazar', 'Nandakumar crossing', 'Mahishadal Raj College gate', 'Haldia Township Sector 4', 'Chandipur beach road', 'Kolaghat station road'];
  await step('dispatch requests', async () => {
    const rows: Prisma.DispatchRequestCreateManyInput[] = [];
    for (let g = 1; g <= 90; g++) {
      const p = patientAt(g * 307);
      const ts = new Date(now.getTime() - (90 - g) * 1.3 * DAY - (g % 24) * HOUR);
      const status: DispatchStatus = g % 13 === 0 ? 'CANCELLED' : 'COMPLETED';
      rows.push({
        reference: ref('DEM', `${g}amb`), mode: 'LIVE', status, requestedByUserId: p.accountUserId, callerPhone: `+9198${pad(20000000 + g, 8)}`,
        pickupLatitude: 22.3 + (Math.random() - 0.5) * 0.3, pickupLongitude: 87.92 + (Math.random() - 0.5) * 0.3, pickupAddress: at(PICKUPS, g), pickupDistrict: 'Purba Medinipur',
        requiredVehicleType: g % 5 === 0 ? 'ALS' : 'BLS', emergencyGuidanceShownAt: ts, closedAt: plus(ts, 70 * MIN), createdAt: ts,
      });
    }
    const have = new Set((await prisma.dispatchRequest.findMany({ where: { reference: { in: rows.map((r) => r.reference) } }, select: { reference: true } })).map((r) => r.reference));
    return insert(rows.filter((r) => !have.has(r.reference)), (c) => prisma.dispatchRequest.createMany({ data: c }));
  });
  await step('dispatch assignments', async () => {
    const requests = await prisma.dispatchRequest.findMany({ where: { reference: { startsWith: 'DEM-' }, assignments: { none: {} } } });
    const vehicles = await prisma.ambulanceVehicle.findMany({ where: { operatorProviderId: operator.id }, orderBy: { createdAt: 'asc' } });
    const rows: Prisma.DispatchAssignmentCreateManyInput[] = [];
    for (const r of requests) {
      const vehicle = vehicles.find((v) => v.vehicleType === r.requiredVehicleType);
      if (!vehicle) continue;
      rows.push({
        requestId: r.id, operatorProviderId: operator.id, vehicleId: vehicle.id, status: r.status === 'COMPLETED' ? 'COMPLETED' : 'CANCELLED', confirmationSource: 'OPERATOR_APP', confirmedByUserId: operator.ownerId,
        offeredAt: plus(r.createdAt, 20_000), respondedAt: plus(r.createdAt, 75_000), etaMinutes: 8 + (r.reference.length * 3) % 20,
      });
    }
    return insert(rows, (c) => prisma.dispatchAssignment.createMany({ data: c }));
  });
  await step('dispatch events', async () => {
    const requests = await prisma.dispatchRequest.findMany({ where: { reference: { startsWith: 'DEM-' }, events: { none: {} } } });
    const TRAIL: [DispatchStatus | null, DispatchStatus, string, number][] = [
      [null, 'RECEIVED', 'PATIENT', 0], ['RECEIVED', 'SEARCHING', 'SYSTEM', 0], ['SEARCHING', 'OFFERED', 'SYSTEM', 0], ['OFFERED', 'ACCEPTED', 'OPERATOR', 1], ['ACCEPTED', 'EN_ROUTE', 'OPERATOR', 3],
      ['EN_ROUTE', 'ARRIVED', 'OPERATOR', 18], ['ARRIVED', 'PATIENT_ONBOARD', 'OPERATOR', 26], ['PATIENT_ONBOARD', 'AT_DESTINATION', 'OPERATOR', 55], ['AT_DESTINATION', 'COMPLETED', 'OPERATOR', 70],
    ];
    const rows: Prisma.DispatchEventCreateManyInput[] = [];
    for (const r of requests) {
      for (const [fromStatus, toStatus, actorKind, m] of TRAIL) if (r.status === 'COMPLETED' || m <= 1) rows.push({ requestId: r.id, fromStatus, toStatus, actorKind, createdAt: plus(r.createdAt, m * MIN) });
      if (r.status === 'CANCELLED') rows.push({ requestId: r.id, fromStatus: 'ACCEPTED', toStatus: 'CANCELLED', actorKind: 'PATIENT', createdAt: plus(r.createdAt, 6 * MIN) });
    }
    return insert(rows, (c) => prisma.dispatchEvent.createMany({ data: c }));
  });

  // ── Money: transactions, ledger, settlements ────────────────────────────
  await step('transactions · appointments', async () => {
    const appointmentsCandidates = await prisma.appointment.findMany({ where: { reference: { startsWith: 'DEM-' } } });
    // "has no transaction yet" as an id-set check: a relation-null filter would $lookup every transaction and time out on Atlas.
    const appointmentsLinked = new Set((await prisma.serviceTransaction.findMany({ where: { appointmentId: { in: appointmentsCandidates.map((x) => x.id) } }, select: { appointmentId: true } })).map((t) => t.appointmentId));
    const appointments = appointmentsCandidates.filter((x) => !appointmentsLinked.has(x.id));
    const rows: Prisma.ServiceTransactionCreateManyInput[] = appointments.map((a) => {
      const direct = a.attribution === 'PROVIDER_DIRECT';
      const status: TransactionStatus = a.status === 'COMPLETED' ? (direct ? 'PAY_AT_PROVIDER' : 'PAID') : a.status.startsWith('CANCELLED') || a.status === 'REJECTED' ? 'CANCELLED' : a.status === 'NO_SHOW' ? 'PAID' : direct ? 'PAY_AT_PROVIDER' : 'PENDING_PAYMENT';
      return {
        reference: ref('DTX', a.id), sourceType: 'APPOINTMENT', appointmentId: a.id, providerId: a.facilityProviderId, patientProfileId: a.patientProfileId, category: 'CONSULTATION', grossMinor: a.feeMinor, status, attribution: a.attribution,
        commissionEligible: a.status === 'COMPLETED' && a.attribution === 'PLATFORM', eligibilityReason: direct ? 'Walk-in booking: no platform commission' : a.status === 'COMPLETED' ? 'Service completed through the platform' : null,
        serviceCompletedAt: a.completedAt, createdAt: a.createdAt,
      };
    });
    return insert(rows, (c) => prisma.serviceTransaction.createMany({ data: c }));
  });
  await step('transactions · lab', async () => {
    const ordersCandidates = await prisma.diagnosticOrder.findMany({ where: { reference: { startsWith: 'DDX-' } } });
    // "has no transaction yet" as an id-set check: a relation-null filter would $lookup every transaction and time out on Atlas.
    const ordersLinked = new Set((await prisma.serviceTransaction.findMany({ where: { diagnosticOrderId: { in: ordersCandidates.map((x) => x.id) } }, select: { diagnosticOrderId: true } })).map((t) => t.diagnosticOrderId));
    const orders = ordersCandidates.filter((x) => !ordersLinked.has(x.id));
    const rows: Prisma.ServiceTransactionCreateManyInput[] = orders.map((o) => ({
      reference: ref('DTX', o.id), sourceType: 'DIAGNOSTIC_ORDER', diagnosticOrderId: o.id, providerId: o.providerId, patientProfileId: o.patientProfileId, category: 'DIAGNOSTIC', grossMinor: o.totalMinor,
      status: o.status === 'CANCELLED' ? 'CANCELLED' : o.status === 'REQUESTED' ? 'PENDING_PAYMENT' : 'PAID', attribution: o.attribution, commissionEligible: o.status === 'COMPLETED',
      eligibilityReason: o.status === 'COMPLETED' ? 'Report published' : null, serviceCompletedAt: o.completedAt, createdAt: o.createdAt,
    }));
    return insert(rows, (c) => prisma.serviceTransaction.createMany({ data: c }));
  });
  await step('transactions · pharmacy', async () => {
    const ordersCandidates = await prisma.pharmacyOrder.findMany({ where: { reference: { startsWith: 'DRX-' } } });
    // "has no transaction yet" as an id-set check: a relation-null filter would $lookup every transaction and time out on Atlas.
    const ordersLinked = new Set((await prisma.serviceTransaction.findMany({ where: { pharmacyOrderId: { in: ordersCandidates.map((x) => x.id) } }, select: { pharmacyOrderId: true } })).map((t) => t.pharmacyOrderId));
    const orders = ordersCandidates.filter((x) => !ordersLinked.has(x.id));
    const rows: Prisma.ServiceTransactionCreateManyInput[] = orders.map((o) => ({
      reference: ref('DTX', o.id), sourceType: 'PHARMACY_ORDER', pharmacyOrderId: o.id, providerId: o.providerId, patientProfileId: o.patientProfileId, category: 'PHARMACY', grossMinor: o.totalMinor,
      status: o.status === 'CANCELLED' || o.status === 'REJECTED' ? 'CANCELLED' : o.status === 'PLACED' ? 'PENDING_PAYMENT' : 'PAID', attribution: o.attribution, commissionEligible: o.status === 'DELIVERED',
      eligibilityReason: o.status === 'DELIVERED' ? 'Order delivered' : null, serviceCompletedAt: o.completedAt, createdAt: o.createdAt,
    }));
    return insert(rows, (c) => prisma.serviceTransaction.createMany({ data: c }));
  });
  await step('transactions · ambulance', async () => {
    const requestsCandidates = await prisma.dispatchRequest.findMany({ where: { reference: { startsWith: 'DEM-' } } });
    // "has no transaction yet" as an id-set check: a relation-null filter would $lookup every transaction and time out on Atlas.
    const requestsLinked = new Set((await prisma.serviceTransaction.findMany({ where: { dispatchRequestId: { in: requestsCandidates.map((x) => x.id) } }, select: { dispatchRequestId: true } })).map((t) => t.dispatchRequestId));
    const requests = requestsCandidates.filter((x) => !requestsLinked.has(x.id));
    const rows: Prisma.ServiceTransactionCreateManyInput[] = requests.map((r) => ({
      reference: ref('DTX', r.id), sourceType: 'AMBULANCE_DISPATCH', dispatchRequestId: r.id, providerId: operator.id, category: 'AMBULANCE', grossMinor: BigInt(120000 + (r.reference.length * 7919) % 90000),
      status: r.status === 'COMPLETED' ? 'PAID' : 'CANCELLED', attribution: 'PLATFORM', commissionEligible: r.status === 'COMPLETED', eligibilityReason: r.status === 'COMPLETED' ? 'Trip completed' : null,
      serviceCompletedAt: r.closedAt, createdAt: r.createdAt,
    }));
    return insert(rows, (c) => prisma.serviceTransaction.createMany({ data: c }));
  });
  await step('ledger · earnings and commission', () => postEarnings({ reference: { startsWith: 'DTX-' } }));
  // Four completed monthly payouts per provider for everything older than the last 21 days.
  await step('settlement batches', async () => {
    const rows: Prisma.SettlementBatchCreateManyInput[] = [];
    for (let pe = plus(istToUtc(today, 0), -111 * DAY); pe <= ago(21); pe = plus(pe, 30 * DAY)) {
      rows.push({ reference: `DSB-${yyyymmdd(pe)}`, status: 'COMPLETED', periodEnd: pe, totalMinor: 0n, itemCount: 0, createdById: staff.maker, approvedById: staff.checker, approvedAt: plus(pe, DAY), completedAt: plus(pe, 3 * DAY), notes: 'Demo payout cycle', createdAt: plus(pe, DAY) });
    }
    const have = new Set((await prisma.settlementBatch.findMany({ where: { reference: { in: rows.map((r) => r.reference) } }, select: { reference: true } })).map((b) => b.reference));
    return insert(rows.filter((r) => !have.has(r.reference)), (c) => prisma.settlementBatch.createMany({ data: c }));
  });
  const batches = await prisma.settlementBatch.findMany({ where: { reference: { startsWith: 'DSB-' } }, orderBy: { periodEnd: 'asc' } });
  const settleWindow = (b: { periodEnd: Date }) => ({ gt: plus(b.periodEnd, -30 * DAY), lte: b.periodEnd });
  const SETTLED_TYPES: LedgerEntryType[] = ['SERVICE_EARNING', 'COMMISSION'];
  await step('settlement items', async () => {
    const rows: Prisma.SettlementItemCreateManyInput[] = [];
    for (const b of batches) {
      const have = new Set((await prisma.settlementItem.findMany({ where: { batchId: b.id }, select: { providerId: true } })).map((i) => i.providerId));
      const entries = await prisma.providerLedgerEntry.findMany({ where: { settlementItemId: null, entryType: { in: SETTLED_TYPES }, dedupeKey: { contains: ':' }, createdAt: settleWindow(b) }, select: { providerId: true, amountMinor: true } });
      const sums = new Map<string, bigint>();
      for (const e of entries) sums.set(e.providerId, (sums.get(e.providerId) ?? 0n) + e.amountMinor);
      for (const [providerId, amountMinor] of sums) {
        if (amountMinor <= 0n || have.has(providerId)) continue;
        rows.push({ batchId: b.id, providerId, amountMinor, status: 'PAID', payoutReference: `UTR${yymmdd(b.periodEnd)}${md5(providerId + b.id).slice(0, 8).toUpperCase()}`, paidAt: b.completedAt, recordedById: hospital.ownerId, createdAt: b.createdAt });
      }
    }
    return insert(rows, (c) => prisma.settlementItem.createMany({ data: c }));
  });
  const settlementItems = await prisma.settlementItem.findMany({ where: { batchId: { in: batches.map((b) => b.id) } } });
  await step('link ledger to payouts', async () => {
    let n = 0;
    for (const i of settlementItems) {
      const b = batches.find((x) => x.id === i.batchId)!;
      n += (await prisma.providerLedgerEntry.updateMany({ where: { providerId: i.providerId, settlementItemId: null, entryType: { in: SETTLED_TYPES }, createdAt: settleWindow(b) }, data: { settlementItemId: i.id } })).count;
    }
    return n;
  });
  await step('ledger · payouts', async () => {
    const have = new Set((await prisma.providerLedgerEntry.findMany({ where: { settlementItemId: { in: settlementItems.map((i) => i.id) }, entryType: 'SETTLEMENT_PAYOUT' }, select: { settlementItemId: true } })).map((e) => e.settlementItemId));
    const rows: Prisma.ProviderLedgerEntryCreateManyInput[] = settlementItems.filter((i) => !have.has(i.id)).map((i) => ({
      providerId: i.providerId, settlementItemId: i.id, entryType: 'SETTLEMENT_PAYOUT', amountMinor: -i.amountMinor, dedupeKey: `payout:${i.id}`, description: `Payout ${i.payoutReference}`, createdAt: i.paidAt ?? i.createdAt,
    }));
    return insert(rows, (c) => prisma.providerLedgerEntry.createMany({ data: c }));
  });
  await step('batch totals', async () => {
    for (const b of batches) {
      const items = settlementItems.filter((i) => i.batchId === b.id);
      await prisma.settlementBatch.update({ where: { id: b.id }, data: { totalMinor: items.reduce((s, i) => s + i.amountMinor, 0n), itemCount: items.length } });
    }
    return batches.length;
  });

  // ── Notifications and support history ──────────────────────────────────
  const TEMPLATES = ['booking.confirmed', 'booking.cancelled', 'provider.status_changed', 'booking.confirmed', 'auth.password_reset'];
  await step('notifications', async () => {
    const owners = await prisma.providerMember.findMany({ where: { providerId: { in: ORG_IDS }, memberRole: 'OWNER' }, include: { user: { select: { id: true, email: true } } } });
    const rows: Prisma.NotificationCreateManyInput[] = [];
    for (const m of owners) {
      if ((await prisma.notification.count({ where: { userId: m.user.id, templateKey: { in: TEMPLATES } } })) >= 24) continue;
      for (let g = 1; g <= 24; g++) {
        rows.push({ userId: m.user.id, channel: g % 3 === 0 ? 'SMS' : 'EMAIL', templateKey: at(TEMPLATES, g), recipient: m.user.email ?? '', payload: {}, status: g % 17 === 0 ? 'FAILED' : 'SENT', attempts: 1, sentAt: ago(g * 9 / 24), createdAt: ago(g * 9 / 24) });
      }
    }
    return insert(rows, (c) => prisma.notification.createMany({ data: c }));
  });
  await step('support cases', async () => {
    const CASES: [number, SupportCaseType, string, SupportCasePriority, SupportCaseStatus, string, string][] = [
      [1, 'COMPLAINT', 'WAIT_TIME', 'MEDIUM', 'OPEN', 'Waited over an hour past slot time', 'Appointment was at 10:30 but the doctor saw me at 11:45.'],
      [7, 'DISPUTE', 'BILLING', 'HIGH', 'IN_PROGRESS', 'Charged more than the listed fee', 'The app showed ₹500 but I paid ₹700 at the counter.'],
      [13, 'REFUND_REQUEST', 'REFUND', 'HIGH', 'RESOLVED', 'Refund for cancelled appointment', 'Doctor was on leave; please refund the booking.'],
      [19, 'COMPLAINT', 'BEHAVIOUR', 'LOW', 'CLOSED', 'Reception staff were rude', 'Front desk did not help with the queue.'],
      [25, 'SUPPORT', 'REPORT_ACCESS', 'MEDIUM', 'AWAITING_REPORTER', 'Cannot open my lab report', 'The PDF does not open on my phone.'],
      [31, 'DISPUTE', 'SERVICE_QUALITY', 'URGENT', 'ESCALATED', 'Wrong medicine delivered', 'Received 500 mg instead of 650 mg tablets.'],
      [37, 'COMPLAINT', 'WAIT_TIME', 'LOW', 'RESOLVED', 'Long queue at OPD', 'Token system was not followed.'],
      [43, 'REFUND_REQUEST', 'REFUND', 'MEDIUM', 'OPEN', 'Home collection did not happen', 'Nobody came for the sample on the scheduled day.'],
    ];
    const paid = await prisma.serviceTransaction.findMany({ where: { reference: { startsWith: 'DTX-' }, status: 'PAID', patientProfileId: { not: null } }, orderBy: { createdAt: 'desc' }, take: 50, include: { patient: { select: { accountUserId: true } } } });
    const rows: Prisma.SupportCaseCreateManyInput[] = [];
    for (const [rn, type, category, priority, status, subject, description] of CASES) {
      const t = paid[rn - 1];
      if (!t) continue;
      const closed = status === 'RESOLVED' || status === 'CLOSED';
      rows.push({
        reference: ref('DSC', `${t.id}sc`), type, category, priority, status, subject, description, reporterUserId: t.patient?.accountUserId ?? null, providerId: t.providerId, transactionId: t.id,
        slaDueAt: plus(t.createdAt, 3 * DAY), resolution: closed ? 'Resolved with the provider; patient informed.' : null, resolvedAt: closed ? plus(t.createdAt, 2 * DAY) : null, createdAt: plus(t.createdAt, DAY),
      });
    }
    const have = new Set((await prisma.supportCase.findMany({ where: { reference: { in: rows.map((r) => r.reference) } }, select: { reference: true } })).map((c) => c.reference));
    return insert(rows.filter((r) => !have.has(r.reference)), (c) => prisma.supportCase.createMany({ data: c }));
  });
  await step('provider ratings', () => refreshRatings());
} catch (err) {
  console.error('Volume seed stopped; run it again to resume — every step skips what already exists.');
  await prisma.$disconnect();
  throw err;
}

// ── Shared sub-steps ─────────────────────────────────────────────────────
/** Set each order's total to the sum of its items (orders whose reference starts with `prefix`). */
async function orderTotals(prefix: string) {
  const orders = await prisma.diagnosticOrder.findMany({ where: { reference: { startsWith: prefix } }, include: { items: { select: { priceMinor: true } } } });
  let n = 0;
  for (const o of orders) {
    const total = o.items.reduce((sum, i) => sum + i.priceMinor, 0n);
    if (total !== o.totalMinor) { await prisma.diagnosticOrder.update({ where: { id: o.id }, data: { totalMinor: total } }); n++; }
  }
  return n;
}
/** One published v1 report for every REPORT_READY/COMPLETED order that has none yet. */
async function publishReports(prefix: string, publishedById: string) {
  const orders = await prisma.diagnosticOrder.findMany({ where: { reference: { startsWith: prefix }, status: { in: ['REPORT_READY', 'COMPLETED'] }, reports: { none: {} } } });
  const rows: Prisma.DiagnosticReportCreateManyInput[] = orders.map((o) => {
    const publishedAt = o.completedAt ?? plus(o.createdAt, DAY);
    return { orderId: o.id, version: 1, status: 'PUBLISHED', storageKey: `demo/reports/${o.id}/v1.pdf`, sha256: md5(o.id) + md5(o.reference), publishedById, publishedAt, createdAt: publishedAt };
  });
  return insert(rows, (c) => prisma.diagnosticReport.createMany({ data: c }));
}
/** SERVICE_EARNING + 10 % COMMISSION ledger entries for paid, commission-eligible, completed transactions (idempotent on dedupeKey). */
async function postEarnings(where: Prisma.ServiceTransactionWhereInput) {
  const txns = await prisma.serviceTransaction.findMany({ where: { ...where, status: 'PAID', commissionEligible: true, serviceCompletedAt: { not: null } } });
  const rows: Prisma.ProviderLedgerEntryCreateManyInput[] = [];
  for (const chunk of chunked(txns)) {
    const have = new Set((await prisma.providerLedgerEntry.findMany({ where: { transactionId: { in: chunk.map((t) => t.id) } }, select: { dedupeKey: true } })).map((e) => e.dedupeKey));
    for (const t of chunk) {
      if (!have.has(`earning:${t.id}`)) rows.push({ providerId: t.providerId, transactionId: t.id, entryType: 'SERVICE_EARNING', amountMinor: t.grossMinor, dedupeKey: `earning:${t.id}`, description: `Service earning ${t.reference}`, createdAt: t.serviceCompletedAt! });
      if (!have.has(`commission:${t.id}`)) rows.push({ providerId: t.providerId, transactionId: t.id, entryType: 'COMMISSION', amountMinor: -((t.grossMinor * 10n) / 100n), dedupeKey: `commission:${t.id}`, description: `Platform fee 10% on ${t.reference}`, createdAt: t.serviceCompletedAt! });
    }
  }
  return insert(rows, (c) => prisma.providerLedgerEntry.createMany({ data: c }));
}
/** Recompute ratingAverage / ratingCount from published reviews. */
async function refreshRatings(providerIds?: string[]) {
  const groups = await prisma.review.groupBy({ by: ['providerId'], where: { status: 'PUBLISHED', ...(providerIds ? { providerId: { in: providerIds } } : {}) }, _avg: { rating: true }, _count: { _all: true } });
  for (const g of groups) await prisma.provider.update({ where: { id: g.providerId }, data: { ratingAverage: round2(g._avg.rating ?? 0), ratingCount: g._count._all } });
  return groups.length;
}

// ── Summary ──────────────────────────────────────────────────────────────
const sizes = await Promise.all(([
  ['users', prisma.user], ['patient_profiles', prisma.patientProfile], ['providers', prisma.provider], ['doctor_affiliations', prisma.doctorAffiliation], ['appointment_slots', prisma.appointmentSlot], ['appointments', prisma.appointment],
  ['diagnostic_orders', prisma.diagnosticOrder], ['pharmacy_orders', prisma.pharmacyOrder], ['pharmacy_inventory', prisma.pharmacyInventory], ['dispatch_requests', prisma.dispatchRequest], ['service_transactions', prisma.serviceTransaction],
  ['provider_ledger_entries', prisma.providerLedgerEntry], ['settlement_items', prisma.settlementItem], ['reviews', prisma.review], ['support_cases', prisma.supportCase], ['notifications', prisma.notification],
] as [string, { count(): Promise<number> }][]).map(async ([table, model]) => ({ table, rows: await model.count() })));
console.table(sizes.sort((a, b) => b.rows - a.rows));
console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s.`);
console.log(`Extra logins (password ${PASSWORD}): hospital.admin@${D}, hospital.desk1@${D}, demo.dr.1@${D} … demo.dr.30@${D}`);
await prisma.$disconnect();
