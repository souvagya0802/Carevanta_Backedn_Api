import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

// Test files share one database and run one after another: put the defaults back so later files
// (bookings, reminders, notifications) still see bookings start as REQUESTED.
afterAll(async () => {
  await prisma.platformSetting.update({ where: { key: 'finance.settlement_hold_days' }, data: { value: 7 } });
  await prisma.platformSetting.update({ where: { key: 'booking.require_provider_confirmation' }, data: { value: true } });
  invalidateSetting();
});

const now = () => new Date().toISOString();
let slotWindow = 0;
const todayWindowFor = () => { const start = Date.now() + 60 * 60_000 + slotWindow++ * 45 * 60_000; return { startsAt: new Date(start), endsAt: new Date(start + 30 * 60_000) }; };

describe('manual finance operations (audited alternative to editing the database)', () => {
  let ctx: Awaited<ReturnType<typeof affiliatedDoctor>>;
  let slots: { id: string }[];
  let finance: Actor; // FINANCE_APPROVER holds finance.manual.record
  let officer: Actor; // FINANCE_OFFICER does not

  beforeAll(async () => {
    ctx = await affiliatedDoctor({ feeMinor: 60000 });
    const scheduler = await actor(['PLATFORM_ADMIN']);
    slots = (await slotsFor(scheduler, ctx.doctor.id, ctx.hospital.locationId, { capacity: 1, startMinute: 540, endMinute: 900 })).slots;
    finance = await actor(['FINANCE_APPROVER']);
    officer = await actor(['FINANCE_OFFICER']);
    const maker = await actor(['FINANCE_OFFICER']);
    const draft = await maker.post('/api/v1/admin/finance/commission-policies', { code: 'MANUAL_TEST_CONSULT', name: 'Consultation 10%', category: 'CONSULTATION', method: 'PERCENTAGE', rateBps: 1000, taxRateBps: 1800, effectiveFrom: new Date(Date.now() - 86_400_000).toISOString() });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect((await maker.post(`/api/v1/admin/finance/commission-policies/${draft.body.data.id}/submit`)).status).toBe(200);
    expect((await finance.post(`/api/v1/admin/finance/commission-policies/${draft.body.data.id}/activate`, { supersede: true })).status).toBe(200);
  });

  async function booking(slotId: string) {
    const p = await patient();
    const b = await p.post('/api/v1/patient/appointments', { slotId, patientProfileId: p.profileId }, idem());
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    return { patient: p, appointmentId: b.body.data.id as string, txnId: b.body.data.transaction.id as string };
  }
  async function complete(appointmentId: string, slotId: string) {
    await prisma.appointmentSlot.update({ where: { id: slotId }, data: todayWindowFor() });
    for (const action of ['CHECK_IN', 'COMPLETE']) {
      const res = await ctx.hospitalOwner.post(`/api/v1/portal/providers/${ctx.hospital.id}/appointments/${appointmentId}/actions`, { action });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
  }

  it('requires the dedicated permission', async () => {
    const { txnId } = await booking(slots[6]!.id);
    const res = await officer.post(`/api/v1/admin/finance/transactions/${txnId}/manual-payments`, { receivedBy: 'PLATFORM', amountMinor: 60000, method: 'BANK_TRANSFER', receivedAt: now(), note: 'NEFT received in platform account' });
    expect(res.status).toBe(403);
  });

  it('records a bank transfer to the platform: payment captured, transaction PAID, earning posted at completion, duplicate receipt rejected', async () => {
    const { txnId, appointmentId } = await booking(slots[0]!.id);
    const tooMuch = await finance.post(`/api/v1/admin/finance/transactions/${txnId}/manual-payments`, { receivedBy: 'PLATFORM', amountMinor: 70000, method: 'BANK_TRANSFER', receivedAt: now(), note: 'overpayment attempt' });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error.details).toMatchObject({ dueMinor: 60000 });
    expect((await finance.post(`/api/v1/admin/finance/transactions/${txnId}/manual-payments`, { receivedBy: 'PLATFORM', amountMinor: 60000, method: 'BANK_TRANSFER', receivedAt: new Date(Date.now() + 3_600_000).toISOString(), note: 'future date' })).status).toBe(400);

    const ref = `UTR${randomUUID().slice(0, 10).toUpperCase()}`;
    const ok = await finance.post(`/api/v1/admin/finance/transactions/${txnId}/manual-payments`, { receivedBy: 'PLATFORM', amountMinor: 60000, method: 'BANK_TRANSFER', reference: ref, receivedAt: now(), note: 'NEFT received in platform current account' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.status).toBe('PAID');
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: ok.body.data.paymentId } });
    expect(payment).toMatchObject({ gateway: 'MANUAL', status: 'CAPTURED', method: 'bank_transfer', gatewayPaymentId: `MANUAL:${ref}` });

    // the same receipt cannot be recorded twice (on another booking)
    const other = await booking(slots[1]!.id);
    const dup = await finance.post(`/api/v1/admin/finance/transactions/${other.txnId}/manual-payments`, { receivedBy: 'PLATFORM', amountMinor: 60000, method: 'BANK_TRANSFER', reference: ref, receivedAt: now(), note: 'duplicate receipt' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details).toMatchObject({ field: 'reference' });
    // nothing more is due
    expect((await finance.post(`/api/v1/admin/finance/transactions/${txnId}/manual-payments`, { receivedBy: 'PLATFORM', amountMinor: 1, method: 'CASH', receivedAt: now(), note: 'already paid' })).status).toBe(409);

    await complete(appointmentId, slots[0]!.id);
    const txn = await prisma.serviceTransaction.findUniqueOrThrow({ where: { id: txnId }, include: { ledgerEntries: true, commissions: true } });
    expect(txn.commissionEligible).toBe(true);
    const byType = Object.fromEntries(txn.ledgerEntries.map((e) => [e.entryType, e.amountMinor]));
    expect(byType).toEqual({ SERVICE_EARNING: 60000n, COMMISSION: -6000n, COMMISSION_TAX: -1080n });
    const audit = await prisma.auditEvent.findFirst({ where: { action: 'payment.recorded_manually', entityId: payment.id } });
    expect(audit?.metadata).toMatchObject({ method: 'BANK_TRANSFER', note: 'NEFT received in platform current account' });
  });

  it('records a counter payment at the provider: no payment row, PAY_AT_PROVIDER, provider owes commission after completion', async () => {
    const { txnId, appointmentId } = await booking(slots[2]!.id);
    const res = await finance.post(`/api/v1/admin/finance/transactions/${txnId}/manual-payments`, { receivedBy: 'PROVIDER', method: 'CASH', receivedAt: now(), note: 'Patient paid cash at the reception' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'PAY_AT_PROVIDER', paymentId: null });
    expect(await prisma.payment.count({ where: { transactionId: txnId } })).toBe(0);
    expect((await finance.post(`/api/v1/admin/finance/transactions/${txnId}/manual-payments`, { receivedBy: 'PROVIDER', method: 'CASH', receivedAt: now(), note: 'again' })).status).toBe(409);
    await complete(appointmentId, slots[2]!.id);
    const txn = await prisma.serviceTransaction.findUniqueOrThrow({ where: { id: txnId }, include: { ledgerEntries: true } });
    const byType = Object.fromEntries(txn.ledgerEntries.map((e) => [e.entryType, e.amountMinor]));
    expect(byType).toEqual({ COMMISSION: -6000n, COMMISSION_TAX: -1080n }); // no SERVICE_EARNING: the platform never held the money
    const balance = await finance.get(`/api/v1/admin/finance/providers/${ctx.hospital.id}/balance`);
    expect(balance.status).toBe(200);
  });

  it('earning is posted when a manual payment arrives after the service was completed', async () => {
    const { txnId, appointmentId } = await booking(slots[3]!.id);
    await complete(appointmentId, slots[3]!.id); // completed unpaid → PAY_AT_PROVIDER, commission owed
    let txn = await prisma.serviceTransaction.findUniqueOrThrow({ where: { id: txnId }, include: { ledgerEntries: true } });
    expect(txn.status).toBe('PAY_AT_PROVIDER');
    expect(txn.ledgerEntries.some((e) => e.entryType === 'SERVICE_EARNING')).toBe(false);
    const res = await finance.post(`/api/v1/admin/finance/transactions/${txnId}/manual-payments`, { receivedBy: 'PLATFORM', amountMinor: 60000, method: 'UPI', reference: `UPI${randomUUID().slice(0, 8)}`, receivedAt: now(), note: 'Patient paid the platform UPI id later' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.status).toBe('PAID');
    txn = await prisma.serviceTransaction.findUniqueOrThrow({ where: { id: txnId }, include: { ledgerEntries: true } });
    expect(txn.ledgerEntries.find((e) => e.entryType === 'SERVICE_EARNING')?.amountMinor).toBe(60000n);
  });

  it('manual refund: approval of a manual-payment refund stays APPROVED, recording it claws back and recalculates; requester cannot record it', async () => {
    const { txnId, appointmentId } = await booking(slots[4]!.id);
    expect((await finance.post(`/api/v1/admin/finance/transactions/${txnId}/manual-payments`, { receivedBy: 'PLATFORM', amountMinor: 60000, method: 'BANK_TRANSFER', receivedAt: now(), note: 'NEFT received' })).status).toBe(200);
    await complete(appointmentId, slots[4]!.id);
    const req = await officer.post('/api/v1/admin/finance/refunds', { transactionId: txnId, amountMinor: 20000, reason: 'Partial refund agreed with the patient' }, idem());
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    const refundId = req.body.data.id as string;

    // Approver reviews: no gateway to call, so it stays APPROVED awaiting manual completion.
    const approve = await finance.post(`/api/v1/admin/finance/refunds/${refundId}/review`, { decision: 'APPROVE', note: 'Approved; pay by bank transfer' });
    expect(approve.status, JSON.stringify(approve.body)).toBe(200);
    expect(approve.body.data.status).toBe('APPROVED');

    // The requester may not record the payment (separation of duties), even with the permission.
    const requesterWithPerm = await actor(['FINANCE_APPROVER']);
    const stolen = await prisma.refund.update({ where: { id: refundId }, data: { requestedById: requesterWithPerm.user.id } });
    expect(stolen.requestedById).toBe(requesterWithPerm.user.id);
    expect((await requesterWithPerm.post(`/api/v1/admin/finance/refunds/${refundId}/record-manual`, { method: 'BANK_TRANSFER', processedAt: now(), note: 'self record' })).status).toBe(403);
    await prisma.refund.update({ where: { id: refundId }, data: { requestedById: officer.user.id } });

    const rec = await finance.post(`/api/v1/admin/finance/refunds/${refundId}/record-manual`, { method: 'BANK_TRANSFER', reference: `RF${randomUUID().slice(0, 8)}`, processedAt: now(), note: 'Refunded to the patient’s bank account' });
    expect(rec.status, JSON.stringify(rec.body)).toBe(200);
    expect(rec.body.data.status).toBe('SUCCEEDED');
    const txn = await prisma.serviceTransaction.findUniqueOrThrow({ where: { id: txnId }, include: { ledgerEntries: true, commissions: true } });
    expect(txn.status).toBe('PARTIALLY_REFUNDED');
    expect(txn.refundedMinor).toBe(20000n);
    expect(txn.ledgerEntries.find((e) => e.entryType === 'REFUND_CLAWBACK')?.amountMinor).toBe(-20000n);
    expect(txn.commissions.filter((c) => c.status === 'FINAL')).toHaveLength(1);
    expect(txn.commissions.find((c) => c.status === 'FINAL')?.baseMinor).toBe(40000n);
    // cannot record twice
    expect((await finance.post(`/api/v1/admin/finance/refunds/${refundId}/record-manual`, { method: 'CASH', processedAt: now(), note: 'again' })).status).toBe(409);
  });

  it('ledger adjustments are append-only, capped, reasoned and audited; balance reflects them', async () => {
    const before = (await finance.get(`/api/v1/admin/finance/providers/${ctx.hospital.id}/balance`)).body.data.balanceMinor as number;
    expect((await finance.post(`/api/v1/admin/finance/providers/${ctx.hospital.id}/adjustments`, { amountMinor: 0, reason: 'Zero adjustment should fail' })).status).toBe(400);
    expect((await finance.post(`/api/v1/admin/finance/providers/${ctx.hospital.id}/adjustments`, { amountMinor: 5000, reason: 'short' })).status).toBe(400);
    expect((await finance.post(`/api/v1/admin/finance/providers/${ctx.hospital.id}/adjustments`, { amountMinor: 200_000_000, reason: 'Way over the per-entry cap' })).status).toBe(400);
    expect((await finance.post(`/api/v1/admin/finance/providers/${randomUUID()}/adjustments`, { amountMinor: 5000, reason: 'Unknown provider id' })).status).toBe(404);
    const credit = await finance.post(`/api/v1/admin/finance/providers/${ctx.hospital.id}/adjustments`, { amountMinor: 5000, reason: 'Goodwill credit for a delayed payout (ticket CAS-1)' });
    expect(credit.status, JSON.stringify(credit.body)).toBe(201);
    expect(credit.body.data.balanceMinor).toBe(before + 5000);
    const debit = await finance.post(`/api/v1/admin/finance/providers/${ctx.hospital.id}/adjustments`, { amountMinor: -1500, reason: 'Bank reversal fee recovered from the provider' });
    expect(debit.status).toBe(201);
    expect(debit.body.data.balanceMinor).toBe(before + 3500);
    const entries = await prisma.providerLedgerEntry.findMany({ where: { providerId: ctx.hospital.id, entryType: 'ADJUSTMENT' } });
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.createdById === finance.user.id)).toBe(true);
    expect(await prisma.auditEvent.count({ where: { action: 'ledger.adjustment_posted', entityId: ctx.hospital.id } })).toBe(2);
    expect((await officer.post(`/api/v1/admin/finance/providers/${ctx.hospital.id}/adjustments`, { amountMinor: 5000, reason: 'Officer should not be allowed' })).status).toBe(403);
  });

  it('abandoned online checkouts can be closed, then an offline payment recorded; only CREATED payments qualify', async () => {
    const { patient: p, txnId } = await booking(slots[5]!.id);
    const order = await p.post(`/api/v1/patient/transactions/${txnId}/payment-order`, {}, idem());
    expect(order.status).toBe(201);
    const blocked = await finance.post(`/api/v1/admin/finance/transactions/${txnId}/manual-payments`, { receivedBy: 'PLATFORM', amountMinor: 60000, method: 'CASH', receivedAt: now(), note: 'Cash while checkout open' });
    expect(blocked.status).toBe(409);
    const payment = await prisma.payment.findFirstOrThrow({ where: { transactionId: txnId } });
    expect((await finance.post(`/api/v1/admin/finance/payments/${payment.id}/mark-abandoned`, { reason: 'Patient closed the checkout page' })).status).toBe(200);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('FAILED');
    expect((await finance.post(`/api/v1/admin/finance/payments/${payment.id}/mark-abandoned`, { reason: 'Second attempt' })).status).toBe(409);
    const cash = await finance.post(`/api/v1/admin/finance/transactions/${txnId}/manual-payments`, { receivedBy: 'PLATFORM', amountMinor: 60000, method: 'CASH', receivedAt: now(), note: 'Cash deposited at the office' });
    expect(cash.status, JSON.stringify(cash.body)).toBe(200);
  });

  it('only FAILED webhooks can be replayed', async () => {
    const stored = await prisma.paymentWebhookEvent.create({ data: { gateway: 'TEST_GATEWAY', eventId: `evt_${randomUUID()}`, eventType: 'payment.captured', payloadSha256: 'x'.repeat(64), payload: { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_x', order_id: 'order_missing', amount: 1, currency: 'INR', status: 'captured' } } } }, processingStatus: 'FAILED', processingError: 'Unknown order' } });
    const replay = await finance.post(`/api/v1/admin/finance/webhook-events/${stored.id}/replay`);
    expect(replay.status).toBe(200);
    expect(replay.body.data.status).toBe('FAILED'); // still unknown order — stays FAILED with the error refreshed
    const processed = await prisma.paymentWebhookEvent.create({ data: { gateway: 'TEST_GATEWAY', eventId: `evt_${randomUUID()}`, eventType: 'payment.captured', payloadSha256: 'y'.repeat(64), payload: {}, processingStatus: 'PROCESSED' } });
    expect((await finance.post(`/api/v1/admin/finance/webhook-events/${processed.id}/replay`)).status).toBe(409);
    expect((await api().post(`/api/v1/admin/finance/webhook-events/${stored.id}/replay`)).status).toBe(401);
  });
});
