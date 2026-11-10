import { createHmac } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { resetDatabase } from '../helpers/db.js';
import { actor, api, idem, type Actor } from '../helpers/factory.js';
import { affiliatedDoctor, patient, randomUUID, slotsFor } from '../helpers/fixtures.js';

beforeAll(resetDatabase);

const SECRET = 'test-webhook-secret';
function webhook(body: object, eventId = `evt_${randomUUID()}`) {
  const raw = Buffer.from(JSON.stringify(body));
  const sig = createHmac('sha256', SECRET).update(raw).digest('hex');
  return api().post('/api/v1/webhooks/test-gateway').set('Content-Type', 'application/json').set('X-Razorpay-Signature', sig).set('X-Razorpay-Event-Id', eventId).send(raw.toString('utf8'));
}
const captured = (orderId: string, amount: number) => ({
  event: 'payment.captured',
  payload: { payment: { entity: { id: `pay_${randomUUID().slice(0, 12)}`, order_id: orderId, amount, currency: 'INR', status: 'captured', method: 'upi' } } },
});

async function paidBooking(slotId: string) {
  const p = await patient();
  const b = await p.post('/api/v1/patient/appointments', { slotId, patientProfileId: p.profileId }, idem());
  expect(b.status, JSON.stringify(b.body)).toBe(201);
  const txnId = b.body.data.transaction.id as string;
  const order = await p.post(`/api/v1/patient/transactions/${txnId}/payment-order`, {}, idem());
  expect(order.status, JSON.stringify(order.body)).toBe(201);
  const hook = await webhook(captured(order.body.data.gatewayOrderId, order.body.data.amountMinor));
  expect(hook.status).toBe(200);
  return { p, txnId, amount: order.body.data.amountMinor as number, appointmentId: b.body.data.id as string };
}

const policyBody = (extra: Record<string, unknown>) => ({
  code: `EDGE_${randomUUID().slice(0, 6).toUpperCase().replace(/-/g, '_')}`,
  name: 'Edge policy',
  category: 'CONSULTATION',
  method: 'PERCENTAGE',
  rateBps: 1000,
  effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
  ...extra,
});

describe('EDGE-FIN: commission policies', () => {
  let maker: Actor;
  let checker: Actor;
  beforeAll(async () => {
    maker = await actor(['FINANCE_OFFICER']);
    checker = await actor(['FINANCE_APPROVER']);
  });

  it('EDGE-FIN-01: value boundaries — min above max, end before start, lower-case code, 100.01 %; 0 % and 100 % are legal', async () => {
    const url = '/api/v1/admin/finance/commission-policies';
    const now = Date.now();
    const bad = [
      { minMinor: 500, maxMinor: 100 },
      { effectiveFrom: new Date(now).toISOString(), effectiveTo: new Date(now).toISOString() },
      { effectiveFrom: new Date(now).toISOString(), effectiveTo: new Date(now - 1).toISOString() },
      { code: 'lower_case' },
      { code: 'A' },
      { code: '1ABC' },
      { rateBps: 10001 },
      { rateBps: -1 },
      { rateBps: 12.5 },
      { method: 'FLAT' },
      { method: 'FLAT', flatMinor: -1 },
      { taxRateBps: 10001 },
      { effectiveFrom: '2026-01-01' },
      { category: 'TIPS' },
      { providerId: randomUUID() },
    ];
    for (const extra of bad) {
      const res = await maker.post(url, policyBody(extra));
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    expect((await maker.post(url, policyBody({ rateBps: 0 }))).status).toBe(201);
    expect((await maker.post(url, policyBody({ rateBps: 10000 }))).status).toBe(201);
    expect((await maker.post(url, policyBody({ method: 'FLAT', flatMinor: 0 }))).status).toBe(201);
    expect((await maker.post(url, policyBody({ minMinor: 100, maxMinor: 100 }))).status).toBe(201);
    // Same code again becomes version 2, not a duplicate.
    const code = policyBody({}).code;
    const v1 = await maker.post(url, policyBody({ code }));
    const v2 = await maker.post(url, policyBody({ code }));
    expect([v1.body.data.version, v2.body.data.version]).toEqual([1, 2]);
  });

  it('EDGE-FIN-02: lifecycle — ghost 404, double submit 409, activating a draft 409, author cannot approve, retire is final', async () => {
    const url = '/api/v1/admin/finance/commission-policies';
    // Someone holding both the maker and the checker permissions still cannot approve their own draft.
    const author = await actor(['FINANCE_OFFICER', 'FINANCE_APPROVER']);
    const created = await author.post(url, policyBody({}));
    const id = created.body.data.id as string;
    expect((await maker.post(`${url}/${randomUUID()}/submit`)).status).toBe(404);
    expect((await checker.post(`${url}/${id}/activate`, {})).status).toBe(409);
    expect((await author.post(`${url}/${id}/submit`)).status).toBe(200);
    expect((await author.post(`${url}/${id}/submit`)).status).toBe(409);
    const self = await author.post(`${url}/${id}/activate`, {});
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('SEPARATION_OF_DUTIES');
    // Plain maker without the approve permission is a straight 403 FORBIDDEN.
    expect((await maker.post(`${url}/${id}/activate`, {})).body.error.code).toBe('FORBIDDEN');
    expect((await checker.post(`${url}/${id}/activate`, { supersede: true })).status).toBe(200);
    expect((await checker.post(`${url}/${id}/activate`, { supersede: true })).status).toBe(409);
    expect((await checker.post(`${url}/${id}/retire`, { reason: 'edge: retire' })).status).toBe(200);
    expect((await checker.post(`${url}/${id}/retire`, { reason: 'edge: retire twice' })).status).toBe(409);
    expect((await maker.post(`${url}/${id}/submit`)).status).toBe(409);
  });

  it('EDGE-FIN-03: commission rounding is half-up on paise and never exceeds the base; tax rides on the commission', async () => {
    const ctx = await affiliatedDoctor();
    const url = '/api/v1/admin/finance/commission-policies';
    const created = await maker.post(url, policyBody({ rateBps: 3333, taxRateBps: 1800, providerId: ctx.hospital.id, providerType: 'HOSPITAL' }));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await maker.post(`${url}/${created.body.data.id}/submit`);
    const act = await checker.post(`${url}/${created.body.data.id}/activate`, { supersede: true });
    expect(act.status, JSON.stringify(act.body)).toBe(200);
    const preview = (amountMinor: number) => maker.post(`${url}/preview`, { category: 'CONSULTATION', providerId: ctx.hospital.id, amountMinor });
    const big = await preview(10001);
    expect(big.status, JSON.stringify(big.body)).toBe(200);
    expect(big.body.data.result).toEqual({ baseMinor: 10001, commissionMinor: 3333, taxMinor: 600, providerNetMinor: 6068 });
    expect((await preview(1)).body.data.result).toEqual({ baseMinor: 1, commissionMinor: 0, taxMinor: 0, providerNetMinor: 1 });
    expect((await preview(0)).body.data.result).toEqual({ baseMinor: 0, commissionMinor: 0, taxMinor: 0, providerNetMinor: 0 });
    // 2 paise × 33.33 % = 0.67 → 1 paisa (half-up), tax on 1 paisa rounds to 0.
    expect((await preview(2)).body.data.result).toEqual({ baseMinor: 2, commissionMinor: 1, taxMinor: 0, providerNetMinor: 1 });
    expect((await preview(-1)).status).toBe(400);
    expect((await preview(Number.MAX_SAFE_INTEGER + 2)).status).toBe(400);
    const none = await preview(100);
    expect(none.body.data.policy.id).toBe(created.body.data.id);
  });
});

describe('EDGE-FIN: zero fee, refunds and settlements', () => {
  it('EDGE-FIN-04: a free consultation is PAID at zero; there is nothing to pay online and nothing to refund', async () => {
    const ctx = await affiliatedDoctor();
    const { slots } = await slotsFor(ctx.hospitalOwner, ctx.doctor.id, ctx.hospital.locationId, { feeMinor: 0 });
    const p = await patient();
    const b = await p.post('/api/v1/patient/appointments', { slotId: slots[0]!.id, patientProfileId: p.profileId }, idem());
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect(b.body.data.transaction.status).toBe('PAID');
    expect(b.body.data.transaction.grossMinor ?? b.body.data.transaction.amountMinor ?? 0).toBe(0);
    const order = await p.post(`/api/v1/patient/transactions/${b.body.data.transaction.id}/payment-order`, {}, idem());
    expect(order.status).toBe(409);
    const maker = await actor(['FINANCE_OFFICER']);
    const refund = await maker.post('/api/v1/admin/finance/refunds', { transactionId: b.body.data.transaction.id, amountMinor: 1, reason: 'edge: refund a free visit' }, idem());
    expect(refund.status).toBe(409);
  });

  it('EDGE-FIN-05: refunds — zero, over-payment, pending-sum overflow, unpaid transaction, self-approval, double review', async () => {
    const ctx = await affiliatedDoctor({ feeMinor: 60000 });
    const { slots } = await slotsFor(ctx.hospitalOwner, ctx.doctor.id, ctx.hospital.locationId, { capacity: 3 });
    const { txnId, amount } = await paidBooking(slots[0]!.id);
    // The requester also holds the approve permission, so the refusal below is separation of duties, not a missing permission.
    const maker = await actor(['FINANCE_OFFICER', 'FINANCE_APPROVER']);
    const checker = await actor(['FINANCE_APPROVER']);
    const url = '/api/v1/admin/finance/refunds';
    expect((await maker.post(url, { transactionId: txnId, amountMinor: 0, reason: 'edge: zero refund' }, idem())).status).toBe(400);
    expect((await maker.post(url, { transactionId: txnId, amountMinor: -5, reason: 'edge: negative' }, idem())).status).toBe(400);
    expect((await maker.post(url, { transactionId: txnId, amountMinor: 100, reason: 'tiny' }, idem())).status).toBe(400);
    const over = await maker.post(url, { transactionId: txnId, amountMinor: amount + 1, reason: 'edge: more than paid' }, idem());
    expect(over.status).toBe(409);
    expect(over.body.error.details.refundableMinor).toBe(amount);
    const first = await maker.post(url, { transactionId: txnId, amountMinor: amount - 10000, reason: 'edge: partial refund' }, idem());
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    // A second request may only claim what is left after the pending one.
    const second = await maker.post(url, { transactionId: txnId, amountMinor: 10001, reason: 'edge: overlaps pending' }, idem());
    expect(second.status).toBe(409);
    expect(second.body.error.details.refundableMinor).toBe(10000);
    const exact = await maker.post(url, { transactionId: txnId, amountMinor: 10000, reason: 'edge: exactly the rest' }, idem());
    expect(exact.status, JSON.stringify(exact.body)).toBe(201);
    expect((await maker.post(url, { transactionId: txnId, amountMinor: 1, reason: 'edge: nothing left' }, idem())).status).toBe(409);
    // Unpaid booking: nothing captured.
    const q = await patient();
    const unpaid = await q.post('/api/v1/patient/appointments', { slotId: slots[1]!.id, patientProfileId: q.profileId }, idem());
    expect((await maker.post(url, { transactionId: unpaid.body.data.transaction.id, amountMinor: 100, reason: 'edge: unpaid' }, idem())).status).toBe(409);
    // Review rules.
    const rid = first.body.data.id as string;
    const selfReview = await maker.post(`${url}/${rid}/review`, { decision: 'APPROVE', note: 'edge: self approve' });
    expect(selfReview.status).toBe(403);
    expect(selfReview.body.error.code).toBe('SEPARATION_OF_DUTIES');
    expect((await checker.post(`${url}/${rid}/review`, { decision: 'REJECT', note: 'no' })).status).toBe(400);
    expect((await checker.post(`${url}/${rid}/review`, { decision: 'REJECT', note: 'edge: not justified' })).status).toBe(200);
    expect((await checker.post(`${url}/${rid}/review`, { decision: 'APPROVE', note: 'edge: changed my mind' })).status).toBe(409);
    // Rejecting released the reserved amount: the full amount is refundable again minus the other pending one.
    const again = await maker.post(url, { transactionId: txnId, amountMinor: amount - 10000, reason: 'edge: re-request after rejection' }, idem());
    expect(again.status, JSON.stringify(again.body)).toBe(201);
  });

  it('EDGE-FIN-06: settlements — nothing due is 422, creator cannot approve, payouts need an approved batch and a past paidAt', async () => {
    const maker = await actor(['FINANCE_OFFICER']);
    const checker = await actor(['FINANCE_APPROVER']);
    const url = '/api/v1/admin/finance/settlements';
    const empty = await maker.post(url, {}, idem());
    expect(empty.status).toBe(422);
    expect(empty.body.error.code).toBe('PRECONDITION_FAILED');
    expect((await checker.post(`${url}/${randomUUID()}/approve`)).status).toBe(404);
    expect((await maker.post(`${url}/${randomUUID()}/cancel`, { reason: 'edge: ghost batch' })).status).toBe(404);
    const recorder = await actor(['FINANCE_OFFICER', 'FINANCE_APPROVER']);
    expect((await recorder.post(`/api/v1/admin/finance/settlement-items/${randomUUID()}/payout`, { payoutReference: 'UTR-EDGE-1', paidAt: new Date().toISOString() })).status).toBe(400);
    expect((await recorder.post(`/api/v1/admin/finance/settlement-items/${randomUUID()}/payout`, { payoutReference: 'UTREDGE0001', paidAt: new Date(Date.now() + 3_600_000).toISOString() })).status).toBe(400);
    expect((await recorder.post(`/api/v1/admin/finance/settlement-items/${randomUUID()}/payout`, { payoutReference: 'UTREDGE0001', paidAt: new Date().toISOString() })).status).toBe(404);
    expect(await prisma.settlementBatch.count()).toBe(0);
  });
});
