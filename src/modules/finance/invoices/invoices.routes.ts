import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { defineRoute, IdParams } from '../../../http/route.js';
import { prisma } from '../../../lib/prisma.js';
import { forbidden, notFound } from '../../../lib/errors.js';
import { getObject } from '../../../lib/storage.js';
import { PaginationQuery, buildPage, cursorOrderBy, cursorWhere } from '../../../lib/pagination.js';
import { authenticate, requirePermissions, type AuthContext } from '../../../middleware/auth.js';
import { assertProviderAccess, capabilitiesForRole } from '../../providers/provider-access.js';
import { regenerateMissing, samplePdf, withSource } from './invoices.service.js';
import type { Invoice } from '../../../../generated/prisma/client.js';

const InvoiceMetaDto = z.object({ id: z.uuid(), number: z.string(), kind: z.string(), pdfUrl: z.string() }).passthrough();
const ItemsDto = z.object({ items: z.array(InvoiceMetaDto) });

/** Patient (account holder of the invoice's patient profile), provider member with view_finance, or finance.read. */
async function canRead(auth: AuthContext, inv: Invoice): Promise<boolean> {
  if (auth.has('finance.read')) return true;
  if (inv.patientProfileId) {
    const p = await prisma.patientProfile.findUnique({ where: { id: inv.patientProfileId }, select: { accountUserId: true } });
    if (p?.accountUserId === auth.userId) return true;
  }
  if (auth.status !== 'ACTIVE') return false;
  const member = await prisma.providerMember.findUnique({ where: { providerId_userId: { providerId: inv.providerId, userId: auth.userId } }, select: { status: true, memberRole: true } });
  return member?.status === 'ACTIVE' && (await capabilitiesForRole(member.memberRole)).includes('view_finance');
}

async function loadReadable(auth: AuthContext, id: string) {
  const inv = await prisma.invoice.findUnique({ where: { id } });
  if (!inv) throw notFound('Invoice');
  if (!(await canRead(auth, inv))) throw forbidden();
  return inv;
}

const byTxn = (transactionId: string) => prisma.invoice.findMany({ where: { transactionId }, orderBy: [{ issuedAt: 'asc' }, { id: 'asc' }] });
const TxnParams = z.object({ transactionId: z.uuid() });
const ProviderTxnParams = z.object({ providerId: z.uuid(), transactionId: z.uuid() });

export function invoicesRouter(): Router {
  const r = Router();

  defineRoute(r, '/invoices', {
    method: 'get',
    path: '/:id',
    summary: 'Invoice metadata',
    description: 'Patient (own), provider member with the view_finance capability (own provider), or finance.read. 404 for unknown ids, 403 otherwise.',
    tags: ['Invoices'],
    params: IdParams,
    response: InvoiceMetaDto,
    handler: async ({ params, auth }) => (await withSource([await loadReadable(auth, params.id)]))[0]!,
  });

  r.get('/invoices/:id/pdf', authenticate, async (req: Request, res: Response) => {
    const auth = res.locals.auth as AuthContext;
    const id = z.uuid().safeParse(req.params.id);
    if (!id.success) throw notFound('Invoice');
    const inv = await loadReadable(auth, id.data);
    const buf = await getObject(inv.pdfStorageKey);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${inv.number}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(buf);
  });

  // ── Patient ─────────────────────────────────────────────────────────────
  defineRoute(r, '/patient', {
    kind: 'list',
    method: 'get',
    path: '/invoices',
    summary: 'All invoices and credit notes for my account (incl. family members), newest first',
    tags: ['Patient app'],
    query: PaginationQuery,
    response: InvoiceMetaDto,
    handler: async ({ query, auth }) => {
      const profiles = await prisma.patientProfile.findMany({ where: { accountUserId: auth.userId }, select: { id: true } });
      const rows = await prisma.invoice.findMany({
        where: { patientProfileId: { in: profiles.map((p) => p.id) }, kind: { in: ['TAX_INVOICE', 'CREDIT_NOTE'] }, ...cursorWhere(query.cursor) },
        orderBy: cursorOrderBy(),
        take: query.limit + 1,
      });
      const { items, page } = buildPage(rows, query.limit, (i) => i.createdAt);
      return { items: await withSource(items), page };
    },
  });

  defineRoute(r, '/patient', {
    method: 'get',
    path: '/transactions/:transactionId/invoices',
    summary: 'Invoice and credit notes for one of my transactions',
    tags: ['Patient app'],
    params: TxnParams,
    response: ItemsDto,
    handler: async ({ params, auth }) => {
      const txn = await prisma.serviceTransaction.findUnique({ where: { id: params.transactionId }, select: { patient: { select: { accountUserId: true } } } });
      if (!txn || txn.patient?.accountUserId !== auth.userId) throw notFound('Transaction');
      return { items: await withSource(await byTxn(params.transactionId)) };
    },
  });

  // ── Provider portal ─────────────────────────────────────────────────────
  const portalAccess = (auth: AuthContext, providerId: string) => assertProviderAccess(auth, providerId, { platformPermission: 'finance.read', capability: 'view_finance' });

  defineRoute(r, '/portal/providers/:providerId', {
    kind: 'list',
    method: 'get',
    path: '/invoices',
    summary: 'Invoices issued for this provider (patient invoices, credit notes, commission documents), newest first',
    tags: ['Provider portal'],
    params: z.object({ providerId: z.uuid() }),
    query: PaginationQuery.extend({ kind: z.enum(['TAX_INVOICE', 'CREDIT_NOTE', 'COMMISSION_INVOICE', 'SETTLEMENT_STATEMENT']).optional() }),
    response: InvoiceMetaDto,
    handler: async ({ params, query, auth }) => {
      await portalAccess(auth, params.providerId);
      const rows = await prisma.invoice.findMany({
        where: { providerId: params.providerId, ...(query.kind ? { kind: query.kind } : {}), ...cursorWhere(query.cursor) },
        orderBy: cursorOrderBy(),
        take: query.limit + 1,
      });
      const { items, page } = buildPage(rows, query.limit, (i) => i.createdAt);
      return { items: await withSource(items), page };
    },
  });

  defineRoute(r, '/portal/providers/:providerId', {
    method: 'get',
    path: '/transactions/:transactionId/invoices',
    summary: 'Invoice and credit notes for one of this provider’s transactions',
    tags: ['Provider portal'],
    params: ProviderTxnParams,
    response: ItemsDto,
    handler: async ({ params, auth }) => {
      await portalAccess(auth, params.providerId);
      const txn = await prisma.serviceTransaction.findUnique({ where: { id: params.transactionId }, select: { providerId: true } });
      if (!txn || txn.providerId !== params.providerId) throw notFound('Transaction');
      return { items: await withSource(await byTxn(params.transactionId)) };
    },
  });

  defineRoute(r, '/portal/providers/:providerId', {
    method: 'get',
    path: '/settlements/:batchId/invoices',
    summary: 'Commission invoice and settlement statement for this provider in a batch',
    tags: ['Provider portal'],
    params: z.object({ providerId: z.uuid(), batchId: z.uuid() }),
    response: ItemsDto,
    handler: async ({ params, auth }) => {
      await portalAccess(auth, params.providerId);
      const rows = await prisma.invoice.findMany({ where: { settlementBatchId: params.batchId, providerId: params.providerId }, orderBy: [{ issuedAt: 'asc' }, { id: 'asc' }] });
      return { items: await withSource(rows) };
    },
  });

  // ── Admin ───────────────────────────────────────────────────────────────
  const adminTags = ['Admin · Finance'];
  defineRoute(r, '/admin/finance', {
    method: 'get',
    path: '/transactions/:transactionId/invoices',
    summary: 'Invoice and credit notes for a transaction',
    tags: adminTags,
    permissions: ['finance.read'],
    params: TxnParams,
    response: ItemsDto,
    handler: async ({ params }) => ({ items: await withSource(await byTxn(params.transactionId)) }),
  });

  defineRoute(r, '/admin/finance', {
    method: 'get',
    path: '/settlements/:batchId/invoices',
    summary: 'Commission invoices and settlement statements in a batch',
    tags: adminTags,
    permissions: ['finance.read'],
    params: z.object({ batchId: z.uuid() }),
    response: ItemsDto,
    handler: async ({ params }) => ({ items: await withSource(await prisma.invoice.findMany({ where: { settlementBatchId: params.batchId }, orderBy: [{ issuedAt: 'asc' }, { id: 'asc' }] })) }),
  });

  defineRoute(r, '/admin/finance', {
    method: 'post',
    path: '/transactions/:transactionId/invoices/regenerate-missing',
    summary: 'Issue any missing tax invoice / credit notes for a paid transaction (audited)',
    tags: adminTags,
    status: 200,
    permissions: ['finance.manual.record'],
    params: TxnParams,
    response: z.object({ transactions: z.number(), created: z.number() }),
    handler: async ({ params, auth }) => {
      const t = await prisma.serviceTransaction.count({ where: { id: params.transactionId } });
      if (!t) throw notFound('Transaction');
      return regenerateMissing(auth, params.transactionId);
    },
  });

  defineRoute(r, '/admin/finance', {
    method: 'post',
    path: '/invoices/regenerate-missing',
    summary: 'Backfill: issue missing tax invoices / credit notes for every paid transaction (audited)',
    tags: adminTags,
    status: 200,
    permissions: ['finance.manual.record'],
    response: z.object({ transactions: z.number(), created: z.number() }),
    handler: ({ auth }) => regenerateMissing(auth),
  });

  r.get('/admin/finance/invoices/sample.pdf', authenticate, requirePermissions(['finance.read']), async (_req: Request, res: Response) => {
    const buf = await samplePdf();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="sample-invoice.pdf"');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buf);
  });

  return r;
}
