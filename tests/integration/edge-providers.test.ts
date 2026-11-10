import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { resetDatabase } from '../helpers/db.js';
import { actor, createUser } from '../helpers/factory.js';
import { actorForUser, affiliatedDoctor, approveProvider, createDoctor, createHospital, patient, randomUUID, slotsFor, staff } from '../helpers/fixtures.js';

beforeAll(resetDatabase);

const PDF = Buffer.from('%PDF-1.4\n% synthetic edge document\n%%EOF');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

const clinic = (extra: Record<string, unknown> = {}) => ({
  type: 'CLINIC',
  legalName: 'Edge Clinic Pvt Ltd',
  displayName: `Edge Clinic ${randomUUID().slice(0, 6)}`,
  contactPhone: '9800055555',
  location: { name: 'Main', addressLine1: 'Station Road', city: 'Tamluk', district: 'Purba Medinipur', state: 'West Bengal', pincode: '721636', latitude: 22.3, longitude: 87.92 },
  ...extra,
});

describe('EDGE-PROV: registration input boundaries', () => {
  it('EDGE-PROV-01: PIN codes, coordinates, phones and name lengths at their limits', async () => {
    const { registrar } = await staff();
    const loc = clinic().location;
    const bad: Record<string, unknown>[] = [
      { location: { ...loc, pincode: '72163' } },
      { location: { ...loc, pincode: '0721636' } },
      { location: { ...loc, pincode: '721636 ' } },
      { location: { ...loc, pincode: 'ABCDEF' } },
      { location: { ...loc, latitude: 90.0001 } },
      { location: { ...loc, longitude: -180.0001 } },
      { location: { ...loc, latitude: '22.3' } },
      { contactPhone: '12345' },
      { contactPhone: '+9198000555556789012' },
      { contactPhone: '5800055555' },
      { displayName: 'E' },
      { displayName: 'E'.repeat(201) },
      { legalName: ' ' },
      { contactEmail: 'owner@' },
      { gstin: '19ABCDE1234F1Z0' },
      { locations: Array.from({ length: 21 }, () => loc) },
      { type: 'DENTIST' },
    ];
    for (const extra of bad) {
      const res = await registrar.post('/api/v1/admin/providers', clinic(extra));
      expect(res.status, JSON.stringify(extra).slice(0, 80)).toBe(400);
    }
    // Inclusive limits and unicode names are accepted; the slug is derived and never empty.
    const ok = await registrar.post('/api/v1/admin/providers', clinic({ displayName: 'তমলুক ক্লিনিক', legalName: 'L'.repeat(200), location: { ...loc, latitude: -90, longitude: 180, pincode: '100000' }, contactPhone: '+919800055555' }));
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.displayName).toBe('তমলুক ক্লিনিক');
    const row = await prisma.provider.findUniqueOrThrow({ where: { id: ok.body.data.id } });
    expect(row.slug.length).toBeGreaterThan(0);
    expect(row.contactPhone).toBe('+919800055555');
  });

  it('EDGE-PROV-02: doctor profile limits — six specialities, unknown codes, primary outside the list, no registration, 1949 degree, negative fee; zero fee is legal', async () => {
    const { registrar } = await staff();
    const tag = randomUUID().slice(0, 8);
    const base = () => ({
      type: 'DOCTOR',
      legalName: `Dr Edge ${tag}`,
      displayName: `Dr Edge ${tag}`,
      contactPhone: '9800022222',
      owner: { fullName: 'Dr Edge', email: `dr-edge-${randomUUID().slice(0, 8)}@test.carevanta.local` },
      doctor: { specialityCodes: ['GENERAL_MEDICINE'], registrations: [{ council: 'West Bengal Medical Council', registrationNumber: `WBMC-${randomUUID().slice(0, 8)}` }] },
    });
    const bad: ((b: ReturnType<typeof base>) => object)[] = [
      (b) => ({ ...b, doctor: { ...b.doctor, specialityCodes: ['GENERAL_MEDICINE', 'PAEDIATRICS', 'CARDIOLOGY', 'DERMATOLOGY', 'ORTHOPAEDICS', 'GASTROENTEROLOGY'] } }),
      (b) => ({ ...b, doctor: { ...b.doctor, specialityCodes: ['NO_SUCH_SPECIALITY'] } }),
      (b) => ({ ...b, doctor: { ...b.doctor, primarySpecialityCode: 'CARDIOLOGY' } }),
      (b) => ({ ...b, doctor: { ...b.doctor, registrations: [] } }),
      (b) => ({ ...b, doctor: { ...b.doctor, qualifications: [{ degree: 'MBBS', institution: 'Synthetic College', yearAwarded: 1949 }] } }),
      (b) => ({ ...b, doctor: { ...b.doctor, defaultFeeMinor: -1 } }),
      (b) => ({ ...b, doctor: { ...b.doctor, defaultFeeMinor: 100.5 } }),
      (b) => ({ ...b, doctor: { ...b.doctor, yearsOfExperience: 71 } }),
      (b) => ({ ...b, owner: undefined }),
    ];
    for (const mutate of bad) {
      const res = await registrar.post('/api/v1/admin/providers', mutate(base()));
      expect(res.status, JSON.stringify(res.body).slice(0, 200)).toBe(400);
    }
    const free = await registrar.post('/api/v1/admin/providers', { ...base(), doctor: { ...base().doctor, defaultFeeMinor: 0 } });
    expect(free.status, JSON.stringify(free.body)).toBe(201);
    expect(free.body.data.doctor.defaultFeeMinor).toBe(0);
  });

  it('EDGE-PROV-03: a council registration number differing only by case or surrounding spaces is the same registration', async () => {
    const { registrar } = await staff();
    const reg = `wbmc-edge-${randomUUID().slice(0, 6)}`;
    const make = (registrationNumber: string) =>
      registrar.post('/api/v1/admin/providers', {
        type: 'DOCTOR',
        legalName: 'Dr Case',
        displayName: 'Dr Case',
        contactPhone: '9800022222',
        owner: { fullName: 'Dr Case', email: `dr-case-${randomUUID().slice(0, 8)}@test.carevanta.local` },
        doctor: { specialityCodes: ['GENERAL_MEDICINE'], registrations: [{ council: 'West Bengal Medical Council', registrationNumber }] },
      });
    expect((await make(reg)).status).toBe(201);
    expect((await make(reg.toUpperCase())).status).toBe(409);
    expect((await make(`  ${reg}  `)).status).toBe(409);
  });
});

describe('EDGE-PROV: lifecycle state machine', () => {
  it('EDGE-PROV-04: a DRAFT cannot be suspended or reactivated; DEACTIVATED is terminal for every action', async () => {
    const { registrar, verifier } = await staff();
    const admin = await actor(['SUPER_ADMIN']);
    const created = await registrar.post('/api/v1/admin/providers', clinic());
    const id = created.body.data.id as string;
    const suspend = await admin.post(`/api/v1/admin/providers/${id}/status`, { action: 'SUSPEND', reason: 'edge: suspend a draft' });
    expect(suspend.status).toBe(409);
    expect(suspend.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect((await admin.post(`/api/v1/admin/providers/${id}/status`, { action: 'REACTIVATE', reason: 'edge: reactivate a draft' })).status).toBe(409);
    // A reason shorter than 5 characters is refused before any state change.
    expect((await admin.post(`/api/v1/admin/providers/${id}/status`, { action: 'DEACTIVATE', reason: 'bye' })).status).toBe(400);
    expect((await admin.post(`/api/v1/admin/providers/${id}/status`, { action: 'DEACTIVATE', reason: 'edge: closing the draft' })).status).toBe(200);
    expect((await admin.post(`/api/v1/admin/providers/${id}/status`, { action: 'DEACTIVATE', reason: 'edge: closing twice' })).status).toBe(409);
    expect((await admin.post(`/api/v1/admin/providers/${id}/status`, { action: 'REACTIVATE', reason: 'edge: resurrect' })).status).toBe(409);
    expect((await registrar.post(`/api/v1/admin/providers/${id}/submit`)).status).toBe(409);
    expect((await registrar.patch(`/api/v1/admin/providers/${id}`, { displayName: 'Renamed', expectedVersion: created.body.data.version + 1 })).status).toBe(409);
    expect((await registrar.upload(`/api/v1/admin/providers/${id}/documents?documentType=CLINICAL_ESTABLISHMENT_REGISTRATION&fileName=a.pdf`, PDF, 'application/pdf')).status).toBe(409);
    expect(verifier.user.id).toBeTruthy();
  });

  it('EDGE-PROV-05: submission needs a location and a contact; a deactivated location counts as missing', async () => {
    const { registrar } = await staff();
    const noLocation = await registrar.post('/api/v1/admin/providers', clinic({ location: undefined }));
    expect(noLocation.status).toBe(201);
    const res = await registrar.post(`/api/v1/admin/providers/${noLocation.body.data.id}/submit`);
    expect(res.status).toBe(422);
    expect(res.body.error.details.problems).toContain('At least one active location is required');

    const noContact = await registrar.post('/api/v1/admin/providers', clinic({ contactPhone: undefined }));
    expect(noContact.status).toBe(201);
    const res2 = await registrar.post(`/api/v1/admin/providers/${noContact.body.data.id}/submit`);
    expect(res2.status).toBe(422);
    expect(res2.body.error.details.problems).toContain('A contact phone or email is required');

    const withLoc = await registrar.post('/api/v1/admin/providers', clinic());
    const pid = withLoc.body.data.id as string;
    const locId = withLoc.body.data.locations[0].id as string;
    expect((await registrar.patch(`/api/v1/admin/providers/${pid}/locations/${locId}`, { isActive: false })).status).toBe(200);
    const res3 = await registrar.post(`/api/v1/admin/providers/${pid}/submit`);
    expect(res3.status).toBe(422);
    // Submitting twice is a state error, not a crash.
    expect((await registrar.patch(`/api/v1/admin/providers/${pid}/locations/${locId}`, { isActive: true })).status).toBe(200);
    expect((await registrar.post(`/api/v1/admin/providers/${pid}/submit`)).status).toBe(200);
    expect((await registrar.post(`/api/v1/admin/providers/${pid}/submit`)).status).toBe(409);
  });

  it('EDGE-PROV-06: suspending a hospital blocks its future slots and hides it; reactivation re-opens them for booking', async () => {
    const ctx = await affiliatedDoctor();
    const admin = await actor(['SUPER_ADMIN']);
    const { slots } = await slotsFor(ctx.hospitalOwner, ctx.doctor.id, ctx.hospital.locationId, { capacity: 1 });
    expect(slots.length).toBeGreaterThanOrEqual(2);
    const before = await ctx.registrar.get(`/api/v1/discovery/doctors/${ctx.doctor.id}/slots`);
    expect(before.body.data.length).toBe(slots.length);

    expect((await admin.post(`/api/v1/admin/providers/${ctx.hospital.id}/status`, { action: 'SUSPEND', reason: 'edge: licence query' })).status).toBe(200);
    const blocked = await prisma.appointmentSlot.findMany({ where: { locationId: ctx.hospital.locationId } });
    expect(blocked.every((s) => s.status === 'BLOCKED')).toBe(true);
    expect((await ctx.registrar.get(`/api/v1/discovery/doctors/${ctx.doctor.id}/slots`)).body.data).toEqual([]);
    const p = await patient();
    const book = await p.post('/api/v1/patient/appointments', { slotId: slots[0]!.id, patientProfileId: p.profileId }, { 'Idempotency-Key': `edge-${randomUUID()}` });
    expect([404, 409, 422].includes(book.status), JSON.stringify(book.body)).toBe(true);
    // The hospital is no longer public.
    expect((await ctx.registrar.get(`/api/v1/discovery/providers/${ctx.hospital.id}`)).status).toBe(404);

    expect((await admin.post(`/api/v1/admin/providers/${ctx.hospital.id}/status`, { action: 'REACTIVATE', reason: 'edge: licence confirmed' })).status).toBe(200);
    const reopened = await prisma.appointmentSlot.findMany({ where: { locationId: ctx.hospital.locationId } });
    expect(reopened.every((s) => s.status === 'OPEN'), 'facility slots re-open after reactivation').toBe(true);
    const after = await ctx.registrar.get(`/api/v1/discovery/doctors/${ctx.doctor.id}/slots`);
    expect(after.body.data.length).toBe(slots.length);
    const booked = await p.post('/api/v1/patient/appointments', { slotId: slots[0]!.id, patientProfileId: p.profileId }, { 'Idempotency-Key': `edge-${randomUUID()}` });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
  });
});

describe('EDGE-PROV: locations, hours, service areas', () => {
  it('EDGE-PROV-07: opening hours — reversed, overlapping, day 7, 29 windows are refused; adjacent and 24-hour windows pass', async () => {
    const { registrar } = await staff();
    const created = await registrar.post('/api/v1/admin/providers', clinic());
    const id = created.body.data.id as string;
    const locId = created.body.data.locations[0].id as string;
    const url = `/api/v1/admin/providers/${id}/locations/${locId}/hours`;
    const bad = [
      [{ dayOfWeek: 1, opensAtMin: 600, closesAtMin: 600 }],
      [{ dayOfWeek: 1, opensAtMin: 700, closesAtMin: 600 }],
      [{ dayOfWeek: 1, opensAtMin: 540, closesAtMin: 720 }, { dayOfWeek: 1, opensAtMin: 719, closesAtMin: 900 }],
      [{ dayOfWeek: 7, opensAtMin: 540, closesAtMin: 720 }],
      [{ dayOfWeek: 1, opensAtMin: -1, closesAtMin: 720 }],
      [{ dayOfWeek: 1, opensAtMin: 0, closesAtMin: 1441 }],
      Array.from({ length: 29 }, (_, i) => ({ dayOfWeek: i % 7, opensAtMin: (i % 4) * 300, closesAtMin: (i % 4) * 300 + 100 })),
    ];
    for (const hours of bad) {
      const res = await registrar.put(url, { hours });
      expect(res.status, JSON.stringify(hours).slice(0, 100)).toBe(400);
    }
    const ok = await registrar.put(url, { hours: [{ dayOfWeek: 1, opensAtMin: 540, closesAtMin: 720 }, { dayOfWeek: 1, opensAtMin: 720, closesAtMin: 900 }, { dayOfWeek: 0, opensAtMin: 0, closesAtMin: 1440 }, { dayOfWeek: 6, opensAtMin: 0, closesAtMin: 1, isClosed: true }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await prisma.providerOperatingHours.count({ where: { locationId: locId } })).toBe(4);
    // Replacing with an empty list clears the week.
    expect((await registrar.put(url, { hours: [] })).status).toBe(200);
    expect(await prisma.providerOperatingHours.count({ where: { locationId: locId } })).toBe(0);
    // Another provider's location id is 404 even for a platform admin.
    const other = await registrar.post('/api/v1/admin/providers', clinic());
    expect((await registrar.put(`/api/v1/admin/providers/${other.body.data.id}/locations/${locId}/hours`, { hours: [] })).status).toBe(404);
  });

  it('EDGE-PROV-08: service areas — bad PIN, 201 rows, duplicates collapsed, empty list clears coverage', async () => {
    const { registrar } = await staff();
    const created = await registrar.post('/api/v1/admin/providers', clinic({ type: 'DIAGNOSTIC_LAB', diagnostic: { homeCollectionAvailable: true } }));
    const id = created.body.data.id as string;
    const url = `/api/v1/admin/providers/${id}/service-areas`;
    expect((await registrar.put(url, { areas: [{ purpose: 'HOME_COLLECTION', district: 'Purba Medinipur', pincode: '72163' }] })).status).toBe(400);
    expect((await registrar.put(url, { areas: [{ purpose: 'HOME_COLLECTION', district: 'P' }] })).status).toBe(400);
    expect((await registrar.put(url, { areas: [{ purpose: 'DRONE', district: 'Purba Medinipur' }] })).status).toBe(400);
    expect((await registrar.put(url, { areas: Array.from({ length: 201 }, (_, i) => ({ purpose: 'HOME_COLLECTION', district: `District ${i}` })) })).status).toBe(400);
    const dup = await registrar.put(url, { areas: [{ purpose: 'HOME_COLLECTION', district: 'Purba Medinipur', pincode: '721636' }, { purpose: 'HOME_COLLECTION', district: 'Purba Medinipur', pincode: '721636' }, { purpose: 'HOME_COLLECTION', district: 'Purba Medinipur' }] });
    expect(dup.status).toBe(200);
    expect(dup.body.data).toHaveLength(2);
    const cleared = await registrar.put(url, { areas: [] });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data).toEqual([]);
  });
});

describe('EDGE-PROV: members and payout accounts', () => {
  it('EDGE-PROV-09: members — duplicate, self-removal, last owner, deactivated user, and re-adding a removed member', async () => {
    const { registrar } = await staff();
    const hospital = await createHospital(registrar);
    const ownerActor = await actorForUser(hospital.ownerUserId);
    const admin = await actor(['SUPER_ADMIN']);
    const staffUser = await createUser({ fullName: 'Edge Staff' });
    const gone = await createUser({ fullName: 'Gone Staff', status: 'DEACTIVATED' });
    const url = `/api/v1/admin/providers/${hospital.id}/members`;
    expect((await admin.post(url, { userId: gone.id, memberRole: 'STAFF' })).status).toBe(400);
    expect((await admin.post(url, { userId: staffUser.id, memberRole: 'JANITOR' })).status).toBe(400);
    expect((await admin.post(url, { userId: randomUUID(), memberRole: 'STAFF' })).status).toBe(400);
    const added = await admin.post(url, { userId: staffUser.id, memberRole: 'STAFF' });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect((await admin.post(url, { userId: staffUser.id, memberRole: 'ADMIN' })).status).toBe(409);
    const members = added.body.data.members as { id: string; userId: string; memberRole: string }[];
    const ownerMember = members.find((m) => m.memberRole === 'OWNER')!;
    const staffMember = members.find((m) => m.userId === staffUser.id)!;
    // The only owner cannot be removed, and nobody can remove themselves.
    expect((await admin.delete(`${url}/${ownerMember.id}`)).status).toBe(409);
    await prisma.providerMember.create({ data: { providerId: hospital.id, userId: admin.user.id, memberRole: 'ADMIN', status: 'ACTIVE' } });
    const self = await prisma.providerMember.findFirstOrThrow({ where: { providerId: hospital.id, userId: admin.user.id } });
    expect((await admin.delete(`${url}/${self.id}`)).status).toBe(409);
    // Remove the staff member, then invite them back: they must become ACTIVE again rather than "already a member".
    expect((await admin.delete(`${url}/${staffMember.id}`)).status).toBe(200);
    expect((await admin.delete(`${url}/${staffMember.id}`)).status).toBe(404);
    const readd = await admin.post(url, { userId: staffUser.id, memberRole: 'ADMIN' });
    expect(readd.status, JSON.stringify(readd.body)).toBe(201);
    const again = await prisma.providerMember.findUniqueOrThrow({ where: { providerId_userId: { providerId: hospital.id, userId: staffUser.id } } });
    expect(again.status).toBe('ACTIVE');
    expect(again.memberRole).toBe('ADMIN');
    expect(again.removedAt).toBeNull();
    expect(ownerActor.user.id).toBe(hospital.ownerUserId);
  });

  it('EDGE-PROV-10: payout accounts — 8/19-digit numbers and bad IFSC refused; IFSC upper-cased; maker cannot verify; second verify is 409', async () => {
    const { registrar, verifier } = await staff();
    const hospital = await createHospital(registrar);
    const admin = await actor(['SUPER_ADMIN']);
    const url = `/api/v1/admin/providers/${hospital.id}/payout-accounts`;
    for (const body of [
      { accountHolderName: 'Edge Hospital', accountNumber: '12345678', ifsc: 'SBIN0001234' },
      { accountHolderName: 'Edge Hospital', accountNumber: '1'.repeat(19), ifsc: 'SBIN0001234' },
      { accountHolderName: 'Edge Hospital', accountNumber: '1234567890', ifsc: 'SBIN1001234' },
      { accountHolderName: 'Edge Hospital', accountNumber: '1234567890', ifsc: 'SBI00012345' },
      { accountHolderName: 'Edge Hospital', accountNumber: '12345 67890', ifsc: 'SBIN0001234' },
      { accountHolderName: 'E', accountNumber: '1234567890', ifsc: 'SBIN0001234' },
    ]) {
      expect((await admin.post(url, body)).status, JSON.stringify(body)).toBe(400);
    }
    const created = await admin.post(url, { accountHolderName: 'Edge Hospital', accountNumber: '123456789012', ifsc: 'sbin0001234' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.ifsc).toBe('SBIN0001234');
    expect(JSON.stringify(created.body)).not.toContain('123456789012');
    expect(created.body.data.accountNumberLast4 ?? created.body.data.accountNumberMasked).toBeTruthy();
    const acct = created.body.data.id as string;
    const selfVerify = await admin.post(`${url}/${acct}/verify`, { method: 'PENNY_DROP' });
    expect(selfVerify.status).toBe(403);
    expect(selfVerify.body.error.code).toBe('SEPARATION_OF_DUTIES');
    expect((await verifier.post(`${url}/${acct}/verify`, { method: 'PENNY_DROP' })).status).toBe(200);
    expect((await verifier.post(`${url}/${acct}/verify`, { method: 'PENNY_DROP' })).status).toBe(409);
    expect((await admin.post(`${url}/${randomUUID()}/verify`, { method: 'PENNY_DROP' })).status).toBe(404);
  });
});

describe('EDGE-PROV: document uploads', () => {
  it('EDGE-PROV-11: declared type must match the bytes; unsupported types, empty files, expired documents and bad names are refused', async () => {
    const { registrar } = await staff();
    const created = await registrar.post('/api/v1/admin/providers', clinic());
    const id = created.body.data.id as string;
    const url = (q: string) => `/api/v1/admin/providers/${id}/documents?${q}`;
    const pdfQ = 'documentType=CLINICAL_ESTABLISHMENT_REGISTRATION&fileName=licence.pdf';
    expect((await registrar.upload(url(pdfQ), PNG, 'application/pdf')).status).toBe(415);
    expect((await registrar.upload(url(pdfQ), PDF, 'image/png')).status).toBe(415);
    expect((await registrar.upload(url(pdfQ), PDF, 'text/plain')).status).toBe(400);
    expect((await registrar.upload(url(pdfQ), Buffer.alloc(0), 'application/pdf')).status).toBe(400);
    expect((await registrar.upload(url(`${pdfQ}&expiresAt=2020-01-01`), PDF, 'application/pdf')).status).toBe(400);
    expect((await registrar.upload(url(`${pdfQ}&expiresAt=31-12-2030`), PDF, 'application/pdf')).status).toBe(400);
    expect((await registrar.upload(url('documentType=NOT_A_TYPE&fileName=x.pdf'), PDF, 'application/pdf')).status).toBe(400);
    expect((await registrar.upload(url('documentType=CLINICAL_ESTABLISHMENT_REGISTRATION&fileName='), PDF, 'application/pdf')).status).toBe(400);
    expect((await registrar.upload(url(`documentType=CLINICAL_ESTABLISHMENT_REGISTRATION&fileName=${'a'.repeat(256)}.pdf`), PDF, 'application/pdf')).status).toBe(400);
    const traversal = await registrar.upload(url('documentType=CLINICAL_ESTABLISHMENT_REGISTRATION&fileName=..%2F..%2Fetc%2Fpasswd'), PDF, 'application/pdf');
    expect(traversal.status, JSON.stringify(traversal.body)).toBe(201);
    expect(traversal.body.data.fileName).not.toContain('/');
    expect(traversal.body.data.storageKey ?? '').not.toContain('..');
    // A second upload of the same type supersedes the first.
    const second = await registrar.upload(url(pdfQ), PDF, 'application/pdf');
    expect(second.status).toBe(201);
    const list = await registrar.get(`/api/v1/admin/providers/${id}/documents`);
    const statuses = (list.body.data as { id: string; status: string }[]).map((d) => d.status).sort();
    expect(statuses).toEqual(['SUPERSEDED', 'UPLOADED']);
  });

  it('EDGE-PROV-12: approved-provider edits with a stale version are 409 and type-foreign profile sections are 400', async () => {
    const { registrar, verifier } = await staff();
    const doctor = await createDoctor(registrar);
    await approveProvider(doctor.id, registrar, verifier);
    const current = await registrar.get(`/api/v1/admin/providers/${doctor.id}`);
    const v = current.body.data.version as number;
    expect((await registrar.patch(`/api/v1/admin/providers/${doctor.id}`, { facility: { bedCount: 10 }, expectedVersion: v })).status).toBe(400);
    expect((await registrar.patch(`/api/v1/admin/providers/${doctor.id}`, { displayName: 'Dr Renamed', expectedVersion: 0 })).status).toBe(400);
    expect((await registrar.patch(`/api/v1/admin/providers/${doctor.id}`, { displayName: 'Dr Renamed', expectedVersion: v + 5 })).status).toBe(409);
    const ok = await registrar.patch(`/api/v1/admin/providers/${doctor.id}`, { displayName: 'Dr Renamed', contactEmail: null, expectedVersion: v });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.version).toBe(v + 1);
    expect((await registrar.patch(`/api/v1/admin/providers/${doctor.id}`, { displayName: 'Dr Renamed Again', expectedVersion: v })).status).toBe(409);
  });
});
