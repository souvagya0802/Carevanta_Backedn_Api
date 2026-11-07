import type { Prisma} from '../../generated/prisma/client.js';
import { type PrismaClient } from '../../generated/prisma/client.js';
import { logger } from './logger.js';
import { SCHEMA_INDEXES } from './mongo-index-manifest.js';

/**
 * All MongoDB indexes are created by the application, not by `prisma db push`:
 * the schema-declared ones come from the generated manifest (with partial filters
 * for unique indexes over optional fields, which db push cannot express), and
 * this file adds the partial unique indexes that enforce "one live row per …"
 * invariants plus the partial indexes that keep hot queries narrow. It is
 * idempotent and runs at API start-up, in the worker, in `npm run db:sync`, and
 * once per test run.
 *
 * Field names are the stored (snake_case) names from `@map`, not Prisma names.
 */
export interface IndexSpec {
  collection: string;
  name: string;
  key: Record<string, 1 | -1 | '2dsphere' | 'text'>;
  unique?: boolean;
  partialFilterExpression?: Record<string, unknown>;
}

/**
 * "Column IS NULL" for a partial index. Plain null equality is one of the few
 * predicates partialFilterExpression accepts, and it matches both an explicit
 * null and a missing field (verified on MongoDB 7 and 8), which covers both
 * ways Prisma stores an unset optional field.
 */
const isNull = (field: string) => ({ [field]: null });

export const PARTIAL_INDEXES: IndexSpec[] = [
  // identity
  { collection: 'user_roles', name: 'user_roles_active_unique', key: { user_id: 1, role_id: 1 }, unique: true, partialFilterExpression: isNull('revoked_at') },
  // catalogue
  { collection: 'provider_services', name: 'provider_services_providerwide_unique', key: { provider_id: 1, service_id: 1 }, unique: true, partialFilterExpression: isNull('location_id') },
  // admin
  { collection: 'notification_templates', name: 'notification_templates_one_active', key: { key: 1, channel: 1, locale: 1 }, unique: true, partialFilterExpression: { is_active: true } },
  // providers
  // Names end in `_partial` or describe the rule so they never collide with the auto-named indexes `db push` creates.
  { collection: 'providers', name: 'providers_gstin_partial', key: { gstin: 1 }, partialFilterExpression: { gstin: { $type: 'string' } } },
  { collection: 'provider_locations', name: 'provider_locations_one_primary', key: { provider_id: 1 }, unique: true, partialFilterExpression: { is_primary: true } },
  // Discovery prefilters by bounding box on latitude/longitude, then computes haversine distance in the pipeline.
  { collection: 'provider_locations', name: 'provider_locations_active_coords_idx', key: { latitude: 1, longitude: 1 }, partialFilterExpression: { is_active: true, latitude: { $type: 'number' } } },
  { collection: 'provider_documents', name: 'provider_documents_expires_at_partial', key: { expires_at: 1 }, partialFilterExpression: { status: 'ACCEPTED', expires_at: { $type: 'date' } } },
  { collection: 'verification_cases', name: 'verification_cases_one_open_per_provider', key: { provider_id: 1 }, unique: true, partialFilterExpression: { status: { $in: ['OPEN', 'IN_REVIEW', 'AWAITING_PROVIDER'] } } },
  { collection: 'provider_payout_accounts', name: 'payout_accounts_one_verified', key: { provider_id: 1 }, unique: true, partialFilterExpression: { status: 'VERIFIED' } },
  // operations
  { collection: 'doctor_affiliations', name: 'doctor_affiliations_one_live', key: { doctor_provider_id: 1, facility_provider_id: 1 }, unique: true, partialFilterExpression: { status: { $in: ['INVITED', 'REQUESTED', 'PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED'] } } },
  { collection: 'appointment_slots', name: 'appointment_slots_open_by_doctor', key: { doctor_provider_id: 1, starts_at: 1 }, partialFilterExpression: { status: 'OPEN' } },
  { collection: 'patient_profiles', name: 'patient_profiles_one_self', key: { account_user_id: 1 }, unique: true, partialFilterExpression: { relationship: 'SELF' } },
  { collection: 'appointments', name: 'appointments_patient_slot_live', key: { patient_profile_id: 1, slot_id: 1 }, unique: true, partialFilterExpression: { status: { $in: ['REQUESTED', 'CONFIRMED', 'CHECKED_IN'] } } },
  { collection: 'dispatch_assignments', name: 'dispatch_assignments_one_accepted', key: { request_id: 1 }, unique: true, partialFilterExpression: { status: 'ACCEPTED' } },
  // finance
  { collection: 'service_transactions', name: 'service_transactions_completed_at_partial', key: { service_completed_at: 1 }, partialFilterExpression: { service_completed_at: { $type: 'date' } } },
  { collection: 'commission_snapshots', name: 'commission_snapshots_one_live', key: { transaction_id: 1 }, unique: true, partialFilterExpression: { status: { $in: ['PROVISIONAL', 'FINAL'] } } },
  { collection: 'provider_ledger_entries', name: 'ledger_unsettled_by_provider', key: { provider_id: 1, created_at: 1 }, partialFilterExpression: isNull('settlement_item_id') },
  // background jobs
  { collection: 'job_leases', name: 'job_leases_locked_until_idx', key: { locked_until: 1 } },
];

/**
 * Everything ensureIndexes() creates by default: every index the Prisma schema declares
 * (src/lib/mongo-index-manifest.ts, generated from the schema; unique indexes over optional
 * fields carry a partial filter) plus the hand-written partial indexes above.
 */
export const ALL_RUNTIME_INDEXES: IndexSpec[] = [...SCHEMA_INDEXES, ...PARTIAL_INDEXES];

interface CreateIndexesResult { ok?: number; errmsg?: string; code?: number }

/**
 * Create every index in `specs` (default: PARTIAL_INDEXES). An index whose name
 * exists with different options is dropped and recreated, so changing a spec
 * here is enough to roll it out.
 */
export async function ensureIndexes(db: PrismaClient, specs: IndexSpec[] = ALL_RUNTIME_INDEXES): Promise<{ created: number; collections: number }> {
  const byCollection = new Map<string, IndexSpec[]>();
  for (const s of specs) byCollection.set(s.collection, [...(byCollection.get(s.collection) ?? []), s]);
  let created = 0;
  for (const [collection, list] of byCollection) {
    const indexes = list.map(({ name, key, unique, partialFilterExpression }) => ({ name, key, ...(unique ? { unique: true } : {}), ...(partialFilterExpression ? { partialFilterExpression } : {}) }));
    const run = () => db.$runCommandRaw({ createIndexes: collection, indexes } as unknown as Prisma.InputJsonObject) as unknown as Promise<CreateIndexesResult>;
    try {
      await run();
    } catch (err) {
      // 85 IndexOptionsConflict / 86 IndexKeySpecsConflict: same name, different definition → replace.
      const code = (err as { code?: number; meta?: { code?: number }; message?: string }).code ?? (err as { meta?: { code?: number } }).meta?.code;
      const msg = (err as Error).message ?? '';
      if (code === 85 || code === 86 || /IndexOptionsConflict|IndexKeySpecsConflict|already exists with (a )?different/i.test(msg)) {
        for (const { name } of list) await db.$runCommandRaw({ dropIndexes: collection, index: name }).catch(() => undefined);
        await run();
      } else {
        throw new Error(`createIndexes on ${collection} failed: ${msg}`);
      }
    }
    created += list.length;
  }
  logger.debug({ created, collections: byCollection.size }, 'mongo indexes ensured');
  return { created, collections: byCollection.size };
}
