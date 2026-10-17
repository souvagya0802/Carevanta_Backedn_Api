import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmacSha256Hex(secret: string, input: string | Buffer): string {
  return createHmac('sha256', secret).update(input).digest('hex');
}

/** Constant-time comparison of two hex/ASCII strings. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** URL-safe opaque token with `bytes` of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

const KEY = Buffer.from(env.DATA_ENCRYPTION_KEY, 'base64');
const KEY_ID = 'k1'; // bump when rotating DATA_ENCRYPTION_KEY; keep old keys for decryption

/** AES-256-GCM field encryption: `k1.<iv>.<tag>.<ciphertext>` (base64url). */
export function encryptField(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [KEY_ID, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptField(payload: string): string {
  const [kid, ivB64, tagB64, ctB64] = payload.split('.');
  if (kid !== KEY_ID || !ivB64 || !tagB64 || !ctB64) throw new Error('Unsupported ciphertext format');
  const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
}
