import { pino } from 'pino';
import { env } from '../config/env.js';
import { getRequestContext } from './request-context.js';

/**
 * Structured JSON logger. Sensitive fields are redacted at the serializer level
 * so that a careless `logger.info({ body })` cannot leak credentials or
 * clinical content.
 */
export const REDACT_PATHS = [
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
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.accountNumber',
  '*.accountNumberEncrypted',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-razorpay-signature"]',
  'res.headers["set-cookie"]',
];

export const logger = pino({
  level: env.APP_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  base: { service: 'carevanta-api', env: env.APP_ENV },
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  timestamp: pino.stdTimeFunctions.isoTime,
  mixin() {
    const ctx = getRequestContext();
    return ctx ? { requestId: ctx.requestId, userId: ctx.userId } : {};
  },
});
