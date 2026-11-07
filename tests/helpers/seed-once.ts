import { prisma } from '../../src/lib/prisma.js';
import { ensureIndexes } from '../../src/lib/mongo-indexes.js';
import { seedReferenceData } from '../../src/seed/reference-data.js';

await ensureIndexes(prisma);
await seedReferenceData(prisma);
// Second run proves the seed is idempotent.
await seedReferenceData(prisma);
await prisma.$disconnect();
