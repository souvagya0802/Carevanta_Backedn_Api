import { Router } from 'express';
import { z } from 'zod';
import { defineRoute, IdParams } from '../../http/route.js';
import { PaginationQuery } from '../../lib/pagination.js';
import { Phone, Reason, SearchText } from '../../http/dto.js';
import { sensitiveLimiter } from '../../middleware/rate-limit.js';
import * as users from './users.service.js';
import { deliverSoon } from '../notifications/notifications.service.js';

const UserStatusEnum = z.enum(['PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'ANONYMISED']);

export const UserSummary = z.object({
  id: z.uuid(),
  fullName: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  status: UserStatusEnum,
  emailVerified: z.boolean(),
  phoneVerified: z.boolean(),
  locked: z.boolean(),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
  roles: z.array(z.string()),
});

const UserDetail = UserSummary.extend({
  mustChangePassword: z.boolean(),
  statusReason: z.string().nullable(),
  failedLoginCount: z.number().int(),
  lockedUntil: z.string().nullable(),
  preferredLanguage: z.string(),
  updatedAt: z.string(),
  roleHistory: z.array(
    z.object({
      roleKey: z.string(),
      roleName: z.string(),
      grantedAt: z.string(),
      grantedById: z.string().nullable(),
      revokedAt: z.string().nullable(),
      revokedById: z.string().nullable(),
    }),
  ),
  providerMemberships: z.array(
    z.object({ providerId: z.uuid(), providerName: z.string(), providerType: z.string(), memberRole: z.string(), status: z.string() }),
  ),
  patientProfileCount: z.number().int(),
  doctorProviderId: z.uuid().nullable(),
});

export function usersRouter(): Router {
  const r = Router();
  const base = '/admin/users';
  const tags = ['Admin · Users'];

  defineRoute(r, base, {
    kind: 'list',
    method: 'get',
    path: '',
    summary: 'Search users',
    tags,
    permissions: ['users.read'],
    query: PaginationQuery.extend({ q: SearchText.optional(), status: UserStatusEnum.optional(), role: z.string().max(64).optional() }),
    response: UserSummary,
    handler: ({ query }) => users.listUsers(query),
  });

  defineRoute(r, base, {
    method: 'post',
    path: '',
    summary: 'Create a user account (invite to set password)',
    tags,
    permissions: ['users.create'],
    body: z
      .object({
        fullName: z.string().trim().min(2).max(160),
        email: z.email().max(254).optional(),
        phone: Phone.optional(),
        roles: z.array(z.string().max(64)).max(10).default([]),
        sendInvite: z.boolean().default(true),
      })
      .refine((b) => b.email || b.phone, { message: 'email or phone is required' }),
    response: UserDetail,
    handler: async ({ body, auth }) => {
      const id = await users.createUser(auth, body);
      if (body.sendInvite) deliverSoon();
      return users.getUser(id);
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/:id/password-reset',
    summary: 'Send the user a one-time password-reset link',
    description: 'The link goes to the account\'s own email (or mobile). Administrators never see the token or set passwords.',
    tags,
    status: 202,
    permissions: ['users.update'],
    middleware: [sensitiveLimiter],
    params: IdParams,
    response: z.object({ channel: z.enum(['EMAIL', 'SMS']), recipient: z.string(), expiresInMinutes: z.number().int() }),
    handler: async ({ params, auth }) => {
      const result = await users.sendPasswordReset(auth, params.id);
      deliverSoon();
      return result;
    },
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/:id',
    summary: 'User details',
    tags,
    permissions: ['users.read'],
    params: IdParams,
    response: UserDetail,
    handler: ({ params }) => users.getUser(params.id),
  });

  defineRoute(r, base, {
    method: 'patch',
    path: '/:id',
    summary: 'Edit permitted profile fields',
    tags,
    permissions: ['users.update'],
    params: IdParams,
    body: z
      .object({
        fullName: z.string().trim().min(2).max(160).optional(),
        email: z.email().max(254).nullable().optional(),
        phone: Phone.nullable().optional(),
        preferredLanguage: z.enum(['en', 'bn', 'hi']).optional(),
      })
      .strict(),
    response: UserDetail,
    handler: async ({ params, body, auth }) => {
      await users.updateUser(auth, params.id, body);
      return users.getUser(params.id);
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/:id/status',
    summary: 'Suspend, reactivate or deactivate an account',
    description: 'Non-active statuses revoke all sessions immediately. You cannot change your own status.',
    tags,
    status: 200,
    permissions: ['users.status'],
    params: IdParams,
    body: z.object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'DEACTIVATED']), reason: Reason }),
    response: UserDetail,
    handler: async ({ params, body, auth }) => {
      await users.changeUserStatus(auth, params.id, body.status, body.reason);
      return users.getUser(params.id);
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/:id/unlock',
    summary: 'Clear a login lockout',
    tags,
    status: 204,
    permissions: ['users.status'],
    params: IdParams,
    handler: async ({ params, auth }) => users.unlockUser(auth, params.id),
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/:id/sessions/revoke',
    summary: 'Revoke all sessions of a user',
    tags,
    status: 204,
    permissions: ['users.sessions.revoke'],
    params: IdParams,
    handler: async ({ params, auth }) => users.revokeUserSessions(auth, params.id),
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/:id/roles',
    summary: 'Grant a platform role',
    description: 'You can only grant roles whose permissions you hold, never to yourself.',
    tags,
    status: 200,
    permissions: ['roles.assign'],
    middleware: [sensitiveLimiter],
    params: IdParams,
    body: z.object({ roleKey: z.string().max(64), reason: z.string().max(500).optional() }),
    response: UserDetail,
    handler: async ({ params, body, auth }) => {
      await users.assignRole(auth, params.id, body.roleKey, body.reason);
      return users.getUser(params.id);
    },
  });

  defineRoute(r, base, {
    method: 'delete',
    path: '/:id/roles/:roleKey',
    summary: 'Revoke a platform role',
    tags,
    status: 200,
    permissions: ['roles.assign'],
    params: z.object({ id: z.uuid(), roleKey: z.string().max(64) }),
    response: UserDetail,
    handler: async ({ params, auth }) => {
      await users.revokeRole(auth, params.id, params.roleKey);
      return users.getUser(params.id);
    },
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/:id/activity',
    summary: 'Recent audit events and login attempts for a user',
    tags,
    permissions: ['users.read', 'audit.read'],
    params: IdParams,
    query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }),
    handler: ({ params, query }) => users.userActivity(params.id, query.limit),
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/:id/anonymise',
    summary: 'Irreversibly anonymise an account (retention policy)',
    tags,
    status: 204,
    permissions: ['users.anonymise'],
    params: IdParams,
    body: z.object({ reason: Reason, confirm: z.literal('ANONYMISE') }),
    handler: async ({ params, body, auth }) => users.anonymiseUser(auth, params.id, body.reason),
  });

  return r;
}
