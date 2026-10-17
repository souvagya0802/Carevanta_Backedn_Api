import { randomUUID } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import type { AuthContext } from '../../middleware/auth.js';
import type { PaymentGateway, ReconciliationStatus } from '../../../generated/prisma/client.js';

export interface StatementLine {
  gatewayPaymentId: string;
  gatewayOrderId: string;
  amountMinor: number;
  currency: string;
  status: 'captured' | 'failed' | 'refunded' | 'authorized';
}

/**
 * Compare a gateway settlement/transactions report (exported from the gateway
 * dashboard or API) against internal payment records for the same period.
 * Every line produces a record; every internal CAPTURED payment in the window
 * missing from the statement is flagged MISSING_AT_GATEWAY.
 */
export async function runReconciliation(
  actor: AuthContext,
  input: { gateway: PaymentGateway; from: Date; to: Date; lines: StatementLine[] },
) {
  const runId = randomUUID();
  const counts: Partial<Record<ReconciliationStatus, number>> = {};
  const bump = (s: ReconciliationStatus) => (counts[s] = (counts[s] ?? 0) + 1);
  const seen = new Set<string>();

  await prisma.$transaction(async (tx) => {
    for (const line of input.lines) {
      const payment = await tx.payment.findUnique({ where: { gateway_gatewayOrderId: { gateway: input.gateway, gatewayOrderId: line.gatewayOrderId } } });
      let status: ReconciliationStatus;
      if (!payment) status = 'MISSING_INTERNAL';
      else {
        seen.add(payment.id);
        const internalStatus = payment.status === 'CAPTURED' || payment.status === 'PARTIALLY_REFUNDED' ? 'captured' : payment.status === 'REFUNDED' ? 'refunded' : payment.status.toLowerCase();
        if (BigInt(line.amountMinor) !== payment.amountMinor || line.currency !== payment.currency) status = 'AMOUNT_MISMATCH';
        else if (internalStatus !== line.status) status = 'STATUS_MISMATCH';
        else status = 'MATCHED';
      }
      bump(status);
      await tx.reconciliationRecord.create({
        data: {
          runId,
          gateway: input.gateway,
          gatewayReference: line.gatewayPaymentId,
          paymentId: payment?.id ?? null,
          expectedMinor: payment?.amountMinor ?? null,
          actualMinor: BigInt(line.amountMinor),
          expectedStatus: payment?.status ?? null,
          actualStatus: line.status,
          status,
        },
      });
    }
    const internal = await tx.payment.findMany({
      where: { gateway: input.gateway, status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'] }, capturedAt: { gte: input.from, lt: input.to } },
      select: { id: true, gatewayPaymentId: true, amountMinor: true, status: true },
    });
    for (const p of internal.filter((x) => !seen.has(x.id))) {
      bump('MISSING_AT_GATEWAY');
      await tx.reconciliationRecord.create({
        data: { runId, gateway: input.gateway, gatewayReference: p.gatewayPaymentId, paymentId: p.id, expectedMinor: p.amountMinor, expectedStatus: p.status, status: 'MISSING_AT_GATEWAY' },
      });
    }
    await audit(tx, { action: 'finance.reconciliation_run', entityType: 'reconciliation_run', entityId: runId, actorUserId: actor.userId, metadata: { lines: input.lines.length, counts } });
  });
  return { runId, counts };
}

export async function resolveRecord(actor: AuthContext, id: string, note: string) {
  return prisma.$transaction(async (tx) => {
    const r = await tx.reconciliationRecord.findUnique({ where: { id } });
    if (!r) throw notFound('Reconciliation record');
    if (r.status === 'MATCHED' || r.status === 'RESOLVED') throw conflict('Nothing to resolve');
    await tx.reconciliationRecord.update({ where: { id }, data: { status: 'RESOLVED', resolvedById: actor.userId, resolvedAt: new Date(), resolutionNote: note } });
    await audit(tx, { action: 'finance.reconciliation_resolved', entityType: 'reconciliation_record', entityId: id, metadata: { previous: r.status } });
  });
}
