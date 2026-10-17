import { describe, expect, it } from 'vitest';
import { redactForAudit } from '../../src/lib/audit.js';
import { decryptField, encryptField, safeEqual } from '../../src/lib/crypto.js';
import { canTransition } from '../../src/lib/state-machine.js';
import { APPOINTMENT_TRANSITIONS } from '../../src/modules/appointments/appointments.service.js';
import { AFFILIATION_TRANSITIONS } from '../../src/modules/affiliations/affiliations.service.js';
import { PROVIDER_TRANSITIONS } from '../../src/modules/providers/provider-state.js';
import { validateUpload } from '../../src/lib/storage.js';
import { decodeCursor, encodeCursor } from '../../src/lib/pagination.js';
import { istToUtc, utcToIstParts } from '../../src/lib/time.js';
import { PasswordSchema } from '../../src/modules/auth/passwords.js';
import { SYSTEM_ROLES } from '../../src/modules/access/permissions.js';

describe('audit redaction', () => {
  it('removes secrets and free text at any depth', () => {
    const out = redactForAudit({ password: 'x', nested: { refreshToken: 'y', accountNumber: '123', ok: 1 }, description: 'clinical text' }) as any;
    expect(out.password).toBe('[REDACTED]');
    expect(out.nested.refreshToken).toBe('[REDACTED]');
    expect(out.nested.accountNumber).toBe('[REDACTED]');
    expect(out.nested.ok).toBe(1);
    expect(out.description).toBe('[REDACTED]');
  });
});

describe('field encryption', () => {
  it('round-trips and is non-deterministic', () => {
    const a = encryptField('123456789012');
    const b = encryptField('123456789012');
    expect(a).not.toBe(b);
    expect(decryptField(a)).toBe('123456789012');
  });
  it('detects tampering', () => {
    const parts = encryptField('secret').split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptField(parts.join('.'))).toThrow();
  });
  it('compares in constant time', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('state machines', () => {
  it('terminal states have no exits and key paths exist', () => {
    expect(canTransition(APPOINTMENT_TRANSITIONS, 'COMPLETED', 'CANCELLED_BY_PATIENT')).toBe(false);
    expect(canTransition(APPOINTMENT_TRANSITIONS, 'REQUESTED', 'COMPLETED')).toBe(false);
    expect(canTransition(APPOINTMENT_TRANSITIONS, 'CHECKED_IN', 'COMPLETED')).toBe(true);
    expect(canTransition(AFFILIATION_TRANSITIONS, 'ENDED', 'ACTIVE')).toBe(false);
    expect(canTransition(PROVIDER_TRANSITIONS, 'DRAFT', 'APPROVED')).toBe(false);
    expect(canTransition(PROVIDER_TRANSITIONS, 'DEACTIVATED', 'APPROVED')).toBe(false);
  });
});

describe('uploads', () => {
  it('rejects disguised content', () => {
    expect(() => validateUpload(Buffer.from('MZ\x90\x00 fake exe'), 'application/pdf')).toThrow();
    expect(() => validateUpload(Buffer.from('%PDF-1.7 ok'), 'text/html')).toThrow();
    expect(validateUpload(Buffer.from('%PDF-1.7 ok'), 'application/pdf').ext).toBe('pdf');
  });
});

describe('cursors', () => {
  it('round-trips and rejects junk', () => {
    const c = encodeCursor(new Date('2026-10-17T00:00:00Z'), '01890000-0000-7000-8000-000000000000');
    expect(decodeCursor(c)?.id).toBe('01890000-0000-7000-8000-000000000000');
    expect(() => decodeCursor('eyJ0IjoieCJ9')).toThrow();
  });
});

describe('IST conversion', () => {
  it('10:00 IST is 04:30 UTC on the same date', () => {
    const t = istToUtc('2026-10-20', 600);
    expect(t.toISOString()).toBe('2026-10-20T04:30:00.000Z');
    expect(utcToIstParts(t)).toMatchObject({ date: '2026-10-20', minutes: 600 });
    // 02:00 IST belongs to the previous UTC day.
    expect(istToUtc('2026-10-20', 120).toISOString()).toBe('2026-10-19T20:30:00.000Z');
  });
});

describe('password policy and roles', () => {
  it('enforces length and blocks common passwords', () => {
    expect(PasswordSchema.safeParse('short').success).toBe(false);
    expect(PasswordSchema.safeParse('password123').success).toBe(false);
    expect(PasswordSchema.safeParse('aaaaaaaaaaaaaaaa').success).toBe(false);
    expect(PasswordSchema.safeParse('Tamluk-Monsoon-2026').success).toBe(true);
  });
  it('finance maker and checker roles are disjoint for approval', () => {
    const officer = SYSTEM_ROLES.find((r) => r.key === 'FINANCE_OFFICER')!;
    const approver = SYSTEM_ROLES.find((r) => r.key === 'FINANCE_APPROVER')!;
    expect(officer.permissions).not.toContain('finance.settlements.approve');
    expect(approver.permissions).not.toContain('finance.settlements.create');
  });
});
