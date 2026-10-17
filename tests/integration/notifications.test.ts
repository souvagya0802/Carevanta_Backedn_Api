import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { resetDatabase } from '../helpers/db.js';
import { actor } from '../helpers/factory.js';
import { smsSegments } from '../../src/modules/notifications/notifications.service.js';

beforeAll(resetDatabase);

describe('notification outbox', () => {
  it('reports health, cancels queued items, bulk-retries failures and drains the queue on demand', async () => {
    const sa = await actor(['SUPER_ADMIN']);
    // Creating users with an invite queues an EMAIL (template exists) and an SMS (template now seeded too).
    const a = await sa.post('/api/v1/admin/users', { fullName: 'Outbox Email', email: 'outbox.email@test.carevanta.local' });
    const b = await sa.post('/api/v1/admin/users', { fullName: 'Outbox Sms', phone: '9800077777' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const queued = await prisma.notification.findMany({ where: { userId: { in: [a.body.data.id, b.body.data.id] } } });
    expect(queued.map((n) => n.channel).sort()).toEqual(['EMAIL', 'SMS']);

    const stats = await sa.get('/api/v1/admin/notifications/stats');
    expect(stats.status).toBe(200);
    expect(stats.body.data.byStatus.QUEUED).toBeGreaterThanOrEqual(2);
    expect(stats.body.data.drivers).toMatchObject({ SMS: 'log', EMAIL: 'log' }); // no SMTP in tests
    expect(stats.body.data.processing).toBe('inline');
    expect(typeof stats.body.data.oldestQueuedAt).toBe('string');

    // Cancel the SMS: the payload (one-time code) is dropped with it.
    const sms = queued.find((n) => n.channel === 'SMS')!;
    const cancel = await sa.post(`/api/v1/admin/notifications/${sms.id}/cancel`, { reason: 'Wrong number entered' });
    expect(cancel.status).toBe(200);
    const cancelled = await prisma.notification.findUniqueOrThrow({ where: { id: sms.id } });
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.payload).toEqual({});
    expect((await sa.post(`/api/v1/admin/notifications/${sms.id}/cancel`, { reason: 'Twice' })).status).toBe(409);

    // Filters: by template key and by user.
    const byKey = await sa.get(`/api/v1/admin/notifications?templateKey=auth.account_created&userId=${a.body.data.id}`);
    expect(byKey.status).toBe(200);
    expect(byKey.body.data).toHaveLength(1);
    expect(byKey.body.data[0].recipient).toBe('ou***@test.carevanta.local');
    expect(JSON.stringify(byKey.body)).not.toContain('"payload"');

    // Deliver now drains the queue through the log driver.
    const drain = await sa.post('/api/v1/admin/notifications/deliver-now');
    expect(drain.status).toBe(200);
    expect(drain.body.data.sent).toBeGreaterThanOrEqual(1);
    expect(drain.body.data.remaining).toBe(0);

    // A notification whose template is missing fails; bulk retry re-queues it.
    const orphan = await prisma.notification.create({ data: { channel: 'PUSH', templateKey: 'no.such_template', recipient: 'device-token', payload: {} } });
    await sa.post('/api/v1/admin/notifications/deliver-now');
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: orphan.id } })).lastError).toContain('No active template');
    await prisma.notification.update({ where: { id: orphan.id }, data: { status: 'FAILED' } });
    const bulk = await sa.post('/api/v1/admin/notifications/retry-failed', { templateKey: 'no.such_template' });
    expect(bulk.status).toBe(200);
    expect(bulk.body.data.requeued).toBe(1);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: orphan.id } })).status).toBe('QUEUED');
    await prisma.notification.delete({ where: { id: orphan.id } });

    // Read-only roles cannot drain, cancel or retry.
    const auditor = await actor(['AUDITOR']);
    expect((await auditor.post('/api/v1/admin/notifications/deliver-now')).status).toBe(403);
  });
});

describe('notification templates', () => {
  it('lists the catalogue with nothing missing after seeding, previews drafts, and refuses broken templates', async () => {
    const sa = await actor(['SUPER_ADMIN']);
    const cat = await sa.get('/api/v1/admin/notification-templates/catalogue');
    expect(cat.status).toBe(200);
    expect(cat.body.data.missing).toEqual([]);
    expect(cat.body.data.keys.map((k: { key: string }) => k.key)).toContain('booking.confirmed');

    const preview = await sa.post('/api/v1/admin/notification-templates/preview', { key: 'booking.confirmed', channel: 'SMS', body: 'Appt {{reference}} at {{when}} — {{oops}}' });
    expect(preview.status).toBe(200);
    expect(preview.body.data.errors[0]).toContain('{{oops}}');
    expect(preview.body.data.rendered.body).toContain('APT-7K3M9Q');
    expect(preview.body.data.sms.segments).toBe(1);

    // Publish refuses the same problems, and an email without a subject.
    expect((await sa.post('/api/v1/admin/notification-templates', { key: 'booking.confirmed', channel: 'SMS', body: 'Hi {{oops}}' })).status).toBe(400);
    expect((await sa.post('/api/v1/admin/notification-templates', { key: 'auth.verify_email', channel: 'EMAIL', body: 'Code {{token}}' })).status).toBe(400);

    // A valid publish bumps the version and deactivates the previous one.
    const before = await prisma.notificationTemplate.findFirstOrThrow({ where: { key: 'booking.confirmed', channel: 'SMS', locale: 'en', isActive: true } });
    const pub = await sa.post('/api/v1/admin/notification-templates', { key: 'booking.confirmed', channel: 'SMS', body: 'Carevanta: {{reference}} confirmed for {{when}}. Reply STOP to opt out.' });
    expect(pub.status, JSON.stringify(pub.body)).toBe(201);
    expect(pub.body.data.version).toBe(before.version + 1);
    expect((await prisma.notificationTemplate.findUniqueOrThrow({ where: { id: before.id } })).isActive).toBe(false);
    expect((await sa.get('/api/v1/admin/notification-templates/catalogue')).body.data.missing).toEqual([]);

    // Test-send needs SMTP, which tests do not configure.
    expect((await sa.post('/api/v1/admin/notification-templates/test-send', { key: 'auth.verify_email', to: 'someone@test.carevanta.local' })).status).toBe(400);
  });

  it('counts SMS segments by encoding', () => {
    expect(smsSegments('Short message')).toEqual({ encoding: 'GSM-7', length: 13, segments: 1 });
    expect(smsSegments('x'.repeat(161)).segments).toBe(2);
    expect(smsSegments('আপনার অ্যাপয়েন্টমেন্ট নিশ্চিত হয়েছে').encoding).toBe('UCS-2');
    expect(smsSegments('ক'.repeat(71)).segments).toBe(2);
  });
});
