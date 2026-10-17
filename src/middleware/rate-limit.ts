import { rateLimit, type Options } from 'express-rate-limit';
import { AppError } from '../lib/errors.js';
import { env } from '../config/env.js';

/**
 * In-memory limiter per API instance. This is a first line of defence; the
 * authoritative brute-force protection is the per-account lockout stored in
 * PostgreSQL. When running more than one instance behind a load balancer,
 * plug a shared store (e.g. Redis) into `store` — see docs/operations.md.
 */
function limiter(opts: Partial<Options>) {
  return rateLimit({
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: () => !env.RATE_LIMIT_ENABLED || (env.APP_ENV === 'test' && process.env.RATE_LIMIT_IN_TESTS !== 'true'),
    handler: (_req, _res, next) => next(new AppError(429, 'RATE_LIMITED', 'Too many requests, please slow down')),
    ...opts,
  });
}

export const globalLimiter = limiter({ windowMs: 60_000, limit: 600 });
export const authLimiter = limiter({ windowMs: 60_000, limit: 20 });
export const sensitiveLimiter = limiter({ windowMs: 60_000, limit: 60 });
