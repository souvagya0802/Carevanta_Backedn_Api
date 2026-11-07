import type { PrismaClient } from '../../../generated/prisma/client.js';
import { PERMISSIONS, SENSITIVE_PERMISSIONS, SYSTEM_ROLES, type PermissionKey } from './permissions.js';

/**
 * Idempotently synchronise permission rows and system-role grants with the
 * code catalogue. Safe to run on every deploy. Custom (non-system) roles are
 * never touched.
 */
export async function syncAccessControl(db: PrismaClient): Promise<void> {
  for (const [key, description] of Object.entries(PERMISSIONS)) {
    await db.permission.upsert({
      where: { key },
      create: { key, description, isSensitive: SENSITIVE_PERMISSIONS.includes(key as PermissionKey) },
      update: { description, isSensitive: SENSITIVE_PERMISSIONS.includes(key as PermissionKey) },
    });
  }
  const perms = await db.permission.findMany({ select: { id: true, key: true } });
  const idByKey = new Map(perms.map((p) => [p.key, p.id]));

  for (const def of SYSTEM_ROLES) {
    const role = await db.role.upsert({
      where: { key: def.key },
      create: { key: def.key, name: def.name, description: def.description, isSystem: true, scope: 'PLATFORM' },
      update: { name: def.name, description: def.description, isSystem: true },
    });
    const wanted = new Set(def.permissions.map((k) => idByKey.get(k)!).filter(Boolean));
    const existing = await db.rolePermission.findMany({ where: { roleId: role.id }, select: { permissionId: true } });
    const have = new Set(existing.map((e) => e.permissionId));
    const toAdd = [...wanted].filter((id) => !have.has(id));
    const toRemove = [...have].filter((id) => !wanted.has(id));
    if (toAdd.length) {
      // `toAdd` already excludes existing grants (MongoDB createMany has no skipDuplicates).
      await db.rolePermission.createMany({ data: toAdd.map((permissionId) => ({ roleId: role.id, permissionId })) });
    }
    if (toRemove.length) {
      await db.rolePermission.deleteMany({ where: { roleId: role.id, permissionId: { in: toRemove } } });
    }
  }
}
