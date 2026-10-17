import { z } from 'zod';
import { toJsonMinor } from '../lib/money.js';

/** Shared DTO helpers so every module serialises the same way. */
export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
export const isoDate = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);
export const minor = (v: bigint | null | undefined): number | null => toJsonMinor(v);
export const dec = (v: { toNumber(): number } | null | undefined): number | null => (v == null ? null : v.toNumber());

export const Money = z.number().int().describe('Integer minor units (paise)');
export const MoneyInput = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).describe('Integer minor units (paise)');
export const Currency = z.literal('INR');
export const DateString = z.iso.date();
export const DateTimeString = z.iso.datetime({ offset: true });
export const Phone = z
  .string()
  .trim()
  .regex(/^(\+[1-9]\d{7,14}|[6-9]\d{9})$/, 'Mobile number must be E.164 (+91…) or a 10-digit Indian mobile')
  .transform((v) => (v.startsWith('+') ? v : `+91${v}`));
export const Pincode = z.string().regex(/^[1-9][0-9]{5}$/, 'Invalid Indian PIN code');
/** GSTIN check digit (mod-36 weighted sum, as published by GSTN). Catches the typos the format regex cannot. */
export function gstinChecksumValid(gstin: string): boolean {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const s = gstin.toUpperCase();
  if (s.length !== 15) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = chars.indexOf(s[i]!);
    if (v < 0) return false;
    const weighted = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(weighted / 36) + (weighted % 36);
  }
  return chars[(36 - (sum % 36)) % 36] === s[14];
}
export const Gstin = z
  .string()
  .toUpperCase()
  .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Invalid GSTIN format')
  .refine(gstinChecksumValid, 'GSTIN check digit does not match — please re-check the number');
export const Reason = z.string().trim().min(5, 'Please give a reason (min 5 characters)').max(1000);
export const SearchText = z.string().trim().min(1).max(100);
