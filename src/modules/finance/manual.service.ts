import { randomUUID } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, isPgError, notFound, separationOfDuties } from '../../lib/errors.js';
import { onRefundSucceeded, post } from './commission.service.js';
import type { AuthContext } from '../../middleware/auth.js';

/**
 * Manual finance operations. Everything that normally arrives automatically
 * (gateway captures, gateway refunds, ledger postings) can also be recorded by
 * an authorised finance user — without touching the database by hand.
 *
 * Principles: nothing is edited in place; every operation appends (a payment
 * row, a refund state, a ledger entry) with the actor, a reason and an audit
 * event; maker–checker still applies to refunds; amounts are validated against
 * what is actually due or refundable.
 */

export const MANUAL_METHODS = ['BANK_TRANSFER', 'UPI', 'CASH', 'CARD_POS', 'CHEQUE', 'OTHER'] as const;
export type ManualMethod = (typeof MANUAL_METHODS)[number];

const capturedOf = (payments: { status: string; amountMinor: bigint }[]) => payments.filter((p) => p.status === 'CAPTURED' || p.status === 'PARTIALLY_REFUNDED').reduce((s, p) => s + p.amountMinor, 0n);

/**
 * Record money received for a transaction outside the gateway.
 *  - receivedBy PLATFORM: the platform's account got the money → a MANUAL payment is
 *    captured; when the full amount is in, the transaction is PAID and (if the service
 *    is already completed) the provider's earning is posted exactly as a webhook would.
 *  - receivedBy PROVIDER: the provider collected at the counter → the transaction is
 *    PAY_AT_PROVIDER; no payment row (the platform never held the money), commission is
 *    still owed by the provider when the service completes.
 */
export async function recordManualPayment(
  actor: AuthContext,
  transactionId: string,
  input: { receivedBy: 'PLATFORM' | 'PROVIDER'; amountMinor: bigint; method: ManualMethod; reference?: string; receivedAt: Date; note: string },
) {
  if (input.receivedAt.getTime() > Date.now() + 5 * 60_000) throw badRequest('receivedAt cannot be in the future');
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM service_transactions WHERE id = ${transactionId}::uuid FOR UPDATE`;
    const txn = await tx.serviceTransaction.findUnique({ where: { id: transactionId }, include: { payments: true } });
    if (!txn) throw notFound('Transaction');
    if (!['PENDING_PAYMENT', 'PAY_AT_PROVIDER'].includes(txn.status)) throw conflict(`Transaction is ${txn.status}; nothing left to record`, { status: txn.status });
    if (txn.payments.some((p) => p.status === 'CREATED' && p.gateway !== 'MANUAL')) {
      throw conflict('An online payment is still in progress for this transaction; mark it abandoned first or wait for the gateway', { field: 'payment' });
    }
    const due = txn.grossMinor - capturedOf(txn.payments);

    if (input.receivedBy === 'PROVIDER') {
      if (txn.status === 'PAY_AT_PROVIDER') throw conflict('Already marked as paid at the provider');
      await tx.serviceTransaction.update({ where: { id: txn.id }, data: { status: 'PAY_AT_PROVIDER' } });
      await audit(tx, { action: 'payment.recorded_at_provider', entityType: 'transaction', entityId: txn.id, actorUserId: actor.userId, metadata: { method: input.method, reference: input.reference ?? null, receivedAt: input.receivedAt.toISOString(), note: input.note } });
      return { transactionId: txn.id, status: 'PAY_AT_PROVIDER' as const, paymentId: null };
    }

    if (input.amountMinor <= 0n) throw badRequest('Amount must be positive', { field: 'amountMinor' });
    if (input.amountMinor > due) throw conflict(`Only ${Number(due)} paise is still due on this transaction`, { field: 'amountMinor', dueMinor: Number(due) });
    let payment;
    try {
      payment = await tx.payment.create({
        data: {
          transactionId: txn.id,
          gateway: 'MANUAL',
          gatewayOrderId: `MANUAL-${randomUUID()}`,
          gatewayPaymentId: input.reference ? `MANUAL:${input.reference}` : null,
          amountMinor: input.amountMinor,
          currency: txn.currency,
          status: 'CAPTURED',
          method: input.method.toLowerCase(),
          capturedAt: input.receivedAt,
          idempotencyKey: `manual:${randomUUID()}`,
        },
      });
    } catch (err) {
      if (isPgError(err, '23505')) throw conflict('This receipt / bank reference was already recorded on another payment', { field: 'reference' });
      throw err;
    }
    const captured = capturedOf(txn.payments) + input.amountMinor;
    let status = txn.status;
    if (captured >= txn.grossMinor) {
      status = 'PAID';
      await tx.serviceTransaction.update({ where: { id: txn.id }, data: { status } });
      // Service already completed before the money arrived: the earning is owed now.
      if (txn.serviceCompletedAt) {
        const base = txn.grossMinor - txn.refundedMinor;
        if (base > 0n) await post(tx, { providerId: txn.providerId, transactionId: txn.id, entryType: 'SERVICE_EARNING', amountMinor: base, dedupeKey: `earning:${txn.id}`, actorUserId: actor.userId, description: 'Earning posted on manual payment after completion' });
      }
    }
    await audit(tx, { action: 'payment.recorded_manually', entityType: 'payment', entityId: payment.id, actorUserId: actor.userId, metadata: { transactionId: txn.id, amountMinor: input.amountMinor.toString(), method: input.method, reference: input.reference ?? null, receivedAt: input.receivedAt.toISOString(), note: input.note, transactionStatus: status } });
    return { transactionId: txn.id, status, paymentId: payment.id };
  });
}

/** An abandoned online checkout (still CREATED at the gateway) is closed so another payment can be recorded. */
export async function markPaymentAbandoned(actor: AuthContext, paymentId: string, reason: string) {
  const res = await prisma.payment.updateMany({ where: { id: paymentId, status: 'CREATED' }, data: { status: 'FAILED', failureCode: 'ABANDONED', failureReason: reason.slice(0, 500) } });
  if (res.count !== 1) {
    const p = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!p) throw notFound('Payment');
    throw conflict(`Only a CREATED payment can be marked abandoned; this one is ${p.status}`);
  }
  await audit(prisma, { action: 'payment.marked_abandoned', entityType: 'payment', entityId: paymentId, actorUserId: actor.userId, metadata: { reason } });
}

/**
 * Record that a refund was paid to the patient outside the gateway (bank
 * transfer, UPI, cash). Allowed from REQUESTED (then the recorder acts as the
 * approver and must not be the requester), APPROVED (gateway not applicable) or
 * FAILED (gateway attempt failed). Applies the same clawback as a gateway webhook.
 */
export async function recordManualRefund(actor: AuthContext, refundId: string, input: { method: ManualMethod; reference?: string; processedAt: Date; note: string }) {
  if (input.processedAt.getTime() > Date.now() + 5 * 60_000) throw badRequest('processedAt cannot be in the future');
  return prisma.$transaction(async (tx) => {
    const refund = await tx.refund.findUnique({ where: { id: refundId } });
    if (!refund) throw notFound('Refund');
    if (!['REQUESTED', 'APPROVED', 'FAILED'].includes(refund.status)) throw conflict(`Refund is ${refund.status}; only requested, approved or failed refunds can be recorded manually`);
    if (refund.requestedById === actor.userId) throw separationOfDuties('The person who requested a refund cannot record its payment');
    if (refund.status === 'PROCESSING') throw conflict('The gateway is processing this refund; wait for its webhook');
    const gatewayRefundId = `MANUAL:${input.reference ?? refund.reference}`;
    const res = await tx.refund.updateMany({
      where: { id: refund.id, status: refund.status },
      data: { status: 'SUCCEEDED', processedAt: input.processedAt, gatewayRefundId, failureReason: null, ...(refund.reviewedById ? {} : { reviewedById: actor.userId, reviewedAt: new Date() }), reviewNote: refund.reviewNote ? `${refund.reviewNote} · ${input.note}`.slice(0, 1000) : input.note.slice(0, 1000) },
    });
    if (res.count !== 1) throw conflict('Refund changed concurrently');
    await onRefundSucceeded(tx, refund.id, actor.userId);
    await audit(tx, { action: 'refund.recorded_manually', entityType: 'refund', entityId: refund.id, actorUserId: actor.userId, metadata: { amountMinor: refund.amountMinor.toString(), method: input.method, reference: input.reference ?? null, processedAt: input.processedAt.toISOString(), note: input.note, previousStatus: refund.status } });
    return tx.refund.findUniqueOrThrow({ where: { id: refund.id } });
  });
}

/**
 * Manual ledger adjustment (+ owed to the provider, − owed by the provider).
 * Used for goodwill credits, penalties, corrections after a bank reversal, etc.
 * Append-only: a mistaken adjustment is fixed with an opposite adjustment.
 */
export async function postAdjustment(actor: AuthContext, providerId: string, input: { amountMinor: bigint; reason: string; transactionId?: string }) {
  if (input.amountMinor === 0n) throw badRequest('Amount cannot be zero', { field: 'amountMinor' });
  if (input.amountMinor > 100_000_000n || input.amountMinor < -100_000_000n) throw badRequest('A single adjustment is limited to ₹10,00,000; split larger corrections', { field: 'amountMinor' });
  const provider = await prisma.provider.findUnique({ where: { id: providerId }, select: { id: true, displayName: true } });
  if (!provider) throw notFound('Provider');
  if (input.transactionId) {
    const txn = await prisma.serviceTransaction.findUnique({ where: { id: input.transactionId }, select: { providerId: true } });
    if (!txn || txn.providerId !== providerId) throw badRequest('The transaction does not belong to this provider', { field: 'transactionId' });
  }
  const id = randomUUID();
  await prisma.$transaction(async (tx) => {
    await post(tx, { providerId, transactionId: input.transactionId ?? null, entryType: 'ADJUSTMENT', amountMinor: input.amountMinor, dedupeKey: `adjustment:${id}`, description: input.reason.slice(0, 300), actorUserId: actor.userId });
    await audit(tx, { action: 'ledger.adjustment_posted', entityType: 'provider', entityId: providerId, actorUserId: actor.userId, metadata: { amountMinor: input.amountMinor.toString(), reason: input.reason, transactionId: input.transactionId ?? null, dedupeKey: `adjustment:${id}` } });
  });
  const entry = await prisma.providerLedgerEntry.findUniqueOrThrow({ where: { dedupeKey: `adjustment:${id}` } });
  return { id: entry.id, providerId, amountMinor: Number(entry.amountMinor), description: entry.description, createdAt: entry.createdAt.toISOString() };
}
