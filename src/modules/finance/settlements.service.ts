import type { Prisma } from '../../lib/prisma.js';
import { prisma } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, notFound, preconditionFailed, separationOfDuties } from '../../lib/errors.js';
import { makeReference, REF } from '../../lib/reference.js';
import { getSetting } from '../settings/settings.service.js';
import { post } from './commission.service.js';
import type { AuthContext } from '../../middleware/auth.js';

export async function providerBalance(providerId: string) {
  const [all, unsettled] = await Promise.all([
    prisma.providerLedgerEntry.aggregate({ where: { providerId }, _sum: { amountMinor: true } }),
    prisma.providerLedgerEntry.aggregate({ where: { providerId, settlementItemId: null }, _sum: { amountMinor: true } }),
  ]);
  return { balanceMinor: all._sum.amountMinor ?? 0n, unsettledMinor: unsettled._sum.amountMinor ?? 0n };
}

/**
 * Prepare a settlement batch (maker). For every provider, sums ledger entries
 * not yet in a settlement and older than the hold period. Only positive
 * balances with a VERIFIED payout account are included; negative balances
 * (provider owes commission) carry forward. Entries are claimed with a
 * conditional UPDATE, so two concurrent batch runs can never settle the same
 * entry twice.
 */
export async function createBatch(actor: AuthContext, input: { asOf?: Date; notes?: string }) {
  const holdDays = await getSetting<number>('finance.settlement_hold_days', 7);
  const cutoff = new Date((input.asOf ?? new Date()).getTime() - holdDays * 86_400_000);

  return prisma.$transaction(
    async (tx) => {
      // Unsettled entries up to the cut-off, grouped per provider; only positive balances are paid out.
      const unsettled = await tx.providerLedgerEntry.findMany({
        where: { settlementItemId: null, createdAt: { lte: cutoff } },
        select: { id: true, providerId: true, amountMinor: true },
        orderBy: { createdAt: 'asc' },
      });
      const byProvider = new Map<string, { provider_id: string; total: bigint; ids: string[] }>();
      for (const e of unsettled) {
        const g = byProvider.get(e.providerId) ?? { provider_id: e.providerId, total: 0n, ids: [] };
        g.total += e.amountMinor;
        g.ids.push(e.id);
        byProvider.set(e.providerId, g);
      }
      const groups = [...byProvider.values()].filter((g) => g.total > 0n);

      const skipped: { providerId: string; reason: string; amountMinor: number }[] = [];
      const eligible: typeof groups = [];
      for (const g of groups) {
        const provider = await tx.provider.findUniqueOrThrow({ where: { id: g.provider_id }, select: { status: true } });
        const account = await tx.providerPayoutAccount.findFirst({ where: { providerId: g.provider_id, status: 'VERIFIED' } });
        if (!account) skipped.push({ providerId: g.provider_id, reason: 'No verified payout account', amountMinor: Number(g.total) });
        else if (provider.status === 'SUSPENDED' || provider.status === 'DEACTIVATED') skipped.push({ providerId: g.provider_id, reason: `Provider ${provider.status}`, amountMinor: Number(g.total) });
        else eligible.push(g);
      }
      if (eligible.length === 0) throw preconditionFailed('Nothing is due for settlement', { skipped, cutoff: cutoff.toISOString() });

      const batch = await tx.settlementBatch.create({
        data: { reference: makeReference(REF.settlement), periodEnd: cutoff, createdById: actor.userId, notes: input.notes, status: 'DRAFT' },
      });
      let total = 0n;
      for (const g of eligible) {
        const account = await tx.providerPayoutAccount.findFirstOrThrow({ where: { providerId: g.provider_id, status: 'VERIFIED' } });
        const item = await tx.settlementItem.create({ data: { batchId: batch.id, providerId: g.provider_id, payoutAccountId: account.id, amountMinor: g.total } });
        const claimed = await tx.providerLedgerEntry.updateMany({
          where: { id: { in: g.ids }, settlementItemId: null },
          data: { settlementItemId: item.id },
        });
        if (claimed.count !== g.ids.length) throw conflict('Ledger entries were settled concurrently; retry');
        total += g.total;
      }
      const ready = await tx.settlementBatch.update({
        where: { id: batch.id },
        data: { status: 'PENDING_APPROVAL', totalMinor: total, itemCount: eligible.length },
      });
      await audit(tx, { action: 'settlement.batch_created', entityType: 'settlement_batch', entityId: batch.id, metadata: { totalMinor: total.toString(), items: eligible.length, skipped: skipped.length } });
      return { batch: ready, skipped };
    },
    // Concurrent batch runs are serialised by the conditional updateMany above (write conflicts abort the loser).
    { timeout: 30_000 },
  );
}

export async function approveBatch(actor: AuthContext, batchId: string) {
  await prisma.$transaction(async (tx) => {
    const b = await tx.settlementBatch.findUnique({ where: { id: batchId } });
    if (!b) throw notFound('Settlement batch');
    if (b.createdById === actor.userId) throw separationOfDuties('A batch must be approved by someone other than its creator');
    if (b.status !== 'PENDING_APPROVAL') throw conflict(`Batch is ${b.status}`);
    await tx.settlementBatch.update({ where: { id: batchId }, data: { status: 'APPROVED', approvedById: actor.userId, approvedAt: new Date() } });
    await audit(tx, { action: 'settlement.batch_approved', entityType: 'settlement_batch', entityId: batchId });
  });
}

export async function cancelBatch(actor: AuthContext, batchId: string, reason: string) {
  await prisma.$transaction(async (tx) => {
    const b = await tx.settlementBatch.findUnique({ where: { id: batchId }, include: { items: true } });
    if (!b) throw notFound('Settlement batch');
    if (b.status !== 'DRAFT' && b.status !== 'PENDING_APPROVAL' && b.status !== 'APPROVED') throw conflict(`Batch is ${b.status}`);
    if (b.items.some((i) => i.status === 'PAID')) throw conflict('Batch has paid items');
    await tx.providerLedgerEntry.updateMany({ where: { settlementItemId: { in: b.items.map((i) => i.id) } }, data: { settlementItemId: null } });
    await tx.settlementItem.updateMany({ where: { batchId }, data: { status: 'CANCELLED' } });
    await tx.settlementBatch.update({ where: { id: batchId }, data: { status: 'CANCELLED', notes: reason } });
    await audit(tx, { action: 'settlement.batch_cancelled', entityType: 'settlement_batch', entityId: batchId, actorUserId: actor.userId, metadata: { reason } });
  });
}

async function refreshBatchStatus(tx: Prisma.TransactionClient, batchId: string) {
  const items = await tx.settlementItem.findMany({ where: { batchId }, select: { status: true } });
  if (items.some((i) => i.status === 'PENDING')) {
    await tx.settlementBatch.update({ where: { id: batchId }, data: { status: 'PROCESSING' } });
    return;
  }
  const anyFailed = items.some((i) => i.status === 'FAILED');
  await tx.settlementBatch.update({ where: { id: batchId }, data: { status: anyFailed ? 'PARTIALLY_FAILED' : 'COMPLETED', completedAt: new Date() } });
}

/**
 * Record that a payout was made. Requires bank evidence (UTR) and an APPROVED
 * batch. The UTR is unique across all items, so the same bank transfer cannot
 * be recorded twice.
 */
export async function recordPayout(actor: AuthContext, itemId: string, input: { payoutReference: string; paidAt: Date; evidenceNote?: string }) {
  if (input.paidAt > new Date(Date.now() + 5 * 60_000)) throw badRequest('paidAt cannot be in the future');
  await prisma.$transaction(async (tx) => {
    const item = await tx.settlementItem.findUnique({ where: { id: itemId }, include: { batch: true } });
    if (!item) throw notFound('Settlement item');
    if (item.status !== 'PENDING') throw conflict(`Item is ${item.status}`);
    if (item.batch.status !== 'APPROVED' && item.batch.status !== 'PROCESSING') throw preconditionFailed('The batch must be approved before recording payouts');
    const res = await tx.settlementItem.updateMany({
      where: { id: itemId, status: 'PENDING' },
      data: { status: 'PAID', payoutReference: input.payoutReference, paidAt: input.paidAt, evidenceNote: input.evidenceNote, recordedById: actor.userId, attemptCount: { increment: 1 } },
    });
    if (res.count !== 1) throw conflict('Item changed concurrently');
    await post(tx, {
      providerId: item.providerId,
      entryType: 'SETTLEMENT_PAYOUT',
      amountMinor: -item.amountMinor,
      dedupeKey: `payout:${item.id}`,
      description: `Payout ${input.payoutReference}`,
      actorUserId: actor.userId,
    });
    // Link the payout entry to the item so it is not re-settled.
    await tx.providerLedgerEntry.update({ where: { dedupeKey: `payout:${item.id}` }, data: { settlementItemId: item.id } });
    await refreshBatchStatus(tx, item.batchId);
    await audit(tx, { action: 'settlement.payout_recorded', entityType: 'settlement_item', entityId: itemId, metadata: { amountMinor: item.amountMinor.toString(), payoutReference: input.payoutReference } });
  });
}

/** A failed transfer releases its ledger entries back to the unsettled pool for the next batch. */
export async function recordPayoutFailure(actor: AuthContext, itemId: string, reason: string) {
  await prisma.$transaction(async (tx) => {
    const item = await tx.settlementItem.findUnique({ where: { id: itemId }, include: { batch: true } });
    if (!item) throw notFound('Settlement item');
    if (item.status !== 'PENDING') throw conflict(`Item is ${item.status}`);
    if (item.batch.status !== 'APPROVED' && item.batch.status !== 'PROCESSING') throw preconditionFailed('The batch must be approved first');
    await tx.settlementItem.update({ where: { id: itemId }, data: { status: 'FAILED', failureReason: reason, attemptCount: { increment: 1 }, recordedById: actor.userId } });
    await tx.providerLedgerEntry.updateMany({ where: { settlementItemId: itemId }, data: { settlementItemId: null } });
    await refreshBatchStatus(tx, item.batchId);
    await audit(tx, { action: 'settlement.payout_failed', entityType: 'settlement_item', entityId: itemId, metadata: { reason } });
  });
}
