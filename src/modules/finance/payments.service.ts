import { prisma, transactionWithRetry, lockTransaction } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { AppError, badRequest, conflict, notFound, separationOfDuties } from '../../lib/errors.js';
import { sha256Hex } from '../../lib/crypto.js';
import { makeReference, REF } from '../../lib/reference.js';
import { logger } from '../../lib/logger.js';
import { getGateway, type LiveGateway } from './gateway.js';
import { onRefundSucceeded } from './commission.service.js';
import type { AuthContext } from '../../middleware/auth.js';

/** Create a gateway order for the outstanding amount of a transaction. */
export async function createPaymentOrder(transactionId: string, idempotencyKey: string) {
  const existing = await prisma.payment.findUnique({ where: { idempotencyKey } });
  if (existing) return existing;
  const txn = await prisma.serviceTransaction.findUnique({ where: { id: transactionId }, include: { payments: true } });
  if (!txn) throw notFound('Transaction');
  if (txn.status !== 'PENDING_PAYMENT') throw conflict(`Transaction is ${txn.status}; nothing to pay online`);
  const paid = txn.payments.filter((p) => p.status === 'CAPTURED').reduce((s, p) => s + p.amountMinor, 0n);
  const due = txn.grossMinor - paid;
  if (due <= 0n) throw conflict('Nothing is due');
  const order = await (await getGateway()).createOrder({ amountMinor: due, currency: txn.currency, receipt: txn.reference });
  if (order.amountMinor !== due || order.currency !== txn.currency) {
    throw new AppError(502, 'SERVICE_UNAVAILABLE', 'Gateway returned an unexpected order amount');
  }
  return prisma.payment.create({
    data: {
      transactionId: txn.id,
      gateway: order.gateway,
      gatewayOrderId: order.gatewayOrderId,
      amountMinor: due,
      currency: txn.currency,
      idempotencyKey,
    },
  });
}

/** Thrown inside the webhook transaction; recorded for reconciliation after rollback. */
class AmountMismatch extends Error {
  constructor(public readonly record: { paymentId: string; gatewayReference: string; expectedMinor: bigint; actualMinor: bigint; actualStatus: string }) {
    super('Amount or currency mismatch');
  }
}

interface RazorpayEvent {
  event: string;
  payload?: {
    payment?: { entity?: { id: string; order_id: string; amount: number; currency: string; status: string; method?: string; error_code?: string; error_description?: string } };
    refund?: { entity?: { id: string; payment_id: string; amount: number; status: string } };
  };
}

interface StripeEvent {
  id: string;
  type: string;
  data?: {
    object?: {
      object?: string; id: string; amount?: number; amount_received?: number; currency?: string; status?: string;
      payment_method_types?: string[]; last_payment_error?: { code?: string; message?: string };
      payment_intent?: string | null; refunds?: { data?: { id: string; amount: number; status: string }[] };
    };
  };
}

/**
 * Stripe events are mapped onto the same shape Razorpay sends, so one
 * processing path handles both. A Stripe PaymentIntent id is our "order id";
 * the browser confirms it with the client secret; success is confirmed here.
 */
function normaliseStripeEvent(e: StripeEvent): RazorpayEvent {
  const o = e.data?.object;
  if (!o) return { event: e.type };
  const currency = (o.currency ?? 'inr').toUpperCase();
  switch (e.type) {
    case 'payment_intent.succeeded':
      return { event: 'payment.captured', payload: { payment: { entity: { id: o.id, order_id: o.id, amount: o.amount_received ?? o.amount ?? 0, currency, status: 'captured', method: o.payment_method_types?.[0] } } } };
    case 'payment_intent.payment_failed':
      return { event: 'payment.failed', payload: { payment: { entity: { id: o.id, order_id: o.id, amount: o.amount ?? 0, currency, status: 'failed', error_code: o.last_payment_error?.code, error_description: o.last_payment_error?.message } } } };
    case 'charge.refunded': {
      const r = o.refunds?.data?.[0];
      return r ? { event: 'refund.processed', payload: { refund: { entity: { id: r.id, payment_id: o.payment_intent ?? '', amount: r.amount, status: r.status } } } } : { event: e.type };
    }
    case 'refund.updated':
    case 'refund.created':
      if (o.status === 'succeeded') return { event: 'refund.processed', payload: { refund: { entity: { id: o.id, payment_id: o.payment_intent ?? '', amount: o.amount ?? 0, status: o.status } } } };
      if (o.status === 'failed' || o.status === 'canceled') return { event: 'refund.failed', payload: { refund: { entity: { id: o.id, payment_id: o.payment_intent ?? '', amount: o.amount ?? 0, status: o.status } } } };
      return { event: e.type };
    default:
      return { event: e.type };
  }
}

/**
 * Process one verified webhook. Stored once per (gateway, eventId): a duplicate
 * delivery is acknowledged and ignored. Amount/currency mismatches are never
 * applied — they are recorded for reconciliation.
 */
export async function processWebhook(gateway: LiveGateway, eventId: string, rawBody: Buffer) {
  let event: RazorpayEvent;
  try {
    const parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
    event = gateway === 'STRIPE' ? normaliseStripeEvent(parsed as StripeEvent) : (parsed as RazorpayEvent);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw badRequest('Malformed webhook body');
  }
  const payloadSha256 = sha256Hex(rawBody);

  const stored = await prisma.paymentWebhookEvent.upsert({
    where: { gateway_eventId: { gateway, eventId } },
    create: { gateway, eventId, eventType: event.event?.slice(0, 64) ?? 'unknown', payloadSha256, payload: event as object },
    update: {},
  });
  if (stored.processingStatus === 'PROCESSED' || stored.processingStatus === 'IGNORED') return { duplicate: true, status: stored.processingStatus };
  if (stored.payloadSha256 !== payloadSha256) {
    logger.warn({ eventId }, 'webhook replay with different payload ignored');
    return { duplicate: true, status: 'IGNORED' as const };
  }

  return applyStoredEvent(gateway, stored.id, eventId, event);
}

/**
 * Re-run processing for a stored webhook that previously FAILED (for example the
 * order was created a moment after the gateway's first delivery). Used by
 * finance staff from the admin console; PROCESSED/IGNORED events are never replayed.
 */
export async function replayWebhookEvent(actor: AuthContext, storedId: string) {
  const stored = await prisma.paymentWebhookEvent.findUnique({ where: { id: storedId } });
  if (!stored) throw notFound('Webhook event');
  if (stored.processingStatus !== 'FAILED') throw conflict(`Only FAILED events can be replayed; this one is ${stored.processingStatus}`);
  if (stored.gateway === 'MANUAL') throw conflict('Manual payments have no webhook to replay');
  const result = await applyStoredEvent(stored.gateway as LiveGateway, stored.id, stored.eventId, stored.payload as unknown as RazorpayEvent);
  await audit(prisma, { action: 'webhook.replayed', entityType: 'webhook_event', entityId: stored.id, actorUserId: actor.userId, metadata: { eventId: stored.eventId, result: result.status } });
  return result;
}

async function applyStoredEvent(gateway: LiveGateway, storedId: string, eventId: string, event: RazorpayEvent) {
  const stored = { id: storedId };
  try {
    const result = await transactionWithRetry(async (tx) => {
      // Write to the event document first so concurrent deliveries conflict and serialise (transactionWithRetry reruns the loser).
      await tx.paymentWebhookEvent.update({ where: { id: stored.id }, data: { version: { increment: 1 } }, select: { id: true } });
      const fresh = await tx.paymentWebhookEvent.findUniqueOrThrow({ where: { id: stored.id } });
      if (fresh.processingStatus === 'PROCESSED' || fresh.processingStatus === 'IGNORED') return { duplicate: true, status: fresh.processingStatus };

      let outcome: 'PROCESSED' | 'IGNORED' = 'IGNORED';
      const pay = event.payload?.payment?.entity;
      const ref = event.payload?.refund?.entity;

      if ((event.event === 'payment.captured' || event.event === 'order.paid') && pay) {
        const payment = await tx.payment.findUnique({ where: { gateway_gatewayOrderId: { gateway, gatewayOrderId: pay.order_id } } });
        if (!payment) throw new Error('Unknown order');
        if (BigInt(pay.amount) !== payment.amountMinor || pay.currency !== payment.currency) {
          throw new AmountMismatch({
            paymentId: payment.id,
            gatewayReference: pay.id,
            expectedMinor: payment.amountMinor,
            actualMinor: BigInt(pay.amount),
            actualStatus: pay.status,
          });
        }
        if (payment.status !== 'CAPTURED') {
          await tx.payment.update({
            where: { id: payment.id },
            data: { status: 'CAPTURED', gatewayPaymentId: pay.id, method: pay.method?.slice(0, 32), capturedAt: new Date() },
          });
          const txn = await tx.serviceTransaction.findUniqueOrThrow({ where: { id: payment.transactionId }, include: { payments: true } });
          const captured = txn.payments.reduce((s, p) => s + (p.id === payment.id || p.status === 'CAPTURED' ? p.amountMinor : 0n), 0n);
          if (captured >= txn.grossMinor && (txn.status === 'PENDING_PAYMENT' || txn.status === 'PAY_AT_PROVIDER')) {
            await tx.serviceTransaction.update({ where: { id: txn.id }, data: { status: 'PAID' } });
          }
          await audit(tx, { action: 'payment.captured', entityType: 'payment', entityId: payment.id, actorType: 'WEBHOOK', metadata: { amountMinor: pay.amount, gatewayPaymentId: pay.id } });
        }
        outcome = 'PROCESSED';
      } else if (event.event === 'payment.failed' && pay) {
        const payment = await tx.payment.findUnique({ where: { gateway_gatewayOrderId: { gateway, gatewayOrderId: pay.order_id } } });
        if (payment && payment.status === 'CREATED') {
          await tx.payment.update({
            where: { id: payment.id },
            data: { status: 'FAILED', gatewayPaymentId: pay.id, failureCode: pay.error_code?.slice(0, 64), failureReason: pay.error_description?.slice(0, 500) },
          });
          await audit(tx, { action: 'payment.failed', entityType: 'payment', entityId: payment.id, actorType: 'WEBHOOK' });
        }
        outcome = 'PROCESSED';
      } else if (event.event === 'refund.processed' && ref) {
        const refund = await tx.refund.findUnique({ where: { gatewayRefundId: ref.id } });
        if (!refund) throw new Error('Unknown refund');
        if (BigInt(ref.amount) !== refund.amountMinor) throw new Error('Refund amount mismatch');
        if (refund.status === 'PROCESSING') {
          await tx.refund.update({ where: { id: refund.id }, data: { status: 'SUCCEEDED', processedAt: new Date() } });
          await onRefundSucceeded(tx, refund.id, null);
          await audit(tx, { action: 'refund.succeeded', entityType: 'refund', entityId: refund.id, actorType: 'WEBHOOK' });
        }
        outcome = 'PROCESSED';
      } else if (event.event === 'refund.failed' && ref) {
        const refund = await tx.refund.findUnique({ where: { gatewayRefundId: ref.id } });
        if (refund?.status === 'PROCESSING') {
          await tx.refund.update({ where: { id: refund.id }, data: { status: 'FAILED', failureReason: 'Gateway reported failure' } });
        }
        outcome = 'PROCESSED';
      }

      await tx.paymentWebhookEvent.update({ where: { id: stored.id }, data: { processingStatus: outcome, processedAt: new Date(), processingError: null } });
      return { duplicate: false, status: outcome };
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof AmountMismatch) {
      // Never applied — surfaced to finance as a reconciliation exception.
      await prisma.reconciliationRecord.create({
        data: { runId: stored.id, gateway, ...err.record, expectedStatus: 'CAPTURED', status: 'AMOUNT_MISMATCH' },
      });
    }
    await prisma.paymentWebhookEvent.update({ where: { id: stored.id }, data: { processingStatus: 'FAILED', processingError: message.slice(0, 1000) } });
    logger.warn({ eventId, err: message }, 'webhook processing failed');
    return { duplicate: false, status: 'FAILED' as const };
  }
}

// ─── Refunds (maker–checker) ───────────────────────────────────────────────

export async function requestRefund(actor: AuthContext, input: { transactionId: string; amountMinor: bigint; reason: string; idempotencyKey: string }) {
  return transactionWithRetry(async (tx) => {
    const existing = await tx.refund.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) return existing;
    await lockTransaction(tx, input.transactionId);
    const txn = await tx.serviceTransaction.findUnique({ where: { id: input.transactionId }, include: { payments: true, refunds: true } });
    if (!txn) throw notFound('Transaction');
    const captured = txn.payments.filter((p) => p.status === 'CAPTURED' || p.status === 'PARTIALLY_REFUNDED');
    if (!captured.length) throw conflict('No captured online payment to refund');
    const refundable = captured.reduce((s, p) => s + p.amountMinor - p.refundedMinor, 0n);
    const pending = txn.refunds.filter((r) => ['REQUESTED', 'APPROVED', 'PROCESSING'].includes(r.status)).reduce((s, r) => s + r.amountMinor, 0n);
    if (input.amountMinor <= 0n) throw badRequest('Refund amount must be positive');
    if (input.amountMinor > refundable - pending) {
      throw conflict('Refund exceeds the refundable amount', { refundableMinor: Number(refundable - pending) });
    }
    const refund = await tx.refund.create({
      data: {
        reference: makeReference(REF.refund),
        transactionId: txn.id,
        paymentId: captured[0]!.id,
        amountMinor: input.amountMinor,
        reason: input.reason,
        requestedById: actor.userId,
        idempotencyKey: input.idempotencyKey,
      },
    });
    await audit(tx, { action: 'refund.requested', entityType: 'refund', entityId: refund.id, metadata: { amountMinor: input.amountMinor.toString(), transactionId: txn.id } });
    return refund;
  });
}

export async function reviewRefund(actor: AuthContext, refundId: string, decision: 'APPROVE' | 'REJECT', note: string) {
  const refund = await prisma.refund.findUnique({ where: { id: refundId }, include: { payment: true } });
  if (!refund) throw notFound('Refund');
  if (refund.status !== 'REQUESTED') throw conflict(`Refund is ${refund.status}`);
  if (refund.requestedById === actor.userId) throw separationOfDuties('A refund must be approved by someone other than the requester');

  if (decision === 'REJECT') {
    const res = await prisma.refund.updateMany({ where: { id: refundId, status: 'REQUESTED' }, data: { status: 'REJECTED', reviewedById: actor.userId, reviewedAt: new Date(), reviewNote: note } });
    if (res.count !== 1) throw conflict('Refund changed concurrently');
    await audit(prisma, { action: 'refund.rejected', entityType: 'refund', entityId: refundId, metadata: { note } });
    return;
  }

  // Claim the refund first so two approvers cannot both call the gateway.
  const claimed = await prisma.refund.updateMany({
    where: { id: refundId, status: 'REQUESTED' },
    data: { status: 'APPROVED', reviewedById: actor.userId, reviewedAt: new Date(), reviewNote: note },
  });
  if (claimed.count !== 1) throw conflict('Refund changed concurrently');
  if (refund.payment?.gateway === 'MANUAL' || !refund.payment?.gatewayPaymentId) {
    // Nothing to call: the money was received outside a gateway. The refund stays APPROVED
    // until finance pays the patient back and records it (POST /refunds/:id/record-manual).
    await audit(prisma, { action: 'refund.approved', entityType: 'refund', entityId: refundId, metadata: { manualCompletionRequired: true, note } });
    return;
  }
  try {
    const g = await (await getGateway()).createRefund({ gatewayPaymentId: refund.payment.gatewayPaymentId, amountMinor: refund.amountMinor, receipt: refund.reference });
    await prisma.refund.update({ where: { id: refundId }, data: { status: 'PROCESSING', gatewayRefundId: g.gatewayRefundId } });
    await audit(prisma, { action: 'refund.approved', entityType: 'refund', entityId: refundId, metadata: { gatewayRefundId: g.gatewayRefundId } });
  } catch (err) {
    await prisma.refund.update({ where: { id: refundId }, data: { status: 'FAILED', failureReason: 'Gateway refund call failed' } });
    throw err;
  }
}
