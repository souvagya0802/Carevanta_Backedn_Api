import { prisma } from '../../src/lib/prisma.js';

/**
 * Collections holding reference data seeded once per run; everything else is
 * emptied between test files so each file starts from a known state.
 */
const KEEP = new Set([
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
  'job_leases',
]);

interface ListCollections { cursor: { firstBatch: { name: string; type?: string }[] } }

export async function resetDatabase(): Promise<void> {
  const res = (await prisma.$runCommandRaw({ listCollections: 1, nameOnly: true, authorizedCollections: true })) as unknown as ListCollections;
  const names = res.cursor.firstBatch.filter((c) => (c.type ?? 'collection') === 'collection' && !c.name.startsWith('system.')).map((c) => c.name).filter((n) => !KEEP.has(n));
  // deleteMany keeps the collections and their indexes (dropping would lose the partial indexes).
  await Promise.all(names.map((name) => prisma.$runCommandRaw({ delete: name, deletes: [{ q: {}, limit: 0 }] })));
  // Mapping review state may be changed by catalogue tests; restore it.
  await prisma.conditionSpecialityMapping.updateMany({
    data: { reviewStatus: 'PENDING_REVIEW', reviewedById: null, reviewedAt: null, proposedById: null },
  });
}
