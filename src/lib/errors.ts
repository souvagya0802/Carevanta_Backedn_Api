import { Prisma } from '../../generated/prisma/client.js';

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_LOCKED'
  | 'ACCOUNT_INACTIVE'
  | 'TOKEN_INVALID'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'DUPLICATE'
  | 'INVALID_STATE_TRANSITION'
  | 'SLOT_UNAVAILABLE'
  | 'SLOT_BUSY'
  | 'IDEMPOTENCY_CONFLICT'
  | 'PRECONDITION_FAILED'
  | 'SEPARATION_OF_DUTIES'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'WEBHOOK_SIGNATURE_INVALID'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'VALIDATION_FAILED', message, details);
export const unauthenticated = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'You do not have permission to perform this action', details?: unknown) =>
  new AppError(403, 'FORBIDDEN', message, details);
export const notFound = (entity = 'Resource') => new AppError(404, 'NOT_FOUND', `${entity} not found`);
export const conflict = (message: string, details?: unknown) => new AppError(409, 'CONFLICT', message, details);
export const duplicate = (message: string, details?: unknown) => new AppError(409, 'DUPLICATE', message, details);
export const invalidTransition = (entity: string, from: string, to: string) =>
  new AppError(409, 'INVALID_STATE_TRANSITION', `${entity} cannot move from ${from} to ${to}`, { from, to });
export const preconditionFailed = (message: string, details?: unknown) =>
  new AppError(422, 'PRECONDITION_FAILED', message, details);
export const separationOfDuties = (message: string) => new AppError(403, 'SEPARATION_OF_DUTIES', message);

/** Map known database errors to safe client errors without leaking internals. */
export function fromDatabaseError(err: unknown): AppError | undefined {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2002': {
        const target = (err.meta?.target ?? (err.meta as any)?.driverAdapterError?.cause?.constraint) as unknown;
        return duplicate('A record with these unique values already exists', {
          fields: normaliseTarget(target),
        });
      }
      case 'P2003':
        return conflict('A referenced record does not exist or is still in use');
      case 'P2025':
        return notFound();
      case 'P2034':
        return new AppError(409, 'CONFLICT', 'The operation conflicted with a concurrent change; please retry');
      default:
        break;
    }
  }
  const pgCode = extractPgCode(err);
  switch (pgCode) {
    case '23505':
      return duplicate('A record with these unique values already exists');
    case '23503':
      return conflict('A referenced record does not exist or is still in use');
    case '23514':
      return badRequest('The request violates a data integrity rule', { constraint: extractConstraint(err) });
    case '23P01':
      return conflict('The request overlaps with an existing record', { constraint: extractConstraint(err) });
    case '40001':
    case '40P01':
      return new AppError(409, 'CONFLICT', 'The operation conflicted with a concurrent change; please retry');
    case 'P0001':
      return conflict('This record cannot be modified');
    case '57014':
      return new AppError(503, 'SERVICE_UNAVAILABLE', 'The operation timed out; please retry');
    default:
      return undefined;
  }
}

function normaliseTarget(target: unknown): string[] | undefined {
  if (Array.isArray(target)) return target.map(String);
  if (typeof target === 'string') return [target];
  return undefined;
}

/** Walk Prisma driver-adapter error wrappers to find the PostgreSQL SQLSTATE. */
export function extractPgCode(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  let cur: any = err;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    if (typeof cur.code === 'string' && /^[0-9A-Z]{5}$/.test(cur.code) && !cur.code.startsWith('P2')) return cur.code;
    if (cur.originalCode && typeof cur.originalCode === 'string') return cur.originalCode;
    if (cur.kind === 'postgres' && cur.code) return String(cur.code);
    cur = cur.cause ?? cur.meta?.driverAdapterError?.cause ?? cur.meta?.driverAdapterError;
  }
  return undefined;
}

export function extractConstraint(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  let cur: any = err;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    if (typeof cur.constraint === 'string') return cur.constraint;
    if (cur.constraint?.index) return String(cur.constraint.index);
    cur = cur.cause ?? cur.meta?.driverAdapterError?.cause ?? cur.meta?.driverAdapterError;
  }
  return undefined;
}

export function isPgError(err: unknown, code: string, constraint?: string): boolean {
  if (extractPgCode(err) !== code && !(code === '23505' && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
    return false;
  }
  if (!constraint) return true;
  const c = extractConstraint(err);
  if (c) return c === constraint;
  const meta = (err as any)?.meta;
  return JSON.stringify(meta ?? {}).includes(constraint) || String((err as any)?.message ?? '').includes(constraint);
}
