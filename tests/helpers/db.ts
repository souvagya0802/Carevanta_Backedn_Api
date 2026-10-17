import { prisma } from '../../src/lib/prisma.js';

/**
 * Tables holding reference data seeded once per run; everything else is
 * truncated between test files so each file starts from a known state.
 */
const KEEP = new Set([
  '_prisma_migrations',
  'permissions',
  'roles',
  'role_permissions',
  'service_regions',
  'specialities',
  'conditions',
  'condition_speciality_mappings',
  'departments',
  'amenities',
  'services',
  'service_panel_items',
  'notification_templates',
  'platform_settings',
]);

export async function resetDatabase(): Promise<void> {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
  const tables = rows.map((r) => r.tablename).filter((t) => !KEEP.has(t));
  if (tables.length) {
    await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  }
  // Mapping review state may be changed by catalogue tests; restore it.
  await prisma.conditionSpecialityMapping.updateMany({
    data: { reviewStatus: 'PENDING_REVIEW', reviewedById: null, reviewedAt: null, proposedById: null },
  });
}
