import { prisma } from '../../src/lib/prisma.js';
import { ensureIndexes } from '../../src/lib/mongo-indexes.js';
import { seedReferenceData } from '../../src/seed/reference-data.js';

await ensureIndexes(prisma);
await seedReferenceData(prisma);
// Test-only service regions: production seeds none (geography is data an admin creates).
for (const r of [
  { code: 'WB-PMD-MOYNA', name: 'Moyna', district: 'Purba Medinipur', state: 'West Bengal', status: 'PILOT' as const },
  { code: 'WB-PMD-TAMLUK', name: 'Tamluk', district: 'Purba Medinipur', state: 'West Bengal', status: 'PILOT' as const },
]) {
  await prisma.serviceRegion.upsert({ where: { code: r.code }, create: r, update: {} });
}
// Second run proves the seed is idempotent.
await seedReferenceData(prisma);
await prisma.$disconnect();
