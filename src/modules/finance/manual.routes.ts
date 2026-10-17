import { Router } from 'express';
import { z } from 'zod';
import { defineRoute, IdParams } from '../../http/route.js';
import { prisma } from '../../lib/prisma.js';
import { DateTimeString, MoneyInput, Reason } from '../../http/dto.js';
import { refundDto, txnDto } from './finance.routes.js';
import { replayWebhookEvent } from './payments.service.js';
import { MANUAL_METHODS, markPaymentAbandoned, postAdjustment, recordManualPayment, recordManualRefund } from './manual.service.js';
import { providerBalance } from './settlements.service.js';

const Method = z.enum(MANUAL_METHODS);

/**
 * Manual finance operations for authorised staff — the audited alternative to
 * editing the database when money moved outside the gateway.
 */
export function manualFinanceRouter(): Router {
  const r = Router();
  const base = '/admin/finance';
  const tags = ['Admin · Finance (manual)'];

  defineRoute(r, base, {
    method: 'post',
    path: '/transactions/:id/manual-payments',
    summary: 'Record money received outside the gateway (platform account or at the provider)',
    description:
      'receivedBy=PLATFORM captures a MANUAL payment (amount ≤ due); when fully paid the transaction becomes PAID and, if already completed, the provider earning is posted. receivedBy=PROVIDER marks the transaction PAY_AT_PROVIDER (no money held by the platform). Every call is audited with the reason.',
    tags,
    status: 200,
    permissions: ['finance.manual.record'],
    params: IdParams,
    body: z.object({
      receivedBy: z.enum(['PLATFORM', 'PROVIDER']),
      amountMinor: MoneyInput.optional(),
      method: Method,
      reference: z.string().trim().min(3).max(60).optional(),
      receivedAt: DateTimeString,
      note: Reason,
    }),
    response: z.object({ transactionId: z.uuid(), status: z.string(), paymentId: z.uuid().nullable(), transaction: z.object({ id: z.uuid() }).passthrough() }),
    handler: async ({ params, body, auth }) => {
      const result = await recordManualPayment(auth, params.id, { ...body, amountMinor: BigInt(body.amountMinor ?? 0), receivedAt: new Date(body.receivedAt) });
      const txn = await prisma.serviceTransaction.findUniqueOrThrow({ where: { id: params.id }, include: { provider: { select: { id: true, displayName: true, type: true } } } });
      return { ...result, transaction: txnDto(txn) };
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/payments/:id/mark-abandoned',
    summary: 'Close an abandoned online checkout (CREATED → FAILED)',
    tags,
    status: 200,
    permissions: ['finance.manual.record'],
    params: IdParams,
    body: z.object({ reason: Reason }),
    response: z.object({ id: z.uuid(), status: z.string() }),
    handler: async ({ params, body, auth }) => {
      await markPaymentAbandoned(auth, params.id, body.reason);
      return { id: params.id, status: 'FAILED' };
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/refunds/:id/record-manual',
    summary: 'Record a refund paid to the patient outside the gateway',
    description: 'Allowed for REQUESTED (recorder acts as approver, must differ from requester), APPROVED and FAILED refunds. Applies the same ledger clawback and commission recalculation as a gateway webhook.',
    tags,
    status: 200,
    permissions: ['finance.manual.record'],
    params: IdParams,
    body: z.object({ method: Method, reference: z.string().trim().min(3).max(60).optional(), processedAt: DateTimeString, note: Reason }),
    response: z.object({ id: z.uuid() }).passthrough(),
    handler: async ({ params, body, auth }) => refundDto(await recordManualRefund(auth, params.id, { ...body, processedAt: new Date(body.processedAt) })),
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/providers/:id/adjustments',
    summary: 'Post a manual ledger adjustment for a provider',
    description: 'Positive = owed to the provider (credit), negative = owed by the provider (debit). Capped at ₹10,00,000 per entry; append-only, so corrections are made with an opposite entry.',
    tags,
    permissions: ['finance.manual.record'],
    params: IdParams,
    body: z.object({ amountMinor: z.number().int().refine((v) => v !== 0, 'cannot be zero'), reason: z.string().trim().min(10, 'Please explain the adjustment (min 10 characters)').max(300), transactionId: z.uuid().optional() }),
    response: z.object({ id: z.uuid(), providerId: z.uuid(), amountMinor: z.number().int(), description: z.string().nullable(), createdAt: z.string(), balanceMinor: z.number().int(), unsettledMinor: z.number().int() }),
    handler: async ({ params, body, auth }) => {
      const entry = await postAdjustment(auth, params.id, { ...body, amountMinor: BigInt(body.amountMinor) });
      const b = await providerBalance(params.id);
      return { ...entry, balanceMinor: Number(b.balanceMinor), unsettledMinor: Number(b.unsettledMinor) };
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/webhook-events/:id/replay',
    summary: 'Re-process a FAILED gateway webhook',
    tags,
    status: 200,
    permissions: ['finance.manual.record'],
    params: IdParams,
    response: z.object({ duplicate: z.boolean(), status: z.string() }),
    handler: ({ params, auth }) => replayWebhookEvent(auth, params.id),
  });

  return r;
}
