import { createHmac, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { invalidateSetting } from '../../src/modules/settings/settings.service.js';
import { resetDatabase } from '../helpers/db.js';
import { actor, api, idem, type Actor } from '../helpers/factory.js';
import { affiliatedDoctor, patient, slotsFor } from '../helpers/fixtures.js';

beforeAll(async () => {
  await resetDatabase();
  await prisma.platformSetting.update({ where: { key: 'finance.settlement_hold_days' }, data: { value: 0 } });
  await prisma.platformSetting.update({ where: { key: 'booking.require_provider_confirmation' }, data: { value: false } });
  invalidateSetting();
});

const SECRET = 'test-webhook-secret';
function webhook(body: object, eventId = `evt_${randomUUID()}`, secret = SECRET) {
  const raw = Buffer.from(JSON.stringify(body));
  const sig = createHmac('sha256', secret).update(raw).digest('hex');
  return api()
    .post('/api/v1/webhooks/test-gateway')
    .set('Content-Type', 'application/json')
    .set('X-Razorpay-Signature', sig)
    .set('X-Razorpay-Event-Id', eventId)
    // Send the exact signed bytes as a string (supertest would JSON-encode a Buffer).
    .send(raw.toString('utf8'));
}
const captured = (orderId: string, amount: number, paymentId = `pay_${randomUUID().slice(0, 12)}`) => ({
  event: 'payment.captured',
  payload: { payment: { entity: { id: paymentId, order_id: orderId, amount, currency: 'INR', status: 'captured', method: 'upi' } } },
});

async function activePolicy(maker: Actor, checker: Actor, body: Record<string, unknown>) {
  const created = await maker.post('/api/v1/admin/finance/commission-policies', body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect((await maker.post(`/api/v1/admin/finance/commission-policies/${created.body.data.id}/submit`)).status).toBe(200);
  const act = await checker.post(`/api/v1/admin/finance/commission-policies/${created.body.data.id}/activate`, { supersede: true });
  expect(act.status, JSON.stringify(act.body)).toBe(200);
  return act.body.data;
}

// Each slot pulled into "today" gets its own window so a doctor never overlaps.
let todayWindow = 0;
function todayWindowFor() {
  const start = Date.now() + 60 * 60_000 + todayWindow++ * 45 * 60_000;
  return { startsAt: new Date(start), endsAt: new Date(start + 30 * 60_000) };
}

/** Book, pay online through the (simulated) gateway, check in and complete. */
async function paidCompletedAppointment(ctx: Awaited<ReturnType<typeof affiliatedDoctor>>, slotId: string) {
  const p = await patient();
  const b = await p.post('/api/v1/patient/appointments', { slotId, patientProfileId: p.profileId }, idem());
  expect(b.status, JSON.stringify(b.body)).toBe(201);
  const txnId = b.body.data.transaction.id as string;
  const order = await p.post(`/api/v1/patient/transactions/${txnId}/payment-order`, {}, idem());
  expect(order.status, JSON.stringify(order.body)).toBe(201);
  expect(order.body.data.simulated).toBe(true);
  const hook = await webhook(captured(order.body.data.gatewayOrderId, order.body.data.amountMinor));
  expect(hook.status).toBe(200);
  // Move the slot into "today" so check-in/complete are permitted.
  await prisma.appointmentSlot.update({ where: { id: slotId }, data: todayWindowFor() });
  const owner = ctx.hospitalOwner;
  for (const action of ['CHECK_IN', 'COMPLETE']) {
    const res = await owner.post(`/api/v1/portal/providers/${ctx.hospital.id}/appointments/${b.body.data.id}/actions`, { action });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  return { patient: p, appointmentId: b.body.data.id as string, txnId, paymentOrderId: order.body.data.gatewayOrderId as string };
}

describe('commission policies', () => {
  it('maker-checker, overlap protection and legal gating for surgery', async () => {
    const maker = await actor(['FINANCE_OFFICER']);
    const checker = await actor(['FINANCE_APPROVER']);
    const legal = await actor(['LEGAL_REVIEWER']);
    const draft = await maker.post('/api/v1/admin/finance/commission-policies', {
      code: 'CONSULT_DEFAULT',
      name: 'Consultation default',
      category: 'CONSULTATION',
      method: 'PERCENTAGE',
      rateBps: 1000,
      taxRateBps: 1800,
      effectiveFrom: new Date(Date.now() - 86_400_000).toISOString(),
    });
    expect(draft.status).toBe(201);
    expect(draft.body.data.version).toBe(1);
    await maker.post(`/api/v1/admin/finance/commission-policies/${draft.body.data.id}/submit`);
    const self = await maker.post(`/api/v1/admin/finance/commission-policies/${draft.body.data.id}/activate`, {});
    expect(self.status).toBe(403); // makers lack the permission entirely
    expect((await checker.post(`/api/v1/admin/finance/commission-policies/${draft.body.data.id}/activate`, {})).status).toBe(200);

    // A second ACTIVE policy for the same scope and period is rejected by the DB.
    const overlap = await maker.post('/api/v1/admin/finance/commission-policies', {
      code: 'CONSULT_DEFAULT',
      name: 'Consultation default v2',
      category: 'CONSULTATION',
      method: 'PERCENTAGE',
      rateBps: 800,
      taxRateBps: 1800,
      effectiveFrom: new Date(Date.now() - 3600_000).toISOString(),
    });
    expect(overlap.body.data.version).toBe(2);
    await maker.post(`/api/v1/admin/finance/commission-policies/${overlap.body.data.id}/submit`);
    const clash = await checker.post(`/api/v1/admin/finance/commission-policies/${overlap.body.data.id}/activate`, { supersede: false });
    expect(clash.status).toBe(409);

    const surgery = await maker.post('/api/v1/admin/finance/commission-policies', {
      code: 'SURGERY_PILOT',
      name: 'Surgery coordination',
      category: 'SURGERY',
      method: 'FLAT',
      flatMinor: 200000,
      taxRateBps: 1800,
      effectiveFrom: new Date().toISOString(),
    });
    expect(surgery.body.data.highRisk).toBe(true);
    await maker.post(`/api/v1/admin/finance/commission-policies/${surgery.body.data.id}/submit`);
    const blocked = await checker.post(`/api/v1/admin/finance/commission-policies/${surgery.body.data.id}/activate`, {});
    expect(blocked.status).toBe(422);
    expect((await legal.post(`/api/v1/admin/finance/commission-policies/${surgery.body.data.id}/legal-review`, { status: 'APPROVED', note: 'Counsel opinion ref SYN-001' })).status).toBe(200);
    expect((await checker.post(`/api/v1/admin/finance/commission-policies/${surgery.body.data.id}/activate`, {})).status).toBe(200);
  });

  it('rejects invalid policy values', async () => {
    const maker = await actor(['FINANCE_OFFICER']);
    const res = await maker.post('/api/v1/admin/finance/commission-policies', {
      code: 'BAD_POLICY',
      name: 'Bad',
      category: 'DIAGNOSTIC',
      method: 'PERCENTAGE',
      rateBps: 20000,
      effectiveFrom: new Date().toISOString(),
    });
    expect(res.status).toBe(400);
    const noRate = await maker.post('/api/v1/admin/finance/commission-policies', { code: 'BAD_TWO', name: 'Bad two', category: 'DIAGNOSTIC', method: 'PERCENTAGE', effectiveFrom: new Date().toISOString() });
    expect(noRate.status).toBe(400);
  });
});

describe('payments, completion, commission and ledger', () => {
  let ctx: Awaited<ReturnType<typeof affiliatedDoctor>>;
  let slots: { id: string }[];
  let maker: Actor;
  let checker: Actor;

  beforeAll(async () => {
    ctx = await affiliatedDoctor({ feeMinor: 60000 });
    const scheduler = await actor(['PLATFORM_ADMIN']);
    slots = (await slotsFor(scheduler, ctx.doctor.id, ctx.hospital.locationId, { capacity: 1, startMinute: 540, endMinute: 900 })).slots;
    maker = await actor(['FINANCE_OFFICER']);
    checker = await actor(['FINANCE_APPROVER']);
    // Hospital-specific policy beats the category default created earlier.
    await activePolicy(maker, checker, {
      code: `HOSP_${ctx.hospital.id.slice(0, 8).toUpperCase()}`,
      name: 'Hospital agreement',
      category: 'CONSULTATION',
      providerId: ctx.hospital.id,
      method: 'PERCENTAGE',
      rateBps: 1000,
      taxRateBps: 1800,
      effectiveFrom: new Date(Date.now() - 86_400_000).toISOString(),
    });
  });

  it('a verified webhook captures the payment; the client cannot mark it paid', async () => {
    const p = await patient();
    const b = await p.post('/api/v1/patient/appointments', { slotId: slots[0]!.id, patientProfileId: p.profileId }, idem());
    const txnId = b.body.data.transaction.id;
    const order = await p.post(`/api/v1/patient/transactions/${txnId}/payment-order`, {}, idem());
    expect((await prisma.serviceTransaction.findUniqueOrThrow({ where: { id: txnId } })).status).toBe('PENDING_PAYMENT');

    const forged = await webhook(captured(order.body.data.gatewayOrderId, 60000), `evt_${randomUUID()}`, 'wrong-secret');
    expect(forged.status).toBe(401);
    expect((await prisma.serviceTransaction.findUniqueOrThrow({ where: { id: txnId } })).status).toBe('PENDING_PAYMENT');

    const mismatch = await webhook(captured(order.body.data.gatewayOrderId, 1));
    expect(mismatch.status).toBe(200);
    expect(mismatch.body.data.status).toBe('FAILED');
    expect(await prisma.reconciliationRecord.count({ where: { status: 'AMOUNT_MISMATCH' } })).toBeGreaterThan(0);

    const eventId = `evt_${randomUUID()}`;
    const ok = await webhook(captured(order.body.data.gatewayOrderId, 60000), eventId);
    expect(ok.body.data.status).toBe('PROCESSED');
    const dup = await webhook(captured(order.body.data.gatewayOrderId, 60000), eventId);
    expect(dup.body.data.duplicate).toBe(true);
    expect((await prisma.serviceTransaction.findUniqueOrThrow({ where: { id: txnId } })).status).toBe('PAID');
    expect(await prisma.payment.count({ where: { transactionId: txnId, status: 'CAPTURED' } })).toBe(1);
  });

  it('records a failed payment without changing the booking', async () => {
    const p = await patient();
    const b = await p.post('/api/v1/patient/appointments', { slotId: slots[1]!.id, patientProfileId: p.profileId }, idem());
    const order = await p.post(`/api/v1/patient/transactions/${b.body.data.transaction.id}/payment-order`, {}, idem());
    const res = await webhook({
      event: 'payment.failed',
      payload: { payment: { entity: { id: 'pay_failed1', order_id: order.body.data.gatewayOrderId, amount: 60000, currency: 'INR', status: 'failed', error_code: 'BAD_REQUEST_ERROR', error_description: 'Payment declined' } } },
    });
    expect(res.status).toBe(200);
    const payment = await prisma.payment.findFirstOrThrow({ where: { gatewayOrderId: order.body.data.gatewayOrderId } });
    expect(payment.status).toBe('FAILED');
    expect((await prisma.serviceTransaction.findUniqueOrThrow({ where: { id: b.body.data.transaction.id } })).status).toBe('PENDING_PAYMENT');
  });

  it('completion freezes a commission snapshot and posts ledger entries exactly once', async () => {
    const r = await paidCompletedAppointment(ctx, slots[2]!.id);
    const txn = await prisma.serviceTransaction.findUniqueOrThrow({ where: { id: r.txnId }, include: { commissions: true, ledgerEntries: true } });
    expect(txn.commissionEligible).toBe(true);
    expect(txn.commissions).toHaveLength(1);
    const snap = txn.commissions[0]!;
    expect(snap.commissionMinor).toBe(6000n); // 10% of ₹600
    expect(snap.taxMinor).toBe(1080n); // 18% of commission
    expect(snap.providerNetMinor).toBe(52920n);
    const byType = Object.fromEntries(txn.ledgerEntries.map((e) => [e.entryType, e.amountMinor]));
    expect(byType).toEqual({ SERVICE_EARNING: 60000n, COMMISSION: -6000n, COMMISSION_TAX: -1080n });
  });

  it('changing the policy later does not alter historical commission', async () => {
    const before = await prisma.commissionSnapshot.findMany({ where: { transaction: { providerId: ctx.hospital.id } } });
    await activePolicy(maker, checker, {
      code: `HOSP_${ctx.hospital.id.slice(0, 8).toUpperCase()}`,
      name: 'Hospital agreement (renegotiated)',
      category: 'CONSULTATION',
      providerId: ctx.hospital.id,
      method: 'PERCENTAGE',
      rateBps: 500,
      taxRateBps: 1800,
      effectiveFrom: new Date().toISOString(),
    });
    const after = await prisma.commissionSnapshot.findMany({ where: { id: { in: before.map((b) => b.id) } } });
    expect(after.map((a) => a.commissionMinor)).toEqual(before.map((b) => b.commissionMinor));
    await expect(prisma.commissionSnapshot.update({ where: { id: before[0]!.id }, data: { commissionMinor: 1n } })).rejects.toThrow();
  });

  it('walk-ins (provider-direct) are not commissionable by default', async () => {
    const walk = await ctx.hospitalOwner.post(
      `/api/v1/portal/providers/${ctx.hospital.id}/appointments/walk-in`,
      { slotId: slots[3]!.id, patientFullName: 'Walk In', patientPhone: '9800066666' },
      idem(),
    );
    expect(walk.status, JSON.stringify(walk.body)).toBe(201);
    await prisma.appointmentSlot.update({ where: { id: slots[3]!.id }, data: todayWindowFor() });
    for (const action of ['CHECK_IN', 'COMPLETE']) {
      await ctx.hospitalOwner.post(`/api/v1/portal/providers/${ctx.hospital.id}/appointments/${walk.body.data.id}/actions`, { action });
    }
    const txn = await prisma.serviceTransaction.findUniqueOrThrow({ where: { appointmentId: walk.body.data.id }, include: { commissions: true, ledgerEntries: true } });
    expect(txn.commissionEligible).toBe(false);
    expect(txn.commissions).toHaveLength(0);
    expect(txn.status).toBe('PAY_AT_PROVIDER');
    expect(txn.ledgerEntries).toHaveLength(0);
  });

  it('refund: maker-checker, gateway webhook, clawback and commission recalculated on the remaining base', async () => {
    const r = await paidCompletedAppointment(ctx, slots[4]!.id);
    const requester = await actor(['FINANCE_OFFICER']);
    const tooMuch = await requester.post('/api/v1/admin/finance/refunds', { transactionId: r.txnId, amountMinor: 70000, reason: 'Overcharge claim' }, idem());
    expect(tooMuch.status).toBe(409);
    const key = idem();
    const req1 = await requester.post('/api/v1/admin/finance/refunds', { transactionId: r.txnId, amountMinor: 20000, reason: 'Partial refund for delay' }, key);
    expect(req1.status, JSON.stringify(req1.body)).toBe(201);
    const replay = await requester.post('/api/v1/admin/finance/refunds', { transactionId: r.txnId, amountMinor: 20000, reason: 'Partial refund for delay' }, key);
    expect(replay.body.data.id).toBe(req1.body.data.id);

    const selfApprove = await actor(['SUPER_ADMIN']);
    const own = await selfApprove.post('/api/v1/admin/finance/refunds', { transactionId: r.txnId, amountMinor: 1000, reason: 'Self approval attempt' }, idem());
    expect((await selfApprove.post(`/api/v1/admin/finance/refunds/${own.body.data.id}/review`, { decision: 'APPROVE', note: 'self approve' })).status).toBe(403);
    await checker.post(`/api/v1/admin/finance/refunds/${own.body.data.id}/review`, { decision: 'REJECT', note: 'Not justified' });

    const approve = await checker.post(`/api/v1/admin/finance/refunds/${req1.body.data.id}/review`, { decision: 'APPROVE', note: 'Delay confirmed' });
    expect(approve.status).toBe(200);
    expect(approve.body.data.status).toBe('PROCESSING');
    const hook = await webhook({ event: 'refund.processed', payload: { refund: { entity: { id: approve.body.data.gatewayRefundId, payment_id: 'x', amount: 20000, status: 'processed' } } } });
    expect(hook.body.data.status).toBe('PROCESSED');

    const txn = await prisma.serviceTransaction.findUniqueOrThrow({ where: { id: r.txnId }, include: { commissions: { orderBy: { calculatedAt: 'asc' } }, ledgerEntries: true } });
    expect(txn.status).toBe('PARTIALLY_REFUNDED');
    expect(txn.refundedMinor).toBe(20000n);
    expect(txn.commissions.map((c) => c.status)).toEqual(['REVERSED', 'FINAL']);
    expect(txn.commissions[1]!.baseMinor).toBe(40000n);
    expect(txn.commissions[1]!.rateBps).toBe(txn.commissions[0]!.rateBps); // original terms, not the renegotiated rate
    const net = txn.ledgerEntries.reduce((s, e) => s + e.amountMinor, 0n);
    expect(net).toBe(txn.commissions[1]!.providerNetMinor);
  });
});

describe('settlements', () => {
  it('maker-checker batch, UTR evidence, no double settlement, failure and retry', async () => {
    const ctx = await affiliatedDoctor({ feeMinor: 80000 });
    const scheduler = await actor(['PLATFORM_ADMIN']);
    const { slots } = await slotsFor(scheduler, ctx.doctor.id, ctx.hospital.locationId, { capacity: 1, startMinute: 900, endMinute: 1020 });
    await paidCompletedAppointment(ctx, slots[0]!.id);

    const sa = await actor(['SUPER_ADMIN']);
    const approver = await actor(['FINANCE_APPROVER']);
    const officer = await actor(['FINANCE_OFFICER']);
    const acct = await sa.post(`/api/v1/admin/providers/${ctx.hospital.id}/payout-accounts`, { accountHolderName: 'Hospital', accountNumber: '998877665544', ifsc: 'SBIN0001234' });
    await ctx.verifier.post(`/api/v1/admin/providers/${ctx.hospital.id}/payout-accounts/${acct.body.data.id}/verify`, { method: 'PENNY_DROP' });

    const balance = await officer.get(`/api/v1/admin/finance/providers/${ctx.hospital.id}/balance`);
    expect(balance.body.data.unsettledMinor).toBeGreaterThan(0);

    const [b1, b2] = await Promise.all([
      officer.post('/api/v1/admin/finance/settlements', {}, idem()),
      officer.post('/api/v1/admin/finance/settlements', {}, idem()),
    ]);
    const created = [b1, b2].filter((r) => r.status === 201);
    expect(created.length).toBeGreaterThanOrEqual(1);
    const linked = await prisma.providerLedgerEntry.groupBy({ by: ['settlementItemId'], where: { providerId: ctx.hospital.id }, _count: true });
    // Every entry belongs to at most one item; no entry in two batches.
    const items = await prisma.settlementItem.findMany({ where: { providerId: ctx.hospital.id, status: { not: 'CANCELLED' } } });
    expect(items).toHaveLength(1);
    expect(linked.filter((l) => l.settlementItemId).length).toBe(1);

    const batchId = items[0]!.batchId;
    expect((await officer.post(`/api/v1/admin/finance/settlement-items/${items[0]!.id}/payout`, { payoutReference: 'UTR00000001', paidAt: new Date().toISOString() })).status).toBe(422); // not approved
    expect((await officer.post(`/api/v1/admin/finance/settlements/${batchId}/approve`)).status).toBe(403);
    expect((await approver.post(`/api/v1/admin/finance/settlements/${batchId}/approve`)).status).toBe(200);

    const fail = await officer.post(`/api/v1/admin/finance/settlement-items/${items[0]!.id}/failure`, { reason: 'Beneficiary bank rejected (synthetic)' });
    expect(fail.status).toBe(200);
    expect((await prisma.settlementBatch.findUniqueOrThrow({ where: { id: batchId } })).status).toBe('PARTIALLY_FAILED');

    // Retry: entries are back in the pool and go into a new batch.
    const retry = await officer.post('/api/v1/admin/finance/settlements', {}, idem());
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    const retryItem = retry.body.data.items.find((i: { providerId: string }) => i.providerId === ctx.hospital.id);
    await approver.post(`/api/v1/admin/finance/settlements/${retry.body.data.id}/approve`);
    const paid = await officer.post(`/api/v1/admin/finance/settlement-items/${retryItem.id}/payout`, { payoutReference: 'UTR00000002', paidAt: new Date().toISOString() });
    expect(paid.status).toBe(200);
    const again = await officer.post(`/api/v1/admin/finance/settlement-items/${retryItem.id}/payout`, { payoutReference: 'UTR00000003', paidAt: new Date().toISOString() });
    expect(again.status).toBe(409);

    const after = await officer.get(`/api/v1/admin/finance/providers/${ctx.hospital.id}/balance`);
    expect(after.body.data.balanceMinor).toBe(0);
    const nothing = await officer.post('/api/v1/admin/finance/settlements', {}, idem());
    expect(nothing.status).toBe(422);
  });
});

describe('reconciliation', () => {
  it('flags mismatches and missing records', async () => {
    const officer = await actor(['FINANCE_OFFICER']);
    const captured = await prisma.payment.findFirstOrThrow({ where: { status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED'] } } });
    const res = await officer.post('/api/v1/admin/finance/reconciliation/runs', {
      gateway: 'TEST_GATEWAY',
      from: new Date(Date.now() - 86_400_000).toISOString(),
      to: new Date(Date.now() + 60_000).toISOString(),
      lines: [
        { gatewayPaymentId: captured.gatewayPaymentId, gatewayOrderId: captured.gatewayOrderId, amountMinor: Number(captured.amountMinor), currency: 'INR', status: 'captured' },
        { gatewayPaymentId: 'pay_ghost', gatewayOrderId: 'order_ghost', amountMinor: 100, currency: 'INR', status: 'captured' },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.counts.MISSING_INTERNAL).toBe(1);
    expect(res.body.data.counts.MATCHED).toBe(1);
    expect(res.body.data.counts.MISSING_AT_GATEWAY).toBeGreaterThan(0);
  });
});
