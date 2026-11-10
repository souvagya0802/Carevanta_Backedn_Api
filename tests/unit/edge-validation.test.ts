import { describe, expect, it } from 'vitest';
import { BirthDate, DateString, Gstin, Phone, Pincode, Reason, gstinChecksumValid } from '../../src/http/dto.js';
import { PasswordSchema } from '../../src/modules/auth/passwords.js';
import { normaliseIdentifier } from '../../src/modules/auth/auth.service.js';
import { decodeCursor, encodeCursor, PaginationQuery } from '../../src/lib/pagination.js';
import { applyBps, formatInr, fromJsonMinor, toJsonMinor } from '../../src/lib/money.js';
import { calculateCommission } from '../../src/modules/finance/commission.service.js';
import { shortName } from '../../src/modules/reviews/reviews.service.js';
import { canTransition, isTerminal } from '../../src/lib/state-machine.js';
import { PROVIDER_TRANSITIONS } from '../../src/modules/providers/provider-state.js';
import { AFFILIATION_TRANSITIONS } from '../../src/modules/affiliations/affiliations.service.js';
import { PHARMACY_TRANSITIONS } from '../../src/modules/pharmacy/pharmacy.routes.js';
import { DIAGNOSTIC_TRANSITIONS } from '../../src/modules/diagnostics/diagnostics.routes.js';
import { DISPATCH_TRANSITIONS } from '../../src/modules/ambulance/ambulance.routes.js';
import { SUPPORT_TRANSITIONS } from '../../src/modules/support/support.routes.js';

describe('EDGE-VAL: Indian phone numbers', () => {
  it('EDGE-VAL-01: accepts 10-digit mobiles starting 6–9 and E.164; refuses landlines, leading zeros, letters, spaces inside', () => {
    expect(Phone.parse('9800011111')).toBe('+919800011111');
    expect(Phone.parse('6000000000')).toBe('+916000000000');
    expect(Phone.parse(' 9800011111 ')).toBe('+919800011111');
    expect(Phone.parse('+919800011111')).toBe('+919800011111');
    expect(Phone.parse('+14155552671')).toBe('+14155552671');
    for (const bad of ['09800011111', '5800011111', '980001111', '98000111111', '+0919800011111', '98000 11111', '+91-9800011111', 'abcdefghij', '', '+1234567']) {
      expect(Phone.safeParse(bad).success, bad).toBe(false);
    }
    // normaliseIdentifier is more forgiving (login): spaces, dashes and brackets are stripped.
    expect(normaliseIdentifier('98000 11111')).toEqual({ phone: '+919800011111' });
    expect(normaliseIdentifier('(+91) 98000-11111')).toEqual({ phone: '+919800011111' });
    expect(normaliseIdentifier('  Someone@Example.COM ')).toEqual({ email: 'someone@example.com' });
    expect(() => normaliseIdentifier('09800011111')).toThrow();
    expect(() => normaliseIdentifier('not an id')).toThrow();
  });
});

describe('EDGE-VAL: PIN codes, GSTIN, dates, reasons', () => {
  it('EDGE-VAL-02: PIN must be six digits not starting with 0', () => {
    for (const ok of ['721636', '100000', '999999']) expect(Pincode.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['072163', '72163', '7216361', '72163a', ' 721636', '721636 ', '']) expect(Pincode.safeParse(bad).success, bad).toBe(false);
  });

  it('EDGE-VAL-03: GSTIN format and check digit; lower-case input is normalised', () => {
    // 27AAPFU0939F1ZV is a commonly cited valid example.
    expect(gstinChecksumValid('27AAPFU0939F1ZV')).toBe(true);
    expect(gstinChecksumValid('27AAPFU0939F1ZW')).toBe(false);
    expect(gstinChecksumValid('27aapfu0939f1zv')).toBe(true);
    expect(gstinChecksumValid('27AAPFU0939F1Z')).toBe(false);
    expect(Gstin.parse('27aapfu0939f1zv')).toBe('27AAPFU0939F1ZV');
    expect(Gstin.safeParse('27AAPFU0939F1ZW').success).toBe(false);
    expect(Gstin.safeParse('27AAPFU0939F0ZV').success).toBe(false); // 13th char must not be 0
    expect(Gstin.safeParse('27AAPFU0939F1YV').success).toBe(false); // 14th char must be Z
  });

  it('EDGE-VAL-04: calendar dates — leap days, month 13, future birth dates, reasons at 4 and 5 characters', () => {
    expect(DateString.safeParse('2024-02-29').success).toBe(true);
    expect(DateString.safeParse('2023-02-29').success).toBe(false);
    expect(DateString.safeParse('2026-13-01').success).toBe(false);
    expect(DateString.safeParse('2026-11-31').success).toBe(false);
    expect(DateString.safeParse('10-11-2026').success).toBe(false);
    expect(DateString.safeParse('2026-11-10T00:00:00Z').success).toBe(false);
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect(BirthDate.safeParse(today).success).toBe(true);
    expect(BirthDate.safeParse(tomorrow).success).toBe(false);
    expect(BirthDate.safeParse('1900-01-01').success).toBe(true);
    expect(Reason.safeParse('abcd').success).toBe(false);
    expect(Reason.safeParse('  abcde  ').success).toBe(true);
    expect(Reason.safeParse('    abcd    ').success).toBe(false);
    expect(Reason.safeParse('x'.repeat(1001)).success).toBe(false);
  });

  it('EDGE-VAL-05: password policy — 11/12/128/129 chars, common words in any case, low variety, unicode', () => {
    expect(PasswordSchema.safeParse('a'.repeat(11)).success).toBe(false);
    expect(PasswordSchema.safeParse('Abcdef123456').success).toBe(true);
    expect(PasswordSchema.safeParse('Abcdef12'.repeat(16)).success).toBe(true);
    expect(PasswordSchema.safeParse('Abcdef12'.repeat(16) + 'x').success).toBe(false);
    expect(PasswordSchema.safeParse('CAREVANTA123').success).toBe(false);
    expect(PasswordSchema.safeParse('PassWord123').success).toBe(false); // 11 chars anyway
    expect(PasswordSchema.safeParse('ababababababab').success).toBe(false);
    expect(PasswordSchema.safeParse('abcdefabcdef').success).toBe(true);
    expect(PasswordSchema.safeParse('সুরক্ষিত-পাসওয়ার্ড-২০২৬').success).toBe(true);
  });
});

describe('EDGE-VAL: pagination cursors', () => {
  it('EDGE-VAL-06: round-trips, refuses tampering, and limit coercion edges', () => {
    const now = new Date();
    const id = '00000000-0000-7000-8000-000000000001';
    const c = encodeCursor(now, id);
    expect(decodeCursor(c)).toEqual({ createdAt: now, id });
    expect(decodeCursor(undefined)).toBeUndefined();
    expect(decodeCursor('')).toBeUndefined();
    for (const bad of ['garbage', Buffer.from('{"t":"x","i":"' + id + '"}').toString('base64url'), Buffer.from('{"t":"' + now.toISOString() + '","i":"not-a-uuid"}').toString('base64url'), Buffer.from('null').toString('base64url'), Buffer.from('"str"').toString('base64url')]) {
      expect(() => decodeCursor(bad), bad).toThrow();
    }
    expect(PaginationQuery.parse({}).limit).toBe(25);
    expect(PaginationQuery.parse({ limit: '100' }).limit).toBe(100);
    expect(PaginationQuery.parse({ limit: '1' }).limit).toBe(1);
    for (const bad of ['0', '101', '-1', '1.5', 'abc', '', ' ']) expect(PaginationQuery.safeParse({ limit: bad }).success, `limit=${bad}`).toBe(false);
    // Scientific notation coerces to a plain integer; harmless and documented.
    expect(PaginationQuery.parse({ limit: '1e2' }).limit).toBe(100);
    expect(PaginationQuery.safeParse({ cursor: 'x'.repeat(201) }).success).toBe(false);
  });
});

describe('EDGE-VAL: money corner cases', () => {
  it('EDGE-VAL-07: zero base, 100 % with tax, flat above base with min/max, negative formatting, unsafe integers', () => {
    const terms = (extra: object) => ({ method: 'PERCENTAGE' as const, rateBps: 1000, flatMinor: null, minMinor: null, maxMinor: null, taxRateBps: 0, ...extra });
    expect(calculateCommission(terms({}), 0n)).toEqual({ baseMinor: 0n, commissionMinor: 0n, taxMinor: 0n, providerNetMinor: 0n });
    // 100 % commission plus 18 % tax can never exceed the base: commission is reduced so net is never negative.
    const full = calculateCommission(terms({ rateBps: 10000, taxRateBps: 1800 }), 118n);
    expect(full.commissionMinor + full.taxMinor).toBeLessThanOrEqual(118n);
    expect(full.providerNetMinor).toBeGreaterThanOrEqual(0n);
    expect(full.commissionMinor).toBe(100n);
    expect(full.taxMinor).toBe(18n);
    // A minimum above the base is capped at the base.
    expect(calculateCommission(terms({ minMinor: 5000n }), 100n).commissionMinor).toBe(100n);
    // min > max (should be refused upstream): clamp applies min then max, so max wins.
    expect(calculateCommission(terms({ minMinor: 50n, maxMinor: 10n }), 1000n).commissionMinor).toBe(10n);
    // Flat zero and percentage zero.
    expect(calculateCommission({ ...terms({}), method: 'FLAT', flatMinor: 0n }, 1000n).commissionMinor).toBe(0n);
    expect(calculateCommission(terms({ rateBps: 0 }), 1000n).commissionMinor).toBe(0n);
    expect(() => calculateCommission(terms({}), -1n)).toThrow(RangeError);
    // Half-up at exactly .5 paise, and the smallest non-zero case.
    expect(applyBps(1n, 5000)).toBe(1n);
    expect(applyBps(1n, 4999)).toBe(0n);
    expect(formatInr(-150n)).toBe('-₹1.50');
    expect(formatInr(0n)).toBe('₹0.00');
    expect(formatInr(123456789n)).toBe('₹12,34,567.89');
    expect(() => fromJsonMinor(2 ** 53)).toThrow(RangeError);
    expect(() => fromJsonMinor(1.5)).toThrow(RangeError);
    expect(() => toJsonMinor(2n ** 53n)).toThrow(RangeError);
    expect(toJsonMinor(null)).toBeNull();
  });
});

describe('EDGE-VAL: review author names', () => {
  it('EDGE-VAL-08: shortName never exposes a full surname and copes with empty, single and multi-word names', () => {
    expect(shortName('Susmita Das Singha')).toBe('Susmita S.');
    expect(shortName('Susmita')).toBe('Susmita');
    expect(shortName('  Susmita   Das ')).toBe('Susmita D.');
    expect(shortName('')).toBe('Patient');
    expect(shortName('   ')).toBe('Patient');
    expect(shortName(null)).toBe('Patient');
    expect(shortName('সুস্মিতা দাস')).toBe('সুস্মিতা দ.');
  });
});

describe('EDGE-VAL: every lifecycle map is closed and sane', () => {
  it('EDGE-VAL-09: terminal states have no exits, no state points to itself, every target exists in the map', () => {
    const maps: Record<string, Record<string, readonly string[]>> = {
      provider: PROVIDER_TRANSITIONS,
      affiliation: AFFILIATION_TRANSITIONS,
      pharmacy: PHARMACY_TRANSITIONS,
      diagnostic: DIAGNOSTIC_TRANSITIONS,
      dispatch: DISPATCH_TRANSITIONS,
      support: SUPPORT_TRANSITIONS,
    };
    for (const [name, map] of Object.entries(maps)) {
      const states = Object.keys(map);
      for (const [from, targets] of Object.entries(map)) {
        expect(targets.includes(from), `${name}.${from} points to itself`).toBe(false);
        for (const to of targets) expect(states.includes(to), `${name}.${from} → unknown ${to}`).toBe(true);
        expect(canTransition(map as never, from as never, from as never)).toBe(false);
      }
      const terminals = states.filter((s) => isTerminal(map as never, s as never));
      expect(terminals.length, `${name} has a terminal state`).toBeGreaterThan(0);
      // Every non-terminal state can eventually reach a terminal state.
      for (const start of states) {
        const seen = new Set<string>();
        const stack = [start];
        while (stack.length) {
          const s = stack.pop()!;
          if (seen.has(s)) continue;
          seen.add(s);
          stack.push(...map[s]!);
        }
        expect([...seen].some((s) => terminals.includes(s)), `${name}.${start} can never finish`).toBe(true);
      }
    }
    expect(canTransition(PROVIDER_TRANSITIONS, 'DEACTIVATED', 'APPROVED')).toBe(false);
    expect(canTransition(PROVIDER_TRANSITIONS, 'SUSPENDED', 'APPROVED')).toBe(true);
    expect(canTransition(PHARMACY_TRANSITIONS, 'OUT_FOR_DELIVERY', 'CANCELLED')).toBe(false);
    expect(canTransition(DIAGNOSTIC_TRANSITIONS, 'PROCESSING', 'CANCELLED')).toBe(false);
  });
});
