import type { InvoiceKind } from '../../../../generated/prisma/client.js';
import { prisma } from '../../../lib/prisma.js';

/** Short code per document kind, used in the number: CV-INV-2026-27-000001. */
export const KIND_CODE: Record<InvoiceKind, string> = {
  TAX_INVOICE: 'INV',
  CREDIT_NOTE: 'CRN',
  COMMISSION_INVOICE: 'COM',
  SETTLEMENT_STATEMENT: 'STM',
};

/** Indian fiscal year (April–March) of `at`, evaluated in IST: "2026-27". */
export function fiscalYearOf(at: Date): string {
  const ist = new Date(at.getTime() + 330 * 60_000);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export function formatNumber(prefix: string, kind: InvoiceKind, fiscalYear: string, sequence: number): string {
  return `${prefix}-${KIND_CODE[kind]}-${fiscalYear}-${String(sequence).padStart(6, '0')}`;
}

interface FindAndModifyResult { value?: { next?: number } | null }

/**
 * Allocate the next sequence for (kind, fiscal year). One atomic findAndModify on
 * invoice_counters (never inside a transaction): it returns the value before the
 * increment, so concurrent callers always get distinct consecutive numbers. The
 * first allocation of a year upserts the counter; a lost upsert race (duplicate
 * key) is retried and then finds the row.
 */
export async function allocateSequence(kind: InvoiceKind, fiscalYear: string): Promise<number> {
  const id = `${kind}:${fiscalYear}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = (await prisma.$runCommandRaw({
        findAndModify: 'invoice_counters',
        query: { _id: id },
        update: [{ $set: { next: { $add: [{ $ifNull: ['$next', 1] }, 1] } } }],
        upsert: true,
        new: false,
      })) as unknown as FindAndModifyResult;
      return res.value?.next ?? 1;
    } catch (err) {
      if (attempt < 3 && /E11000|duplicate key/i.test(String((err as Error).message))) continue;
      throw err;
    }
  }
}
