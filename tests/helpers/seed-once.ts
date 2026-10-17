import { prisma } from '../../src/lib/prisma.js';
import { seedReferenceData } from '../../src/seed/reference-data.js';

await seedReferenceData(prisma);
// Second run proves the seed is idempotent.
await seedReferenceData(prisma);
await prisma.$disconnect();
