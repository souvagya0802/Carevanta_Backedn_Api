import { pino } from 'pino';
import { env } from '../config/env.js';
import { getRequestContext } from './request-context.js';

/**
 * Structured JSON logger. Sensitive fields are redacted at the serializer level
 * so that a careless `logger.info({ body })` cannot leak credentials or
 * clinical content. Secrets are replaced outright; personal identifiers are
 * masked so a line can still be correlated (a***@example.com, •••••21) without
 * the log store becoming a second copy of the contact book.
 */
export const SECRET_KEYS = [
  'password',
  'newPassword',
  'currentPassword',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'cookie',
  'accountNumber',
  'accountNumberEncrypted',
  'secretKey',
  'webhookSecret',
  'apiKey',
  'clientSecret',
  'otp',
];
export const PII_KEYS = ['email', 'phone', 'mobile', 'identifier', 'recipient', 'to', 'fullName', 'contactEmail', 'contactPhone'];

export const REDACT_PATHS = [
  ...SECRET_KEYS.flatMap((k) => [k, `*.${k}`]),
  ...PII_KEYS.flatMap((k) => [k, `*.${k}`]),
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-razorpay-signature"]',
  'res.headers["set-cookie"]',
];

const PII_KEY_SET = new Set(PII_KEYS);

/** Mask a contact value: keep enough to tell two records apart, never enough to contact the person. */
export function maskPii(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '[REDACTED]';
  const at = value.indexOf('@');
  if (at > 0) {
    const domain = value.slice(at + 1);
    return `${value[0]}***@${domain.length > 0 ? domain : '***'}`;
  }
  const digits = value.replace(/\D/g, '');
  if (digits.length >= 4) return `•••${digits.slice(-2)}`;
  return '[REDACTED]';
}

/** pino `censor` callback: secrets vanish, personal identifiers are masked. */
export function censorLogValue(value: unknown, path: string[]): string {
  const key = path[path.length - 1] ?? '';
  return PII_KEY_SET.has(key) ? maskPii(value) : '[REDACTED]';
}

export const logger = pino({
  level: env.APP_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  base: { service: 'carevanta-api', env: env.APP_ENV },
  redact: { paths: REDACT_PATHS, censor: censorLogValue },
  timestamp: pino.stdTimeFunctions.isoTime,
  mixin() {
    const ctx = getRequestContext();
    return ctx ? { requestId: ctx.requestId, userId: ctx.userId } : {};
  },
});
