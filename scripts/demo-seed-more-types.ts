/**
 * Demo organisations for the two provider types demo:seed does not cover
 * (development only), with about three months of history so every portal
 * page has something to show:
 *
 *   Clinic         Moyna Family Clinic: 3 departments, 5 visiting doctors from the
 *                  hospital (including Dr. Abhijit Maity), morning OPD, appointments,
 *                  reviews and the money behind them.
 *   Imaging centre Tamluk Imaging & Scan Centre: X-ray, ultrasound, CT, MRI, ECG and
 *                  echo price list, ~200 orders with published reports and payments.
 *
 *   npm run demo:seed:more
 *
 * Run after demo:seed and demo:seed:volume. Refuses production; does nothing
 * when the clinic and imaging centre are already complete. Written with typed
 * Prisma calls against MongoDB: there is no single wrapping transaction
 * (MongoDB caps one at 60 s), so every step skips rows that already exist and
 * an interrupted run can simply be started again.
 *
 * Slot times are IST wall-clock minutes converted to UTC instants (07:00 IST
 * is stored as 01:30Z); "today" is the IST calendar date.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { prisma, type Prisma } from '../src/lib/prisma.js';
import { hashPassword } from '../src/modules/auth/passwords.js';
import { istToUtc, utcToIstParts } from '../src/lib/time.js';
import type { AppointmentStatus, BookingSource, DiagnosticOrderStatus, TransactionStatus } from '../generated/prisma/enums.js';

if (process.env.APP_ENV === 'production') { console.error('Refusing to seed demo data in production.'); process.exit(2); }
const PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo-Carevanta-2026';
const D = 'demo.carevanta.local';
const CHUNK = 1000;
const CLINIC_SLUG = 'demo-moyna-family-clinic';
const IMAGING_SLUG = 'demo-tamluk-imaging-centre';

// ── Helpers ──────────────────────────────────────────────────────────────
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = new Date();
const today = utcToIstParts(now).date; // IST calendar date, YYYY-MM-DD
const ago = (days: number) => new Date(now.getTime() - days * DAY);
const plus = (at: Date, ms: number) => new Date(at.getTime() + ms);
const shiftDate = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
/** Date-only values are stored as UTC midnight, as the API does with `new Date('YYYY-MM-DD')`. */
const dateOnly = (date: string) => new Date(`${date}T00:00:00Z`);
const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const ref = (prefix: string, seed: string) => `${prefix}-${md5(seed).slice(0, 10).toUpperCase()}`;
/** `(random() * max)::int` in Postgres rounds half away from zero. */
const randInt = (max: number) => Math.round(Math.random() * max);
const round2 = (x: number) => Math.round(x * 100) / 100;
/** Zero-based pick that mirrors Postgres' `(ARRAY[...])[1 + (x % len)]`. */
const at = <T>(arr: readonly T[], i: number): T => arr[((i % arr.length) + arr.length) % arr.length]!;
const chunked = <T>(rows: T[]) => { const out: T[][] = []; for (let i = 0; i < rows.length; i += CHUNK) out.push(rows.slice(i, i + CHUNK)); return out; };

async function step(name: string, fn: () => Promise<number>) {
  const t = Date.now();
  const n = await fn();
  console.log(`${name.padEnd(30)} ${String(n).padStart(6)} rows  ${((Date.now() - t) / 1000).toFixed(1)}s`);
  return n;
}
async function insert<T>(rows: T[], createMany: (chunk: T[]) => Promise<{ count: number }>) {
  let n = 0;
  for (const chunk of chunked(rows)) n += (await createMany(chunk)).count;
  return n;
}

// ── Preconditions ────────────────────────────────────────────────────────
const demoDoctorUsers = await prisma.user.findMany({ where: { email: { startsWith: 'demo.dr.', endsWith: `@${D}` } }, select: { id: true, fullName: true } });
if (demoDoctorUsers.length === 0) throw new Error('Run npm run demo:seed and npm run demo:seed:volume first.');
const existingClinic = await prisma.provider.findUnique({ where: { slug: CLINIC_SLUG } });
if (existingClinic && (await prisma.providerLedgerEntry.count({ where: { providerId: existingClinic.id } })) > 0) {
  console.log('Clinic and imaging centre already exist. Nothing to do.');
  await prisma.$disconnect();
  process.exit(0);
}

const hash = await hashPassword(PASSWORD);
const OWNERS: [string, string, string][] = [[CLINIC_SLUG, `clinic.owner@${D}`, 'Dr. Kamal Bhunia'], [IMAGING_SLUG, `imaging.owner@${D}`, 'Shyamal Dinda']];

try {
  // ── Owners ──────────────────────────────────────────────────────────────
  await step('owner users', async () => {
    const have = new Set((await prisma.user.findMany({ where: { email: { in: OWNERS.map(([, e]) => e) } }, select: { email: true } })).map((u) => u.email));
    const rows: Prisma.UserCreateManyInput[] = OWNERS.filter(([, e]) => !have.has(e)).map(([, email, fullName]) => ({ email, fullName, passwordHash: hash, status: 'ACTIVE', emailVerifiedAt: now, createdAt: ago(100) }));
    return insert(rows, (c) => prisma.user.createMany({ data: c }));
  });

  // ── Providers, profiles, locations, hours, coverage ─────────────────────
  await step('providers', async () => {
    const rows: Prisma.ProviderCreateManyInput[] = [
      { type: 'CLINIC', status: 'APPROVED', legalName: 'Moyna Family Clinic LLP', displayName: 'Moyna Family Clinic', slug: CLINIC_SLUG, description: "Morning OPD for general medicine, children and women's health, close to Moyna bazar.", contactPhone: '9800100011', isListed: true, submittedAt: ago(96), approvedAt: ago(94), createdAt: ago(98) },
      { type: 'IMAGING_CENTRE', status: 'APPROVED', legalName: 'Tamluk Imaging and Scan Centre Pvt Ltd', displayName: 'Tamluk Imaging & Scan Centre', slug: IMAGING_SLUG, description: 'X-ray, ultrasound, CT, MRI, ECG and echo with same-day reports.', contactPhone: '9800100012', isListed: true, submittedAt: ago(96), approvedAt: ago(94), createdAt: ago(98) },
    ];
    const have = new Set((await prisma.provider.findMany({ where: { slug: { in: [CLINIC_SLUG, IMAGING_SLUG] } }, select: { slug: true } })).map((p) => p.slug));
    return insert(rows.filter((r) => !have.has(r.slug)), (c) => prisma.provider.createMany({ data: c }));
  });
  const clinic = await prisma.provider.findUniqueOrThrow({ where: { slug: CLINIC_SLUG } });
  const imaging = await prisma.provider.findUniqueOrThrow({ where: { slug: IMAGING_SLUG } });
  const ownerUsers = new Map((await prisma.user.findMany({ where: { email: { in: OWNERS.map(([, e]) => e) } } })).map((u) => [u.email!, u.id]));
  for (const [slug, email] of OWNERS) {
    const providerId = slug === CLINIC_SLUG ? clinic.id : imaging.id;
    await step(`owner membership ${email.split('@')[0]}`, async () => {
      const userId = ownerUsers.get(email)!;
      if (await prisma.providerMember.findFirst({ where: { providerId, userId } })) return 0;
      await prisma.providerMember.create({ data: { providerId, userId, memberRole: 'OWNER', status: 'ACTIVE', joinedAt: ago(94) } });
      return 1;
    });
  }
  const clinicOwnerId = ownerUsers.get(`clinic.owner@${D}`)!;
  const imagingOwnerId = ownerUsers.get(`imaging.owner@${D}`)!;
  await step('clinic profile', async () => {
    if (await prisma.facilityProfile.findUnique({ where: { providerId: clinic.id } })) return 0;
    await prisma.facilityProfile.create({ data: { providerId: clinic.id, ownershipType: 'PRIVATE', bedCount: 6, hasEmergency: false, establishmentRegistrationNo: 'WB/CE/PMD/2023/0412' } });
    return 1;
  });
  await step('imaging profile', async () => {
    if (await prisma.diagnosticProfile.findUnique({ where: { providerId: imaging.id } })) return 0;
    await prisma.diagnosticProfile.create({ data: { providerId: imaging.id, offersPathology: false, offersImaging: true, homeCollectionAvailable: false, aerbLicenseNo: 'AERB/RF-DX/WB/2022/1187', pcpndtRegistrationNo: 'PNDT/PMD/2022/031', typicalTurnaroundHours: 6 } });
    return 1;
  });
  await step('locations', async () => {
    const rows: Prisma.ProviderLocationCreateManyInput[] = [
      { providerId: clinic.id, name: 'Bazar Clinic', addressLine1: 'Thana Road, near Moyna Bazar', locality: 'Moyna Bazar', city: 'Moyna', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721629', latitude: 22.272, longitude: 87.773, isPrimary: true, isActive: true },
      { providerId: imaging.id, name: 'Main Centre', addressLine1: 'Hospital More, Mecheda Road', locality: 'Hospital More', city: 'Tamluk', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721636', latitude: 22.296, longitude: 87.918, isPrimary: true, isActive: true },
    ];
    const have = new Set((await prisma.providerLocation.findMany({ where: { providerId: { in: [clinic.id, imaging.id] } }, select: { providerId: true } })).map((l) => l.providerId));
    return insert(rows.filter((r) => !have.has(r.providerId)), (c) => prisma.providerLocation.createMany({ data: c }));
  });
  const clinicLoc = await prisma.providerLocation.findFirstOrThrow({ where: { providerId: clinic.id } });
  const imagingLoc = await prisma.providerLocation.findFirstOrThrow({ where: { providerId: imaging.id } });
  await step('opening hours', async () => {
    const have = new Set((await prisma.providerOperatingHours.findMany({ where: { locationId: { in: [clinicLoc.id, imagingLoc.id] } } })).map((h) => `${h.locationId}|${h.dayOfWeek}|${h.opensAtMin}`));
    const rows: Prisma.ProviderOperatingHoursCreateManyInput[] = [];
    for (let d = 0; d <= 6; d++) {
      if (!have.has(`${clinicLoc.id}|${d}|420`)) rows.push({ locationId: clinicLoc.id, dayOfWeek: d, opensAtMin: 420, closesAtMin: 780, isClosed: d === 0 });
      if (!have.has(`${imagingLoc.id}|${d}|480`)) rows.push({ locationId: imagingLoc.id, dayOfWeek: d, opensAtMin: 480, closesAtMin: 1260, isClosed: false });
    }
    return insert(rows, (c) => prisma.providerOperatingHours.createMany({ data: c }));
  });
  await step('coverage', async () => {
    if (await prisma.providerServiceArea.findFirst({ where: { providerId: clinic.id, purpose: 'OPD', district: 'Purba Medinipur', pincode: null } })) return 0;
    await prisma.providerServiceArea.create({ data: { providerId: clinic.id, district: 'Purba Medinipur', pincode: null, purpose: 'OPD' } });
    return 1;
  });

  // ── Clinic: departments and five visiting doctors from the hospital ─────
  const CLINIC_DEPARTMENTS = ['DEPT_GENERAL_MEDICINE', 'DEPT_PAEDIATRICS', 'DEPT_OBGYN'];
  const departments = await prisma.department.findMany({ where: { code: { in: CLINIC_DEPARTMENTS } } });
  await step('clinic departments', async () => {
    const have = new Set((await prisma.facilityDepartment.findMany({ where: { providerId: clinic.id }, select: { departmentId: true } })).map((d) => d.departmentId));
    const rows: Prisma.FacilityDepartmentCreateManyInput[] = departments.filter((d) => !have.has(d.id)).map((d) => ({ providerId: clinic.id, departmentId: d.id, isActive: true, verifiedAt: ago(94) }));
    return insert(rows, (c) => prisma.facilityDepartment.createMany({ data: c }));
  });
  // The old temp table `clinic_doctors`: the first five volume-seed doctors (by provider id) whose primary speciality
  // belongs to one of the clinic's departments, plus Dr. Abhijit Maity (the doctor@gmail.com demo login) as n = 6.
  const departmentBySpeciality = new Map<string, string>();
  for (const d of departments) if (d.specialityId && !departmentBySpeciality.has(d.specialityId)) departmentBySpeciality.set(d.specialityId, d.id);
  const demoDoctorProviders = await prisma.provider.findMany({ where: { type: 'DOCTOR', displayName: { in: demoDoctorUsers.map((u) => u.fullName) } }, orderBy: { id: 'asc' }, include: { doctorProfile: { include: { specialities: { where: { isPrimary: true } } } } } });
  const clinicDoctors: { providerId: string; departmentId: string; n: number }[] = [];
  for (const p of demoDoctorProviders) {
    const departmentId = p.doctorProfile?.specialities.map((s) => departmentBySpeciality.get(s.specialityId)).find((id): id is string => !!id);
    if (departmentId && !clinicDoctors.some((d) => d.providerId === p.id)) clinicDoctors.push({ providerId: p.id, departmentId, n: clinicDoctors.length + 1 });
    if (clinicDoctors.length === 5) break;
  }
  const abhijit = await prisma.provider.findFirst({ where: { displayName: 'Dr. Abhijit Maity', type: 'DOCTOR' } });
  const paediatrics = departments.find((d) => d.code === 'DEPT_PAEDIATRICS');
  if (abhijit && paediatrics && !clinicDoctors.some((d) => d.providerId === abhijit.id)) clinicDoctors.push({ providerId: abhijit.id, departmentId: paediatrics.id, n: 6 });
  const clinicDoctorIds = clinicDoctors.map((d) => d.providerId);
  await step('clinic affiliations', async () => {
    const have = new Set((await prisma.doctorAffiliation.findMany({ where: { facilityProviderId: clinic.id }, select: { doctorProviderId: true } })).map((a) => a.doctorProviderId));
    const rows: Prisma.DoctorAffiliationCreateManyInput[] = clinicDoctors.filter((d) => !have.has(d.providerId)).map((d) => ({
      doctorProviderId: d.providerId, facilityProviderId: clinic.id, locationId: clinicLoc.id, departmentId: d.departmentId, roleTitle: 'Visiting Consultant', engagementType: 'VISITING',
      consultationFeeMinor: BigInt(30000 + (d.n % 3) * 10000), status: 'ACTIVE', initiatedBy: 'FACILITY', doctorConfirmedAt: ago(92), facilityConfirmedAt: ago(93), verifiedAt: ago(91), startDate: dateOnly(shiftDate(today, -91)), createdAt: ago(93),
    }));
    return insert(rows, (c) => prisma.doctorAffiliation.createMany({ data: c }));
  });
  const affiliations = await prisma.doctorAffiliation.findMany({ where: { facilityProviderId: clinic.id } });
  await step('affiliation events', async () => {
    const fresh = await prisma.doctorAffiliation.findMany({ where: { facilityProviderId: clinic.id, events: { none: {} } } });
    const rows: Prisma.AffiliationEventCreateManyInput[] = fresh.flatMap((a) => [
      { affiliationId: a.id, fromStatus: null, toStatus: 'INVITED', actorKind: 'FACILITY', createdAt: a.createdAt },
      { affiliationId: a.id, fromStatus: 'INVITED', toStatus: 'PENDING_VERIFICATION', actorKind: 'DOCTOR', createdAt: a.doctorConfirmedAt ?? a.createdAt },
      { affiliationId: a.id, fromStatus: 'PENDING_VERIFICATION', toStatus: 'ACTIVE', actorKind: 'PLATFORM', createdAt: a.verifiedAt ?? a.createdAt },
    ]);
    return insert(rows, (c) => prisma.affiliationEvent.createMany({ data: c }));
  });
  // Early morning OPD (07:00–09:00) never overlaps the doctors' hospital (10:00+) or chamber sessions.
  await step('clinic schedules', async () => {
    const have = new Set((await prisma.doctorSchedule.findMany({ where: { locationId: clinicLoc.id } })).map((s) => `${s.doctorProviderId}|${s.dayOfWeek}`));
    const rows: Prisma.DoctorScheduleCreateManyInput[] = [];
    for (const a of affiliations) {
      const d = clinicDoctors.find((x) => x.providerId === a.doctorProviderId);
      if (!d) continue;
      for (const dayOfWeek of d.n % 2 === 0 ? [1, 3, 5] : [2, 4, 6]) {
        if (have.has(`${a.doctorProviderId}|${dayOfWeek}`)) continue;
        rows.push({ doctorProviderId: a.doctorProviderId, locationId: clinicLoc.id, affiliationId: a.id, dayOfWeek, startMinute: 420, endMinute: 540, slotMinutes: 15, capacityPerSlot: 1, feeMinor: a.consultationFeeMinor, validFrom: dateOnly(shiftDate(today, -90)), isActive: true, createdById: clinicOwnerId });
      }
    }
    return insert(rows, (c) => prisma.doctorSchedule.createMany({ data: c }));
  });
  await step('clinic slots', async () => {
    const schedules = await prisma.doctorSchedule.findMany({ where: { locationId: clinicLoc.id, isActive: true } });
    const from = shiftDate(today, -90);
    const to = shiftDate(today, 21);
    // The same doctor must not get a second slot at the same instant anywhere (unique on doctor + location + startsAt).
    const have = new Set((await prisma.appointmentSlot.findMany({ where: { doctorProviderId: { in: clinicDoctorIds }, startsAt: { gte: istToUtc(from, 0), lt: istToUtc(shiftDate(to, 1), 0) } }, select: { doctorProviderId: true, locationId: true, startsAt: true } }))
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
            capacity: 1, bookedCount: 0, status: 'OPEN', feeMinor: s.feeMinor ?? 30000n, createdAt: new Date(Math.min(now.getTime(), startsAt.getTime() - 14 * DAY)),
          });
        }
      }
    }
    return insert(rows, (c) => prisma.appointmentSlot.createMany({ data: c }));
  });

  // Patients: the volume seed's patients (still owned by their seed accounts), in id order — the old temp table `pts`.
  const patientUsers = await prisma.user.findMany({ where: { email: { startsWith: 'demo.patient.', endsWith: `@${D}` } }, select: { id: true } });
  const pts = await prisma.patientProfile.findMany({ where: { accountUserId: { in: patientUsers.map((u) => u.id) } }, orderBy: { id: 'asc' }, select: { id: true, accountUserId: true } });
  if (pts.length === 0) throw new Error('No demo patients found — run npm run demo:seed:volume first.');
  const patientAt = (k: number) => at(pts, k);

  const REASONS = ['Fever', 'Child vaccination follow-up', 'Cough and cold', 'Pregnancy check-up', 'Stomach pain', 'Diabetes review', 'Skin rash', 'Headache'];
  const UPCOMING: AppointmentStatus[] = ['REQUESTED', 'CONFIRMED', 'CONFIRMED'];
  const PAST: AppointmentStatus[] = ['COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'NO_SHOW', 'COMPLETED', 'CANCELLED_BY_PATIENT', 'COMPLETED', 'COMPLETED'];
  const CONFIRMED_LIKE = new Set<AppointmentStatus>(['CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'NO_SHOW', 'CANCELLED_BY_PATIENT', 'CANCELLED_BY_PROVIDER']);
  await step('clinic appointments', async () => {
    const slots = await prisma.appointmentSlot.findMany({ where: { locationId: clinicLoc.id }, orderBy: [{ startsAt: 'asc' }, { id: 'asc' }] });
    const booked = new Set((await prisma.appointment.findMany({ where: { locationId: clinicLoc.id }, select: { slotId: true } })).map((a) => a.slotId));
    const rows: Prisma.AppointmentCreateManyInput[] = [];
    slots.forEach((s, i) => {
      const n = i + 1;
      const past = s.startsAt < now;
      if (!((past && n % 100 < 70) || (!past && n % 100 < 40)) || booked.has(s.id)) return;
      const p = patientAt(n * 3571);
      const source: BookingSource = n % 4 === 0 ? 'WALK_IN' : 'PATIENT_APP';
      const status = past ? at(PAST, n) : at(UPCOMING, n);
      rows.push({
        reference: ref('DCL', s.id), patientProfileId: p.id, bookedByUserId: p.accountUserId, doctorProviderId: s.doctorProviderId, facilityProviderId: clinic.id, locationId: s.locationId, slotId: s.id, affiliationId: s.affiliationId,
        status, source, attribution: source === 'WALK_IN' ? 'PROVIDER_DIRECT' : 'PLATFORM', feeMinor: s.feeMinor, reasonForVisit: at(REASONS, n), idempotencyKey: `demo:${s.id}`,
        confirmedAt: CONFIRMED_LIKE.has(status) ? plus(s.startsAt, -DAY) : null,
        checkedInAt: status === 'CHECKED_IN' || status === 'COMPLETED' ? plus(s.startsAt, -5 * MIN) : null,
        completedAt: status === 'COMPLETED' ? plus(s.startsAt, 12 * MIN) : null,
        cancelledAt: status.startsWith('CANCELLED') ? plus(s.startsAt, -6 * HOUR) : null,
        createdAt: plus(s.startsAt, -2 * DAY),
      });
    });
    return insert(rows, (c) => prisma.appointment.createMany({ data: c }));
  });
  await step('clinic slot counts', async () => {
    const live = await prisma.appointment.findMany({ where: { reference: { startsWith: 'DCL-' }, status: { in: ['REQUESTED', 'CONFIRMED', 'CHECKED_IN'] } }, select: { slotId: true } });
    let n = 0;
    for (const chunk of chunked(live.map((a) => a.slotId))) n += (await prisma.appointmentSlot.updateMany({ where: { id: { in: chunk } }, data: { bookedCount: 1 } })).count;
    return n;
  });
  await step('clinic appointment events', async () => {
    const appointments = await prisma.appointment.findMany({ where: { reference: { startsWith: 'DCL-' }, events: { none: {} } } });
    const rows: Prisma.AppointmentEventCreateManyInput[] = [];
    for (const a of appointments) {
      rows.push({ appointmentId: a.id, fromStatus: null, toStatus: 'REQUESTED', actorKind: a.source === 'WALK_IN' ? 'PROVIDER' : 'PATIENT', createdAt: a.createdAt });
      if (a.status !== 'REQUESTED') rows.push({ appointmentId: a.id, fromStatus: 'REQUESTED', toStatus: a.status, actorKind: a.status === 'CANCELLED_BY_PATIENT' ? 'PATIENT' : 'PROVIDER', createdAt: a.completedAt ?? a.cancelledAt ?? a.confirmedAt ?? plus(a.createdAt, HOUR) });
    }
    return insert(rows, (c) => prisma.appointmentEvent.createMany({ data: c }));
  });
  const REVIEW_COMMENTS = ['Quick morning OPD, did not miss work.', 'Doctor was very good with my child.', 'Clean and close to the bazar.', 'Short wait, clear advice.', null];
  await step('clinic reviews', async () => {
    const completed = await prisma.appointment.findMany({ where: { reference: { startsWith: 'DCL-' }, status: 'COMPLETED' }, select: { id: true, facilityProviderId: true, bookedByUserId: true, completedAt: true } });
    const reviewed = new Set((await prisma.review.findMany({ where: { appointmentId: { in: completed.map((a) => a.id) } }, select: { appointmentId: true } })).map((r) => r.appointmentId));
    const rows: Prisma.ReviewCreateManyInput[] = completed.filter((a) => !reviewed.has(a.id) && Math.random() < 0.15).map((a) => ({
      providerId: a.facilityProviderId, authorUserId: a.bookedByUserId, appointmentId: a.id, rating: 3 + randInt(2), comment: at(REVIEW_COMMENTS, randInt(4)), status: 'PUBLISHED',
      moderatedAt: plus(a.completedAt!, DAY), createdAt: plus(a.completedAt!, 5 * HOUR),
    }));
    return insert(rows, (c) => prisma.review.createMany({ data: c }));
  });

  // ── Imaging centre: price list and ~200 orders with reports ─────────────
  await step('imaging price list', async () => {
    const PRICES: [string, number, number][] = [['IMG_XRAY_CHEST', 35000, 2], ['IMG_XRAY_KNEE', 40000, 2], ['IMG_USG_ABDOMEN', 110000, 4], ['IMG_USG_PELVIS', 90000, 4], ['IMG_CT_HEAD', 300000, 6], ['IMG_MRI_BRAIN', 650000, 24], ['PROC_ECG', 25000, 1], ['PROC_ECHO', 180000, 4]];
    const services = new Map((await prisma.service.findMany({ where: { code: { in: PRICES.map(([code]) => code) } }, select: { id: true, code: true } })).map((s) => [s.code, s.id]));
    const have = new Set((await prisma.providerService.findMany({ where: { providerId: imaging.id }, select: { serviceId: true } })).map((s) => s.serviceId));
    const rows: Prisma.ProviderServiceCreateManyInput[] = [];
    for (const [code, price, tat] of PRICES) {
      const serviceId = services.get(code);
      if (!serviceId || have.has(serviceId)) continue;
      rows.push({ providerId: imaging.id, serviceId, locationId: imagingLoc.id, priceMinor: BigInt(price), homeServiceAvailable: false, turnaroundHours: tat, isActive: true });
    }
    return insert(rows, (c) => prisma.providerService.createMany({ data: c }));
  });
  const IMAGING_OPEN: DiagnosticOrderStatus[] = ['REQUESTED', 'CONFIRMED', 'PROCESSING', 'REPORT_READY'];
  await step('imaging orders', async () => {
    const rows: Prisma.DiagnosticOrderCreateManyInput[] = [];
    for (let g = 1; g <= 200; g++) {
      const p = patientAt(g * 911);
      const ts = new Date(now.getTime() - (200 - g) * 0.45 * DAY);
      const status: DiagnosticOrderStatus = g > 192 ? at(IMAGING_OPEN, g) : g % 19 === 0 ? 'CANCELLED' : 'COMPLETED';
      const reference = ref('DIM', `${g}im`);
      rows.push({
        reference, patientProfileId: p.id, bookedByUserId: p.accountUserId, providerId: imaging.id, locationId: imagingLoc.id, collectionMode: 'CENTRE_VISIT', scheduledAt: plus(ts, DAY), status,
        source: g % 6 === 0 ? 'PROVIDER_PORTAL' : 'PATIENT_APP', attribution: g % 6 === 0 ? 'PROVIDER_DIRECT' : 'PLATFORM', totalMinor: 0n, idempotencyKey: `demo:${reference}`,
        completedAt: status === 'COMPLETED' ? plus(ts, DAY + 6 * HOUR) : null, createdAt: ts,
      });
    }
    const have = new Set((await prisma.diagnosticOrder.findMany({ where: { reference: { in: rows.map((r) => r.reference) } }, select: { reference: true } })).map((o) => o.reference));
    return insert(rows.filter((r) => !have.has(r.reference)), (c) => prisma.diagnosticOrder.createMany({ data: c }));
  });
  await step('imaging order items', async () => {
    const orders = await prisma.diagnosticOrder.findMany({ where: { reference: { startsWith: 'DIM-' }, items: { none: {} } }, select: { id: true } });
    const offerings = await prisma.providerService.findMany({ where: { providerId: imaging.id, isActive: true }, include: { service: { select: { name: true } } } });
    if (offerings.length === 0) return 0;
    const rows: Prisma.DiagnosticOrderItemCreateManyInput[] = orders.map((o) => {
      const ps = [...offerings].sort((a, b) => md5(o.id + a.id).localeCompare(md5(o.id + b.id)))[0]!;
      return { orderId: o.id, providerServiceId: ps.id, serviceName: ps.service.name, priceMinor: ps.priceMinor };
    });
    return insert(rows, (c) => prisma.diagnosticOrderItem.createMany({ data: c }));
  });
  await step('imaging totals', async () => {
    const orders = await prisma.diagnosticOrder.findMany({ where: { reference: { startsWith: 'DIM-' } }, include: { items: { select: { priceMinor: true } } } });
    let n = 0;
    for (const o of orders) {
      const total = o.items.reduce((sum, i) => sum + i.priceMinor, 0n);
      if (total !== o.totalMinor) { await prisma.diagnosticOrder.update({ where: { id: o.id }, data: { totalMinor: total } }); n++; }
    }
    return n;
  });
  await step('imaging reports', async () => {
    const orders = await prisma.diagnosticOrder.findMany({ where: { reference: { startsWith: 'DIM-' }, status: { in: ['REPORT_READY', 'COMPLETED'] }, reports: { none: {} } } });
    const rows: Prisma.DiagnosticReportCreateManyInput[] = orders.map((o) => {
      const publishedAt = o.completedAt ?? plus(o.createdAt, DAY);
      return { orderId: o.id, version: 1, status: 'PUBLISHED', storageKey: `demo/reports/${o.id}/v1.pdf`, sha256: md5(o.id) + md5(o.reference), publishedById: imagingOwnerId, publishedAt, createdAt: publishedAt };
    });
    return insert(rows, (c) => prisma.diagnosticReport.createMany({ data: c }));
  });

  // ── Money for both ──────────────────────────────────────────────────────
  await step('transactions · clinic', async () => {
    const appointmentsCandidates = await prisma.appointment.findMany({ where: { reference: { startsWith: 'DCL-' } } });
    // "has no transaction yet" as an id-set check: a relation-null filter would $lookup every transaction and time out on Atlas.
    const appointmentsLinked = new Set((await prisma.serviceTransaction.findMany({ where: { appointmentId: { in: appointmentsCandidates.map((x) => x.id) } }, select: { appointmentId: true } })).map((t) => t.appointmentId));
    const appointments = appointmentsCandidates.filter((x) => !appointmentsLinked.has(x.id));
    const rows: Prisma.ServiceTransactionCreateManyInput[] = appointments.map((a) => {
      const direct = a.attribution === 'PROVIDER_DIRECT';
      const status: TransactionStatus = a.status === 'COMPLETED' ? (direct ? 'PAY_AT_PROVIDER' : 'PAID') : a.status.startsWith('CANCELLED') ? 'CANCELLED' : a.status === 'NO_SHOW' ? 'PAID' : direct ? 'PAY_AT_PROVIDER' : 'PENDING_PAYMENT';
      return {
        reference: ref('DTX', a.id), sourceType: 'APPOINTMENT', appointmentId: a.id, providerId: a.facilityProviderId, patientProfileId: a.patientProfileId, category: 'CONSULTATION', grossMinor: a.feeMinor, status, attribution: a.attribution,
        commissionEligible: a.status === 'COMPLETED' && a.attribution === 'PLATFORM', eligibilityReason: direct ? 'Walk-in booking: no platform commission' : a.status === 'COMPLETED' ? 'Service completed through the platform' : null,
        serviceCompletedAt: a.completedAt, createdAt: a.createdAt,
      };
    });
    return insert(rows, (c) => prisma.serviceTransaction.createMany({ data: c }));
  });
  await step('transactions · imaging', async () => {
    const ordersCandidates = await prisma.diagnosticOrder.findMany({ where: { reference: { startsWith: 'DIM-' } } });
    // "has no transaction yet" as an id-set check: a relation-null filter would $lookup every transaction and time out on Atlas.
    const ordersLinked = new Set((await prisma.serviceTransaction.findMany({ where: { diagnosticOrderId: { in: ordersCandidates.map((x) => x.id) } }, select: { diagnosticOrderId: true } })).map((t) => t.diagnosticOrderId));
    const orders = ordersCandidates.filter((x) => !ordersLinked.has(x.id));
    const rows: Prisma.ServiceTransactionCreateManyInput[] = orders.map((o) => ({
      reference: ref('DTX', o.id), sourceType: 'DIAGNOSTIC_ORDER', diagnosticOrderId: o.id, providerId: o.providerId, patientProfileId: o.patientProfileId, category: 'DIAGNOSTIC', grossMinor: o.totalMinor,
      status: o.status === 'CANCELLED' ? 'CANCELLED' : o.status === 'REQUESTED' ? 'PENDING_PAYMENT' : 'PAID', attribution: o.attribution, commissionEligible: o.status === 'COMPLETED' && o.attribution === 'PLATFORM',
      eligibilityReason: o.status === 'COMPLETED' ? 'Report published' : null, serviceCompletedAt: o.completedAt, createdAt: o.createdAt,
    }));
    return insert(rows, (c) => prisma.serviceTransaction.createMany({ data: c }));
  });
  await step('ledger', async () => {
    const txns = await prisma.serviceTransaction.findMany({ where: { providerId: { in: [clinic.id, imaging.id] }, status: 'PAID', commissionEligible: true, serviceCompletedAt: { not: null } } });
    const rows: Prisma.ProviderLedgerEntryCreateManyInput[] = [];
    for (const chunk of chunked(txns)) {
      const have = new Set((await prisma.providerLedgerEntry.findMany({ where: { transactionId: { in: chunk.map((t) => t.id) } }, select: { dedupeKey: true } })).map((e) => e.dedupeKey));
      for (const t of chunk) {
        if (!have.has(`earning:${t.id}`)) rows.push({ providerId: t.providerId, transactionId: t.id, entryType: 'SERVICE_EARNING', amountMinor: t.grossMinor, dedupeKey: `earning:${t.id}`, description: `Service earning ${t.reference}`, createdAt: t.serviceCompletedAt! });
        if (!have.has(`commission:${t.id}`)) rows.push({ providerId: t.providerId, transactionId: t.id, entryType: 'COMMISSION', amountMinor: -((t.grossMinor * 10n) / 100n), dedupeKey: `commission:${t.id}`, description: `Platform fee 10% on ${t.reference}`, createdAt: t.serviceCompletedAt! });
      }
    }
    return insert(rows, (c) => prisma.providerLedgerEntry.createMany({ data: c }));
  });

  await step('provider ratings', async () => {
    const groups = await prisma.review.groupBy({ by: ['providerId'], where: { status: 'PUBLISHED', providerId: { in: [clinic.id, imaging.id] } }, _avg: { rating: true }, _count: { _all: true } });
    for (const g of groups) await prisma.provider.update({ where: { id: g.providerId }, data: { ratingAverage: round2(g._avg.rating ?? 0), ratingCount: g._count._all } });
    return groups.length;
  });
} catch (err) {
  console.error('Seed stopped; run it again to resume — every step skips what already exists.');
  await prisma.$disconnect();
  throw err;
}
await prisma.$disconnect();
console.log(`Done. Owner logins (password ${PASSWORD}): clinic.owner@${D}, imaging.owner@${D}`);
