import PDFDocument from 'pdfkit';

/** Party block printed on a document (seller, buyer, facilitator). */
export interface Party {
  name: string;
  address?: string | null;
  gstin?: string | null;
  pan?: string | null;
  stateCode?: string | null;
  phone?: string | null;
}

export interface InvoiceLine {
  description: string;
  hsnSac?: string | null;
  quantity: number;
  unitMinor: number;
  amountMinor: number;
  taxPercent?: number | null;
  taxMinor?: number;
  note?: string | null;
  refundId?: string;
}

export interface TaxRow { label: string; ratePercent: number | null; baseMinor: number; amountMinor: number }

export interface InvoicePdfInput {
  title: string; // "Tax Invoice", "Credit Note", ...
  number: string;
  issuedAt: Date;
  placeOfSupply?: string | null;
  platformName: string;
  logo?: { bytes: Buffer; mimeType: string } | null;
  seller: Party;
  sellerLabel?: string;
  buyer: Party;
  facilitator?: Party | null;
  lines: InvoiceLine[];
  taxRows: TaxRow[];
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  currency: string;
  references?: { label: string; value: string }[];
  notes?: string[];
  footerNote?: string | null;
}

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Indian digit grouping: 100000 paise → "1,000.00"; 1,00,00,000 → "1,00,000.00". */
export const formatMinor = (minor: number) => inr.format(minor / 100);

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function below100(n: number): string {
  if (n < 20) return ONES[n]!;
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`;
}
function below1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', r ? below100(r) : ''].filter(Boolean).join(' ');
}
/** Indian numbering in words (crore, lakh, thousand). */
export function integerInWords(n: number): string {
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  if (crore) parts.push(`${integerInWords(crore)} Crore`);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  if (lakh) parts.push(`${below100(lakh)} Lakh`);
  const thousand = Math.floor((n % 100_000) / 1000);
  if (thousand) parts.push(`${below100(thousand)} Thousand`);
  const rest = n % 1000;
  if (rest) parts.push(below1000(rest));
  return parts.join(' ');
}
/** 123456 paise → "Rupees One Thousand Two Hundred Thirty Four and Fifty Six Paise only". */
export function amountInWords(minor: number): string {
  const abs = Math.abs(Math.round(minor));
  const rupees = Math.floor(abs / 100);
  const paise = abs % 100;
  return `Rupees ${integerInWords(rupees)}${paise ? ` and ${below100(paise)} Paise` : ''} only`;
}

const BLACK = '#111111';
const MUTED = '#555555';
const LINE = '#cccccc';

/** Render an A4 invoice-style document with pdfkit and return its bytes. */
export function renderInvoicePdf(input: InvoicePdfInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: `${input.title} ${input.number}`, Author: input.platformName } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = 40;
  const right = doc.page.width - 40;
  const width = right - left;

  // Header: logo (PNG/JPEG only — pdfkit cannot embed WebP) or the platform name in bold.
  let logoDrawn = false;
  if (input.logo && (input.logo.mimeType === 'image/png' || input.logo.mimeType === 'image/jpeg')) {
    try {
      doc.image(input.logo.bytes, left, 36, { fit: [140, 48] });
      logoDrawn = true;
    } catch {
      logoDrawn = false;
    }
  }
  if (!logoDrawn) doc.font('Helvetica-Bold').fontSize(20).fillColor(BLACK).text(input.platformName, left, 46, { width: 260 });
  doc.font('Helvetica-Bold').fontSize(16).fillColor(BLACK).text(input.title, left, 40, { width, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED);
  doc.text(`Number: ${input.number}`, left, 62, { width, align: 'right' });
  doc.text(`Date: ${input.issuedAt.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' })}`, { width, align: 'right' });
  if (input.placeOfSupply) doc.text(`Place of Supply: ${input.placeOfSupply}`, { width, align: 'right' });
  doc.moveTo(left, 100).lineTo(right, 100).strokeColor(LINE).stroke();

  // Party blocks.
  const party = (label: string, p: Party, x: number, y: number, w: number) => {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(label.toUpperCase(), x, y, { width: w });
    doc.font('Helvetica-Bold').fontSize(10).fillColor(BLACK).text(p.name, { width: w });
    doc.font('Helvetica').fontSize(9).fillColor(BLACK);
    if (p.address) doc.text(p.address, { width: w });
    if (p.phone) doc.text(`Phone: ${p.phone}`, { width: w });
    if (p.gstin) doc.text(`GSTIN: ${p.gstin}`, { width: w });
    if (p.pan) doc.text(`PAN: ${p.pan}`, { width: w });
    if (p.stateCode) doc.text(`State Code: ${p.stateCode}`, { width: w });
    return doc.y;
  };
  const colW = (width - 20) / 2;
  const yA = party(input.sellerLabel ?? 'Supplier', input.seller, left, 110, colW);
  const yB = party('Billed To', input.buyer, left + colW + 20, 110, colW);
  let y = Math.max(yA, yB) + 8;
  if (input.facilitator) {
    y = party('Facilitated By (Marketplace)', input.facilitator, left, y, width) + 8;
  }

  // Line items.
  const cols = [
    { label: 'Description', w: width - 330, align: 'left' as const },
    { label: 'HSN/SAC', w: 60, align: 'left' as const },
    { label: 'Qty', w: 40, align: 'right' as const },
    { label: 'Unit Price', w: 75, align: 'right' as const },
    { label: 'Tax', w: 65, align: 'right' as const },
    { label: 'Amount', w: 90, align: 'right' as const },
  ];
  const row = (cells: string[], bold: boolean) => {
    const startY = y;
    let x = left;
    let maxY = y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(BLACK);
    cells.forEach((c, i) => {
      doc.text(c, x + 3, startY + 4, { width: cols[i]!.w - 6, align: cols[i]!.align });
      maxY = Math.max(maxY, doc.y);
      x += cols[i]!.w;
    });
    y = maxY + 4;
    doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).stroke();
    if (y > doc.page.height - 140) {
      doc.addPage();
      y = 50;
    }
  };
  doc.rect(left, y, width, 18).fill('#f2f2f2');
  row(cols.map((c) => c.label), true);
  for (const l of input.lines) {
    const tax = l.taxPercent != null ? `${l.taxPercent}%` : l.note ?? '';
    row([l.description, l.hsnSac ?? '', String(l.quantity), formatMinor(l.unitMinor), tax, formatMinor(l.amountMinor)], false);
  }

  // Tax table and totals.
  y += 6;
  if (input.taxRows.length) {
    doc.font('Helvetica-Bold').fontSize(9).text('Tax Summary', left, y);
    y = doc.y + 2;
    for (const t of input.taxRows) {
      doc.font('Helvetica').fontSize(9).text(`${t.label}${t.ratePercent != null ? ` @ ${t.ratePercent}%` : ''} on ${input.currency} ${formatMinor(t.baseMinor)}`, left, y, { width: width - 120 });
      doc.text(formatMinor(t.amountMinor), right - 120, y, { width: 120, align: 'right' });
      y = doc.y + 2;
    }
  }
  const total = (label: string, v: number, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9).fillColor(BLACK);
    doc.text(label, right - 260, y, { width: 140, align: 'right' });
    doc.text(`${input.currency} ${formatMinor(v)}`, right - 120, y, { width: 120, align: 'right' });
    y = doc.y + 3;
  };
  y += 4;
  total('Subtotal', input.subtotalMinor);
  total('Tax', input.taxMinor);
  total('Total', input.totalMinor, true);
  doc.font('Helvetica-Oblique').fontSize(9).fillColor(BLACK).text(`Amount in words: ${amountInWords(input.totalMinor)}`, left, y + 4, { width });
  y = doc.y + 8;

  if (input.references?.length) {
    doc.font('Helvetica').fontSize(9).fillColor(BLACK);
    for (const r of input.references) {
      doc.text(`${r.label}: ${r.value}`, left, y, { width });
      y = doc.y + 1;
    }
    y += 6;
  }
  if (input.notes?.length) {
    doc.font('Helvetica').fontSize(8).fillColor(MUTED);
    for (const n of input.notes) {
      doc.text(n, left, y, { width });
      y = doc.y + 2;
    }
  }
  if (input.footerNote) doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(input.footerNote, left, y + 6, { width });
  doc.font('Helvetica').fontSize(8).fillColor(MUTED).text('This is a computer-generated invoice and does not require a signature.', left, doc.y + 6, { width });

  // Page numbers.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(`Page ${i + 1} of ${range.count}`, left, doc.page.height - 30, { width, align: 'center', lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return done;
}
