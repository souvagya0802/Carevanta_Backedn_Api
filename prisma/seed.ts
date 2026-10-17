/**
 * Reference-data seed: `npm run db:seed`. Idempotent; safe in every
 * environment. It creates NO user accounts — the first super-admin is created
 * with `npm run admin:bootstrap` (see docs/operations.md).
 */
import { prisma } from '../src/lib/prisma.js';
import { seedReferenceData } from '../src/seed/reference-data.js';

try {
  await seedReferenceData(prisma);
  console.log('Reference data seeded.');
} catch (err) {
  console.error('Seed failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
