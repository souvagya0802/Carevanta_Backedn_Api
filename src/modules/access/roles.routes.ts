import { Router } from 'express';
import { z } from 'zod';
import { defineRoute, IdParams } from '../../http/route.js';
import { DateTimeString } from '../../http/dto.js';
import { prisma } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { conflict, forbidden, isPgError, notFound } from '../../lib/errors.js';
import { ALL_PERMISSIONS } from './permissions.js';
import type { AuthContext } from '../../middleware/auth.js';

const RoleDto = z.object({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  scope: z.string(),
  isSystem: z.boolean(),
  permissions: z.array(z.string()),
  /** Users currently holding the role. */
  activeAssignments: z.number().int(),
  /** Every grant ever made, including revoked ones — a role with history cannot be deleted. */
  totalAssignments: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const roleInclude = {
  permissions: { include: { permission: { select: { key: true } } } },
  _count: { select: { users: { where: { revokedAt: null } } } },
} as const;

async function loadRole(id: string) {
  const role = await prisma.role.findUnique({ where: { id }, include: roleInclude });
  if (!role) throw notFound('Role');
  const totalAssignments = await prisma.userRole.count({ where: { roleId: id } });
  return toDto(role, totalAssignments);
}

function toDto(role: { id: string; key: string; name: string; description: string | null; scope: string; isSystem: boolean; createdAt: Date; updatedAt: Date; permissions: { permission: { key: string } }[]; _count: { users: number } }, totalAssignments: number) {
  return {
    id: role.id,
    key: role.key,
    name: role.name,
    description: role.description,
    scope: role.scope,
    isSystem: role.isSystem,
    permissions: role.permissions.map((p) => p.permission.key).sort(),
    activeAssignments: role._count.users,
    totalAssignments,
    createdAt: role.createdAt.toISOString(),
    updatedAt: role.updatedAt.toISOString(),
  };
}

/** Anti-escalation: a custom role may only contain permissions the actor already holds. */
function assertHolds(actor: AuthContext, permissions: string[]) {
  if (actor.isSuperAdmin) return;
  const missing = permissions.filter((p) => !actor.permissions.has(p));
  if (missing.length) throw forbidden('A custom role cannot contain permissions you do not hold', { missing });
}

/**
 * Self-lockout guard: an actor who manages roles only through this very role
 * must not remove `roles.manage` from it, or nobody with that role could undo
 * the change. Super-admins hold every permission implicitly and are exempt.
 */
async function assertNoSelfLockout(actor: AuthContext, roleId: string, roleKey: string, nextPermissions: string[]) {
  if (actor.isSuperAdmin || !actor.roles.includes(roleKey) || nextPermissions.includes('roles.manage')) return;
  const otherSources = await prisma.userRole.count({
    where: { userId: actor.userId, revokedAt: null, roleId: { not: roleId }, role: { permissions: { some: { permission: { key: 'roles.manage' } } } } },
  });
  if (otherSources === 0) throw conflict('Removing roles.manage from a role you hold would lock you out of role management', { permission: 'roles.manage' });
}

const PermissionKeyEnum = z.enum(ALL_PERMISSIONS as [string, ...string[]]);
const Reason = z.string().trim().max(500).optional();
const uniq = (xs: string[]) => Array.from(new Set(xs));

export function rolesRouter(): Router {
  const r = Router();
  const tags = ['Admin · Roles'];

  defineRoute(r, '/admin', {
    method: 'get',
    path: '/permissions',
    summary: 'Permission catalogue',
    tags,
    permissions: ['roles.read'],
    response: z.array(z.object({ key: z.string(), description: z.string(), isSensitive: z.boolean() })),
    handler: () => prisma.permission.findMany({ orderBy: { key: 'asc' }, select: { key: true, description: true, isSensitive: true } }),
  });

  defineRoute(r, '/admin', {
    method: 'get',
    path: '/roles',
    summary: 'List roles with permissions and assignment counts',
    tags,
    permissions: ['roles.read'],
    response: z.array(RoleDto),
    handler: async () => {
      const [roles, history] = await Promise.all([
        prisma.role.findMany({ orderBy: [{ isSystem: 'desc' }, { name: 'asc' }], include: roleInclude }),
        prisma.userRole.groupBy({ by: ['roleId'], _count: { _all: true } }),
      ]);
      const totals = new Map(history.map((h) => [h.roleId, h._count._all]));
      return roles.map((role) => toDto(role, totals.get(role.id) ?? 0));
    },
  });

  defineRoute(r, '/admin', {
    method: 'get',
    path: '/roles/:id',
    summary: 'Role detail',
    tags,
    permissions: ['roles.read'],
    params: IdParams,
    response: RoleDto,
    handler: ({ params }) => loadRole(params.id),
  });

  defineRoute(r, '/admin', {
    method: 'post',
    path: '/roles',
    summary: 'Create a custom role',
    tags,
    permissions: ['roles.manage'],
    body: z.object({
      key: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/, 'UPPER_SNAKE_CASE, 3–64 chars, starting with a letter'),
      name: z.string().trim().min(3).max(120),
      description: z.string().trim().max(500).optional(),
      permissions: z.array(PermissionKeyEnum).min(1).max(ALL_PERMISSIONS.length),
      reason: Reason,
    }),
    response: RoleDto,
    handler: async ({ body, auth }) => {
      const permissions = uniq(body.permissions);
      assertHolds(auth, permissions);
      try {
        const id = await prisma.$transaction(async (tx) => {
          const role = await tx.role.create({
            data: { key: body.key, name: body.name, description: body.description || null, isSystem: false, scope: 'PLATFORM' },
          });
          const perms = await tx.permission.findMany({ where: { key: { in: permissions } } });
          await tx.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })) });
          await audit(tx, { action: 'role.created', entityType: 'role', entityId: role.id, metadata: { key: body.key, permissions, reason: body.reason ?? null } });
          return role.id;
        });
        return loadRole(id);
      } catch (err) {
        if (isPgError(err, '23505')) throw conflict('A role with this key already exists', { field: 'key' });
        throw err;
      }
    },
  });

  defineRoute(r, '/admin', {
    method: 'patch',
    path: '/roles/:id',
    summary: 'Edit a custom role',
    description:
      'System roles are defined in code and cannot be edited here. Pass `expectedUpdatedAt` (the `updatedAt` you last saw) to be rejected with 409 if someone else changed the role in the meantime. Permission changes apply to every current holder immediately.',
    tags,
    permissions: ['roles.manage'],
    params: IdParams,
    body: z
      .object({
        name: z.string().trim().min(3).max(120).optional(),
        description: z.string().trim().max(500).nullable().optional(),
        permissions: z.array(PermissionKeyEnum).min(1).optional(),
        reason: Reason,
        expectedUpdatedAt: DateTimeString.optional(),
      })
      .strict(),
    response: RoleDto,
    handler: async ({ params, body, auth }) => {
      const role = await prisma.role.findUnique({ where: { id: params.id }, include: roleInclude });
      if (!role) throw notFound('Role');
      if (role.isSystem) throw forbidden('System roles cannot be edited');
      if (body.expectedUpdatedAt && new Date(body.expectedUpdatedAt).getTime() !== role.updatedAt.getTime()) {
        throw conflict('This role was changed by someone else since you opened it; reload and try again', { updatedAt: role.updatedAt.toISOString() });
      }
      const next = body.permissions ? uniq(body.permissions) : undefined;
      if (next) {
        assertHolds(auth, next);
        await assertNoSelfLockout(auth, role.id, role.key, next);
      }
      const before = role.permissions.map((p) => p.permission.key).sort();
      await prisma.$transaction(async (tx) => {
        await tx.role.update({
          where: { id: role.id },
          // Always bump updatedAt, even for permission-only edits, so optimistic concurrency sees every change.
          data: { updatedAt: new Date(), ...(body.name ? { name: body.name } : {}), ...(body.description !== undefined ? { description: body.description || null } : {}) },
        });
        if (next) {
          await tx.rolePermission.deleteMany({ where: { roleId: role.id } });
          const perms = await tx.permission.findMany({ where: { key: { in: next } } });
          await tx.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })) });
        }
        await audit(tx, {
          action: 'role.updated',
          entityType: 'role',
          entityId: role.id,
          metadata: {
            key: role.key,
            name: body.name ?? undefined,
            added: next ? next.filter((p) => !before.includes(p)) : [],
            removed: next ? before.filter((p) => !next.includes(p)) : [],
            affectedUsers: role._count.users,
            reason: body.reason ?? null,
          },
        });
      });
      return loadRole(role.id);
    },
  });

  defineRoute(r, '/admin', {
    method: 'delete',
    path: '/roles/:id',
    summary: 'Delete an unused custom role',
    description: 'Only custom roles that were never granted can be deleted; a role with assignment history is kept for audit.',
    tags,
    status: 204,
    permissions: ['roles.manage'],
    params: IdParams,
    handler: async ({ params }) => {
      await prisma.$transaction(async (tx) => {
        const role = await tx.role.findUnique({ where: { id: params.id } });
        if (!role) throw notFound('Role');
        if (role.isSystem) throw forbidden('System roles cannot be deleted');
        const used = await tx.userRole.count({ where: { roleId: role.id } });
        if (used) throw conflict('This role has assignment history; revoke it from users and keep it for audit instead of deleting', { totalAssignments: used });
        await tx.role.delete({ where: { id: role.id } });
        await audit(tx, { action: 'role.deleted', entityType: 'role', entityId: role.id, metadata: { key: role.key } });
      });
    },
  });

  return r;
}
