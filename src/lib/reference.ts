import { randomInt } from 'node:crypto';

// Crockford base32 without I, L, O, U — unambiguous when read over the phone.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Human-friendly reference such as `APT-2610-7K3QH9MX` (prefix, YYMM, 8 random
 * chars ≈ 40 bits). Uniqueness is guaranteed by a DB unique constraint; callers
 * retry on the (very rare) collision via `withUniqueRetry`.
 */
export function makeReference(prefix: string, now = new Date()): string {
  const yymm = `${String(now.getUTCFullYear()).slice(2)}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  let rand = '';
  for (let i = 0; i < 8; i++) rand += ALPHABET[randomInt(ALPHABET.length)];
  return `${prefix}-${yymm}-${rand}`;
}

export const REF = {
  appointment: 'APT',
  diagnosticOrder: 'DXO',
  pharmacyOrder: 'RXO',
  dispatch: 'EMR',
  transaction: 'TXN',
  refund: 'RFD',
  settlement: 'STL',
  supportCase: 'CAS',
  incident: 'INC',
} as const;
