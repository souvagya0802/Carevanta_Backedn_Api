import { describe, expect, it } from 'vitest';
import { applyBps, clamp, formatInr, fromJsonMinor, toJsonMinor } from '../../src/lib/money.js';
import { calculateCommission, type CommissionTerms } from '../../src/modules/finance/commission.service.js';

const pct = (rateBps: number, extra: Partial<CommissionTerms> = {}): CommissionTerms => ({
  method: 'PERCENTAGE',
  rateBps,
  flatMinor: null,
  minMinor: null,
  maxMinor: null,
  taxRateBps: 0,
  ...extra,
});

describe('applyBps (half-up integer rounding)', () => {
  it('computes exact percentages', () => {
    expect(applyBps(100_000n, 1000)).toBe(10_000n); // 10% of ₹1000
    expect(applyBps(0n, 1000)).toBe(0n);
    expect(applyBps(100n, 0)).toBe(0n);
    expect(applyBps(100n, 10_000)).toBe(100n);
  });
  it('rounds half up and never uses floats', () => {
    expect(applyBps(5n, 1000)).toBe(1n); // 0.5 → 1
    expect(applyBps(4n, 1000)).toBe(0n); // 0.4 → 0
    expect(applyBps(15n, 1000)).toBe(2n); // 1.5 → 2
    expect(applyBps(14n, 1000)).toBe(1n);
    expect(applyBps(333n, 333)).toBe(11n); // 11.0889
    // Values beyond float precision stay exact.
    expect(applyBps(9_007_199_254_740_993n, 5000)).toBe(4_503_599_627_370_497n);
  });
  it('rejects negatives', () => {
    expect(() => applyBps(-1n, 100)).toThrow(RangeError);
  });
});

describe('calculateCommission', () => {
  it('percentage with GST-style tax on commission', () => {
    const r = calculateCommission(pct(1000, { taxRateBps: 1800 }), 60_000n);
    expect(r).toEqual({ baseMinor: 60_000n, commissionMinor: 6_000n, taxMinor: 1_080n, providerNetMinor: 52_920n });
  });
  it('applies min and max bounds', () => {
    expect(calculateCommission(pct(500, { minMinor: 2_000n }), 10_000n).commissionMinor).toBe(2_000n);
    expect(calculateCommission(pct(500, { maxMinor: 10_000n }), 1_000_000n).commissionMinor).toBe(10_000n);
  });
  it('flat fee never exceeds the base', () => {
    const r = calculateCommission({ ...pct(0), method: 'FLAT', rateBps: null, flatMinor: 5_000n }, 3_000n);
    expect(r.commissionMinor).toBe(3_000n);
    expect(r.providerNetMinor).toBe(0n);
  });
  it('keeps provider net non-negative when tax would overflow the base', () => {
    const r = calculateCommission({ ...pct(0), method: 'FLAT', rateBps: null, flatMinor: 1_000n, taxRateBps: 1800 }, 1_000n);
    expect(r.commissionMinor + r.taxMinor).toBeLessThanOrEqual(1_000n);
    expect(r.providerNetMinor).toBeGreaterThanOrEqual(0n);
    expect(r.providerNetMinor).toBe(r.baseMinor - r.commissionMinor - r.taxMinor);
  });
  it('is exhaustive over small bases (invariants hold for every value)', () => {
    for (let base = 0n; base <= 2_000n; base += 7n) {
      for (const terms of [pct(1234, { taxRateBps: 1800 }), pct(10_000, { taxRateBps: 1800 }), { ...pct(0), method: 'FLAT' as const, rateBps: null, flatMinor: 999n, taxRateBps: 500 }]) {
        const r = calculateCommission(terms, base);
        expect(r.commissionMinor >= 0n && r.taxMinor >= 0n && r.providerNetMinor >= 0n).toBe(true);
        expect(r.commissionMinor + r.taxMinor + r.providerNetMinor).toBe(base);
      }
    }
  });
});

describe('JSON money helpers', () => {
  it('round-trips safe integers and refuses unsafe ones', () => {
    expect(toJsonMinor(12_345n)).toBe(12_345);
    expect(fromJsonMinor(12_345)).toBe(12_345n);
    expect(() => toJsonMinor(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(RangeError);
    expect(() => fromJsonMinor(1.5)).toThrow(RangeError);
  });
  it('formats INR', () => {
    expect(formatInr(123_456_78n)).toBe('₹1,23,456.78');
    expect(clamp(5n, 10n, null)).toBe(10n);
  });
});
