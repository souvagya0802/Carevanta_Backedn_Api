import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { hashPassword } from '../../src/modules/auth/passwords.js';
import { TEST_PASSWORD, actor, api, login, type Actor } from './factory.js';

// Synthetic coordinates near Tamluk and Moyna (Purba Medinipur).
export const TAMLUK = { lat: 22.3, lng: 87.92 };
export const MOYNA = { lat: 22.27, lng: 87.77 };

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

export async function staff() {
  const registrar = await actor(['PLATFORM_ADMIN']);
  const verifier = await actor(['VERIFICATION_OFFICER']);
  return { registrar, verifier };
}

/** Give an invited (password-less) user a password and return an actor for them. */
export async function actorForUser(userId: string): Promise<Actor> {
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(TEST_PASSWORD), mustChangePassword: false } });
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const t = await login(u.email!);
  const auth = { Authorization: `Bearer ${t.accessToken}` };
  return {
    user: u,
    tokens: t,
    get: (url: string) => api().get(url).set(auth),
    post: (url: string, body?: object, headers: Record<string, string> = {}) => api().post(url).set(auth).set(headers).send(body ?? {}),
    patch: (url: string, body?: object) => api().patch(url).set(auth).send(body ?? {}),
    put: (url: string, body?: object) => api().put(url).set(auth).send(body ?? {}),
    delete: (url: string) => api().delete(url).set(auth),
    upload: (url: string, file: Buffer, contentType: string) => api().post(url).set(auth).set('Content-Type', contentType).send(file),
  } as Actor;
}

export async function approveProvider(providerId: string, registrar: Actor, verifier: Actor) {
  const submit = await registrar.post(`/api/v1/admin/providers/${providerId}/submit`);
  expect(submit.status, JSON.stringify(submit.body)).toBe(200);
  const kase = await prisma.verificationCase.findFirstOrThrow({ where: { providerId, status: { in: ['OPEN', 'IN_REVIEW'] } }, include: { checks: true } });
  for (const check of kase.checks.filter((c) => c.isRequired)) {
    const res = await verifier.post(`/api/v1/admin/verification-cases/${kase.id}/checks/${check.checkType}`, {
      status: 'PASSED',
      method: 'OFFICIAL_REGISTRY_LOOKUP',
      sourceReference: `synthetic-registry-ref-${uniq()}`,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  const decision = await verifier.post(`/api/v1/admin/verification-cases/${kase.id}/decision`, { decision: 'APPROVE', note: 'All checks passed (synthetic test data)' });
  expect(decision.status, JSON.stringify(decision.body)).toBe(200);
  return kase.id;
}

export async function createHospital(registrar: Actor, opts: { name?: string; at?: { lat: number; lng: number }; departments?: string[] } = {}) {
  const name = opts.name ?? `Tamluk General Hospital ${uniq()}`;
  const at = opts.at ?? TAMLUK;
  const res = await registrar.post('/api/v1/admin/providers', {
    type: 'HOSPITAL',
    legalName: `${name} Pvt Ltd`,
    displayName: name,
    contactPhone: '9800011111',
    owner: { fullName: 'Hospital Owner', email: `owner-${uniq()}@test.carevanta.local` },
    facility: { ownershipType: 'PRIVATE', bedCount: 50, hasEmergency: true },
    location: { name: 'Main campus', addressLine1: 'Hospital Road', city: 'Tamluk', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721636', latitude: at.lat, longitude: at.lng, regionCode: 'WB-PMD-TAMLUK' },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const id = res.body.data.id as string;
  if (opts.departments?.length) {
    const d = await registrar.put(`/api/v1/admin/providers/${id}/departments`, { departmentCodes: opts.departments });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
  }
  const owner = res.body.data.members.find((m: { memberRole: string }) => m.memberRole === 'OWNER');
  return { id, ownerUserId: owner.userId as string, locationId: res.body.data.locations[0].id as string };
}

export async function createDoctor(registrar: Actor, opts: { specialities?: string[]; feeMinor?: number; withOwnClinic?: boolean } = {}) {
  const tag = uniq();
  const res = await registrar.post('/api/v1/admin/providers', {
    type: 'DOCTOR',
    legalName: `Dr. Test ${tag}`,
    displayName: `Dr. Test ${tag}`,
    contactPhone: '9800022222',
    owner: { fullName: `Dr. Test ${tag}`, email: `doctor-${tag}@test.carevanta.local` },
    doctor: {
      specialityCodes: opts.specialities ?? ['GASTROENTEROLOGY'],
      defaultFeeMinor: opts.feeMinor ?? 50000,
      qualifications: [{ degree: 'MBBS', institution: 'Synthetic Medical College', yearAwarded: 2010 }],
      registrations: [{ council: 'West Bengal Medical Council', registrationNumber: `WBMC-${tag}` }],
    },
    location: opts.withOwnClinic === false ? undefined : { name: 'Own chamber', addressLine1: 'Station Road', city: 'Moyna', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721629', latitude: MOYNA.lat, longitude: MOYNA.lng, regionCode: 'WB-PMD-MOYNA' },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { id: res.body.data.id as string, userId: res.body.data.doctor.user.id as string, locationId: res.body.data.locations[0]?.id as string | undefined };
}

/** An APPROVED doctor with an ACTIVE affiliation at an APPROVED hospital. */
export async function affiliatedDoctor(opts: { specialities?: string[]; departments?: string[]; feeMinor?: number } = {}) {
  const { registrar, verifier } = await staff();
  const hospital = await createHospital(registrar, { departments: opts.departments ?? ['DEPT_GASTRO'] });
  const doctor = await createDoctor(registrar, { specialities: opts.specialities, feeMinor: opts.feeMinor });
  await approveProvider(hospital.id, registrar, verifier);
  await approveProvider(doctor.id, registrar, verifier);
  const hospitalOwner = await actorForUser(hospital.ownerUserId);
  const doctorUser = await actorForUser(doctor.userId);
  const invite = await hospitalOwner.post(`/api/v1/portal/providers/${hospital.id}/affiliations/invite`, {
    doctorProviderId: doctor.id,
    locationId: hospital.locationId,
    departmentCode: (opts.departments ?? ['DEPT_GASTRO'])[0],
    consultationFeeMinor: opts.feeMinor ?? 60000,
    engagementType: 'VISITING',
  });
  expect(invite.status, JSON.stringify(invite.body)).toBe(201);
  const affiliationId = invite.body.data.id as string;
  const accept = await doctorUser.post(`/api/v1/portal/doctor/affiliations/${affiliationId}/accept`, {});
  expect(accept.status, JSON.stringify(accept.body)).toBe(200);
  const verify = await verifier.post(`/api/v1/admin/affiliations/${affiliationId}/actions`, { action: 'VERIFY' });
  expect(verify.status, JSON.stringify(verify.body)).toBe(200);
  return { registrar, verifier, hospital, doctor, hospitalOwner, doctorUser, affiliationId };
}

/** Tomorrow's date in IST as YYYY-MM-DD (+ offset days). */
export function istDate(offsetDays = 1): string {
  const d = new Date(Date.now() + 330 * 60_000 + offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}
export function istWeekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export async function slotsFor(scheduler: Actor, doctorProviderId: string, locationId: string, opts: { capacity?: number; feeMinor?: number; date?: string; startMinute?: number; endMinute?: number } = {}) {
  const date = opts.date ?? istDate(2);
  const sched = await scheduler.post('/api/v1/schedules', {
    doctorProviderId,
    locationId,
    dayOfWeek: istWeekday(date),
    startMinute: opts.startMinute ?? 600,
    endMinute: opts.endMinute ?? 720,
    slotMinutes: 30,
    capacityPerSlot: opts.capacity ?? 1,
    ...(opts.feeMinor != null ? { feeMinor: opts.feeMinor } : {}),
    validFrom: istDate(0),
  });
  expect(sched.status, JSON.stringify(sched.body)).toBe(201);
  const gen = await scheduler.post(`/api/v1/schedules/${sched.body.data.id}/generate-slots`, { from: date, to: date });
  expect(gen.status, JSON.stringify(gen.body)).toBe(200);
  const slots = await prisma.appointmentSlot.findMany({ where: { scheduleId: sched.body.data.id }, orderBy: { startsAt: 'asc' } });
  return { scheduleId: sched.body.data.id as string, slots, created: gen.body.data.created as number, skipped: gen.body.data.skipped as number };
}

export async function patient() {
  const a = await actor([], { fullName: 'Synthetic Patient' });
  const profile = await prisma.patientProfile.create({ data: { accountUserId: a.user.id, fullName: 'Synthetic Patient', relationship: 'SELF' } });
  return { ...a, profileId: profile.id };
}

export { randomUUID };
