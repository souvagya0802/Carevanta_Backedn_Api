/**
 * Realistic demo data for the provider portal and admin dashboard.
 *
 *   npm run demo:seed
 *
 * Creates one organisation of every provider type in Purba Medinipur, with
 * owners and staff you can sign in as, plus a patient who has booked an
 * appointment, a lab test, a medicine order and an ambulance. Everything goes
 * through the real HTTP API in-process, so the data obeys the same rules as
 * production (verification, maker-checker, stock reservation, ...).
 *
 * - Refuses to run in production, and refuses to run twice (fixed emails).
 * - All demo logins share one password, printed at the end.
 * - The internal staff accounts used to register and approve the providers are
 *   deactivated at the end so no extra admin login is left behind.
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/prisma.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/modules/auth/passwords.js';
import { syncAccessControl } from '../src/modules/access/seed-access.js';
import { approvePendingMappingsForDemo } from './demo-approve-mappings.js';

if (process.env.APP_ENV === 'production') {
  console.error('Refusing to seed demo data in production.');
  process.exit(2);
}

const DOMAIN = 'demo.carevanta.local';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo-Carevanta-2026';
const TAMLUK = { lat: 22.3, lng: 87.92 };
const MOYNA = { lat: 22.27, lng: 87.77 };
const V = '/api/v1';

const LOGINS = {
  hospital: `hospital.owner@${DOMAIN}`,
  reception: `hospital.reception@${DOMAIN}`,
  doctor: `dr.anjali.maity@${DOMAIN}`,
  lab: `lab.owner@${DOMAIN}`,
  pharmacy: `pharmacy.owner@${DOMAIN}`,
  pharmacist: `pharmacist@${DOMAIN}`,
  ambulance: `ambulance.owner@${DOMAIN}`,
  dispatcher: `dispatcher@${DOMAIN}`,
  patient: `riya.das@${DOMAIN}`,
};
const STAFF = { registrar: `internal.registrar@${DOMAIN}`, verifier: `internal.verifier@${DOMAIN}`, ops: `internal.ops@${DOMAIN}` };

const app = createApp();
const http = () => request(app);
const idem = () => ({ 'Idempotency-Key': `demo-${randomUUID()}` });
const istDate = (offsetDays: number) => new Date(Date.now() + 330 * 60_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);

function ok(res: request.Response, expected: number, what: string) {
  if (res.status !== expected) throw new Error(`${what}: expected ${expected}, got ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
}

/** Find-or-create so an interrupted seed can be re-run without colliding on the e-mail unique index. */
async function makeUser(email: string, fullName: string, roles: string[] = []) {
  const passwordHash = await hashPassword(PASSWORD);
  const user = await prisma.user.upsert({ where: { email }, update: {}, create: { email, fullName, passwordHash, status: 'ACTIVE', emailVerifiedAt: new Date() } });
  for (const key of roles) {
    const role = await prisma.role.findUniqueOrThrow({ where: { key } });
    const live = await prisma.userRole.findFirst({ where: { userId: user.id, roleId: role.id, revokedAt: null } });
    if (!live) await prisma.userRole.create({ data: { userId: user.id, roleId: role.id, reason: 'Demo seed' } });
  }
  return user;
}

/** Sign in as an email and return request helpers carrying the token. */
async function as(email: string) {
  const login = await http().post(`${V}/auth/login`).send({ identifier: email, password: PASSWORD });
  const tokens = ok(login, 200, `login ${email}`);
  const auth = { Authorization: `Bearer ${tokens.accessToken}` };
  return {
    get: (url: string) => http().get(V + url).set(auth),
    post: (url: string, body: object = {}, headers: Record<string, string> = {}) => http().post(V + url).set(auth).set(headers).send(body),
    put: (url: string, body: object = {}) => http().put(V + url).set(auth).send(body),
  };
}
type Client = Awaited<ReturnType<typeof as>>;

/** Give an invited (password-less) member the demo password and make the membership active. */
async function activateInvited(email: string, providerId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(PASSWORD), mustChangePassword: false, status: 'ACTIVE', emailVerifiedAt: new Date() } });
  await prisma.providerMember.update({ where: { providerId_userId: { providerId, userId: user.id } }, data: { status: 'ACTIVE' } });
}

async function approve(providerId: string, registrar: Client, verifier: Client) {
  ok(await registrar.post(`/admin/providers/${providerId}/submit`), 200, 'submit');
  const kase = await prisma.verificationCase.findFirstOrThrow({ where: { providerId, status: { in: ['OPEN', 'IN_REVIEW'] } }, include: { checks: true } });
  for (const check of kase.checks.filter((c) => c.isRequired)) {
    ok(await verifier.post(`/admin/verification-cases/${kase.id}/checks/${check.checkType}`, { status: 'PASSED', method: 'OFFICIAL_REGISTRY_LOOKUP', sourceReference: `demo-${check.checkType.toLowerCase()}` }), 200, `check ${check.checkType}`);
  }
  ok(await verifier.post(`/admin/verification-cases/${kase.id}/decision`, { decision: 'APPROVE', note: 'Demo data — approved without real registry checks' }), 200, 'decision');
}

async function weeklySchedule(client: Client, providerId: string, doctorProviderId: string, locationId: string, startMinute: number, endMinute: number, feeMinor: number) {
  for (const dayOfWeek of [1, 2, 3, 4, 5, 6]) {
    const s = ok(await client.post(`/portal/providers/${providerId}/schedules`, { doctorProviderId, locationId, dayOfWeek, startMinute, endMinute, slotMinutes: 15, capacityPerSlot: 1, feeMinor, validFrom: istDate(0) }), 201, 'schedule');
    ok(await client.post(`/portal/providers/${providerId}/schedules/${s.id}/generate-slots`, { from: istDate(1), to: istDate(21) }), 200, 'generate slots');
  }
}

async function main() {
  if (await prisma.user.findUnique({ where: { email: LOGINS.hospital } })) {
    console.log('Demo data already exists. Logins:');
    printLogins();
    return;
  }
  await syncAccessControl(prisma);
  await makeUser(STAFF.registrar, 'Demo Registrar', ['PLATFORM_ADMIN']);
  await makeUser(STAFF.verifier, 'Demo Verifier', ['VERIFICATION_OFFICER']);
  await makeUser(STAFF.ops, 'Demo Operations', ['SUPER_ADMIN']);
  const registrar = await as(STAFF.registrar);
  const verifier = await as(STAFF.verifier);
  const ops = await as(STAFF.ops);

  // ── Hospital with a receptionist ────────────────────────────────────────
  console.log('Hospital…');
  const hospital = ok(await registrar.post('/admin/providers', {
    type: 'HOSPITAL', legalName: 'Tamluk Seva Sadan Hospital Pvt Ltd', displayName: 'Tamluk Seva Sadan Hospital', contactPhone: '9800100001',
    owner: { fullName: 'Subhasis Pal', email: LOGINS.hospital },
    facility: { ownershipType: 'PRIVATE', bedCount: 80, hasEmergency: true },
    location: { name: 'Main Campus', addressLine1: 'Hospital Road, Tamluk', city: 'Tamluk', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721636', latitude: TAMLUK.lat, longitude: TAMLUK.lng },
  }), 201, 'create hospital');
  const hospitalLocationId = hospital.locations[0].id as string;
  ok(await registrar.put(`/admin/providers/${hospital.id}/departments`, { departmentCodes: ['DEPT_GENERAL_MEDICINE', 'DEPT_CARDIO'] }), 200, 'departments');
  await approve(hospital.id, registrar, verifier);
  await activateInvited(LOGINS.hospital, hospital.id);
  const hospitalOwner = await as(LOGINS.hospital);
  ok(await hospitalOwner.post(`/portal/providers/${hospital.id}/members`, { fullName: 'Mousumi Jana', email: LOGINS.reception, memberRole: 'STAFF' }), 201, 'invite receptionist');
  await activateInvited(LOGINS.reception, hospital.id);

  // ── Doctor with her own chamber, affiliated to the hospital ─────────────
  console.log('Doctor…');
  const doctor = ok(await registrar.post('/admin/providers', {
    type: 'DOCTOR', legalName: 'Dr. Anjali Maity', displayName: 'Dr. Anjali Maity', contactPhone: '9800100002',
    owner: { fullName: 'Dr. Anjali Maity', email: LOGINS.doctor },
    doctor: {
      specialityCodes: ['GENERAL_MEDICINE'], defaultFeeMinor: 40000,
      qualifications: [{ degree: 'MBBS', institution: 'Medical College Kolkata', yearAwarded: 2012 }, { degree: 'MD (General Medicine)', institution: 'NRS Medical College', yearAwarded: 2016 }],
      registrations: [{ council: 'West Bengal Medical Council', registrationNumber: 'WBMC-DEMO-71234' }],
    },
    location: { name: 'Moyna Chamber', addressLine1: 'Station Road, Moyna Bazar', city: 'Moyna', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721629', latitude: MOYNA.lat, longitude: MOYNA.lng },
  }), 201, 'create doctor');
  const chamberId = doctor.locations[0].id as string;
  await approve(doctor.id, registrar, verifier);
  await activateInvited(LOGINS.doctor, doctor.id);
  const doctorUser = await as(LOGINS.doctor);
  const invite = ok(await hospitalOwner.post(`/portal/providers/${hospital.id}/affiliations/invite`, { doctorProviderId: doctor.id, locationId: hospitalLocationId, departmentCode: 'DEPT_GENERAL_MEDICINE', consultationFeeMinor: 50000, engagementType: 'VISITING', roleTitle: 'Consultant Physician' }), 201, 'invite doctor');
  ok(await doctorUser.post(`/portal/doctor/affiliations/${invite.id}/accept`), 200, 'accept affiliation');
  ok(await verifier.post(`/admin/affiliations/${invite.id}/actions`, { action: 'VERIFY' }), 200, 'verify affiliation');
  await weeklySchedule(hospitalOwner, hospital.id, doctor.id, hospitalLocationId, 600, 780, 50000);   // 10:00–13:00 at the hospital
  await weeklySchedule(doctorUser, doctor.id, doctor.id, chamberId, 1020, 1200, 40000);             // 17:00–20:00 at the chamber

  // ── Diagnostic lab with priced tests ────────────────────────────────────
  console.log('Lab…');
  const lab = ok(await registrar.post('/admin/providers', {
    type: 'DIAGNOSTIC_LAB', legalName: 'Moyna Diagnostic Centre', displayName: 'Moyna Diagnostic Centre', contactPhone: '9800100003',
    owner: { fullName: 'Pradip Samanta', email: LOGINS.lab },
    diagnostic: { offersPathology: true, homeCollectionAvailable: true },
    location: { name: 'Main Lab', addressLine1: 'College Road, Moyna', city: 'Moyna', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721629', latitude: MOYNA.lat, longitude: MOYNA.lng },
  }), 201, 'create lab');
  await approve(lab.id, registrar, verifier);
  await activateInvited(LOGINS.lab, lab.id);
  const labOwner = await as(LOGINS.lab);
  ok(await labOwner.put(`/portal/providers/${lab.id}/service-areas`, { areas: [{ purpose: 'HOME_COLLECTION', district: 'Purba Medinipur', pincode: '721629' }, { purpose: 'HOME_COLLECTION', district: 'Purba Medinipur', pincode: '721636' }] }), 200, 'lab coverage');
  const tests = ok(await labOwner.get('/portal/catalogue/services?category=DIAGNOSTIC_TEST&limit=6'), 200, 'catalogue tests') as { code: string }[];
  const offeringIds: string[] = [];
  for (const [i, t] of tests.entries()) {
    const o = ok(await labOwner.put(`/portal/providers/${lab.id}/services/${t.code}`, { priceMinor: 25000 + i * 15000, homeServiceAvailable: true, turnaroundHours: 24 }), 200, `price ${t.code}`);
    offeringIds.push(o.id);
  }

  // ── Pharmacy with stock and a pharmacist ────────────────────────────────
  console.log('Pharmacy…');
  const pharmacy = ok(await registrar.post('/admin/providers', {
    type: 'PHARMACY', legalName: 'Tamluk Medical Hall', displayName: 'Tamluk Medical Hall', contactPhone: '9800100004',
    owner: { fullName: 'Biswajit Bera', email: LOGINS.pharmacy },
    pharmacy: { retailDrugLicenseNo: 'WB/PMD/RET/2024/0117', pharmacistName: 'Sanchita Giri', pharmacistRegistrationNo: 'WBPC-44821', homeDeliveryAvailable: true },
    location: { name: 'Bazar Store', addressLine1: 'Netaji Road, Tamluk Bazar', city: 'Tamluk', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721636', latitude: TAMLUK.lat, longitude: TAMLUK.lng },
  }), 201, 'create pharmacy');
  const storeId = pharmacy.locations[0].id as string;
  await approve(pharmacy.id, registrar, verifier);
  await activateInvited(LOGINS.pharmacy, pharmacy.id);
  const pharmacyOwner = await as(LOGINS.pharmacy);
  ok(await pharmacyOwner.put(`/portal/providers/${pharmacy.id}/service-areas`, { areas: [{ purpose: 'DELIVERY', district: 'Purba Medinipur', pincode: '721636' }] }), 200, 'pharmacy coverage');
  ok(await pharmacyOwner.post(`/portal/providers/${pharmacy.id}/members`, { fullName: 'Sanchita Giri', email: LOGINS.pharmacist, memberRole: 'PHARMACIST' }), 201, 'invite pharmacist');
  await activateInvited(LOGINS.pharmacist, pharmacy.id);
  let medicines = ok(await pharmacyOwner.get('/portal/catalogue/medicines?limit=6'), 200, 'catalogue medicines') as { id: string; requiresPrescription: boolean }[];
  if (medicines.length < 3) {
    for (const m of [
      { name: 'Paracetamol', strength: '500 mg', dosageForm: 'Tablet', packSize: '10', manufacturer: 'Cipla' },
      { name: 'Cetirizine', strength: '10 mg', dosageForm: 'Tablet', packSize: '10', manufacturer: 'Dr. Reddy\'s' },
      { name: 'ORS Sachet', strength: '21 g', dosageForm: 'Powder', packSize: '1', manufacturer: 'FDC' },
      { name: 'Amoxicillin', strength: '500 mg', dosageForm: 'Capsule', packSize: '10', manufacturer: 'Sun Pharma', schedule: 'SCHEDULE_H' },
    ]) ok(await ops.post('/admin/catalogue/medicines', m), 201, `medicine ${m.name}`);
    medicines = ok(await pharmacyOwner.get('/portal/catalogue/medicines?limit=6'), 200, 'catalogue medicines') as typeof medicines;
  }
  for (const [i, m] of medicines.entries()) {
    ok(await pharmacyOwner.put(`/portal/providers/${pharmacy.id}/inventory`, { locationId: storeId, medicineId: m.id, batchNumber: `B24${String(1000 + i * 37)}`, expiryDate: istDate(i === 0 ? 40 : 400 + i * 30), quantityOnHand: 120 - i * 20, mrpMinor: 3000 + i * 1200, sellingPriceMinor: 2700 + i * 1100 }), 200, 'stock batch');
  }

  // ── Ambulance operator with a verified vehicle and crew ─────────────────
  console.log('Ambulance…');
  const operator = ok(await registrar.post('/admin/providers', {
    type: 'AMBULANCE_OPERATOR', legalName: 'Purba Medinipur Ambulance Service', displayName: 'Purba Medinipur Ambulance Service', contactPhone: '9800100005',
    owner: { fullName: 'Tapas Adhikari', email: LOGINS.ambulance },
    ambulance: { dispatchPhone: '9800100006', isOpen24x7: true, fleetSize: 2 },
    location: { name: 'Tamluk Base Station', addressLine1: 'NH-116 Bypass, Tamluk', city: 'Tamluk', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721636', latitude: TAMLUK.lat, longitude: TAMLUK.lng },
  }), 201, 'create operator');
  await approve(operator.id, registrar, verifier);
  await activateInvited(LOGINS.ambulance, operator.id);
  const operatorOwner = await as(LOGINS.ambulance);
  ok(await operatorOwner.put(`/portal/providers/${operator.id}/service-areas`, { areas: [{ purpose: 'AMBULANCE', district: 'Purba Medinipur' }] }), 200, 'ambulance coverage');
  ok(await operatorOwner.post(`/portal/providers/${operator.id}/members`, { fullName: 'Rakesh Maity', email: LOGINS.dispatcher, memberRole: 'DISPATCHER' }), 201, 'invite dispatcher');
  await activateInvited(LOGINS.dispatcher, operator.id);
  const bls = ok(await operatorOwner.post(`/portal/providers/${operator.id}/vehicles`, { registrationNumber: 'WB29AB1234', vehicleType: 'BLS', equipment: ['OXYGEN', 'STRETCHER', 'FIRST_AID'], insuranceValidUntil: istDate(300), fitnessValidUntil: istDate(500) }), 201, 'vehicle 1');
  const als = ok(await operatorOwner.post(`/portal/providers/${operator.id}/vehicles`, { registrationNumber: 'WB29CD5678', vehicleType: 'ALS', equipment: ['OXYGEN', 'STRETCHER', 'CARDIAC_MONITOR', 'DEFIBRILLATOR', 'VENTILATOR'], insuranceValidUntil: istDate(200) }), 201, 'vehicle 2');
  ok(await ops.post(`/admin/ambulance/vehicles/${bls.id}/status`, { status: 'AVAILABLE' }), 200, 'verify vehicle 1');
  ok(await ops.post(`/admin/ambulance/vehicles/${als.id}/status`, { status: 'AVAILABLE' }), 200, 'verify vehicle 2');
  ok(await operatorOwner.post(`/portal/providers/${operator.id}/crew`, { fullName: 'Sk. Nasir Ali', role: 'DRIVER', licenseNumber: 'WB-2015-0012345', licenseValidUntil: istDate(700) }), 201, 'crew 1');
  ok(await operatorOwner.post(`/portal/providers/${operator.id}/crew`, { fullName: 'Pinki Das', role: 'EMT', licenseNumber: 'EMT-WB-3321', licenseValidUntil: istDate(400) }), 201, 'crew 2');

  // ── A patient who has used everything ───────────────────────────────────
  console.log('Patient…');
  const patientUser = await makeUser(LOGINS.patient, 'Riya Das');
  const profile = await prisma.patientProfile.create({ data: { accountUserId: patientUser.id, fullName: 'Riya Das', relationship: 'SELF' } });
  const patient = await as(LOGINS.patient);
  const slots = ok(await hospitalOwner.get(`/portal/providers/${hospital.id}/slots?doctorProviderId=${doctor.id}&from=${new Date(Date.now() + 86_400_000).toISOString()}&to=${new Date(Date.now() + 8 * 86_400_000).toISOString()}`), 200, 'slots') as { id: string; status: string }[];
  const open = slots.filter((s) => s.status === 'OPEN');
  ok(await patient.post('/patient/appointments', { slotId: open[0]!.id, patientProfileId: profile.id }, idem()), 201, 'book appointment 1');
  ok(await patient.post('/patient/appointments', { slotId: open[5]!.id, patientProfileId: profile.id }, idem()), 201, 'book appointment 2');
  ok(await ops.post('/admin/diagnostic-orders', { patientProfileId: profile.id, providerId: lab.id, providerServiceIds: offeringIds.slice(0, 2), collectionMode: 'CENTRE_VISIT' }, idem()), 201, 'lab order');
  const otc = medicines.find((m) => !m.requiresPrescription);
  if (otc) ok(await ops.post('/admin/pharmacy-orders', { patientProfileId: profile.id, providerId: pharmacy.id, locationId: storeId, fulfilment: 'PICKUP', items: [{ medicineId: otc.id, quantity: 2 }] }, idem()), 201, 'pharmacy order');
  ok(await ops.post('/admin/diagnostic-orders', { patientProfileId: profile.id, providerId: lab.id, providerServiceIds: offeringIds.slice(2, 3), collectionMode: 'HOME_COLLECTION', collectionPincode: '721629' }, idem()), 201, 'home collection order');

  // Live dispatch is off by default (a high-risk platform setting). The demo
  // turns it on in this development database so the dispatcher screen has an
  // offer to accept; Super Admin → Settings → Emergency switches it off again.
  await prisma.platformSetting.upsert({ where: { key: 'emergency.live_dispatch_enabled' }, update: { value: true }, create: { key: 'emergency.live_dispatch_enabled', value: true, description: 'Enabled by the demo seed' } });
  const emergency = ok(await patient.post('/patient/emergency', { district: 'Purba Medinipur' }), 201, 'emergency request');
  if (emergency.status !== 'OFFERED') console.warn(`Emergency request ended as ${emergency.status}; the dispatcher will have nothing to accept.`);

  // Symptom search needs approved symptom → specialist links; approve the starter ones for the demo only.
  console.log(`Approved ${await approvePendingMappingsForDemo()} symptom → specialist links (demo only).`);

  // Internal staff accounts are not meant to be used afterwards.
  await prisma.user.updateMany({ where: { email: { in: Object.values(STAFF) } }, data: { status: 'DEACTIVATED', statusReason: 'Demo seed helper account' } });

  console.log('\nDemo data created.');
  printLogins();
}

function printLogins() {
  console.log(`\nPassword for every login: ${PASSWORD}`);
  console.log('Note: "Live ambulance dispatch" was turned ON in this development database so the dispatcher demo works. Turn it off under Super Admin → Settings → Emergency.\n');
  console.table([
    { who: 'Hospital owner', email: LOGINS.hospital, sees: 'Everything for Tamluk Seva Sadan Hospital' },
    { who: 'Hospital receptionist', email: LOGINS.reception, sees: 'Appointments only (STAFF role)' },
    { who: 'Doctor', email: LOGINS.doctor, sees: 'Own chamber + hospital affiliation' },
    { who: 'Lab owner', email: LOGINS.lab, sees: 'Orders & reports, services' },
    { who: 'Pharmacy owner', email: LOGINS.pharmacy, sees: 'Orders, stock, finance' },
    { who: 'Pharmacist', email: LOGINS.pharmacist, sees: 'Prescriptions, stock, orders' },
    { who: 'Ambulance owner', email: LOGINS.ambulance, sees: 'Dispatch, vehicles & crew' },
    { who: 'Dispatcher', email: LOGINS.dispatcher, sees: 'Dispatch (one offer is waiting)' },
    { who: 'Patient', email: LOGINS.patient, sees: 'Patient app (two appointments, a lab order, a medicine order)' },
  ]);
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
