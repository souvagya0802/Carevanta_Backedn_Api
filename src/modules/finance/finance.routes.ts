import { Router } from 'express';
import { z } from 'zod';
import { defineRoute, IdParams } from '../../http/route.js';
import { prisma } from '../../lib/prisma.js';
import { PaginationQuery, buildPage, cursorOrderBy, cursorWhere } from '../../lib/pagination.js';
import { DateTimeString, MoneyInput, Reason, iso, minor } from '../../http/dto.js';
import { notFound } from '../../lib/errors.js';
import * as policies from './policies.service.js';
import * as payments from './payments.service.js';
import * as settlements from './settlements.service.js';
import * as recon from './reconciliation.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';

const Category = z.enum(['CONSULTATION', 'DIAGNOSTIC', 'PHARMACY', 'PROCEDURE', 'SURGERY', 'AMBULANCE', 'OTHER']);
const ProviderType = z.enum(['DOCTOR', 'HOSPITAL', 'CLINIC', 'DIAGNOSTIC_LAB', 'IMAGING_CENTRE', 'PHARMACY', 'AMBULANCE_OPERATOR']);
const PolicyDto = z.object({ id: z.uuid(), code: z.string(), version: z.number().int(), status: z.string(), legalReviewStatus: z.string() }).passthrough();
const Passthrough = z.object({ id: z.uuid() }).passthrough();

export function txnDto(t: any) {
  return {
    id: t.id,
    reference: t.reference,
    sourceType: t.sourceType,
    sourceId: t.appointmentId ?? t.diagnosticOrderId ?? t.pharmacyOrderId ?? t.dispatchRequestId,
    provider: t.provider ? { id: t.provider.id, displayName: t.provider.displayName, type: t.provider.type } : undefined,
    category: t.category,
    grossMinor: minor(t.grossMinor)!,
    refundedMinor: minor(t.refundedMinor)!,
    currency: t.currency,
    status: t.status,
    attribution: t.attribution,
    commissionEligible: t.commissionEligible,
    eligibilityReason: t.eligibilityReason,
    serviceCompletedAt: iso(t.serviceCompletedAt),
    createdAt: t.createdAt.toISOString(),
  };
}

export function paymentDto(p: any) {
  return {
    id: p.id,
    transactionId: p.transactionId,
    gateway: p.gateway,
    simulated: p.gateway === 'TEST_GATEWAY',
    gatewayOrderId: p.gatewayOrderId,
    gatewayPaymentId: p.gatewayPaymentId,
    amountMinor: minor(p.amountMinor)!,
    refundedMinor: minor(p.refundedMinor)!,
    currency: p.currency,
    status: p.status,
    method: p.method,
    failureReason: p.failureReason,
    capturedAt: iso(p.capturedAt),
    createdAt: p.createdAt.toISOString(),
  };
}

export function refundDto(r: any) {
  return {
    id: r.id,
    reference: r.reference,
    transactionId: r.transactionId,
    paymentId: r.paymentId,
    amountMinor: minor(r.amountMinor)!,
    currency: r.currency,
    reason: r.reason,
    status: r.status,
    requestedById: r.requestedById,
    reviewedById: r.reviewedById,
    reviewedAt: iso(r.reviewedAt),
    reviewNote: r.reviewNote,
    gatewayRefundId: r.gatewayRefundId,
    processedAt: iso(r.processedAt),
    failureReason: r.failureReason,
    createdAt: r.createdAt.toISOString(),
  };
}

function batchDto(b: any) {
  return {
    id: b.id,
    reference: b.reference,
    status: b.status,
    periodEnd: b.periodEnd.toISOString(),
    totalMinor: minor(b.totalMinor)!,
    currency: b.currency,
    itemCount: b.itemCount,
    createdById: b.createdById,
    approvedById: b.approvedById,
    approvedAt: iso(b.approvedAt),
    completedAt: iso(b.completedAt),
    notes: b.notes,
    createdAt: b.createdAt.toISOString(),
    items: b.items?.map((i: any) => ({
      id: i.id,
      providerId: i.providerId,
      providerName: i.provider?.displayName,
      amountMinor: minor(i.amountMinor)!,
      status: i.status,
      payoutReference: i.payoutReference,
      paidAt: iso(i.paidAt),
      failureReason: i.failureReason,
      attemptCount: i.attemptCount,
    })),
  };
}

export function financeRouter(): Router {
  const r = Router();
  const base = '/admin/finance';
  const tags = ['Admin · Finance'];

  // ── Commission policies ────────────────────────────────────────────────
  defineRoute(r, base, {
    kind: 'list',
    method: 'get',
    path: '/commission-policies',
    summary: 'List commission policies (all versions)',
    tags,
    permissions: ['finance.read'],
    query: PaginationQuery.extend({ status: z.enum(['DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'RETIRED']).optional(), category: Category.optional() }),
    response: PolicyDto,
    handler: async ({ query }) => {
      const rows = await prisma.commissionPolicy.findMany({
        where: { ...(query.status ? { status: query.status } : {}), ...(query.category ? { category: query.category } : {}), ...cursorWhere(query.cursor) },
        orderBy: cursorOrderBy(),
        take: query.limit + 1,
      });
      const { items, page } = buildPage(rows, query.limit, (p) => p.createdAt);
      return { items: items.map(policies.policyDto), page };
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/commission-policies',
    summary: 'Draft a commission policy (new code or new version of an existing code)',
    description:
      'Rates are basis points (1000 = 10%). Money is minor units. Policies on PROCEDURE/SURGERY are high-risk under NMC rules on referral commissions and cannot be activated without legal approval.',
    tags,
    permissions: ['finance.policies.manage'],
    body: z.object({
      code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
      name: z.string().trim().min(3).max(160),
      description: z.string().max(2000).optional(),
      category: Category,
      providerType: ProviderType.optional(),
      providerId: z.uuid().optional(),
      agreementId: z.uuid().optional(),
      method: z.enum(['PERCENTAGE', 'FLAT']),
      rateBps: z.number().int().min(0).max(10000).optional(),
      flatMinor: MoneyInput.optional(),
      minMinor: MoneyInput.optional(),
      maxMinor: MoneyInput.optional(),
      taxRateBps: z.number().int().min(0).max(10000).default(0),
      effectiveFrom: DateTimeString,
      effectiveTo: DateTimeString.optional(),
    }),
    response: PolicyDto,
    handler: ({ body, auth }) => policies.createPolicy(auth, body),
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/commission-policies/:id',
    summary: 'Commission policy',
    tags,
    permissions: ['finance.read'],
    params: IdParams,
    response: PolicyDto,
    handler: async ({ params }) => {
      const p = await prisma.commissionPolicy.findUnique({ where: { id: params.id } });
      if (!p) throw notFound('Commission policy');
      return policies.policyDto(p);
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/commission-policies/:id/submit',
    summary: 'Submit a draft for approval',
    tags,
    status: 200,
    permissions: ['finance.policies.manage'],
    params: IdParams,
    response: PolicyDto,
    handler: ({ params, auth }) => policies.submitPolicy(auth, params.id),
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/commission-policies/:id/legal-review',
    summary: 'Record the legal/compliance review outcome',
    tags,
    status: 200,
    permissions: ['finance.policies.legal_review'],
    params: IdParams,
    body: z.object({ status: z.enum(['UNDER_REVIEW', 'APPROVED', 'REJECTED']), note: Reason }),
    response: PolicyDto,
    handler: ({ params, body, auth }) => policies.recordLegalReview(auth, params.id, body.status, body.note),
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/commission-policies/:id/activate',
    summary: 'Approve and activate (checker ≠ author)',
    tags,
    status: 200,
    permissions: ['finance.policies.approve'],
    params: IdParams,
    body: z.object({ supersede: z.boolean().default(false) }),
    response: PolicyDto,
    handler: ({ params, body, auth }) => policies.activatePolicy(auth, params.id, body.supersede),
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/commission-policies/:id/retire',
    summary: 'Retire a policy (future transactions stop using it)',
    tags,
    status: 200,
    permissions: ['finance.policies.approve'],
    params: IdParams,
    body: z.object({ reason: Reason }),
    response: PolicyDto,
    handler: ({ params, body, auth }) => policies.retirePolicy(auth, params.id, body.reason),
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/commission-policies/preview',
    summary: 'Preview which policy applies and the resulting commission',
    tags,
    status: 200,
    permissions: ['finance.read'],
    body: z.object({ category: Category, providerId: z.uuid(), amountMinor: MoneyInput, at: DateTimeString.optional() }),
    handler: ({ body }) => policies.previewCommission({ ...body, amountMinor: BigInt(body.amountMinor), at: body.at ? new Date(body.at) : undefined }),
  });

  // ── Transactions ───────────────────────────────────────────────────────
  defineRoute(r, base, {
    kind: 'list',
    method: 'get',
    path: '/transactions',
    summary: 'Service transactions',
    tags,
    permissions: ['finance.read'],
    query: PaginationQuery.extend({
      status: z.enum(['PENDING_PAYMENT', 'PAID', 'PAY_AT_PROVIDER', 'PARTIALLY_REFUNDED', 'REFUNDED', 'CANCELLED']).optional(),
      providerId: z.uuid().optional(),
      commissionEligible: z.enum(['true', 'false']).optional(),
    }),
    response: Passthrough,
    handler: async ({ query }) => {
      const where: Prisma.ServiceTransactionWhereInput = {
        ...(query.status ? { status: query.status } : {}),
        ...(query.providerId ? { providerId: query.providerId } : {}),
        ...(query.commissionEligible ? { commissionEligible: query.commissionEligible === 'true' } : {}),
        ...cursorWhere(query.cursor),
      };
      const rows = await prisma.serviceTransaction.findMany({ where, include: { provider: { select: { id: true, displayName: true, type: true } } }, orderBy: cursorOrderBy(), take: query.limit + 1 });
      const { items, page } = buildPage(rows, query.limit, (t) => t.createdAt);
      return { items: items.map(txnDto), page };
    },
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/transactions/:id',
    summary: 'Transaction with payments, refunds, commission snapshots and ledger entries',
    tags,
    permissions: ['finance.read'],
    params: IdParams,
    response: Passthrough,
    handler: async ({ params }) => {
      const t = await prisma.serviceTransaction.findUnique({
        where: { id: params.id },
        include: {
          provider: { select: { id: true, displayName: true, type: true } },
          payments: { orderBy: { createdAt: 'asc' } },
          refunds: { orderBy: { createdAt: 'asc' } },
          commissions: { orderBy: { calculatedAt: 'asc' } },
          ledgerEntries: { orderBy: { createdAt: 'asc' } },
        },
      });
      if (!t) throw notFound('Transaction');
      return {
        ...txnDto(t),
        payments: t.payments.map(paymentDto),
        refunds: t.refunds.map(refundDto),
        commissions: t.commissions.map((c) => ({
          id: c.id,
          policyCode: c.policyCode,
          policyVersion: c.policyVersion,
          method: c.method,
          rateBps: c.rateBps,
          flatMinor: minor(c.flatMinor),
          taxRateBps: c.taxRateBps,
          baseMinor: minor(c.baseMinor)!,
          commissionMinor: minor(c.commissionMinor)!,
          taxMinor: minor(c.taxMinor)!,
          providerNetMinor: minor(c.providerNetMinor)!,
          status: c.status,
          calculatedAt: c.calculatedAt.toISOString(),
          reversedAt: iso(c.reversedAt),
        })),
        ledgerEntries: t.ledgerEntries.map((e) => ({ id: e.id, entryType: e.entryType, amountMinor: minor(e.amountMinor)!, settlementItemId: e.settlementItemId, createdAt: e.createdAt.toISOString() })),
      };
    },
  });

  defineRoute(r, base, {
    kind: 'list',
    method: 'get',
    path: '/payments',
    summary: 'Payments',
    tags,
    permissions: ['finance.read'],
    query: PaginationQuery.extend({ status: z.enum(['CREATED', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'PARTIALLY_REFUNDED', 'REFUNDED']).optional() }),
    response: Passthrough,
    handler: async ({ query }) => {
      const rows = await prisma.payment.findMany({ where: { ...(query.status ? { status: query.status } : {}), ...cursorWhere(query.cursor) }, orderBy: cursorOrderBy(), take: query.limit + 1 });
      const { items, page } = buildPage(rows, query.limit, (p) => p.createdAt);
      return { items: items.map(paymentDto), page };
    },
  });

  defineRoute(r, base, {
    kind: 'list',
    method: 'get',
    path: '/webhook-events',
    summary: 'Received payment webhooks (for investigation)',
    tags,
    permissions: ['finance.read'],
    query: PaginationQuery.extend({ status: z.enum(['RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED']).optional() }),
    response: Passthrough,
    handler: async ({ query }) => {
      const rows = await prisma.paymentWebhookEvent.findMany({
        where: { ...(query.status ? { processingStatus: query.status } : {}), ...cursorWhere(query.cursor, 'receivedAt') },
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        select: { id: true, gateway: true, eventId: true, eventType: true, processingStatus: true, processingError: true, receivedAt: true, processedAt: true },
      });
      const { items, page } = buildPage(rows, query.limit, (e) => e.receivedAt);
      return { items: items.map((e) => ({ ...e, receivedAt: e.receivedAt.toISOString(), processedAt: iso(e.processedAt) })), page };
    },
  });

  // ── Refunds ────────────────────────────────────────────────────────────
  defineRoute(r, base, {
    kind: 'list',
    method: 'get',
    path: '/refunds',
    summary: 'Refunds',
    tags,
    permissions: ['finance.read'],
    query: PaginationQuery.extend({ status: z.enum(['REQUESTED', 'APPROVED', 'REJECTED', 'PROCESSING', 'SUCCEEDED', 'FAILED']).optional() }),
    response: Passthrough,
    handler: async ({ query }) => {
      const rows = await prisma.refund.findMany({ where: { ...(query.status ? { status: query.status } : {}), ...cursorWhere(query.cursor) }, orderBy: cursorOrderBy(), take: query.limit + 1 });
      const { items, page } = buildPage(rows, query.limit, (x) => x.createdAt);
      return { items: items.map(refundDto), page };
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/refunds',
    summary: 'Request a refund (maker)',
    tags,
    idempotent: true,
    permissions: ['finance.refunds.request'],
    body: z.object({ transactionId: z.uuid(), amountMinor: MoneyInput.refine((v) => v > 0, 'must be positive'), reason: Reason }),
    response: Passthrough,
    handler: async ({ body, auth, req }) =>
      refundDto(await payments.requestRefund(auth, { ...body, amountMinor: BigInt(body.amountMinor), idempotencyKey: req.header('idempotency-key')! })),
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/refunds/:id/review',
    summary: 'Approve (sends to gateway) or reject a refund (checker)',
    tags,
    status: 200,
    permissions: ['finance.refunds.approve'],
    params: IdParams,
    body: z.object({ decision: z.enum(['APPROVE', 'REJECT']), note: Reason }),
    response: Passthrough,
    handler: async ({ params, body, auth }) => {
      await payments.reviewRefund(auth, params.id, body.decision, body.note);
      return refundDto(await prisma.refund.findUniqueOrThrow({ where: { id: params.id } }));
    },
  });

  // ── Ledger & payables ──────────────────────────────────────────────────
  defineRoute(r, base, {
    method: 'get',
    path: '/providers/:id/balance',
    summary: 'Provider payable balance',
    description: 'Positive = owed to the provider; negative = the provider owes commission (e.g. pay-at-counter bookings).',
    tags,
    permissions: ['finance.read'],
    params: IdParams,
    response: z.object({ balanceMinor: z.number().int(), unsettledMinor: z.number().int() }),
    handler: async ({ params }) => {
      const b = await settlements.providerBalance(params.id);
      return { balanceMinor: minor(b.balanceMinor)!, unsettledMinor: minor(b.unsettledMinor)! };
    },
  });

  defineRoute(r, base, {
    kind: 'list',
    method: 'get',
    path: '/providers/:id/ledger',
    summary: 'Provider ledger entries',
    tags,
    permissions: ['finance.read'],
    params: IdParams,
    query: PaginationQuery,
    response: Passthrough,
    handler: async ({ params, query }) => {
      const rows = await prisma.providerLedgerEntry.findMany({ where: { providerId: params.id, ...cursorWhere(query.cursor) }, orderBy: cursorOrderBy(), take: query.limit + 1 });
      const { items, page } = buildPage(rows, query.limit, (e) => e.createdAt);
      return {
        page,
        items: items.map((e) => ({ id: e.id, entryType: e.entryType, amountMinor: minor(e.amountMinor)!, transactionId: e.transactionId, settlementItemId: e.settlementItemId, description: e.description, createdAt: e.createdAt.toISOString() })),
      };
    },
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/payables',
    summary: 'Providers with unsettled balances',
    tags,
    permissions: ['finance.read'],
    query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
    response: z.array(z.object({ providerId: z.uuid(), displayName: z.string(), unsettledMinor: z.number().int(), entries: z.number().int(), hasVerifiedPayoutAccount: z.boolean() })),
    handler: async ({ query }) => {
      const rows = await prisma.$queryRaw<{ provider_id: string; display_name: string; total: bigint; n: bigint; verified: boolean }[]>`
        SELECT e.provider_id, p.display_name, SUM(e.amount_minor)::bigint AS total, COUNT(*)::bigint AS n,
               EXISTS (SELECT 1 FROM provider_payout_accounts a WHERE a.provider_id = e.provider_id AND a.status = 'VERIFIED') AS verified
          FROM provider_ledger_entries e JOIN providers p ON p.id = e.provider_id
         WHERE e.settlement_item_id IS NULL
         GROUP BY e.provider_id, p.display_name
         ORDER BY total DESC
         LIMIT ${query.limit}`;
      return rows.map((x) => ({ providerId: x.provider_id, displayName: x.display_name, unsettledMinor: minor(x.total)!, entries: Number(x.n), hasVerifiedPayoutAccount: x.verified }));
    },
  });

  // ── Settlements ────────────────────────────────────────────────────────
  defineRoute(r, base, {
    kind: 'list',
    method: 'get',
    path: '/settlements',
    summary: 'Settlement batches',
    tags,
    permissions: ['finance.read'],
    query: PaginationQuery,
    response: Passthrough,
    handler: async ({ query }) => {
      const rows = await prisma.settlementBatch.findMany({ where: cursorWhere(query.cursor), orderBy: cursorOrderBy(), take: query.limit + 1 });
      const { items, page } = buildPage(rows, query.limit, (b) => b.createdAt);
      return { items: items.map(batchDto), page };
    },
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/settlements/:id',
    summary: 'Settlement batch with items',
    tags,
    permissions: ['finance.read'],
    params: IdParams,
    response: Passthrough,
    handler: async ({ params }) => {
      const b = await prisma.settlementBatch.findUnique({ where: { id: params.id }, include: { items: { include: { provider: { select: { displayName: true } } } } } });
      if (!b) throw notFound('Settlement batch');
      return batchDto(b);
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/settlements',
    summary: 'Prepare a settlement batch (maker)',
    tags,
    idempotent: true,
    permissions: ['finance.settlements.create'],
    body: z.object({ asOf: DateTimeString.optional(), notes: z.string().max(1000).optional() }),
    response: Passthrough,
    handler: async ({ body, auth }) => {
      const { batch, skipped } = await settlements.createBatch(auth, { asOf: body.asOf ? new Date(body.asOf) : undefined, notes: body.notes });
      const full = await prisma.settlementBatch.findUniqueOrThrow({ where: { id: batch.id }, include: { items: { include: { provider: { select: { displayName: true } } } } } });
      return { ...batchDto(full), skipped };
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/settlements/:id/approve',
    summary: 'Approve a settlement batch (checker ≠ maker)',
    tags,
    status: 200,
    permissions: ['finance.settlements.approve'],
    params: IdParams,
    response: Passthrough,
    handler: async ({ params, auth }) => {
      await settlements.approveBatch(auth, params.id);
      return batchDto(await prisma.settlementBatch.findUniqueOrThrow({ where: { id: params.id }, include: { items: true } }));
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/settlements/:id/cancel',
    summary: 'Cancel an unpaid batch (entries return to the pool)',
    tags,
    status: 200,
    permissions: ['finance.settlements.create'],
    params: IdParams,
    body: z.object({ reason: Reason }),
    response: Passthrough,
    handler: async ({ params, body, auth }) => {
      await settlements.cancelBatch(auth, params.id, body.reason);
      return batchDto(await prisma.settlementBatch.findUniqueOrThrow({ where: { id: params.id }, include: { items: true } }));
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/settlement-items/:id/payout',
    summary: 'Record a completed bank transfer (UTR required)',
    tags,
    status: 200,
    permissions: ['finance.settlements.record'],
    params: IdParams,
    body: z.object({ payoutReference: z.string().regex(/^[A-Z0-9]{8,32}$/, 'Bank UTR / reference (8–32 alphanumerics)'), paidAt: DateTimeString, evidenceNote: z.string().max(1000).optional() }),
    response: Passthrough,
    handler: async ({ params, body, auth }) => {
      await settlements.recordPayout(auth, params.id, { ...body, paidAt: new Date(body.paidAt) });
      return { id: params.id, status: 'PAID' };
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/settlement-items/:id/failure',
    summary: 'Record a failed transfer (entries return to the pool for retry)',
    tags,
    status: 200,
    permissions: ['finance.settlements.record'],
    params: IdParams,
    body: z.object({ reason: Reason }),
    response: Passthrough,
    handler: async ({ params, body, auth }) => {
      await settlements.recordPayoutFailure(auth, params.id, body.reason);
      return { id: params.id, status: 'FAILED' };
    },
  });

  // ── Reconciliation ─────────────────────────────────────────────────────
  defineRoute(r, base, {
    method: 'post',
    path: '/reconciliation/runs',
    summary: 'Reconcile a gateway statement against internal payments',
    tags,
    permissions: ['finance.reconcile'],
    body: z.object({
      gateway: z.enum(['RAZORPAY', 'TEST_GATEWAY']),
      from: DateTimeString,
      to: DateTimeString,
      lines: z
        .array(
          z.object({
            gatewayPaymentId: z.string().max(64),
            gatewayOrderId: z.string().max(64),
            amountMinor: MoneyInput,
            currency: z.string().length(3),
            status: z.enum(['captured', 'failed', 'refunded', 'authorized']),
          }),
        )
        .max(5000),
    }),
    response: z.object({ runId: z.uuid(), counts: z.record(z.string(), z.number().int()) }),
    handler: ({ body, auth }) => recon.runReconciliation(auth, { ...body, from: new Date(body.from), to: new Date(body.to) }),
  });

  defineRoute(r, base, {
    kind: 'list',
    method: 'get',
    path: '/reconciliation/records',
    summary: 'Reconciliation records (mismatches first)',
    tags,
    permissions: ['finance.read'],
    query: PaginationQuery.extend({ status: z.enum(['MATCHED', 'AMOUNT_MISMATCH', 'STATUS_MISMATCH', 'MISSING_INTERNAL', 'MISSING_AT_GATEWAY', 'RESOLVED']).optional(), runId: z.uuid().optional() }),
    response: Passthrough,
    handler: async ({ query }) => {
      const rows = await prisma.reconciliationRecord.findMany({
        where: { ...(query.status ? { status: query.status } : {}), ...(query.runId ? { runId: query.runId } : {}), ...cursorWhere(query.cursor) },
        orderBy: cursorOrderBy(),
        take: query.limit + 1,
      });
      const { items, page } = buildPage(rows, query.limit, (x) => x.createdAt);
      return {
        page,
        items: items.map((x) => ({ ...x, expectedMinor: minor(x.expectedMinor), actualMinor: minor(x.actualMinor), createdAt: x.createdAt.toISOString(), resolvedAt: iso(x.resolvedAt) })),
      };
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/reconciliation/records/:id/resolve',
    summary: 'Resolve a reconciliation exception with a note',
    tags,
    status: 204,
    permissions: ['finance.reconcile'],
    params: IdParams,
    body: z.object({ note: Reason }),
    handler: ({ params, body, auth }) => recon.resolveRecord(auth, params.id, body.note),
  });

  // ── Patient payment initiation ─────────────────────────────────────────
  defineRoute(r, '/patient', {
    method: 'post',
    path: '/transactions/:id/payment-order',
    summary: 'Create a payment order for one of my bookings',
    description: 'Returns the gateway order for the checkout SDK. Payment is confirmed only by the gateway webhook, never by the app.',
    tags: ['Patient app'],
    idempotent: true,
    params: IdParams,
    response: Passthrough,
    handler: async ({ params, auth, req }) => {
      const txn = await prisma.serviceTransaction.findUnique({ where: { id: params.id }, include: { patient: { select: { accountUserId: true } } } });
      if (!txn || txn.patient?.accountUserId !== auth.userId) throw notFound('Transaction');
      return paymentDto(await payments.createPaymentOrder(txn.id, `${auth.userId}:${req.header('idempotency-key')}`));
    },
  });

  return r;
}
