import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { invalidateSetting } from '../../src/modules/settings/settings.service.js';
import { allocateSequence, fiscalYearOf, formatNumber } from '../../src/modules/finance/invoices/numbering.js';
import { amountInWords, formatMinor } from '../../src/modules/finance/invoices/pdf.js';
import { resetDatabase } from '../helpers/db.js';
import { actor, api, idem, type Actor } from '../helpers/factory.js';
import { affiliatedDoctor, patient, slotsFor } from '../helpers/fixtures.js';

// 1×1 PNG (synthetic logo).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

const binary = (res: any, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

beforeAll(async () => {
  await resetDatabase();
  await prisma.platformSetting.update({ where: { key: 'booking.require_provider_confirmation' }, data: { value: false } });
  invalidateSetting();
});
afterAll(async () => {
  await prisma.platformSetting.update({ where: { key: 'booking.require_provider_confirmation' }, data: { value: true } });
  await prisma.platformSetting.deleteMany({ where: { key: 'branding.logo' } });
  invalidateSetting();
});

describe('invoice numbering', () => {
  it('uses the Indian fiscal year (April–March, IST) and the prefix', () => {
    expect(fiscalYearOf(new Date('2027-03-31T18:29:00Z'))).toBe('2026-27'); // 23:59 IST 31 Mar
    expect(fiscalYearOf(new Date('2027-03-31T18:30:00Z'))).toBe('2027-28'); // 00:00 IST 1 Apr
    expect(formatNumber('CV', 'TAX_INVOICE', '2026-27', 1)).toBe('CV-INV-2026-27-000001');
    expect(formatNumber('CV', 'CREDIT_NOTE', '2026-27', 42)).toBe('CV-CRN-2026-27-000042');
  });

  it('allocates consecutive numbers atomically under 20 concurrent callers, separately per year', async () => {
    const seqs = await Promise.all(Array.from({ length: 20 }, () => allocateSequence('SETTLEMENT_STATEMENT', '2090-91')));
    expect([...seqs].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(await allocateSequence('SETTLEMENT_STATEMENT', '2091-92')).toBe(1); // rollover starts again at 1
    expect(await allocateSequence('SETTLEMENT_STATEMENT', '2090-91')).toBe(21);
  });

  it('formats amounts the Indian way and in words', () => {
    expect(formatMinor(10_000_000)).toBe('1,00,000.00');
    expect(amountInWords(123_456)).toBe('Rupees One Thousand Two Hundred Thirty Four and Fifty Six Paise only');
    expect(amountInWords(1_50_00_000_00)).toBe('Rupees One Crore Fifty Lakh only');
  });
});

describe('invoices end to end', () => {
  let ctx: Awaited<ReturnType<typeof affiliatedDoctor>>;
  let slots: { id: string }[];
  let finance: Actor;
  let officer: Actor;
  let admin: Actor;

  beforeAll(async () => {
    ctx = await affiliatedDoctor({ feeMinor: 60000 });
    const scheduler = await actor(['PLATFORM_ADMIN']);
    slots = (await slotsFor(scheduler, ctx.doctor.id, ctx.hospital.locationId, { capacity: 1, startMinute: 540, endMinute: 900 })).slots;
    finance = await actor(['FINANCE_APPROVER']);
    officer = await actor(['FINANCE_OFFICER']);
    admin = await actor(['SUPER_ADMIN']);
    const logo = await api().put('/api/v1/admin/branding/logo').set({ Authorization: `Bearer ${admin.tokens.accessToken}`, 'Content-Type': 'image/png' }).send(PNG);
    expect(logo.status, JSON.stringify(logo.body)).toBe(200);
  });

  async function paidBooking(slotId: string) {
    const p = await patient();
    const b = await p.post('/api/v1/patient/appointments', { slotId, patientProfileId: p.profileId }, idem());
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    const txnId = b.body.data.transaction.id as string;
    const pay = await finance.post(`/api/v1/admin/finance/transactions/${txnId}/manual-payments`, { receivedBy: 'PLATFORM', amountMinor: 60000, method: 'UPI', reference: `UPI${txnId.slice(-8)}`, receivedAt: new Date().toISOString(), note: 'UPI received in platform account' });
    expect(pay.status, JSON.stringify(pay.body)).toBe(200);
    return { patient: p, txnId };
  }

  it('issues a tax invoice on capture, a credit note on refund, and enforces object-level access', async () => {
    const { patient: p, txnId } = await paidBooking(slots[0]!.id);
    const list = await p.get(`/api/v1/patient/transactions/${txnId}/invoices`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.data.items).toHaveLength(1);
    const inv = list.body.data.items[0];
    expect(inv).toMatchObject({ kind: 'TAX_INVOICE', totalMinor: 60000, sourceType: 'APPOINTMENT', pdfUrl: `/api/v1/invoices/${inv.id}/pdf` });
    expect(inv.number).toMatch(/^CV-INV-\d{4}-\d{2}-\d{6}$/);

    // PDF: real, has the number, the logo image, attachment headers.
    const pdf = await p.get(inv.pdfUrl).buffer(true).parse(binary);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toBe(`attachment; filename="${inv.number}.pdf"`);
    expect(pdf.headers['cache-control']).toBe('private, no-store');
    const bytes = pdf.body as Buffer;
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(1024);
    expect(bytes.toString('latin1')).toContain(inv.number);
    expect(bytes.toString('latin1')).toMatch(/\/Subtype \/Image/);

    // Idempotent: regenerate-missing creates nothing new.
    const regen = await finance.post(`/api/v1/admin/finance/transactions/${txnId}/invoices/regenerate-missing`);
    expect(regen.status, JSON.stringify(regen.body)).toBe(200);
    expect(regen.body.data.created).toBe(0);

    // Access: other patient 403, unknown 404, provider owner yes, another provider 403, admin yes.
    const other = await patient();
    expect((await other.get(`/api/v1/invoices/${inv.id}`)).status).toBe(403);
    expect((await other.get(inv.pdfUrl)).status).toBe(403);
    expect((await other.get('/api/v1/invoices/0190a0a0-0000-7000-8000-000000000000')).status).toBe(404);
    const txn = await prisma.serviceTransaction.findUniqueOrThrow({ where: { id: txnId } });
    expect(txn.providerId).toBe(ctx.hospital.id);
    expect((await ctx.hospitalOwner.get(`/api/v1/invoices/${inv.id}`)).status).toBe(200);
    const portalList = await ctx.hospitalOwner.get(`/api/v1/portal/providers/${ctx.hospital.id}/invoices?limit=10`);
    expect(portalList.status).toBe(200);
    expect(portalList.body.data.map((i: { id: string }) => i.id)).toContain(inv.id);
    const otherProvider = await affiliatedDoctor({ feeMinor: 50000 });
    expect((await otherProvider.hospitalOwner.get(`/api/v1/invoices/${inv.id}`)).status).toBe(403);
    expect((await otherProvider.hospitalOwner.get(`/api/v1/portal/providers/${ctx.hospital.id}/invoices`)).status).toBe(403);
    expect((await finance.get(`/api/v1/invoices/${inv.id}`)).status).toBe(200);
    expect((await finance.get(`/api/v1/admin/finance/transactions/${txnId}/invoices`)).body.data.items).toHaveLength(1);

    // Refund → credit note referencing the original.
    const req = await officer.post('/api/v1/admin/finance/refunds', { transactionId: txnId, amountMinor: 20000, reason: 'Partial refund for a delayed consultation' }, idem());
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    const done = await finance.post(`/api/v1/admin/finance/refunds/${req.body.data.id}/record-manual`, { method: 'UPI', processedAt: new Date().toISOString(), note: 'Refunded by UPI to the patient' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const after = await p.get(`/api/v1/patient/transactions/${txnId}/invoices`);
    expect(after.body.data.items.map((i: { kind: string }) => i.kind)).toEqual(['TAX_INVOICE', 'CREDIT_NOTE']);
    const cn = await prisma.invoice.findUniqueOrThrow({ where: { id: after.body.data.items[1].id } });
    expect(cn.supersedesInvoiceId).toBe(inv.id);
    expect(Number(cn.totalMinor)).toBe(20000);
    expect(cn.number).toMatch(/^CV-CRN-/);

    // Patient's account-wide list, newest first.
    const mine = await p.get('/api/v1/patient/invoices?limit=1');
    expect(mine.status).toBe(200);
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0].kind).toBe('CREDIT_NOTE');
    expect(mine.body.page.hasMore).toBe(true);
    const next = await p.get(`/api/v1/patient/invoices?limit=1&cursor=${mine.body.page.nextCursor}`);
    expect(next.body.data[0].id).toBe(inv.id);
  });

  it('serves a sample invoice PDF to finance staff only', async () => {
    const res = await finance.get('/api/v1/admin/finance/invoices/sample.pdf').buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect((res.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const p = await patient();
    expect((await p.get('/api/v1/admin/finance/invoices/sample.pdf')).status).toBe(403);
  });

  it('returns an empty settlement document list (commission invoices deferred)', async () => {
    const res = await ctx.hospitalOwner.get(`/api/v1/portal/providers/${ctx.hospital.id}/settlements/0190a0a0-0000-7000-8000-000000000000/invoices`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });
});
