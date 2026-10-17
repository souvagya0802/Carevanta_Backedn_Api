import argon2 from 'argon2';
import { z } from 'zod';

/**
 * Argon2id with OWASP-recommended parameters (19 MiB, t=2, p=1). Hashes embed
 * their parameters, so they can be raised later; `needsRehash` upgrades a hash
 * transparently at next successful login.
 */
const OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

export function needsRehash(hash: string): boolean {
  return argon2.needsRehash(hash, OPTIONS);
}

// A fixed hash used to equalise timing when the account does not exist.
let dummyHash: Promise<string> | undefined;
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword('carevanta-timing-equaliser-not-a-real-password');
  return dummyHash;
}

const COMMON = new Set(['password', 'password123', '12345678', '123456789', 'qwerty123', 'carevanta123', 'admin123', 'welcome123']);

/** Length-first policy (NIST SP 800-63B): 12–128 chars, not a common password. */
export const PasswordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password must be at most 128 characters')
  .refine((p) => !COMMON.has(p.toLowerCase()), 'This password is too common')
  .refine((p) => new Set(p).size >= 6, 'Password is too repetitive');
