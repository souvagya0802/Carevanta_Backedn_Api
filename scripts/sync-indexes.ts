import { prisma } from '../src/lib/prisma.js';
import { ensureIndexes, ALL_RUNTIME_INDEXES } from '../src/lib/mongo-indexes.js';

/**
 * `npm run db:sync` — create (or refresh) every MongoDB index: the ones declared in
 * the Prisma schema (generated manifest, partial where a unique index covers an
 * optional field) and the hand-written partial indexes. Collections are created
 * implicitly. The API and worker run the same routine at start-up, so this is for
 * first deployment, CI and inspecting what will be created. `prisma db push` is
 * not used (it cannot express partial indexes).
 */
const result = await ensureIndexes(prisma);
console.log(`Ensured ${result.created} indexes across ${result.collections} collections:`);
for (const i of ALL_RUNTIME_INDEXES) console.log(`  ${i.collection}.${i.name}${i.unique ? ' (unique)' : ''} ${JSON.stringify(i.key)} where ${JSON.stringify(i.partialFilterExpression ?? {})}`);
await prisma.$disconnect();
