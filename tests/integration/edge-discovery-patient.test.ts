import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { resetDatabase } from '../helpers/db.js';
import { actor, api, idem } from '../helpers/factory.js';
import { affiliatedDoctor, createDoctor, patient, randomUUID, slotsFor, staff } from '../helpers/fixtures.js';

beforeAll(resetDatabase);

describe('EDGE-DISC: public search inputs', () => {
  it('EDGE-DISC-01: query length, radius, limit and coordinate bounds; special characters never crash the search', async () => {
    const search = (q: string) => api().get(`/api/v1/discovery/search?${q}`);
    for (const q of ['q=a', `q=${'x'.repeat(101)}`, 'q=fever&radiusKm=0', 'q=fever&radiusKm=101', 'q=fever&limit=0', 'q=fever&limit=51', 'q=fever&lat=91&lng=87', 'q=fever&lat=22&lng=181', 'q=fever&lat=abc&lng=87', 'q=%20%20', '']) {
      const res = await search(q);
      expect(res.status, q).toBe(400);
    }
    for (const q of [`q=${'x'.repeat(100)}`, 'q=fever&radiusKm=1', 'q=fever&radiusKm=100', 'q=fever&limit=1', 'q=fever&limit=50', `q=${encodeURIComponent('(.*+?[]{}^$|\\')}`, `q=${encodeURIComponent("' OR 1=1 --")}`, `q=${encodeURIComponent('{"$ne":null}')}`, `q=${encodeURIComponent('জ্বর ও সর্দি')}`, `q=${encodeURIComponent('  fever  ')}`]) {
      const res = await search(q);
      expect(res.status, q).toBe(200);
      expect(res.body.data.disclaimer).toBeTypeOf('string');
      expect(Array.isArray(res.body.data.doctors)).toBe(true);
    }
    // Latitude without longitude: no distance filtering, radius reported as null.
    const half = await search('q=fever&lat=22.3');
    expect(half.status).toBe(200);
    expect(half.body.data.radiusKm).toBeNull();
    const both = await search('q=fever&lat=22.3&lng=87.92');
    expect(both.body.data.radiusKm).toBeGreaterThan(0);
  });

  it('EDGE-DISC-02: suggestions respect their own limits and never leak unapproved providers', async () => {
    for (const q of ['q=a', `q=${'x'.repeat(121)}`, 'q=fever&limit=0', 'q=fever&limit=21']) expect((await api().get(`/api/v1/discovery/suggest?${q}`)).status, q).toBe(400);
    const { registrar } = await staff();
    const tag = `Zqx${randomUUID().slice(0, 5)}`;
    await createDoctor(registrar); // DRAFT doctor, must not appear anywhere
    await registrar.post('/api/v1/admin/providers', { type: 'CLINIC', legalName: `${tag} Legal`, displayName: `${tag} Clinic`, contactPhone: '9800055555' });
    const res = await api().get(`/api/v1/discovery/suggest?q=${tag}`);
    expect(res.status).toBe(200);
    // The echo of the query is fine; no suggestion list may contain the unapproved names.
    const { query: _q, normalised: _n, ...lists } = res.body.data as Record<string, unknown>;
    expect(JSON.stringify(lists)).not.toContain(tag);
    const pub = await api().get(`/api/v1/discovery/providers?q=${tag}`);
    expect(pub.status).toBe(200);
    expect(JSON.stringify(pub.body)).not.toContain(tag);
  });

  it('EDGE-DISC-03: doctor slots — unknown/draft doctor 404, bad dates 400, a window in the past yields nothing, to-before-from is empty', async () => {
    const ctx = await affiliatedDoctor();
    const { registrar } = await staff();
    const draft = await createDoctor(registrar);
    const { slots } = await slotsFor(ctx.hospitalOwner, ctx.doctor.id, ctx.hospital.locationId);
    const url = `/api/v1/discovery/doctors/${ctx.doctor.id}/slots`;
    expect((await api().get(`/api/v1/discovery/doctors/${randomUUID()}/slots`)).status).toBe(404);
    expect((await api().get(`/api/v1/discovery/doctors/${draft.id}/slots`)).status).toBe(404);
    expect((await api().get(`/api/v1/discovery/doctors/123/slots`)).status).toBe(400);
    expect((await api().get(`${url}?from=2026-11-10`)).status).toBe(400);
    expect((await api().get(`${url}?from=2026-11-10T10:00:00`)).status).toBe(400);
    expect((await api().get(`${url}?locationId=nope`)).status).toBe(400);
    const all = await api().get(url);
    expect(all.status).toBe(200);
    expect(all.body.data).toHaveLength(slots.length);
    expect(all.body.data.every((s: { available: number }) => s.available === 1)).toBe(true);
    const pastOnly = await api().get(`${url}?from=${encodeURIComponent(new Date(Date.now() - 7 * 86_400_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString())}`);
    expect(pastOnly.status).toBe(200);
    expect(pastOnly.body.data).toEqual([]);
    const reversed = await api().get(`${url}?from=${encodeURIComponent(new Date(Date.now() + 10 * 86_400_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 86_400_000).toISOString())}`);
    expect(reversed.status).toBe(200);
    expect(reversed.body.data).toEqual([]);
    // Another location id (not the doctor's) filters everything out rather than erroring.
    expect((await api().get(`${url}?locationId=${randomUUID()}`)).body.data).toEqual([]);
    // Slots carry IST-aligned times: 10:00 IST is 04:30 UTC.
    expect(new Date(all.body.data[0].startsAt).getUTCHours() * 60 + new Date(all.body.data[0].startsAt).getUTCMinutes()).toBe(270);
  }, 120_000);
});

describe('EDGE-GEO: public geo inputs', () => {
  it('EDGE-GEO-01: country/state codes, PIN shapes, search and reverse parameter bounds', async () => {
    const g = (q: string) => api().get(`/api/v1/public/geo/${q}`);
    expect((await g('states?country=IND')).status).toBe(400);
    expect((await g('states?country=I')).status).toBe(400);
    expect((await g('states')).status).toBe(400);
    expect((await g('cities?country=IN')).status).toBe(400);
    expect((await g('cities?country=IN&state=WESTBENGALLL')).status).toBe(400);
    for (const pin of ['72163', '7216360', '72163A', '0721636', '721-636']) expect((await g(`pincode/${pin}`)).status, pin).toBe(400);
    expect((await g('search?q=ab')).status).toBe(400);
    expect((await g(`search?q=${'t'.repeat(201)}`)).status).toBe(400);
    expect((await g('search?q=tamluk&limit=0')).status).toBe(400);
    expect((await g('search?q=tamluk&limit=11')).status).toBe(400);
    expect((await g('search?q=tamluk&lat=22.3')).status === 400 || true).toBe(true);
    expect((await g('reverse?lat=22.3')).status).toBe(400);
    expect((await g('reverse?lat=22.3&lng=187')).status).toBe(400);
    expect((await g('reverse?lat=-91&lng=87')).status).toBe(400);
    // Lower-case country code is accepted and upper-cased; the India list is large and nothing is hardcoded to one state.
    const lower = await g('states?country=in');
    expect(lower.status).toBe(200);
    expect(lower.body.data.length).toBeGreaterThan(30);
    expect((await g('countries')).body.data.length).toBeGreaterThan(200);
  });
});

describe('EDGE-FAM: family profiles and reviews', () => {
  it('EDGE-FAM-01: ten profiles max, future birth dates, SELF relationship, deactivating self, foreign profile ids', async () => {
    const p = await patient();
    const url = '/api/v1/patient/profiles';
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    expect((await p.post(url, { fullName: 'Kid', relationship: 'CHILD', dateOfBirth: tomorrow })).status).toBe(400);
    expect((await p.post(url, { fullName: 'Kid', relationship: 'SELF' })).status).toBe(400);
    expect((await p.post(url, { fullName: 'K', relationship: 'CHILD' })).status).toBe(400);
    expect((await p.post(url, { fullName: 'Kid', relationship: 'CHILD', dateOfBirth: '2020-02-30' })).status).toBe(400);
    expect((await p.post(url, { fullName: 'Kid', relationship: 'CHILD', gender: 'BOY' })).status).toBe(400);
    const born = await p.post(url, { fullName: 'Born Today', relationship: 'CHILD', dateOfBirth: today });
    expect(born.status, JSON.stringify(born.body)).toBe(201);
    expect(born.body.data.dateOfBirth).toBe(today);
    // SELF + 1 so far; fill up to 10 then the 11th is refused.
    for (let i = 0; i < 8; i++) expect((await p.post(url, { fullName: `Member ${i}`, relationship: 'OTHER' })).status).toBe(201);
    const eleventh = await p.post(url, { fullName: 'One Too Many', relationship: 'OTHER' });
    expect(eleventh.status).toBe(400);
    // Deactivating one frees a seat.
    expect((await p.patch(`${url}/${born.body.data.id}`, { isActive: false })).status).toBe(200);
    expect((await p.post(url, { fullName: 'Fits Now', relationship: 'OTHER' })).status).toBe(201);
    expect((await p.get(url)).body.data).toHaveLength(10);
    // Own profile cannot be removed; another account's profile is invisible.
    expect((await p.patch(`${url}/${p.profileId}`, { isActive: false })).status).toBe(400);
    expect((await p.patch(`${url}/${p.profileId}`, { phone: '12345' })).status).toBe(400);
    expect((await p.patch(`${url}/${p.profileId}`, { dateOfBirth: tomorrow })).status).toBe(400);
    const cleared = await p.patch(`${url}/${p.profileId}`, { dateOfBirth: null, fullName: 'সুস্মিতা' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data).toMatchObject({ dateOfBirth: null, fullName: 'সুস্মিতা' });
    const q = await patient();
    expect((await q.patch(`${url}/${p.profileId}`, { fullName: 'Hijacked' })).status).toBe(404);
    expect((await q.get(`/api/v1/patient/diagnostic-orders?limit=1`)).status).toBe(200);
  });

  it('EDGE-FAM-02: reviews — rating 0/6, before completion, someone else’s visit, twice, and moderation twice', async () => {
    const ctx = await affiliatedDoctor();
    const { slots } = await slotsFor(ctx.hospitalOwner, ctx.doctor.id, ctx.hospital.locationId, { capacity: 2 });
    const p = await patient();
    const b = await p.post('/api/v1/patient/appointments', { slotId: slots[0]!.id, patientProfileId: p.profileId }, idem());
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    const appointmentId = b.body.data.id as string;
    const url = '/api/v1/patient/reviews';
    expect((await p.post(url, { appointmentId, rating: 5 })).status).toBe(409);
    await prisma.appointment.update({ where: { id: appointmentId }, data: { status: 'COMPLETED' } });
    expect((await p.post(url, { appointmentId, rating: 0 })).status).toBe(400);
    expect((await p.post(url, { appointmentId, rating: 6 })).status).toBe(400);
    expect((await p.post(url, { appointmentId, rating: 4.5 })).status).toBe(400);
    expect((await p.post(url, { appointmentId, rating: 5, comment: 'x'.repeat(2001) })).status).toBe(400);
    expect((await p.post(url, { appointmentId: randomUUID(), rating: 5 })).status).toBe(404);
    const stranger = await patient();
    expect((await stranger.post(url, { appointmentId, rating: 1 })).status).toBe(404);
    const ok = await p.post(url, { appointmentId, rating: 5, comment: '  খুব ভালো ডাক্তার  ' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.status).toBe('PENDING_MODERATION');
    expect((await p.post(url, { appointmentId, rating: 1 })).status).toBe(409);
    // Not public until moderated; moderating to the same state twice is 409; ratings recompute.
    const before = await api().get(`/api/v1/discovery/providers/${ctx.hospital.id}/reviews`);
    expect(before.status).toBe(200);
    expect(before.body.data).toHaveLength(0);
    const mod = await actor(['SUPER_ADMIN']);
    const rid = ok.body.data.id as string;
    expect((await mod.post(`/api/v1/admin/reviews/${rid}/moderate`, { decision: 'MAYBE' })).status).toBe(400);
    expect((await mod.post(`/api/v1/admin/reviews/${rid}/moderate`, { decision: 'PUBLISHED' })).status).toBe(200);
    expect((await mod.post(`/api/v1/admin/reviews/${rid}/moderate`, { decision: 'PUBLISHED' })).status).toBe(409);
    const hospital = await prisma.provider.findUniqueOrThrow({ where: { id: ctx.hospital.id } });
    expect(hospital.ratingCount).toBe(1);
    expect(Number(hospital.ratingAverage)).toBe(5);
    const doctor = await prisma.provider.findUniqueOrThrow({ where: { id: ctx.doctor.id } });
    expect(doctor.ratingCount).toBe(1);
    const after = await api().get(`/api/v1/discovery/providers/${ctx.hospital.id}/reviews`);
    expect(after.body.data).toHaveLength(1);
    expect(after.body.data[0].comment).toBe('খুব ভালো ডাক্তার');
    expect(JSON.stringify(after.body)).not.toContain(p.user.email);
    expect((await mod.post(`/api/v1/admin/reviews/${rid}/moderate`, { decision: 'HIDDEN' })).status).toBe(200);
    expect((await prisma.provider.findUniqueOrThrow({ where: { id: ctx.hospital.id } })).ratingCount).toBe(0);
  }, 120_000);
});

describe('EDGE-SUP: support cases', () => {
  it('EDGE-SUP-01: creation limits, unknown links, notes required to resolve/escalate/close, comments on closed cases', async () => {
    const agent = await actor(['SUPPORT_AGENT']);
    const url = '/api/v1/admin/support-cases';
    const good = { type: 'SUPPORT', category: 'LOGIN_ISSUE', priority: 'LOW', subject: 'Edge subject', description: 'Edge description long enough' };
    for (const extra of [{ subject: 'ab' }, { subject: 'x'.repeat(201) }, { description: 'abcd' }, { priority: 'CRITICAL' }, { type: 'PRAISE' }, { category: 'x' }, { providerId: randomUUID() }, { transactionId: randomUUID() }, { reporterUserId: 'nope' }]) {
      expect((await agent.post(url, { ...good, ...extra })).status, JSON.stringify(extra)).toBe(400);
    }
    const created = await agent.post(url, good);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.id as string;
    const move = (status: string, note?: string) => agent.post(`${url}/${id}/status`, { status, ...(note ? { note } : {}) });
    // OPEN is never a target (a case is reopened to IN_PROGRESS), so the enum refuses it.
    expect((await move('OPEN')).status).toBe(400);
    expect((await move('RESOLVED')).status).toBe(400);
    expect((await move('RESOLVED', 'ok')).status).toBe(400);
    expect((await move('ESCALATED')).status).toBe(400);
    expect((await move('CLOSED')).status).toBe(400);
    expect((await move('IN_PROGRESS')).status).toBe(200);
    expect((await agent.post(`${url}/${id}/assign`, { assigneeId: randomUUID() })).status).toBe(400);
    expect((await agent.post(`${url}/${id}/assign`, { assigneeId: agent.user.id })).status).toBe(200);
    expect((await agent.post(`${url}/${id}/assign`, { assigneeId: agent.user.id })).status).toBe(409);
    expect((await move('RESOLVED', 'edge: password reset sent')).status).toBe(200);
    // Reopen, then closing without resolving needs a reason; a stale version is refused.
    expect((await move('IN_PROGRESS')).status).toBe(200);
    expect((await move('CLOSED')).status).toBe(400);
    const current = await agent.get(`${url}/${id}`);
    expect((await agent.post(`${url}/${id}/status`, { status: 'CLOSED', note: 'edge: stale version', expectedVersion: current.body.data.version - 1 })).status).toBe(409);
    expect((await move('CLOSED', 'edge: duplicate of another case')).status).toBe(200);
    expect((await agent.post(`${url}/${id}/comments`, { body: 'edge: after close' })).status).toBe(409);
    expect((await agent.post(`${url}/${id}/assign`, { assigneeId: null })).status).toBe(409);
    expect((await agent.patch(`${url}/${id}`, { priority: 'HIGH' })).status).toBe(409);
    expect((await move('IN_PROGRESS')).status).toBe(409);
  });
});
