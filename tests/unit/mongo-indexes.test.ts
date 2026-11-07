import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { ALL_RUNTIME_INDEXES, PARTIAL_INDEXES } from '../../src/lib/mongo-indexes.js';
import { SCHEMA_INDEXES } from '../../src/lib/mongo-index-manifest.js';

/**
 * The backend creates every MongoDB index itself from a manifest generated out
 * of the Prisma schema (prisma db push cannot express partial indexes). These
 * tests fail when the committed manifest is stale or an index definition uses a
 * form MongoDB rejects.
 */
describe('MongoDB index manifest', () => {
  it('is up to date with prisma/schema', () => {
    expect(() => execFileSync(process.execPath, ['scripts/generate-index-manifest.mjs', '--check'], { encoding: 'utf8', stdio: 'pipe' })).not.toThrow();
  });

  it('makes every unique index over an optional field partial, under the name Prisma would use', () => {
    const phone = SCHEMA_INDEXES.find((i) => i.name === 'users_phone_key');
    expect(phone).toMatchObject({ collection: 'users', unique: true, partialFilterExpression: { phone: { $type: 'string' } } });
    const booking = SCHEMA_INDEXES.find((i) => i.name === 'appointments_booked_by_user_id_idempotency_key_key');
    expect(booking).toMatchObject({ unique: true, partialFilterExpression: { idempotency_key: { $type: 'string' } } });
    // Required-field uniques stay plain.
    expect(SCHEMA_INDEXES.find((i) => i.name === 'provider_ledger_entries_dedupe_key_key')).toMatchObject({ unique: true });
    expect(SCHEMA_INDEXES.find((i) => i.name === 'provider_ledger_entries_dedupe_key_key')?.partialFilterExpression).toBeUndefined();
  });

  it('uses unique index names and only partial-filter forms MongoDB accepts', () => {
    const names = ALL_RUNTIME_INDEXES.map((i) => i.name);
    expect(new Set(names).size).toBe(names.length);
    const forbidden = /"\$(or|exists|ne|not|nor|regex|where)"/;
    for (const i of [...PARTIAL_INDEXES, ...SCHEMA_INDEXES]) expect(JSON.stringify(i.partialFilterExpression ?? {}), i.name).not.toMatch(forbidden);
  });
});
