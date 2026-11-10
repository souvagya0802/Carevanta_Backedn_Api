import { rateLimit, type Options } from 'express-rate-limit';
import { AppError } from '../lib/errors.js';
import { env } from '../config/env.js';

/**
 * In-memory limiter per API instance. This is a first line of defence; the
 * authoritative brute-force protection is the per-account lockout stored in
 * MongoDB (`users.failedLoginCount` / `lockedUntil`, atomic update). When running
 * more than one instance behind a load balancer, plug a shared store (e.g.
 * Redis) into `store` — see docs/operations.md. Keys are the client IP, so
 * `TRUST_PROXY` must match the number of proxies in front of the API or every
 * client shares the load balancer's address.
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
/**
 * Token refresh has its own budget: refresh tokens are long random secrets (nothing to brute-force), and a
 * clinic with several desks behind one connection refreshes often. Sharing the 20/min login budget logged
 * busy front desks out.
 */
export const refreshLimiter = limiter({ windowMs: 60_000, limit: 300 });
/** Place search / reverse geocoding proxy: protects the free upstream geocoder's quota (per IP, about one call every two seconds). */
export const geoLimiter = limiter({ windowMs: 60_000, limit: 30 });
/**
 * Public discovery search and type-ahead suggestions: unauthenticated, regex-backed queries. Two calls a second
 * per IP is generous for a human typing and bounds the database work a scraper can trigger. Not yet mounted on
 * `/discovery/search` and `/discovery/suggest` (owned by the discovery module) — see docs/qa/readiness-report.md.
 */
export const searchLimiter = limiter({ windowMs: 60_000, limit: 120 });
/** A pharmacy adding medicines missing from the catalogue: generous for a busy counter, bounded against scripted spam. */
export const medicineAddLimiter = limiter({ windowMs: 60 * 60_000, limit: 60 });
