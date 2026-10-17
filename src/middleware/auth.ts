import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { AppError, forbidden, unauthenticated } from '../lib/errors.js';
import { verifyAccessToken } from '../modules/auth/tokens.js';
import { getRequestContext } from '../lib/request-context.js';
import { auditDetached } from '../lib/audit.js';
import type { PermissionKey } from '../modules/access/permissions.js';
import type { UserStatus } from '../../generated/prisma/client.js';

export interface AuthContext {
  userId: string;
  sessionId: string;
  status: UserStatus;
  roles: string[];
  permissions: ReadonlySet<string>;
  isSuperAdmin: boolean;
  has(permission: PermissionKey): boolean;
}

const LOGIN_ALLOWED: readonly UserStatus[] = ['ACTIVE', 'PENDING_VERIFICATION'];

/**
 * Validates the bearer token, then re-loads session, account status and
 * permissions from the database on every request. This costs one indexed query
 * but means suspensions, role revocations and logouts take effect immediately.
 */
export async function loadAuthContext(token: string): Promise<AuthContext> {
  const claims = await verifyAccessToken(token);
  const session = await prisma.session.findUnique({
    where: { id: claims.sid },
    select: {
      userId: true,
      revokedAt: true,
      expiresAt: true,
      user: {
        select: {
          id: true,
          status: true,
          roles: {
            where: { revokedAt: null },
            select: { role: { select: { key: true, permissions: { select: { permission: { select: { key: true } } } } } } },
          },
        },
      },
    },
  });
  if (!session || session.userId !== claims.sub || session.revokedAt || session.expiresAt <= new Date()) {
    throw new AppError(401, 'TOKEN_INVALID', 'Session is no longer valid');
  }
  const user = session.user;
  if (!LOGIN_ALLOWED.includes(user.status)) {
    throw new AppError(403, 'ACCOUNT_INACTIVE', 'This account is not active');
  }
  const roles = user.roles.map((r) => r.role.key);
  // Platform permissions only apply to fully ACTIVE accounts.
  const permissions = new Set<string>(
    user.status === 'ACTIVE' ? user.roles.flatMap((r) => r.role.permissions.map((p) => p.permission.key)) : [],
  );
  const isSuperAdmin = user.status === 'ACTIVE' && roles.includes('SUPER_ADMIN');
  return {
    userId: user.id,
    sessionId: claims.sid,
    status: user.status,
    roles,
    permissions,
    isSuperAdmin,
    has: (p) => permissions.has(p),
  };
}

export const authenticate: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return next(unauthenticated());
  const token = header.slice(7).trim();
  if (!token || token.length > 4096) return next(unauthenticated());
  const auth = await loadAuthContext(token);
  res.locals.auth = auth;
  const ctx = getRequestContext();
  if (ctx) ctx.userId = auth.userId;
  next();
};

export function requirePermissions(required: PermissionKey[]): RequestHandler {
  return async (req, res, next) => {
    const auth = res.locals.auth as AuthContext | undefined;
    if (!auth) return next(unauthenticated());
    const missing = required.filter((p) => !auth.permissions.has(p));
    if (missing.length > 0) {
      await auditDetached({
        action: 'access.denied',
        entityType: 'endpoint',
        entityId: `${req.method} ${req.baseUrl}${req.route?.path ?? ''}`.slice(0, 64),
        actorUserId: auth.userId,
        outcome: 'DENIED',
        metadata: { missing },
      });
      return next(forbidden());
    }
    next();
  };
}
