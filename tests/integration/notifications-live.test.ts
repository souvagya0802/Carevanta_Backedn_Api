import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { closeMongoClient } from '../../src/lib/mongo-client.js';
import { stopNotificationStreams } from '../../src/modules/notifications/stream.js';
import { resetDatabase } from '../helpers/db.js';
import { actor, getApp, idem } from '../helpers/factory.js';
import { affiliatedDoctor, patient, slotsFor } from '../helpers/fixtures.js';

const V = '/api/v1';
type Sse = { event: string; data: Record<string, unknown> };

/** Open the SSE stream with fetch (like the apps do) and collect parsed events. */
async function openStream(port: number, token: string, query = '') {
  const ctrl = new AbortController();
  const events: Sse[] = [];
  const res = await fetch(`http://127.0.0.1:${port}${V}/portal/notifications/stream${query}`, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const event = /^event: (.+)$/m.exec(chunk)?.[1];
          const data = /^data: (.+)$/m.exec(chunk)?.[1];
          if (event && data) events.push({ event, data: JSON.parse(data) });
        }
      }
    } catch { /* aborted */ }
  })();
  const waitFor = async (pred: (e: Sse) => boolean, ms = 8000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const hit = events.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no matching SSE event within ${ms} ms; got ${JSON.stringify(events.map((e) => [e.event, e.data.templateKey ?? e.data.ids]))}`);
  };
  return { events, waitFor, close: () => ctrl.abort() };
}

describe('live notifications', () => {
  let server: Server;
  let port: number;
  beforeAll(async () => {
    await resetDatabase();
    server = getApp().listen(0);
    await new Promise<void>((r) => server.once('listening', r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => {
    await stopNotificationStreams();
    await closeMongoClient();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('streams a booking to the front desk with level and meta, replays unread rows on reconnect, and broadcasts read-marks', async () => {
    const { hospital, doctor, hospitalOwner } = await affiliatedDoctor();
    const { slots } = await slotsFor(hospitalOwner, doctor.id, hospital.locationId, { capacity: 3 });
    const p = await patient();

    const live = await openStream(port, hospitalOwner.tokens.accessToken);
    await new Promise((r) => setTimeout(r, 400)); // let the change stream open before the write
    const booked = await p.post(`${V}/patient/appointments`, { slotId: slots[0]!.id, patientProfileId: p.profileId }, idem());
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);

    const ev = await live.waitFor((e) => e.event === 'notification' && e.data.templateKey === 'portal.appointment_booked');
    expect(ev.data).toMatchObject({ level: 'important', title: 'New appointment request', link: `/appointments?id=${booked.body.data.id}`, meta: { kind: 'appointment', id: booked.body.data.id, providerId: hospital.id, status: 'REQUESTED' } });
    expect(typeof ev.data.createdAt).toBe('string');
    // Change stream and safety poll both saw this row; the subscriber must get it exactly once.
    await new Promise((r) => setTimeout(r, 4000));
    expect(live.events.filter((e) => e.event === 'notification' && e.data.id === ev.data.id)).toHaveLength(1);

    // The list carries the same fields next to templateKey.
    const list = await hospitalOwner.get(`${V}/portal/notifications?unread=true`);
    const row = list.body.data.find((n: { id: string }) => n.id === ev.data.id);
    expect(row).toMatchObject({ templateKey: 'portal.appointment_booked', level: 'important', meta: { kind: 'appointment', id: booked.body.data.id } });

    // Marking read on any device tells every open stream.
    expect((await hospitalOwner.post(`${V}/portal/notifications/read`, { ids: [ev.data.id] })).status).toBe(200);
    const read = await live.waitFor((e) => e.event === 'read' && (e.data.ids as string[]).includes(ev.data.id as string));
    expect(read.data.ids).toEqual([ev.data.id]);
    live.close();

    // A second booking while nobody listens, then a reconnect with ?since replays it (unread only, so the first one is not repeated).
    const since = new Date(Date.now() - 60_000).toISOString();
    const second = await p.post(`${V}/patient/appointments`, { slotId: slots[1]!.id, patientProfileId: p.profileId }, idem());
    expect(second.status).toBe(201);
    const again = await openStream(port, hospitalOwner.tokens.accessToken, `?since=${encodeURIComponent(since)}`);
    const replayed = await again.waitFor((e) => e.event === 'notification' && e.data.meta != null && (e.data.meta as { id: string }).id === second.body.data.id);
    expect(replayed.data).toMatchObject({ templateKey: 'portal.appointment_booked', level: 'important' });
    expect(again.events.some((e) => e.data.id === ev.data.id)).toBe(false);
    again.close();
  });

  it('tells the front desk when the patient cancels (important, with a quick-action link), but not the patient themselves', async () => {
    const { hospital, doctor, hospitalOwner } = await affiliatedDoctor();
    const { slots } = await slotsFor(hospitalOwner, doctor.id, hospital.locationId);
    const p = await patient();
    const b = await p.post(`${V}/patient/appointments`, { slotId: slots[0]!.id, patientProfileId: p.profileId }, idem());
    expect((await p.post(`${V}/patient/appointments/${b.body.data.id}/cancel`, { reason: 'Feeling better' })).status).toBe(200);
    const staff = await prisma.notification.findFirst({ where: { userId: hospitalOwner.user.id, templateKey: 'portal.appointment_cancelled_by_patient' } });
    expect(staff).toBeTruthy();
    expect(staff!.link).toBe(`/appointments?id=${b.body.data.id}`);
    expect(staff!.body).toContain('Feeling better');
    expect(staff!.payload).toMatchObject({ level: 'important', meta: { kind: 'appointment', id: b.body.data.id, providerId: hospital.id, status: 'CANCELLED_BY_PATIENT' } });
    expect(await prisma.notification.count({ where: { userId: p.user.id, templateKey: 'portal.appointment_cancelled_by_patient' } })).toBe(0);
  });

  it('pulls platform staff in by permission: new support cases, reviews awaiting moderation, and emergencies nobody can take', async () => {
    const agent = await actor(['SUPPORT_AGENT']);
    const colleague = await actor(['SUPPORT_AGENT']);
    const c = await agent.post(`${V}/admin/support-cases`, { type: 'COMPLAINT', category: 'LATE_REPORT', priority: 'URGENT', subject: 'Report delayed', description: 'Report promised in 24h not delivered after 3 days.' });
    expect(c.status).toBe(201);
    const opened = await prisma.notification.findFirst({ where: { userId: colleague.user.id, templateKey: 'admin.support_case_opened' } });
    expect(opened).toMatchObject({ link: `/support?id=${c.body.data.id}` });
    expect(opened!.payload).toMatchObject({ level: 'important', meta: { kind: 'support_case', id: c.body.data.id } });
    expect(await prisma.notification.count({ where: { userId: agent.user.id, templateKey: 'admin.support_case_opened' } })).toBe(0); // the author is not told

    const { hospital, doctor, hospitalOwner } = await affiliatedDoctor();
    const { slots } = await slotsFor(hospitalOwner, doctor.id, hospital.locationId);
    const p = await patient();
    const appt = await p.post(`${V}/patient/appointments`, { slotId: slots[0]!.id, patientProfileId: p.profileId }, idem());
    await prisma.appointment.update({ where: { id: appt.body.data.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
    const review = await p.post(`${V}/patient/reviews`, { appointmentId: appt.body.data.id, rating: 4, comment: 'Good' });
    expect(review.status).toBe(201);
    const pending = await prisma.notification.findFirst({ where: { userId: colleague.user.id, templateKey: 'admin.review_pending' } });
    expect(pending).toMatchObject({ link: '/reviews' });
    expect(pending!.payload).toMatchObject({ level: 'light', meta: { kind: 'review', id: review.body.data.id, providerId: hospital.id } });

    const admin = await actor(['SUPER_ADMIN']);
    const sos = await p.post(`${V}/patient/emergency`, { district: 'Purba Medinipur' });
    expect(sos.status).toBe(201);
    expect(sos.body.data.status).toBe('NO_PROVIDER_AVAILABLE');
    const mine = await prisma.notification.findFirst({ where: { userId: p.user.id, templateKey: 'dispatch.no_provider_available' } });
    expect(mine).toMatchObject({ link: `/emergency/${sos.body.data.requestId}` });
    expect(mine!.body).toContain('112');
    expect(mine!.payload).toMatchObject({ level: 'critical', meta: { kind: 'dispatch', id: sos.body.data.requestId, status: 'NO_PROVIDER_AVAILABLE' } });
    const ops = await prisma.notification.findFirst({ where: { userId: admin.user.id, templateKey: 'admin.dispatch_attention' } });
    expect(ops).toMatchObject({ link: '/dispatch' });
    expect(ops!.payload).toMatchObject({ level: 'critical' });
  });
});
