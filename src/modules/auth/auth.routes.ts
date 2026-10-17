import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../http/route.js';
import { authLimiter } from '../../middleware/rate-limit.js';
import { prisma } from '../../lib/prisma.js';
import { PasswordSchema } from './passwords.js';
import * as auth from './auth.service.js';
import type { Request } from 'express';
import { buildPage, cursorOrderBy, cursorWhere, PaginationQuery } from '../../lib/pagination.js';
import { notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { deliverSoon } from '../notifications/notifications.service.js';

const client = (req: Request): auth.ClientInfo => ({ ipAddress: req.ip, userAgent: req.get('user-agent') ?? undefined });

const TokenPair = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: z.string(),
  refreshToken: z.string(),
  refreshTokenExpiresAt: z.string(),
  sessionId: z.uuid(),
});

export const MeResponse = z.object({
  id: z.uuid(),
  fullName: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  status: z.string(),
  emailVerified: z.boolean(),
  phoneVerified: z.boolean(),
  mustChangePassword: z.boolean(),
  roles: z.array(z.string()),
  permissions: z.array(z.string()),
  providerMemberships: z.array(z.object({ providerId: z.uuid(), providerName: z.string(), providerType: z.string(), memberRole: z.string() })),
  doctorProviderId: z.uuid().nullable(),
});

export function authRouter(): Router {
  const r = Router();
  const base = '/auth';
  const tags = ['Auth'];

  defineRoute(r, base, {
    method: 'post',
    path: '/login',
    summary: 'Sign in with email/mobile and password',
    tags,
    auth: 'none',
    status: 200,
    middleware: [authLimiter],
    body: z.object({ identifier: z.string().min(3).max(254), password: z.string().min(1).max(128) }),
    response: TokenPair.extend({ mustChangePassword: z.boolean() }),
    handler: ({ body, req }) => auth.login(body.identifier, body.password, client(req)),
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/refresh',
    summary: 'Rotate the refresh token and obtain a new access token',
    tags,
    auth: 'none',
    status: 200,
    middleware: [authLimiter],
    body: z.object({ refreshToken: z.string().min(20).max(200) }),
    response: TokenPair,
    handler: ({ body, req }) => auth.refresh(body.refreshToken, client(req)),
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/logout',
    summary: 'Revoke the current session (or all sessions)',
    tags,
    status: 204,
    body: z.object({ allDevices: z.boolean().default(false) }),
    handler: async ({ body, auth: a }) => {
      await auth.logout(a.sessionId, a.userId, body.allDevices);
    },
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/me',
    summary: 'Current user, roles and effective permissions',
    tags,
    response: MeResponse,
    handler: async ({ auth: a }) => {
      const u = await prisma.user.findUniqueOrThrow({
        where: { id: a.userId },
        include: {
          providerMemberships: { where: { status: 'ACTIVE' }, include: { provider: { select: { displayName: true, type: true } } } },
          doctorProfile: { select: { providerId: true } },
        },
      });
      return {
        id: u.id,
        fullName: u.fullName,
        email: u.email,
        phone: u.phone,
        status: u.status,
        emailVerified: !!u.emailVerifiedAt,
        phoneVerified: !!u.phoneVerifiedAt,
        mustChangePassword: u.mustChangePassword,
        roles: a.roles,
        permissions: [...a.permissions].sort(),
        providerMemberships: u.providerMemberships.map((m) => ({
          providerId: m.providerId,
          providerName: m.provider.displayName,
          providerType: m.provider.type,
          memberRole: m.memberRole,
        })),
        doctorProviderId: u.doctorProfile?.providerId ?? null,
      };
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/password/change',
    summary: 'Change own password (revokes other sessions)',
    tags,
    status: 204,
    middleware: [authLimiter],
    body: z.object({ currentPassword: z.string().min(1).max(128), newPassword: PasswordSchema }),
    handler: async ({ body, auth: a }) => {
      await auth.changePassword(a.userId, a.sessionId, body.currentPassword, body.newPassword);
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/password/forgot',
    summary: 'Request a password-reset message (always 202)',
    tags,
    auth: 'none',
    status: 202,
    middleware: [authLimiter],
    body: z.object({ identifier: z.string().min(3).max(254) }),
    handler: async ({ body }) => {
      await auth.requestPasswordReset(body.identifier);
      deliverSoon();
      return { accepted: true };
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/password/reset',
    summary: 'Reset password with a one-time token (revokes all sessions)',
    tags,
    auth: 'none',
    status: 204,
    middleware: [authLimiter],
    body: z.object({ token: z.string().min(20).max(200), newPassword: PasswordSchema }),
    handler: async ({ body }) => {
      await auth.resetPassword(body.token, body.newPassword);
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/register',
    summary: 'Patient self-registration',
    description: 'Creates a PENDING_VERIFICATION account and a SELF patient profile, and sends a verification code.',
    tags,
    auth: 'none',
    middleware: [authLimiter],
    body: z
      .object({
        fullName: z.string().trim().min(2).max(160),
        email: z.email().max(254).optional(),
        phone: z.string().max(20).optional(),
        password: PasswordSchema,
      })
      .refine((b) => b.email || b.phone, { message: 'email or phone is required' }),
    response: z.object({ id: z.uuid(), status: z.string() }),
    handler: ({ body }) => auth.registerPatient(body),
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/verify/request',
    summary: 'Send a verification code to own email or mobile',
    tags,
    status: 202,
    middleware: [authLimiter],
    body: z.object({ channel: z.enum(['EMAIL', 'SMS']) }),
    handler: async ({ body, auth: a }) => {
      await auth.requestContactVerification(a.userId, body.channel);
      return { accepted: true };
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/verify/confirm',
    summary: 'Confirm an email link token (public) or mobile OTP (signed in)',
    tags,
    auth: 'none',
    status: 200,
    middleware: [authLimiter],
    body: z.object({ token: z.string().min(6).max(200), userId: z.uuid().optional() }),
    response: z.object({ status: z.string() }),
    handler: ({ body }) => auth.confirmContactVerification(body),
  });

  const SessionDto = z.object({
    id: z.uuid(),
    createdAt: z.string(),
    lastUsedAt: z.string(),
    expiresAt: z.string(),
    userAgent: z.string().nullable(),
    ipAddress: z.string().nullable(),
    current: z.boolean(),
  });

  defineRoute(r, base, {
    kind: 'list',
    method: 'get',
    path: '/sessions',
    summary: 'List own active sessions',
    tags,
    query: PaginationQuery,
    response: SessionDto,
    handler: async ({ query, auth: a }) => {
      const rows = await prisma.session.findMany({
        where: { userId: a.userId, revokedAt: null, expiresAt: { gt: new Date() }, ...cursorWhere(query.cursor) },
        orderBy: cursorOrderBy(),
        take: query.limit + 1,
      });
      const { items, page } = buildPage(rows, query.limit, (s) => s.createdAt);
      return {
        page,
        items: items.map((s) => ({
          id: s.id,
          createdAt: s.createdAt.toISOString(),
          lastUsedAt: s.lastUsedAt.toISOString(),
          expiresAt: s.expiresAt.toISOString(),
          userAgent: s.userAgent,
          ipAddress: s.ipAddress,
          current: s.id === a.sessionId,
        })),
      };
    },
  });

  defineRoute(r, base, {
    method: 'delete',
    path: '/sessions/:id',
    summary: 'Revoke one of own sessions',
    tags,
    status: 204,
    params: z.object({ id: z.uuid() }),
    handler: async ({ params, auth: a }) => {
      const res = await prisma.session.updateMany({
        where: { id: params.id, userId: a.userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'USER_REVOKED' },
      });
      if (res.count === 0) throw notFound('Session');
      await audit(prisma, { action: 'auth.session_revoked', entityType: 'session', entityId: params.id });
    },
  });

  return r;
}
