import type { Invoice, InvoiceKind } from '../../../../generated/prisma/client.js';
import { prisma } from '../../../lib/prisma.js';
import { audit } from '../../../lib/audit.js';
import { logger } from '../../../lib/logger.js';
import { getObject, putObject } from '../../../lib/storage.js';
import { getSetting } from '../../settings/settings.service.js';
import { getBranding } from '../../platform/integrations.service.js';
import { allocateSequence, fiscalYearOf, formatNumber } from './numbering.js';
import { renderInvoicePdf, type InvoiceLine, type InvoicePdfInput, type Party, type TaxRow } from './pdf.js';
import type { AuthContext } from '../../../middleware/auth.js';

/**
 * Invoices are immutable documents: they are only ever created, never edited.
 * A correction is a new document (credit note) that references the original.
 *
 * Tax treatment is data-driven and needs legal review (docs/compliance.md):
 * patient invoices name the provider as the supplier and the platform as the
 * marketplace facilitator; healthcare services are shown as GST-exempt lines;
 * medicines are shown as "MRP inclusive of GST" because no per-line GST rate is
 * stored yet.
 */

export interface InvoiceSettings {
  sellerLegalName: string;
  sellerAddress: string;
  sellerGstin: string;
  sellerPan: string;
  sellerStateCode: string;
  numberPrefix: string;
  commissionGstPercent: number;
  footerNote: string;
  showProviderGstin: boolean;
}

export async function invoiceSettings(): Promise<InvoiceSettings> {
  const s = async (k: string, d: string) => String((await getSetting<unknown>(k, d)) ?? d);
  return {
    sellerLegalName: await s('invoice.seller_legal_name', (await getBranding()).name),
    sellerAddress: await s('invoice.seller_address', ''),
    sellerGstin: await s('invoice.seller_gstin', ''),
    sellerPan: await s('invoice.seller_pan', ''),
    sellerStateCode: await s('invoice.seller_state_code', ''),
    numberPrefix: (await s('invoice.number_prefix', 'CV')).trim() || 'CV',
    commissionGstPercent: Number(await getSetting<number>('invoice.commission_gst_percent', 18)),
    footerNote: await s('invoice.footer_note', ''),
    showProviderGstin: (await getSetting<boolean>('invoice.show_provider_gstin', true)) !== false,
  };
}

const TITLE: Record<InvoiceKind, string> = {
  TAX_INVOICE: 'Tax Invoice',
  CREDIT_NOTE: 'Credit Note',
  COMMISSION_INVOICE: 'Commission Invoice',
  SETTLEMENT_STATEMENT: 'Settlement Statement',
};

const SOURCE_LABEL: Record<string, string> = {
  APPOINTMENT: 'Consultation',
  DIAGNOSTIC_ORDER: 'Diagnostic Tests',
  PHARMACY_ORDER: 'Medicines',
  AMBULANCE_DISPATCH: 'Ambulance Service',
};

/** Public metadata shape (API contract). */
export function invoiceMeta(i: Invoice & { sourceType?: string | null; sourceId?: string | null }) {
  return {
    id: i.id,
    number: i.number,
    kind: i.kind,
    issuedAt: i.issuedAt.toISOString(),
    currency: i.currency,
    totalMinor: Number(i.totalMinor),
    taxMinor: Number(i.taxMinor),
    sourceType: i.sourceType ?? null,
    sourceId: i.sourceId ?? null,
    transactionId: i.transactionId,
    providerId: i.providerId,
    patientProfileId: i.patientProfileId,
    pdfUrl: `/api/v1/invoices/${i.id}/pdf`,
  };
}
export type InvoiceMeta = ReturnType<typeof invoiceMeta>;

/** Attach sourceType/sourceId (from the transaction) to a list of invoices. */
export async function withSource(rows: Invoice[]): Promise<InvoiceMeta[]> {
  const ids = [...new Set(rows.map((r) => r.transactionId).filter((x): x is string => !!x))];
  const txns = ids.length
    ? await prisma.serviceTransaction.findMany({ where: { id: { in: ids } }, select: { id: true, sourceType: true, appointmentId: true, diagnosticOrderId: true, pharmacyOrderId: true, dispatchRequestId: true } })
    : [];
  const byId = new Map(txns.map((t) => [t.id, t]));
  return rows.map((r) => {
    const t = r.transactionId ? byId.get(r.transactionId) : undefined;
    return invoiceMeta({ ...r, sourceType: t?.sourceType ?? null, sourceId: t ? t.appointmentId ?? t.diagnosticOrderId ?? t.pharmacyOrderId ?? t.dispatchRequestId : null });
  });
}

async function loadLogo() {
  const b = await getBranding();
  if (!b.logo) return { name: b.name, logo: null };
  try {
    return { name: b.name, logo: { bytes: await getObject(b.logo.storageKey), mimeType: b.logo.mimeType } };
  } catch {
    return { name: b.name, logo: null };
  }
}

function platformParty(s: InvoiceSettings): Party {
  return { name: s.sellerLegalName, address: s.sellerAddress || null, gstin: s.sellerGstin || null, pan: s.sellerPan || null, stateCode: s.sellerStateCode || null };
}

async function providerParty(providerId: string, s: InvoiceSettings): Promise<Party & { state?: string | null }> {
  const p = await prisma.provider.findUniqueOrThrow({ where: { id: providerId }, select: { legalName: true, displayName: true, gstin: true } });
  const loc =
    (await prisma.providerLocation.findFirst({ where: { providerId, isPrimary: true } })) ??
    (await prisma.providerLocation.findFirst({ where: { providerId }, orderBy: { createdAt: 'asc' } }));
  const address = loc ? [loc.addressLine1, loc.addressLine2, `${loc.city}, ${loc.state} ${loc.pincode}`].filter(Boolean).join(', ') : null;
  return { name: p.legalName || p.displayName, address, gstin: s.showProviderGstin ? p.gstin : null, state: loc?.state ?? null };
}

interface Draft {
  kind: InvoiceKind;
  transactionId?: string | null;
  settlementBatchId?: string | null;
  providerId: string;
  patientProfileId?: string | null;
  currency: string;
  lines: InvoiceLine[];
  taxRows: TaxRow[];
  seller: Party;
  sellerLabel?: string;
  buyer: Party;
  facilitator?: Party | null;
  placeOfSupply?: string | null;
  references?: { label: string; value: string }[];
  notes?: string[];
  supersedesInvoiceId?: string | null;
}

/** Number, render, store and record one document. Returns the existing one when a concurrent call won. */
async function issue(d: Draft, findExisting: () => Promise<Invoice | null>): Promise<Invoice> {
  const s = await invoiceSettings();
  const issuedAt = new Date();
  const fiscalYear = fiscalYearOf(issuedAt);
  const sequence = await allocateSequence(d.kind, fiscalYear);
  const number = formatNumber(s.numberPrefix, d.kind, fiscalYear, sequence);
  const subtotalMinor = d.lines.reduce((a, l) => a + l.amountMinor, 0);
  const taxMinor = d.taxRows.reduce((a, t) => a + t.amountMinor, 0);
  const totalMinor = subtotalMinor + taxMinor;
  const brand = await loadLogo();
  const pdf = await renderInvoicePdf({
    title: TITLE[d.kind], number, issuedAt, placeOfSupply: d.placeOfSupply, platformName: brand.name, logo: brand.logo,
    seller: d.seller, sellerLabel: d.sellerLabel, buyer: d.buyer, facilitator: d.facilitator, lines: d.lines, taxRows: d.taxRows,
    subtotalMinor, taxMinor, totalMinor, currency: d.currency, references: d.references, notes: d.notes, footerNote: s.footerNote || null,
  });
  const stored = await putObject('invoices', pdf, 'application/pdf');
  try {
    const inv = await prisma.invoice.create({
      data: {
        number, kind: d.kind, fiscalYear, sequence, transactionId: d.transactionId ?? null, settlementBatchId: d.settlementBatchId ?? null,
        providerId: d.providerId, patientProfileId: d.patientProfileId ?? null, issuedAt, currency: d.currency,
        subtotalMinor: BigInt(subtotalMinor), taxMinor: BigInt(taxMinor), totalMinor: BigInt(totalMinor),
        taxBreakdown: d.taxRows as object, lines: d.lines as object, seller: { ...d.seller, label: d.sellerLabel ?? 'Supplier', facilitator: d.facilitator ?? null } as object, buyer: d.buyer as object,
        pdfStorageKey: stored.key, pdfSha256: stored.sha256, supersedesInvoiceId: d.supersedesInvoiceId ?? null,
      },
    });
    await audit(prisma, { action: 'invoice.issued', entityType: 'invoice', entityId: inv.id, actorType: 'SYSTEM', metadata: { number, kind: d.kind, transactionId: d.transactionId ?? null } });
    return inv;
  } catch (err) {
    const existing = await findExisting();
    if (existing) return existing; // lost an idempotency race; the allocated number stays unused (see docs/compliance.md)
    throw err;
  }
}

const PAID_STATES = ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const;

async function loadTxn(transactionId: string) {
  return prisma.serviceTransaction.findUnique({
    where: { id: transactionId },
    include: { payments: { orderBy: { createdAt: 'asc' } }, refunds: { orderBy: { createdAt: 'asc' } }, patient: { select: { fullName: true, phone: true } } },
  });
}

/** Tax invoice for a paid transaction (once per transaction). */
export async function ensureTaxInvoice(transactionId: string): Promise<Invoice | null> {
  const find = () => prisma.invoice.findFirst({ where: { transactionId, kind: 'TAX_INVOICE' } });
  const existing = await find();
  if (existing) return existing;
  const txn = await loadTxn(transactionId);
  if (!txn || !(PAID_STATES as readonly string[]).includes(txn.status)) return null;
  const paid = txn.payments.filter((p) => ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(p.status));
  if (!paid.length) return null;
  const s = await invoiceSettings();
  const seller = await providerParty(txn.providerId, s);
  const gross = Number(txn.grossMinor);
  const isMedicine = txn.sourceType === 'PHARMACY_ORDER';
  const line: InvoiceLine = {
    description: `${SOURCE_LABEL[txn.sourceType] ?? 'Service'} (Booking ${txn.reference})`,
    hsnSac: null,
    quantity: 1,
    unitMinor: gross,
    amountMinor: gross,
    taxPercent: null,
    taxMinor: 0,
    note: isMedicine ? 'Incl. GST' : 'Exempt',
  };
  const pay = paid[paid.length - 1]!;
  return issue(
    {
      kind: 'TAX_INVOICE', transactionId: txn.id, providerId: txn.providerId, patientProfileId: txn.patientProfileId, currency: txn.currency,
      lines: [line], taxRows: [], seller, buyer: { name: txn.patient?.fullName ?? 'Patient', phone: txn.patient?.phone ?? null },
      facilitator: platformParty(s), placeOfSupply: seller.state ?? null,
      references: [
        { label: 'Booking Reference', value: txn.reference },
        { label: 'Payment Reference', value: pay.gatewayPaymentId ?? pay.gatewayOrderId },
        { label: 'Payment Method', value: `${pay.method ?? 'online'} (${pay.gateway === 'MANUAL' ? 'recorded manually' : pay.gateway.toLowerCase().replace('_', ' ')})` },
      ],
      notes: [
        isMedicine
          ? 'Medicine prices are MRP inclusive of GST.'
          : 'Healthcare services are shown as exempt from GST (subject to confirmation for this service and provider).',
        `The provider named above is the supplier. ${s.sellerLegalName} facilitates the booking and payment as a marketplace.`,
      ],
    },
    find,
  );
}

/** One credit note per succeeded refund; issues the tax invoice first when it is missing. */
export async function ensureCreditNote(refundId: string): Promise<Invoice | null> {
  const find = () => findCreditNote(refundId);
  const existing = await findCreditNote(refundId);
  if (existing) return existing;
  const refund = await prisma.refund.findUnique({ where: { id: refundId } });
  if (!refund || refund.status !== 'SUCCEEDED') return null;
  const original = await ensureTaxInvoice(refund.transactionId);
  if (!original) return null;
  const txn = (await loadTxn(refund.transactionId))!;
  const s = await invoiceSettings();
  const seller = await providerParty(txn.providerId, s);
  const amount = Number(refund.amountMinor);
  return issue(
    {
      kind: 'CREDIT_NOTE', transactionId: txn.id, providerId: txn.providerId, patientProfileId: txn.patientProfileId, currency: refund.currency,
      lines: [{ description: `Refund against invoice ${original.number}: ${refund.reason}`.slice(0, 200), hsnSac: null, quantity: 1, unitMinor: amount, amountMinor: amount, taxPercent: null, taxMinor: 0, note: null, refundId: refund.id }],
      taxRows: [], seller, buyer: { name: txn.patient?.fullName ?? 'Patient', phone: txn.patient?.phone ?? null }, facilitator: platformParty(s),
      placeOfSupply: seller.state ?? null, supersedesInvoiceId: original.id,
      references: [
        { label: 'Original Invoice', value: original.number },
        { label: 'Refund Reference', value: refund.reference },
        { label: 'Booking Reference', value: txn.reference },
      ],
      notes: ['This credit note reduces the amount of the original invoice by the refunded amount.'],
    },
    find,
  );
}

async function findCreditNote(refundId: string): Promise<Invoice | null> {
  const refund = await prisma.refund.findUnique({ where: { id: refundId }, select: { transactionId: true } });
  if (!refund) return null;
  const notes = await prisma.invoice.findMany({ where: { transactionId: refund.transactionId, kind: 'CREDIT_NOTE' } });
  return notes.find((n) => Array.isArray(n.lines) && (n.lines as unknown as InvoiceLine[]).some((l) => l.refundId === refundId)) ?? null;
}

/** Issue every document a transaction should have and does not (tax invoice, credit notes). Returns how many were created. */
export async function ensureTransactionInvoices(transactionId: string): Promise<number> {
  let created = 0;
  const before = await prisma.invoice.count({ where: { transactionId } });
  const inv = await ensureTaxInvoice(transactionId);
  if (inv) {
    const refunds = await prisma.refund.findMany({ where: { transactionId, status: 'SUCCEEDED' }, select: { id: true } });
    for (const r of refunds) await ensureCreditNote(r.id);
  }
  created = (await prisma.invoice.count({ where: { transactionId } })) - before;
  return created;
}

/** Never lets invoice generation break a payment flow: failures are logged and fixed by regenerate-missing. */
export async function ensureTransactionInvoicesSafe(transactionId: string | null | undefined): Promise<void> {
  if (!transactionId) return;
  try {
    await ensureTransactionInvoices(transactionId);
  } catch (err) {
    logger.warn({ transactionId, err: (err as Error).message }, 'invoice generation failed; run regenerate-missing');
  }
}

/** Admin backfill for one transaction or for every paid transaction (audited). */
export async function regenerateMissing(actor: AuthContext, transactionId?: string) {
  const ids = transactionId
    ? [transactionId]
    : (await prisma.serviceTransaction.findMany({ where: { status: { in: [...PAID_STATES] } }, select: { id: true } })).map((t) => t.id);
  let created = 0;
  for (const id of ids) created += await ensureTransactionInvoices(id);
  await audit(prisma, { action: 'invoice.regenerate_missing', entityType: transactionId ? 'transaction' : 'invoice', entityId: transactionId ?? 'all', actorUserId: actor.userId, metadata: { transactions: ids.length, created } });
  return { transactions: ids.length, created };
}

/** A sample tax invoice with the current settings and logo; nothing is stored or numbered. */
export async function samplePdf(): Promise<Buffer> {
  const s = await invoiceSettings();
  const brand = await loadLogo();
  const input: InvoicePdfInput = {
    title: 'Tax Invoice (Sample)', number: formatNumber(s.numberPrefix, 'TAX_INVOICE', fiscalYearOf(new Date()), 0), issuedAt: new Date(),
    placeOfSupply: 'Sample State', platformName: brand.name, logo: brand.logo,
    seller: { name: 'Sample Clinic Private Limited', address: '1 Sample Road, Sample City, Sample State 000000', gstin: s.showProviderGstin ? '00AAAAA0000A0Z0' : null },
    buyer: { name: 'Sample Patient', phone: '+91 00000 00000' }, facilitator: platformParty(s),
    lines: [{ description: 'Consultation (Booking SAMPLE-0001)', quantity: 1, unitMinor: 50_000, amountMinor: 50_000, taxPercent: null, taxMinor: 0, note: 'Exempt' }],
    taxRows: [], subtotalMinor: 50_000, taxMinor: 0, totalMinor: 50_000, currency: 'INR',
    references: [{ label: 'Payment Reference', value: 'SAMPLE' }, { label: 'Payment Method', value: 'upi' }],
    notes: ['Sample document for previewing the layout. Not a real invoice.'], footerNote: s.footerNote || null,
  };
  return renderInvoicePdf(input);
}
