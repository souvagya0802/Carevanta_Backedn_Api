import { APPEND_ONLY_MODELS, prisma } from '../src/lib/prisma.js';
import { MODELS } from '../src/lib/mongo-model-manifest.js';

/**
 * `npm run db:backfill-nulls` — write explicit `null` into every optional scalar
 * field that is missing from existing documents. New writes already do this
 * (src/lib/prisma-null-defaults.ts); this brings documents created before that
 * rule, or by tools outside the API, in line so that `where: { field: null }`
 * matches them. Idempotent; safe to run while the API is up.
 */
type AnyDelegate = { updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ count: number }> };
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

let total = 0;
for (const [model, meta] of Object.entries(MODELS)) {
  // Audit trails are append-only by rule; their optional fields are never filtered by null.
  if (APPEND_ONLY_MODELS.has(model)) continue;
  const delegate = (prisma as unknown as Record<string, AnyDelegate>)[lowerFirst(model)];
  if (!delegate) continue;
  for (const field of meta.optionalScalars) {
    const { count } = await delegate.updateMany({ where: { [field]: { isSet: false } }, data: { [field]: null } });
    if (count) {
      total += count;
      console.log(`${model}.${field}: ${count}`);
    }
  }
}
console.log(`Backfilled ${total} missing optional fields.`);
await prisma.$disconnect();
