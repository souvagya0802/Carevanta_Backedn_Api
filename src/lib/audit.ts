import type { Db } from './prisma.js';
import { prisma } from './prisma.js';
import { getRequestContext } from './request-context.js';
import { logger } from './logger.js';

/**
 * Keys whose values must never reach the audit log. Matching is on the key
 * name at any depth; values are replaced, keys kept, so reviewers can still see
 * *that* a field changed.
 */
const FORBIDDEN_KEYS = new Set([
  'password',
  'newpassword',
  'currentpassword',
  'passwordhash',
  'token',
  'accesstoken',
  'refreshtoken',
  'refreshtokenhash',
  'tokenhash',
  'accountnumber',
  'accountnumberencrypted',
  'secret',
  'otp',
  'description', // free text may contain clinical content
  'reasonforvisit',
  'body',
  'comment',
  'payload',
]);

export function redactForAudit(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactForAudit(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = FORBIDDEN_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redactForAudit(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  actorUserId?: string | null;
  actorType?: 'USER' | 'SYSTEM' | 'WEBHOOK';
  outcome?: 'SUCCESS' | 'DENIED' | 'FAILURE';
  metadata?: Record<string, unknown>;
}

/**
 * Write an audit event. Pass the transaction client so the audit row commits
 * or rolls back with the business change it describes.
 */
export async function audit(db: Db, input: AuditInput): Promise<void> {
  const ctx = getRequestContext();
  await db.auditEvent.create({
    data: {
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      actorUserId: input.actorUserId ?? ctx?.userId ?? null,
      actorType: input.actorType ?? (input.actorUserId || ctx?.userId ? 'USER' : 'SYSTEM'),
      outcome: input.outcome ?? 'SUCCESS',
      requestId: ctx?.requestId ?? null,
      ipAddress: ctx?.ipAddress ?? null,
      userAgent: ctx?.userAgent?.slice(0, 300) ?? null,
      metadata: input.metadata ? (redactForAudit(input.metadata) as object) : undefined,
    },
  });
}

/** Best-effort audit outside a transaction (e.g. denied access). Never throws. */
export async function auditDetached(input: AuditInput): Promise<void> {
  try {
    await audit(prisma, input);
  } catch (err) {
    logger.error({ err, action: input.action }, 'failed to write audit event');
  }
}

export async function logSensitiveAccess(
  db: Db,
  input: { resourceType: string; resourceId: string; purpose: string; granted: boolean; actorUserId?: string },
): Promise<void> {
  const ctx = getRequestContext();
  await db.sensitiveAccessLog.create({
    data: {
      actorUserId: input.actorUserId ?? ctx?.userId ?? null,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      purpose: input.purpose.slice(0, 300),
      granted: input.granted,
      requestId: ctx?.requestId ?? null,
    },
  });
}
