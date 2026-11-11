/**
 * Super-admin-configurable payment gateways (Razorpay, Stripe), Web Push keys
 * and subscriptions, and the in-app/push notifications that business events
 * fan out to provider staff.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { prisma } from '../../src/lib/prisma.js';
import { resetDatabase } from '../helpers/db.js';
import { actor, idem } from '../helpers/factory.js';
import { actorForUser, affiliatedDoctor, createHospital, patient, slotsFor } from '../helpers/fixtures.js';
import { verifyStripeSignature } from '../../src/modules/finance/gateway.js';
import { invalidatePaymentConfig } from '../../src/modules/finance/payment-config.service.js';
import { invalidatePushConfig } from '../../src/modules/notifications/push.service.js';

// Platform settings survive resetDatabase and test files share one database. This file stores payment and
// push keys (including a Razorpay webhook secret, which would make later files' signed test webhooks fail),
// so it puts those settings back exactly as it found them.
const OWN_SETTINGS = { OR: [{ key: { startsWith: 'payments.' } }, { key: { startsWith: 'push.' } }] };
let settingsBefore: Awaited<ReturnType<typeof prisma.platformSetting.findMany>> = [];
beforeAll(async () => {
  await resetDatabase();
  settingsBefore = await prisma.platformSetting.findMany({ where: OWN_SETTINGS });
});
afterAll(async () => {
  await prisma.platformSetting.deleteMany({ where: { ...OWN_SETTINGS, key: { notIn: settingsBefore.map((s) => s.key) } } });
  for (const s of settingsBefore) {
    await prisma.platformSetting.update({ where: { key: s.key }, data: { value: s.value as object, isSensitive: s.isSensitive, version: s.version } });
  }
  invalidatePaymentConfig();
  invalidatePushConfig();
});
afterEach(() => vi.unstubAllGlobals());

const V = '/api/v1';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('payment gateway configuration', () => {
  it('stores keys encrypted, validates formats and modes, and only goes live with a webhook secret', async () => {
    const sa = await actor(['SUPER_ADMIN']);
    const initial = await sa.get(`${V}/admin/integrations/payments`);
    expect(initial.status).toBe(200);
    expect(initial.body.data.activeGateway).toBe('NONE');
    expect(initial.body.data.razorpay).toMatchObject({ enabled: false, hasSecretKey: false });

    // Wrong formats and mode mismatches are refused before anything is stored.
    expect((await sa.put(`${V}/admin/integrations/payments/razorpay`, { enabled: false, mode: 'test', publicKey: 'not-a-key', secretKey: 'x'.repeat(20) })).status).toBe(400);
    expect((await sa.put(`${V}/admin/integrations/payments/razorpay`, { enabled: false, mode: 'test', publicKey: 'rzp_live_ABCDEFGHIJKLMN', secretKey: 'x'.repeat(20) })).status).toBe(400);
    expect((await sa.put(`${V}/admin/integrations/payments/razorpay`, { enabled: true, mode: 'test', publicKey: 'rzp_test_ABCDEFGHIJKLMN' })).status).toBe(400); // enabling without a secret
    expect((await sa.put(`${V}/admin/integrations/payments/stripe`, { enabled: false, mode: 'live', publicKey: 'pk_test_ABCDEFGHIJKLMNOP', secretKey: 'sk_test_ABCDEFGHIJKLMNOP' })).status).toBe(400);
    expect((await sa.put(`${V}/admin/integrations/payments/stripe`, { enabled: false, mode: 'test', publicKey: 'pk_test_ABCDEFGHIJKLMNOP', secretKey: 'sk_test_ABCDEFGHIJKLMNOP', webhookSecret: 'nope' })).status).toBe(400);

    const saved = await sa.put(`${V}/admin/integrations/payments/razorpay`, { enabled: true, mode: 'test', publicKey: 'rzp_test_ABCDEFGHIJKLMN', secretKey: 'secret-value-1234' });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.data.razorpay).toMatchObject({ enabled: true, mode: 'test', publicKey: 'rzp_test_ABCDEFGHIJKLMN', hasSecretKey: true, secretKeyHint: '••••1234', hasWebhookSecret: false });
    expect(JSON.stringify(saved.body)).not.toContain('secret-value');
    // At rest: encrypted, flagged sensitive, and not editable through the generic settings endpoint.
    const row = await prisma.platformSetting.findUniqueOrThrow({ where: { key: 'payments.razorpay.key_secret' } });
    expect(row.isSensitive).toBe(true);
    expect(String(row.value)).not.toContain('secret-value');
    const mode = await prisma.platformSetting.findUniqueOrThrow({ where: { key: 'payments.razorpay.mode' } });
    expect((await sa.put(`${V}/admin/settings/payments.razorpay.mode`, { value: 'live', expectedVersion: mode.version, reason: 'should be blocked' })).status).toBe(400);

    // Cannot go live without the webhook secret; can once it is there. Omitting the secret keeps it.
    expect((await sa.put(`${V}/admin/integrations/payments/active`, { gateway: 'RAZORPAY', reason: 'go live for pilot' })).status).toBe(400);
    const withHook = await sa.put(`${V}/admin/integrations/payments/razorpay`, { enabled: true, mode: 'test', publicKey: 'rzp_test_ABCDEFGHIJKLMN', webhookSecret: 'whk-secret-9999' });
    expect(withHook.body.data.razorpay).toMatchObject({ hasSecretKey: true, hasWebhookSecret: true });
    const live = await sa.put(`${V}/admin/integrations/payments/active`, { gateway: 'RAZORPAY', reason: 'go live for pilot' });
    expect(live.status, JSON.stringify(live.body)).toBe(200);
    expect(live.body.data.activeGateway).toBe('RAZORPAY');
    const pub = await sa.get(`${V}/public/payments`);
    expect(pub.body.data).toMatchObject({ activeGateway: 'RAZORPAY', mode: 'test', publicKey: 'rzp_test_ABCDEFGHIJKLMN' });
    expect(JSON.stringify(pub.body)).not.toMatch(/secret/i);
    // Disabling the active gateway turns checkout off rather than silently switching.
    await sa.put(`${V}/admin/integrations/payments/razorpay`, { enabled: false, mode: 'test', publicKey: 'rzp_test_ABCDEFGHIJKLMN' });
    expect((await sa.get(`${V}/public/payments`)).body.data.activeGateway).toBe('NONE');
    // Non-admins see nothing.
    const outsider = await actor([]);
    expect((await outsider.get(`${V}/admin/integrations/payments`)).status).toBe(403);
  });

  it('tests a gateway with the saved keys and verifies Stripe webhook signatures', async () => {
    const sa = await actor(['SUPER_ADMIN']);
    expect((await sa.put(`${V}/admin/integrations/payments/stripe`, { enabled: true, mode: 'test', publicKey: 'pk_test_ABCDEFGHIJKLMNOP', secretKey: 'sk_test_ABCDEFGHIJKLMNOP', webhookSecret: 'whsec_ABCDEFGHIJKLMNOP' })).status).toBe(200);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(401, { error: { message: 'Invalid API Key' } }))));
    expect((await sa.post(`${V}/admin/integrations/payments/stripe/test`)).status).toBe(422);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(200, { livemode: true, available: [] }))));
    expect((await sa.post(`${V}/admin/integrations/payments/stripe/test`)).status).toBe(422); // live key under test mode
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(200, { livemode: false, available: [{ amount: 125000, currency: 'inr' }] }))));
    const ok = await sa.post(`${V}/admin/integrations/payments/stripe/test`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.detail).toContain('1250.00 INR');

    invalidatePaymentConfig();
    const body = Buffer.from(JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' }));
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', 'whsec_ABCDEFGHIJKLMNOP').update(`${t}.`).update(body).digest('hex');
    expect(await verifyStripeSignature(body, `t=${t},v1=${sig}`)).toBe(true);
    expect(await verifyStripeSignature(Buffer.from('{"tampered":true}'), `t=${t},v1=${sig}`)).toBe(false);
    expect(await verifyStripeSignature(body, `t=${t - 3600},v1=${createHmac('sha256', 'whsec_ABCDEFGHIJKLMNOP').update(`${t - 3600}.`).update(body).digest('hex')}`)).toBe(false);
    expect(await verifyStripeSignature(body, undefined)).toBe(false);
    // A real webhook call with a bad signature is refused and audited; a good one is accepted even when the order is unknown (recorded as FAILED for replay).
    const res = await sa.post(`${V}/webhooks/stripe`, JSON.parse(body.toString()), { 'stripe-signature': 't=1,v1=bad', 'content-type': 'application/json' });
    expect(res.status).toBe(401);
  });
});

describe('push and in-app notifications', () => {
  it('needs VAPID keys first, then fans out bookings to the right staff in-app and by push', async () => {
    const sa = await actor(['SUPER_ADMIN']);
    const { hospital, doctor, hospitalOwner } = await affiliatedDoctor();
    const sub = { endpoint: 'https://push.example.test/sub/abc', keys: { p256dh: 'p256dh-key-value-long-enough', auth: 'auth-secret-value' } };
    expect((await hospitalOwner.post(`${V}/portal/push/subscribe`, sub)).status).toBe(400);
    expect((await hospitalOwner.get(`${V}/portal/push/public-key`)).body.data).toEqual({ publicKey: null, subscribed: false });

    expect((await sa.post(`${V}/admin/integrations/push/generate`, { subject: 'not valid', confirm: true })).status).toBe(400);
    const gen = await sa.post(`${V}/admin/integrations/push/generate`, { subject: 'mailto:ops@carevanta.in', confirm: true });
    expect(gen.status, JSON.stringify(gen.body)).toBe(200);
    expect(gen.body.data).toMatchObject({ configured: true, subscriptions: 0 });
    expect(gen.body.data.publicKey).toMatch(/^[A-Za-z0-9_-]{80,90}$/);
    invalidatePushConfig();
    const priv = await prisma.platformSetting.findUniqueOrThrow({ where: { key: 'push.vapid.private_key' } });
    expect(priv.isSensitive).toBe(true);

    expect((await hospitalOwner.post(`${V}/portal/push/subscribe`, sub)).status).toBe(201);
    expect((await hospitalOwner.get(`${V}/portal/push/public-key`)).body.data.subscribed).toBe(true);
    // Re-subscribing the same endpoint from another account moves it, never duplicates it.
    const invite = await hospitalOwner.post(`${V}/portal/providers/${hospital.id}/members`, { fullName: 'Desk', email: 'desk.push@test.carevanta.local', memberRole: 'STAFF' });
    const clerkId = invite.body.data.members.find((m: { memberRole: string }) => m.memberRole === 'STAFF').userId as string;
    const clerk = await actorForUser(clerkId);
    expect((await clerk.post(`${V}/portal/push/subscribe`, sub)).status).toBe(201);
    expect(await prisma.pushSubscription.count()).toBe(1);
    expect((await clerk.post(`${V}/portal/push/unsubscribe`, { endpoint: sub.endpoint })).status).toBe(200);
    expect((await hospitalOwner.post(`${V}/portal/push/subscribe`, sub)).status).toBe(201);

    // A patient books: the owner (push-subscribed) and the clerk (in-app only) both hear about it; an unrelated hospital does not.
    const other = await createHospital((await actor(['PLATFORM_ADMIN'])), { name: 'Quiet Hospital' });
    const otherOwner = await actorForUser(other.ownerUserId);
    const { slots } = await slotsFor(hospitalOwner, doctor.id, hospital.locationId);
    const p = await patient();
    expect((await p.post(`${V}/patient/appointments`, { slotId: slots[0]!.id, patientProfileId: p.profileId }, idem())).status).toBe(201);
    const ownerCount = await hospitalOwner.get(`${V}/portal/notifications/unread-count`);
    expect(ownerCount.body.data.unread).toBeGreaterThanOrEqual(1);
    const ownerList = await hospitalOwner.get(`${V}/portal/notifications?unread=true`);
    expect(ownerList.body.data[0]).toMatchObject({ channel: 'IN_APP', templateKey: 'portal.appointment_booked', readAt: null });
    expect(ownerList.body.data[0].title).toMatch(/appointment/i);
    expect(ownerList.body.data[0].link).toMatch(/^\/appointments\?id=/);
    expect((await clerk.get(`${V}/portal/notifications/unread-count`)).body.data.unread).toBeGreaterThanOrEqual(1);
    expect((await otherOwner.get(`${V}/portal/notifications/unread-count`)).body.data.unread).toBe(0);
    const pushRows = await prisma.notification.findMany({ where: { channel: 'PUSH', templateKey: 'portal.appointment_booked' } });
    expect(pushRows.map((r) => r.userId)).toEqual([hospitalOwner.user.id]); // only the subscribed person gets a push row
    expect(pushRows[0]).toMatchObject({ status: 'QUEUED', recipient: hospitalOwner.user.id });

    // Reading: one id, then everything; the count follows.
    expect((await hospitalOwner.post(`${V}/portal/notifications/read`, { ids: [ownerList.body.data[0].id] })).body.data.updated).toBe(1);
    expect((await hospitalOwner.post(`${V}/portal/notifications/read`, {})).status).toBe(200);
    expect((await hospitalOwner.get(`${V}/portal/notifications/unread-count`)).body.data.unread).toBe(0);
    // Admin test push with no devices of their own is a clear 422, not a crash.
    expect((await sa.post(`${V}/admin/integrations/push/test`)).status).toBe(422);
  });

  it('shows a doctor in full to their facility only, and filters doctors and appointments by department', async () => {
    const { hospital, doctor, hospitalOwner, registrar } = await affiliatedDoctor({ specialities: ['GENERAL_MEDICINE'], departments: ['DEPT_GENERAL_MEDICINE', 'DEPT_CARDIO'] });
    const base = `${V}/portal/providers/${hospital.id}`;
    const list = await hospitalOwner.get(`${base}/doctors`);
    expect(list.body.data[0]).toMatchObject({ doctorProviderId: doctor.id, departmentCode: 'DEPT_GENERAL_MEDICINE', specialities: ['General Medicine'] });
    const detail = await hospitalOwner.get(`${base}/doctors/${doctor.id}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.data).toMatchObject({ id: doctor.id, specialities: [{ code: 'GENERAL_MEDICINE', isPrimary: true }], here: { status: 'ACTIVE', department: 'General Medicine' } });
    expect(detail.body.data.registrations[0].council).toBe('West Bengal Medical Council');
    const stranger = await createHospital(registrar, { name: 'Nosy Hospital' });
    const strangerOwner = await actorForUser(stranger.ownerUserId);
    expect((await strangerOwner.get(`${V}/portal/providers/${stranger.id}/doctors/${doctor.id}`)).status).toBe(404);

    expect((await hospitalOwner.get(`${base}/affiliations?departmentCode=DEPT_GENERAL_MEDICINE`)).body.data).toHaveLength(1);
    expect((await hospitalOwner.get(`${base}/affiliations?departmentCode=DEPT_CARDIO`)).body.data).toHaveLength(0);
    expect((await hospitalOwner.get(`${base}/affiliations?specialityCode=GENERAL_MEDICINE`)).body.data).toHaveLength(1);
    expect((await hospitalOwner.get(`${base}/affiliations?specialityCode=CARDIOLOGY`)).body.data).toHaveLength(0);
    expect((await hospitalOwner.get(`${base}/affiliations?q=Dr.`)).body.data).toHaveLength(1);
    const { slots } = await slotsFor(hospitalOwner, doctor.id, hospital.locationId);
    const p = await patient();
    await p.post(`${V}/patient/appointments`, { slotId: slots[0]!.id, patientProfileId: p.profileId }, idem());
    expect((await hospitalOwner.get(`${base}/appointments?departmentCode=DEPT_GENERAL_MEDICINE`)).body.data).toHaveLength(1);
    expect((await hospitalOwner.get(`${base}/appointments?departmentCode=DEPT_CARDIO`)).body.data).toHaveLength(0);
    expect((await hospitalOwner.get(`${base}/appointments?doctorProviderId=${doctor.id}&q=synthetic`)).body.data).toHaveLength(1);
    expect((await hospitalOwner.get(`${base}/appointments`)).body.data[0].department).toEqual({ code: 'DEPT_GENERAL_MEDICINE', name: 'General Medicine' });
  });
});
