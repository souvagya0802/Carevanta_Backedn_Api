/**
 * DEMO / DEVELOPMENT ONLY: easy-to-type logins requested by the founder, one
 * per app and one per provider type, attached to the existing demo data so
 * every screen has something to show. The full list is in docs/demo-logins.md.
 *
 *   (No super admin here: the platform super admin is a real account managed in the dashboard, never a shared demo login.)
 *   Providers    hospital@, clinic@, doctor@, lab@, imaging@, pharmacy@, ambulance@ (gmail.com), plus provider@gmail.com for all of them
 *   Patient      user@gmail.com / User@123 (a family of three seeded patients with their full history)
 *
 * These passwords are shorter than the 12-character rule the API enforces for
 * real people, so they are written straight to the database here. The script
 * refuses to run in production. Gmail addresses belong to real people: email
 * is only logged while SMTP is not configured; remove these accounts before
 * connecting a real mail server.
 *
 * Safe to run again: it resets the passwords and skips what already exists.
 *   npm run demo:accounts
 */
import 'dotenv/config';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword } from '../src/modules/auth/passwords.js';
import { audit } from '../src/lib/audit.js';

if (process.env.APP_ENV === 'production') {
  console.error('Refusing to create demo logins in production.');
  process.exit(1);
}

const ACCOUNTS = {
  provider: { email: 'provider@gmail.com', password: 'Prov@123', fullName: 'Demo Provider Owner' },
  user: { email: 'user@gmail.com', password: 'User@123', fullName: 'Pooja Patra' },
};

/** One login per provider type, each OWNER of the matching demo organisation (found by its seed owner). */
const PROVIDER_LOGINS = [
  { email: 'hospital@gmail.com', password: 'Hospital@123', fullName: 'Hospital Owner (Demo)', seedOwner: 'hospital.owner' },
  { email: 'clinic@gmail.com', password: 'Clinic@123', fullName: 'Clinic Owner (Demo)', seedOwner: 'clinic.owner' },
  { email: 'lab@gmail.com', password: 'Lab@123', fullName: 'Lab Owner (Demo)', seedOwner: 'lab.owner' },
  { email: 'imaging@gmail.com', password: 'Imaging@123', fullName: 'Imaging Owner (Demo)', seedOwner: 'imaging.owner' },
  { email: 'pharmacy@gmail.com', password: 'Pharmacy@123', fullName: 'Pharmacy Owner (Demo)', seedOwner: 'pharmacy.owner' },
  { email: 'ambulance@gmail.com', password: 'Ambulance@123', fullName: 'Ambulance Owner (Demo)', seedOwner: 'ambulance.owner' },
];
/**
 * The portal recognises a doctor by the login linked to the doctor's profile, so the doctor login
 * takes over a seeded doctor's account: Dr. Abhijit Maity (Paediatrics), who practises at the hospital,
 * the clinic and his own chamber, with over 1,100 appointments.
 */
const DOCTOR_LOGIN = { email: 'doctor@gmail.com', password: 'Doctor@123', doctorName: 'Dr. Abhijit Maity' };

/** Seeded patients whose history becomes this family: [seed email, relationship]. */
const FAMILY: [string, 'SELF' | 'PARENT'][] = [
  ['demo.patient.52@demo.carevanta.local', 'SELF'],
  ['demo.patient.19@demo.carevanta.local', 'PARENT'],
  ['demo.patient.10@demo.carevanta.local', 'PARENT'],
];

async function upsertLogin(a: { email: string; password: string; fullName: string }) {
  const passwordHash = await hashPassword(a.password);
  const existing = await prisma.user.findFirst({ where: { email: a.email } });
  const data = { passwordHash, status: 'ACTIVE' as const, emailVerifiedAt: new Date(), mustChangePassword: false, failedLoginCount: 0, lockedUntil: null };
  const user = existing
    ? await prisma.user.update({ where: { id: existing.id }, data })
    : await prisma.user.create({ data: { email: a.email, fullName: a.fullName, ...data } });
  await audit(prisma, { action: existing ? 'demo.login_reset' : 'demo.login_created', entityType: 'user', entityId: user.id, actorType: 'SYSTEM', metadata: { email: a.email, note: 'demo:accounts (development only)' } });
  return user;
}

async function ensureOwner(providerId: string, userId: string) {
  const member = await prisma.providerMember.findFirst({ where: { providerId, userId } });
  if (!member) await prisma.providerMember.create({ data: { providerId, userId, memberRole: 'OWNER', status: 'ACTIVE', joinedAt: new Date() } });
  else if (member.status !== 'ACTIVE' || member.memberRole !== 'OWNER') await prisma.providerMember.update({ where: { id: member.id }, data: { status: 'ACTIVE', memberRole: 'OWNER', removedAt: null } });
}

async function main() {
  // 1. (No shared super admin: it is a real account, created and managed in the dashboard.)

  // 2. One owner login per provider type, and provider@gmail.com as owner of all of them
  const allInOne = await upsertLogin(ACCOUNTS.provider);
  const providerLines: string[] = [];
  const allOrgs: string[] = [];
  for (const login of PROVIDER_LOGINS) {
    const org = await prisma.provider.findFirst({ where: { members: { some: { memberRole: 'OWNER', user: { email: `${login.seedOwner}@demo.carevanta.local` } } } }, select: { id: true, displayName: true, type: true } });
    if (!org) { console.warn(`No demo organisation owned by ${login.seedOwner}; run demo:seed, demo:seed:volume and demo:seed:more first.`); continue; }
    const user = await upsertLogin(login);
    await ensureOwner(org.id, user.id);
    await ensureOwner(org.id, allInOne.id);
    providerLines.push(`  ${org.type.padEnd(18)} ${login.email} / ${login.password}  → ${org.displayName}`);
    allOrgs.push(org.displayName);
  }

  // 3. Doctor login: take over the seeded doctor's own account (email + password), keeping all history.
  const doctorProfile = await prisma.doctorProfile.findFirst({ where: { provider: { displayName: DOCTOR_LOGIN.doctorName, type: 'DOCTOR' } }, select: { userId: true, provider: { select: { displayName: true } } } });
  if (doctorProfile?.userId) {
    const taken = await prisma.user.findFirst({ where: { email: DOCTOR_LOGIN.email } });
    if (taken && taken.id !== doctorProfile.userId) console.warn(`${DOCTOR_LOGIN.email} already belongs to another user; doctor login not changed.`);
    else {
      await prisma.user.update({ where: { id: doctorProfile.userId }, data: { email: DOCTOR_LOGIN.email, passwordHash: await hashPassword(DOCTOR_LOGIN.password), status: 'ACTIVE', emailVerifiedAt: new Date(), mustChangePassword: false, failedLoginCount: 0, lockedUntil: null } });
      await audit(prisma, { action: 'demo.doctor_login', entityType: 'user', entityId: doctorProfile.userId, actorType: 'SYSTEM', metadata: { email: DOCTOR_LOGIN.email, note: 'demo:accounts (development only)' } });
      providerLines.push(`  ${'DOCTOR'.padEnd(18)} ${DOCTOR_LOGIN.email} / ${DOCTOR_LOGIN.password}  → ${doctorProfile.provider.displayName}`);
    }
  } else console.warn(`${DOCTOR_LOGIN.doctorName} not found; run demo:seed:volume first.`);

  // 4. Patient family with real history (appointments, lab orders and reports, medicine orders)
  const user = await upsertLogin(ACCOUNTS.user);
  const moved: string[] = [];
  for (const [seedEmail, relationship] of FAMILY) {
    const seeded = await prisma.patientProfile.findFirst({ where: { accountHolder: { email: seedEmail }, relationship: 'SELF' } });
    if (!seeded) continue; // already part of this family (or volume data missing; checked below)
    // Bookings and orders belong to the profile, so moving the profile moves its whole history.
    await prisma.patientProfile.update({ where: { id: seeded.id }, data: { accountUserId: user.id, relationship } });
    moved.push(`${seeded.fullName} (${relationship.toLowerCase()})`);
  }
  if (!moved.length) {
    const family = await prisma.patientProfile.findMany({ where: { accountUserId: user.id, isActive: true }, orderBy: { createdAt: 'asc' }, select: { fullName: true, relationship: true } });
    if (!family.length) console.warn('No seeded patients to attach; run npm run demo:seed:volume first.');
    moved.push(...family.map((f) => `${f.fullName} (${f.relationship.toLowerCase()})`));
  }
  if (!(await prisma.notification.findFirst({ where: { userId: user.id, channel: 'IN_APP' } }))) {
    const now = Date.now();
    const notes = [
      { title: 'Appointment confirmed', body: 'Your visit with the doctor is confirmed. Please arrive 10 minutes early.', link: '/care', ago: 2 },
      { title: 'Lab report ready', body: 'A new lab report has been published. Open it from Health records.', link: '/records', ago: 26 },
      { title: 'Medicine order on the way', body: 'Your pharmacy order is out for delivery.', link: '/orders', ago: 50 },
    ];
    await prisma.notification.createMany({ data: notes.map((n) => ({ userId: user.id, channel: 'IN_APP' as const, templateKey: 'demo.welcome', recipient: user.id, status: 'SENT' as const, sentAt: new Date(now - n.ago * 3_600_000), createdAt: new Date(now - n.ago * 3_600_000), title: n.title, body: n.body, link: n.link })) });
  }

  const profileIds = (await prisma.patientProfile.findMany({ where: { accountUserId: user.id }, select: { id: true } })).map((p) => p.id);
  const [appts, labs, rx] = await Promise.all([
    prisma.appointment.count({ where: { patientProfileId: { in: profileIds } } }),
    prisma.diagnosticOrder.count({ where: { patientProfileId: { in: profileIds } } }),
    prisma.pharmacyOrder.count({ where: { patientProfileId: { in: profileIds } } }),
  ]);
  const counts = [{ appts: BigInt(appts), labs: BigInt(labs), rx: BigInt(rx) }];

  console.log('Demo logins ready (development only):');
  console.log('  Providers:');
  for (const line of providerLines) console.log(line);
  console.log(`  ALL PROVIDERS      ${ACCOUNTS.provider.email} / ${ACCOUNTS.provider.password}  → ${allOrgs.join(', ')}`);
  console.log(`  Patient      ${ACCOUNTS.user.email} / ${ACCOUNTS.user.password}  → ${moved.join(', ')}; ${counts[0]!.appts} appointments, ${counts[0]!.labs} lab orders, ${counts[0]!.rx} medicine orders`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
