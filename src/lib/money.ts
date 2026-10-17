/**
 * Money is integer minor units (paise for INR) held in BigInt. Floating point
 * is never used for money. API payloads carry minor units as JSON integers,
 * which is safe up to Number.MAX_SAFE_INTEGER paise (~₹90 trillion).
 */

export const BPS_DENOMINATOR = 10_000n;

/** amount × bps / 10_000, rounded half-up (away from zero for positives). */
export function applyBps(amountMinor: bigint, bps: number | bigint): bigint {
  const b = BigInt(bps);
  if (amountMinor < 0n || b < 0n) throw new RangeError('applyBps expects non-negative inputs');
  const product = amountMinor * b;
  const quotient = product / BPS_DENOMINATOR;
  const remainder = product % BPS_DENOMINATOR;
  return remainder * 2n >= BPS_DENOMINATOR ? quotient + 1n : quotient;
}

export function clamp(value: bigint, min?: bigint | null, max?: bigint | null): bigint {
  let v = value;
  if (min != null && v < min) v = min;
  if (max != null && v > max) v = max;
  return v;
}

export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/** Convert a BigInt minor amount to a JSON-safe number, refusing unsafe values. */
export function toJsonMinor(value: bigint | null | undefined): number | null {
  if (value == null) return null;
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError('Monetary value exceeds JSON safe integer range');
  }
  return Number(value);
}

export function fromJsonMinor(value: number): bigint {
  if (!Number.isSafeInteger(value)) throw new RangeError('Monetary values must be safe integers (minor units)');
  return BigInt(value);
}

export function formatInr(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const rupees = abs / 100n;
  const paise = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}₹${rupees.toLocaleString('en-IN')}.${paise}`;
}
