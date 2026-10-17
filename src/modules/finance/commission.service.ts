import type { Tx } from '../../lib/prisma.js';
import { applyBps, clamp, minBig } from '../../lib/money.js';
import { audit } from '../../lib/audit.js';
import { getSetting } from '../settings/settings.service.js';
import { makeReference, REF } from '../../lib/reference.js';
import type {
  Attribution,
  CommissionCategory,
  CommissionMethod,
  CommissionPolicy,
  CommissionSnapshot,
  LedgerEntryType,
  ProviderType,
  TransactionSourceType,
} from '../../../generated/prisma/client.js';

// ─── Pure calculation ─────────────────────────────────────────────────────

export interface CommissionTerms {
  method: CommissionMethod;
  rateBps: number | null;
  flatMinor: bigint | null;
  minMinor: bigint | null;
  maxMinor: bigint | null;
  taxRateBps: number;
}

export interface CommissionResult {
  baseMinor: bigint;
  commissionMinor: bigint;
  taxMinor: bigint;
  providerNetMinor: bigint;
}

/**
 * Deterministic integer calculation.
 *  1. raw = base × rate (half-up) or the flat amount
 *  2. clamp to [min, max] when given
 *  3. never more than the base
 *  4. tax = commission × taxRate (half-up); if commission + tax would exceed the
 *     base, commission is reduced so the provider net is never negative.
 */
export function calculateCommission(terms: CommissionTerms, baseMinor: bigint): CommissionResult {
  if (baseMinor < 0n) throw new RangeError('base must be non-negative');
  let commission =
    terms.method === 'PERCENTAGE' ? applyBps(baseMinor, terms.rateBps ?? 0) : (terms.flatMinor ?? 0n);
  commission = clamp(commission, terms.minMinor, terms.maxMinor);
  commission = minBig(commission, baseMinor);
  let tax = applyBps(commission, terms.taxRateBps);
  if (commission + tax > baseMinor) {
    // Largest commission c with c + round(c × t) ≤ base.
    const t = BigInt(terms.taxRateBps);
    commission = (baseMinor * 10_000n) / (10_000n + t);
    tax = applyBps(commission, terms.taxRateBps);
    while (commission > 0n && commission + tax > baseMinor) {
      commission -= 1n;
      tax = applyBps(commission, terms.taxRateBps);
    }
  }
  return { baseMinor, commissionMinor: commission, taxMinor: tax, providerNetMinor: baseMinor - commission - tax };
}

// ─── Policy resolution ────────────────────────────────────────────────────

/**
 * Most specific ACTIVE policy effective at `at`:
 *   provider-specific → provider-type → category default.
 */
export async function resolvePolicy(
  tx: Tx,
  q: { category: CommissionCategory; providerId: string; providerType: ProviderType; at: Date },
): Promise<CommissionPolicy | null> {
  const candidates = await tx.commissionPolicy.findMany({
    where: {
      status: 'ACTIVE',
      category: q.category,
      effectiveFrom: { lte: q.at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: q.at } }],
      AND: [
        { OR: [{ providerId: q.providerId }, { providerId: null }] },
        { OR: [{ providerType: q.providerType }, { providerType: null }] },
      ],
    },
  });
  const score = (p: CommissionPolicy) => (p.providerId ? 2 : 0) + (p.providerType ? 1 : 0);
  return candidates.sort((a, b) => score(b) - score(a))[0] ?? null;
}

export const SOURCE_TO_CATEGORY: Record<TransactionSourceType, CommissionCategory> = {
  APPOINTMENT: 'CONSULTATION',
  DIAGNOSTIC_ORDER: 'DIAGNOSTIC',
  PHARMACY_ORDER: 'PHARMACY',
  AMBULANCE_DISPATCH: 'AMBULANCE',
};

// ─── Ledger ───────────────────────────────────────────────────────────────

export async function post(
  tx: Tx,
  e: { providerId: string; transactionId?: string | null; entryType: LedgerEntryType; amountMinor: bigint; dedupeKey: string; description?: string; actorUserId?: string | null },
) {
  if (e.amountMinor === 0n) return;
  // ON CONFLICT on the dedupe key makes every posting idempotent: replaying a
  // webhook or retrying a completion can never double-post.
  await tx.providerLedgerEntry.upsert({
    where: { dedupeKey: e.dedupeKey },
    create: {
      providerId: e.providerId,
      transactionId: e.transactionId ?? null,
      entryType: e.entryType,
      amountMinor: e.amountMinor,
      dedupeKey: e.dedupeKey,
      description: e.description,
      createdById: e.actorUserId ?? null,
    },
    update: {},
  });
}

// ─── Transaction lifecycle hooks ──────────────────────────────────────────

export async function createTransaction(
  tx: Tx,
  input: {
    sourceType: TransactionSourceType;
    sourceId: string;
    providerId: string;
    patientProfileId: string | null;
    grossMinor: bigint;
    attribution: Attribution;
    payAtProvider: boolean;
  },
) {
  const link =
    input.sourceType === 'APPOINTMENT'
      ? { appointmentId: input.sourceId }
      : input.sourceType === 'DIAGNOSTIC_ORDER'
        ? { diagnosticOrderId: input.sourceId }
        : input.sourceType === 'PHARMACY_ORDER'
          ? { pharmacyOrderId: input.sourceId }
          : { dispatchRequestId: input.sourceId };
  return tx.serviceTransaction.create({
    data: {
      reference: makeReference(REF.transaction),
      sourceType: input.sourceType,
      ...link,
      providerId: input.providerId,
      patientProfileId: input.patientProfileId,
      category: SOURCE_TO_CATEGORY[input.sourceType],
      grossMinor: input.grossMinor,
      attribution: input.attribution,
      status: input.grossMinor === 0n ? 'PAID' : input.payAtProvider ? 'PAY_AT_PROVIDER' : 'PENDING_PAYMENT',
    },
  });
}

function snapshotTerms(s: CommissionSnapshot | CommissionPolicy): CommissionTerms {
  return { method: s.method, rateBps: s.rateBps, flatMinor: s.flatMinor, minMinor: s.minMinor, maxMinor: s.maxMinor, taxRateBps: s.taxRateBps };
}

async function writeSnapshot(
  tx: Tx,
  txn: { id: string; providerId: string; currency: string },
  policy: { id: string; code: string; version: number },
  terms: CommissionTerms,
  base: bigint,
  actorUserId: string | null,
) {
  const result = calculateCommission(terms, base);
  const snap = await tx.commissionSnapshot.create({
    data: {
      transactionId: txn.id,
      policyId: policy.id,
      policyCode: policy.code,
      policyVersion: policy.version,
      method: terms.method,
      rateBps: terms.rateBps,
      flatMinor: terms.flatMinor,
      minMinor: terms.minMinor,
      maxMinor: terms.maxMinor,
      taxRateBps: terms.taxRateBps,
      ...result,
      currency: txn.currency,
      status: 'FINAL',
    },
  });
  await post(tx, { providerId: txn.providerId, transactionId: txn.id, entryType: 'COMMISSION', amountMinor: -result.commissionMinor, dedupeKey: `commission:${snap.id}`, actorUserId });
  await post(tx, { providerId: txn.providerId, transactionId: txn.id, entryType: 'COMMISSION_TAX', amountMinor: -result.taxMinor, dedupeKey: `commission_tax:${snap.id}`, actorUserId });
  return snap;
}

/**
 * Called once when the underlying service is completed. Decides commission
 * eligibility, freezes a commission snapshot using the policy effective when
 * the transaction was created, and posts ledger entries. Idempotent.
 */
export async function onServiceCompleted(tx: Tx, transactionId: string, actorUserId: string | null) {
  const txn = await tx.serviceTransaction.findUniqueOrThrow({ where: { id: transactionId }, include: { provider: true } });
  if (txn.serviceCompletedAt) return; // already processed
  const now = new Date();
  let status = txn.status;
  if (status === 'PENDING_PAYMENT') status = 'PAY_AT_PROVIDER'; // never paid online → settled at the counter

  const chargeDirect = await getSetting<boolean>('finance.commission_on_provider_direct', false);
  let eligible = txn.attribution !== 'PROVIDER_DIRECT' || chargeDirect;
  let reason = eligible ? 'Completed platform-attributed service' : 'Provider-direct booking (walk-in) is not commissionable by policy';
  const base = txn.grossMinor - txn.refundedMinor;
  if (status === 'REFUNDED' || status === 'CANCELLED' || base <= 0n) {
    eligible = false;
    reason = 'Nothing collected after refunds/cancellation';
  }
  let policy: CommissionPolicy | null = null;
  if (eligible) {
    policy = await resolvePolicy(tx, { category: txn.category, providerId: txn.providerId, providerType: txn.provider.type, at: txn.createdAt });
    if (!policy) {
      eligible = false;
      reason = 'No active commission policy applied when the transaction was created';
    }
  }

  await tx.serviceTransaction.update({
    where: { id: txn.id },
    data: { serviceCompletedAt: now, status, commissionEligible: eligible, eligibilityReason: reason },
  });

  // Money the platform collected on the provider's behalf becomes owed to them.
  const collectedByPlatform = status === 'PAID' || status === 'PARTIALLY_REFUNDED';
  if (collectedByPlatform && base > 0n) {
    await post(tx, { providerId: txn.providerId, transactionId: txn.id, entryType: 'SERVICE_EARNING', amountMinor: base, dedupeKey: `earning:${txn.id}`, actorUserId });
  }
  if (eligible && policy) await writeSnapshot(tx, txn, policy, snapshotTerms(policy), base, actorUserId);
  await audit(tx, { action: 'finance.service_completed', entityType: 'transaction', entityId: txn.id, actorUserId, metadata: { eligible, reason, policyId: policy?.id } });
}

/**
 * Apply a successful refund. Before completion only the transaction totals
 * change; after completion the provider earning is clawed back and commission
 * is recomputed on the remaining base using the ORIGINAL snapshot terms (a
 * later policy change never alters historical transactions).
 */
export async function onRefundSucceeded(tx: Tx, refundId: string, actorUserId: string | null) {
  const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
  const txn = await tx.serviceTransaction.findUniqueOrThrow({ where: { id: refund.transactionId } });
  const refunded = txn.refundedMinor + refund.amountMinor;
  const fully = refunded >= txn.grossMinor;
  await tx.serviceTransaction.update({
    where: { id: txn.id },
    data: { refundedMinor: refunded, status: fully ? 'REFUNDED' : 'PARTIALLY_REFUNDED', ...(fully && !txn.serviceCompletedAt ? { commissionEligible: false } : {}) },
  });
  if (refund.paymentId) {
    const p = await tx.payment.findUniqueOrThrow({ where: { id: refund.paymentId } });
    const pr = p.refundedMinor + refund.amountMinor;
    await tx.payment.update({ where: { id: p.id }, data: { refundedMinor: pr, status: pr >= p.amountMinor ? 'REFUNDED' : 'PARTIALLY_REFUNDED' } });
  }
  if (!txn.serviceCompletedAt) return;

  await post(tx, { providerId: txn.providerId, transactionId: txn.id, entryType: 'REFUND_CLAWBACK', amountMinor: -refund.amountMinor, dedupeKey: `refund:${refund.id}`, actorUserId });
  const live = await tx.commissionSnapshot.findFirst({ where: { transactionId: txn.id, status: { not: 'REVERSED' } } });
  if (!live) return;
  await tx.commissionSnapshot.update({ where: { id: live.id }, data: { status: 'REVERSED', reversedAt: new Date(), reversalReason: `Refund ${refund.reference}` } });
  await post(tx, { providerId: txn.providerId, transactionId: txn.id, entryType: 'COMMISSION_REVERSAL', amountMinor: live.commissionMinor + live.taxMinor, dedupeKey: `reversal:${live.id}`, actorUserId });
  const remaining = txn.grossMinor - refunded;
  if (remaining > 0n) {
    await writeSnapshot(tx, txn, { id: live.policyId, code: live.policyCode, version: live.policyVersion }, snapshotTerms(live), remaining, actorUserId);
  } else {
    await tx.serviceTransaction.update({ where: { id: txn.id }, data: { commissionEligible: false, eligibilityReason: 'Fully refunded' } });
  }
}

export async function onSourceCancelled(tx: Tx, transactionId: string, actorUserId: string | null, reason: string) {
  const txn = await tx.serviceTransaction.findUnique({ where: { id: transactionId }, include: { payments: true } });
  if (!txn) return { refundRequestedMinor: 0n };
  const captured = txn.payments.filter((p) => p.status === 'CAPTURED' || p.status === 'PARTIALLY_REFUNDED');
  if (captured.length === 0) {
    await tx.serviceTransaction.update({ where: { id: txn.id }, data: { status: 'CANCELLED', commissionEligible: false, eligibilityReason: reason } });
    return { refundRequestedMinor: 0n };
  }
  // Money was taken: open a refund request for finance to approve (maker-checker).
  const refundable = captured.reduce((s, p) => s + p.amountMinor - p.refundedMinor, 0n);
  const pending = await tx.refund.aggregate({ where: { transactionId: txn.id, status: { in: ['REQUESTED', 'APPROVED', 'PROCESSING'] } }, _sum: { amountMinor: true } });
  const amount = refundable - (pending._sum.amountMinor ?? 0n);
  if (amount > 0n) {
    await tx.refund.create({
      data: {
        reference: makeReference(REF.refund),
        transactionId: txn.id,
        paymentId: captured[0]!.id,
        amountMinor: amount,
        reason: `Auto-requested on cancellation: ${reason}`.slice(0, 500),
        requestedById: actorUserId,
      },
    });
  }
  return { refundRequestedMinor: amount };
}
