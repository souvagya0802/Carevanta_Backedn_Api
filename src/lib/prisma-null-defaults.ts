import { MODELS } from './mongo-model-manifest.js';

/**
 * Prisma's MongoDB connector leaves an omitted optional field out of the stored
 * document, and then `where: { field: null }` / `{ not: null }` do not match
 * it (only `isSet` does). The service code — written for SQL — relies on
 * "IS NULL" semantics in dozens of places (revoked_at, settlement_item_id,
 * location_id, …). Rather than rewrite every filter, every create goes through
 * here and omitted optional scalars are written as explicit null, so documents
 * look exactly like the rows PostgreSQL stored.
 *
 * Nested creates (`relation: { create | createMany | connectOrCreate }`) inside
 * create, update and upsert payloads are completed too. Foreign-key scalars are
 * skipped when the payload uses relation objects ("checked" input), because
 * Prisma rejects mixing the two styles.
 */
type Data = Record<string, unknown>;

const isObject = (v: unknown): v is Data => !!v && typeof v === 'object' && !Array.isArray(v);

function fillNulls(model: string, data: Data): Data {
  const meta = MODELS[model];
  if (!meta) return data;
  const checked = Object.keys(data).some((k) => k in meta.relations);
  const out: Data = { ...data };
  for (const field of meta.optionalScalars) {
    if (field in out) continue;
    if (checked && meta.foreignKeys.includes(field)) continue;
    out[field] = null;
  }
  return out;
}

function completeNested(model: string, data: Data, fill: boolean): Data {
  const meta = MODELS[model];
  if (!meta) return data;
  const out: Data = fill ? fillNulls(model, data) : { ...data };
  for (const [relation, target] of Object.entries(meta.relations)) {
    const payload = out[relation];
    if (!isObject(payload)) continue;
    const next: Data = { ...payload };
    if ('create' in next) next.create = mapEach(next.create, (d) => completeNested(target, d, true));
    if (isObject(next.createMany) && Array.isArray(next.createMany.data)) next.createMany = { ...next.createMany, data: next.createMany.data.map((d) => (isObject(d) ? completeNested(target, d, true) : d)) };
    if ('connectOrCreate' in next) next.connectOrCreate = mapEach(next.connectOrCreate, (d) => (isObject(d.create) ? { ...d, create: completeNested(target, d.create, true) } : d));
    if ('upsert' in next) next.upsert = mapEach(next.upsert, (d) => ({ ...d, ...(isObject(d.create) ? { create: completeNested(target, d.create, true) } : {}), ...(isObject(d.update) ? { update: completeNested(target, d.update, false) } : {}) }));
    if ('update' in next && isObject(next.update)) next.update = isObject(next.update.data) ? { ...next.update, data: completeNested(target, next.update.data, false) } : completeNested(target, next.update, false);
    out[relation] = next;
  }
  return out;
}

const mapEach = (v: unknown, fn: (d: Data) => Data): unknown => (Array.isArray(v) ? v.map((d) => (isObject(d) ? fn(d) : d)) : isObject(v) ? fn(v) : v);

/** Rewrite the args of a Prisma operation so every created document carries explicit nulls. */
export function withExplicitNulls(model: string | undefined, operation: string, args: unknown): unknown {
  if (!model || !isObject(args)) return args;
  switch (operation) {
    case 'create':
      return isObject(args.data) ? { ...args, data: completeNested(model, args.data, true) } : args;
    case 'createMany':
    case 'createManyAndReturn':
      return { ...args, data: mapEach(args.data, (d) => fillNulls(model, d)) };
    case 'upsert':
      return {
        ...args,
        ...(isObject(args.create) ? { create: completeNested(model, args.create, true) } : {}),
        ...(isObject(args.update) ? { update: completeNested(model, args.update, false) } : {}),
      };
    case 'update':
    case 'updateMany':
      return isObject(args.data) ? { ...args, data: completeNested(model, args.data, false) } : args;
    default:
      return args;
  }
}
