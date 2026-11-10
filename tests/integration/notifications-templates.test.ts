import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { resetDatabase } from '../helpers/db.js';
import { actor, createUser } from '../helpers/factory.js';
import { NOTIFICATION_CATALOGUE, enqueueNotification, htmlToText, isHtml, renderTemplate } from '../../src/modules/notifications/notifications.service.js';

beforeAll(resetDatabase);

const T = '/api/v1/admin/notification-templates';

async function drain(sa: Awaited<ReturnType<typeof actor>>) {
  const r = await sa.post('/api/v1/admin/notifications/deliver-now');
  expect(r.status).toBe(200);
}

describe('notification catalogue contract', () => {
  it('declares the booking / order / dispatch / support keys with their variables and channels', () => {
    const byKey = Object.fromEntries(NOTIFICATION_CATALOGUE.map((k) => [k.key, k]));
    expect(Object.keys(byKey['booking.reminder']!.variables)).toEqual(['patientName', 'reference', 'when', 'doctorName', 'locationName', 'hoursBefore']);
    expect(byKey['booking.reminder']!.channels).toEqual(['EMAIL', 'PUSH', 'IN_APP']);
    expect(Object.keys(byKey['booking.requested']!.variables)).toEqual(['patientName', 'reference', 'when', 'doctorName']);
    expect(Object.keys(byKey['booking.rescheduled']!.variables)).toEqual(['reference', 'when', 'doctorName']);
    expect(Object.keys(byKey['order.status_changed']!.variables)).toEqual(['reference', 'kind', 'status']);
    expect(Object.keys(byKey['dispatch.status_changed']!.variables)).toEqual(['reference', 'status']);
    expect(Object.keys(byKey['support.reply']!.variables)).toEqual(['caseReference']);
    for (const k of ['booking.requested', 'booking.rescheduled', 'order.status_changed', 'dispatch.status_changed', 'support.reply']) expect(byKey[k]!.channels).toEqual(['EMAIL', 'IN_APP']);
    // The older keys are still there.
    for (const k of ['auth.account_created', 'auth.password_reset', 'auth.verify_email', 'auth.verify_phone', 'booking.confirmed', 'booking.cancelled', 'provider.status_changed']) expect(byKey[k]).toBeDefined();
  });

  it('is fully covered by the seeded defaults (every key × channel has an active English template)', async () => {
    const sa = await actor(['SUPER_ADMIN']);
    const cat = await sa.get(`${T}/catalogue`);
    expect(cat.status).toBe(200);
    expect(cat.body.data.missing).toEqual([]);
    const active = await prisma.notificationTemplate.findMany({ where: { isActive: true, locale: 'en' } });
    for (const k of NOTIFICATION_CATALOGUE) for (const c of k.channels) expect(active.some((t) => t.key === k.key && t.channel === c), `${k.key}/${c}`).toBe(true);
    // Email defaults carry a subject and only use placeholders the code supplies.
    for (const t of active) {
      const info = NOTIFICATION_CATALOGUE.find((k) => k.key === t.key)!;
      if (t.channel === 'EMAIL') expect(t.subject, `${t.key} subject`).toBeTruthy();
      for (const m of `${t.subject ?? ''} ${t.body}`.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) expect(Object.keys(info.variables), `${t.key}/${t.channel} uses {{${m[1]}}}`).toContain(m[1]);
    }
  });
});

describe('template validation and preview', () => {
  it('refuses an unknown placeholder, naming it, on preview and on publish', async () => {
    const sa = await actor(['SUPER_ADMIN']);
    const preview = await sa.post(`${T}/preview`, { key: 'support.reply', channel: 'EMAIL', subject: 'Case {{caseReference}}', body: 'Hello {{customerName}}, see {{caseReference}}' });
    expect(preview.status).toBe(200);
    expect(preview.body.data.errors).toEqual([expect.stringContaining('{{customerName}}')]);
    const pub = await sa.post(T, { key: 'support.reply', channel: 'EMAIL', subject: 'Case {{caseReference}}', body: 'Hello {{customerName}}' });
    expect(pub.status).toBe(400);
    expect(pub.body.error.message).toContain('{{customerName}}');
    expect(pub.body.error.message).toContain('support.reply');
  });

  it('previews HTML email as HTML plus a plain-text alternative, and refuses HTML on SMS', async () => {
    const sa = await actor(['SUPER_ADMIN']);
    const html = await sa.post(`${T}/preview`, { key: 'support.reply', channel: 'EMAIL', subject: 'Case {{caseReference}}', body: '<h1>Support replied</h1><p>Case <strong>{{caseReference}}</strong> has a new reply.</p>' });
    expect(html.status).toBe(200);
    expect(html.body.data.errors).toEqual([]);
    expect(html.body.data.rendered.isHtml).toBe(true);
    expect(html.body.data.rendered.body).toContain('<strong>CASE-2026-0042</strong>');
    expect(html.body.data.rendered.text).toBe('Support replied\nCase CASE-2026-0042 has a new reply.');

    const plain = await sa.post(`${T}/preview`, { key: 'support.reply', channel: 'EMAIL', subject: 'Case {{caseReference}}', body: 'Case {{caseReference}} has a new reply.' });
    expect(plain.body.data.rendered.isHtml).toBe(false);
    expect(plain.body.data.rendered.text).toBe(plain.body.data.rendered.body);

    const sms = await sa.post(`${T}/preview`, { key: 'booking.confirmed', channel: 'SMS', body: '<b>{{reference}}</b> at {{when}}' });
    expect(sms.body.data.errors).toEqual([expect.stringContaining('plain text')]);
  });

  it('detects HTML and derives readable text', () => {
    expect(isHtml('Plain text with 2 < 3 and a > b')).toBe(false);
    expect(isHtml('<p>Hi</p>')).toBe(true);
    expect(htmlToText('<div style="x"><p>One &amp; two</p><br>Three<script>alert(1)</script></div>')).toBe('One & two\n\nThree');
    expect(htmlToText('<p>Code: <strong>123</strong></p><p>Bye</p>')).toBe('Code: 123\nBye');
  });
});

describe('template delivery', () => {
  it('skips (does not retry) a key whose template was deactivated, and delivers again once a version is active', async () => {
    const sa = await actor(['SUPER_ADMIN']);
    const active = await prisma.notificationTemplate.findFirstOrThrow({ where: { key: 'support.reply', channel: 'EMAIL', locale: 'en', isActive: true } });

    const off = await sa.post(`${T}/${active.id}/deactivate`, { reason: 'Wording under legal review' });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body.data.isActive).toBe(false);
    expect((await sa.post(`${T}/${active.id}/deactivate`)).status).toBe(409);
    expect((await sa.get(`${T}/catalogue`)).body.data.missing).toEqual([{ key: 'support.reply', channel: 'EMAIL', locale: 'en' }]);

    const n = await enqueueNotification(prisma, { channel: 'EMAIL', templateKey: 'support.reply', recipient: 'patient@test.carevanta.local', payload: { caseReference: 'CASE-1' } });
    await drain(sa);
    const skipped = await prisma.notification.findUniqueOrThrow({ where: { id: n.id } });
    expect(skipped.status).toBe('FAILED');
    expect(skipped.attempts).toBe(1); // not retried five times
    expect(skipped.lastError).toContain('inactive');
    expect(skipped.payload).toEqual({});

    const on = await sa.post(`${T}/${active.id}/activate`);
    expect(on.status).toBe(200);
    expect(on.body.data.isActive).toBe(true);
    expect((await sa.get(`${T}/catalogue`)).body.data.missing).toEqual([]);
    expect((await sa.post('/api/v1/admin/notifications/retry-failed', { templateKey: 'support.reply' })).body.data.requeued).toBe(1);
    // The payload was dropped with the skip, so the re-queued message renders with empty variables but is delivered.
    await drain(sa);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).status).toBe('SENT');

    // Activating one version switches the previously active one off (one active per key/channel/locale).
    const v2 = await sa.post(T, { key: 'support.reply', channel: 'EMAIL', subject: 'Case {{caseReference}}', body: 'New reply on {{caseReference}}.' });
    expect(v2.status).toBe(201);
    expect((await sa.post(`${T}/${active.id}/activate`)).status).toBe(200);
    expect((await prisma.notificationTemplate.findUniqueOrThrow({ where: { id: v2.body.data.id } })).isActive).toBe(false);
    expect((await prisma.notificationTemplate.count({ where: { key: 'support.reply', channel: 'EMAIL', locale: 'en', isActive: true } }))).toBe(1);
    expect((await sa.post(`${T}/no-such-id/activate`)).status).toBe(400);
    expect((await (await actor(['AUDITOR'])).post(`${T}/${active.id}/deactivate`)).status).toBe(403);
  });

  it('marks email as only logged when SMTP is not configured', async () => {
    const sa = await actor(['SUPER_ADMIN']);
    expect((await sa.get('/api/v1/admin/notifications/stats')).body.data.drivers.EMAIL).toBe('log');
    const n = await enqueueNotification(prisma, { channel: 'EMAIL', templateKey: 'support.reply', recipient: 'patient@test.carevanta.local', payload: { caseReference: 'CASE-2' } });
    await drain(sa);
    const row = await prisma.notification.findUniqueOrThrow({ where: { id: n.id } });
    expect(row.status).toBe('SENT');
    expect(row.attempts).toBe(1); // regression: one batch used to claim (and send) the same row five times
    expect(row.payload).toMatchObject({ driver: 'log', locale: 'en' });
    expect(row.lastError).toContain('SMTP is not configured');
    const listed = await sa.get('/api/v1/admin/notifications?templateKey=support.reply');
    expect(listed.body.data.find((x: { id: string }) => x.id === n.id).lastError).toContain('SMTP is not configured');
  });

  it('falls back to English when the recipient prefers a language with no template, and uses it once published', async () => {
    const sa = await actor(['SUPER_ADMIN']);
    const user = await createUser({ email: 'bn.patient@test.carevanta.local' });
    await prisma.user.update({ where: { id: user.id }, data: { preferredLanguage: 'bn' } });

    const first = await enqueueNotification(prisma, { userId: user.id, channel: 'EMAIL', templateKey: 'booking.rescheduled', recipient: user.email!, payload: { reference: 'APT-1', when: 'Mon', doctorName: 'Dr. A' } });
    await drain(sa);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: first.id } })).payload).toMatchObject({ driver: 'log', locale: 'en' });

    const bn = await sa.post(T, { key: 'booking.rescheduled', channel: 'EMAIL', locale: 'bn', subject: 'অ্যাপয়েন্টমেন্ট {{reference}}', body: 'নতুন সময় {{when}}, {{doctorName}}' });
    expect(bn.status, JSON.stringify(bn.body)).toBe(201);
    const second = await enqueueNotification(prisma, { userId: user.id, channel: 'EMAIL', templateKey: 'booking.rescheduled', recipient: user.email!, payload: { reference: 'APT-2', when: 'Tue', doctorName: 'Dr. B' } });
    await drain(sa);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: second.id } })).payload).toMatchObject({ locale: 'bn', templateVersion: 1 });
    // English stays the active fallback for everyone else.
    expect((await sa.get(`${T}/catalogue`)).body.data.missing).toEqual([]);
    expect(await renderTemplate(prisma, 'booking.rescheduled', 'EMAIL', { reference: 'X', when: 'Y', doctorName: 'Z' }, 'hi')).toMatchObject({ subject: 'Appointment X moved to Y' });
  });

  it('renders push / in-app rows queued without text from their templates and stores the result on the row', async () => {
    const sa = await actor(['SUPER_ADMIN']);
    const user = await createUser({ email: 'inapp.patient@test.carevanta.local' });
    const n = await enqueueNotification(prisma, { userId: user.id, channel: 'IN_APP', templateKey: 'booking.reminder', recipient: user.id, payload: { patientName: 'Riya', reference: 'APT-9', when: 'Sat 10:30', doctorName: 'Dr. M', locationName: 'Clinic', hoursBefore: '24' } });
    await drain(sa);
    const row = await prisma.notification.findUniqueOrThrow({ where: { id: n.id } });
    expect(row.status).toBe('SENT');
    expect(row.title).toBe('Appointment reminder');
    expect(row.body).toContain('APT-9');
    expect(row.body).toContain('Dr. M');
    expect(row.payload).toMatchObject({ driver: 'inapp' });
  });
});
