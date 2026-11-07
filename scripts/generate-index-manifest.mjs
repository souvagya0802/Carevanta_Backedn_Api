/* global process, console */
// Generates two files from prisma/schema/*.prisma:
//  - src/lib/mongo-index-manifest.ts: every @unique / @@unique / @@index as a MongoDB index spec, using Prisma's
//    own naming (<collection>_<columns>_key / _idx, or `map`). Unique indexes that involve an optional field get
//    a partialFilterExpression restricted to documents where those fields are present (PostgreSQL's NULL-tolerant
//    unique semantics). The backend creates these at start-up (src/lib/mongo-indexes.ts) instead of `prisma db
//    push`, which cannot express partial indexes and refuses to coexist with them.
//  - src/lib/mongo-model-manifest.ts: per model, the optional scalar fields, foreign-key fields and relation
//    fields. src/lib/prisma-null-defaults.ts uses it to write explicit nulls for omitted optional fields, because
//    Prisma's MongoDB connector otherwise leaves them missing and `where: { field: null }` would not match.
//
// Runs automatically after `prisma generate` (see package.json); the unit tests fail if the committed files are
// stale. Usage: node scripts/generate-index-manifest.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SCHEMA_DIR = path.resolve('prisma/schema');
const OUT_INDEXES = path.resolve('src/lib/mongo-index-manifest.ts');
const OUT_MODELS = path.resolve('src/lib/mongo-model-manifest.ts');
const BSON = { String: 'string', Int: 'number', BigInt: 'number', Float: 'number', Decimal: 'number', DateTime: 'date', Boolean: 'bool', Json: 'object', Bytes: 'binData' };

function parseSchema(schemaDir = SCHEMA_DIR) {
  const files = fs.readdirSync(schemaDir).filter((f) => f.endsWith('.prisma')).sort();
  const sources = files.map((f) => fs.readFileSync(path.join(schemaDir, f), 'utf8'));
  const enums = new Set();
  const modelNames = new Set();
  for (const src of sources) {
    for (const m of src.matchAll(/^enum\s+(\w+)/gm)) enums.add(m[1]);
    for (const m of src.matchAll(/^model\s+(\w+)/gm)) modelNames.add(m[1]);
  }
  const models = [];
  for (const src of sources) {
    for (const block of src.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
      const [, name, body] = block;
      const collection = /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? name;
      const fields = [];
      for (const line of body.split('\n')) {
        const f = /^\s+(\w+)\s+([A-Z]\w*)(\[\])?(\?)?\s*(.*)$/.exec(line);
        if (!f) continue;
        const [, fieldName, type, list, optional, attrs] = f;
        const relation = modelNames.has(type);
        const fkMatch = relation ? /@relation\([^)]*fields:\s*\[([^\]]+)\]/.exec(attrs) : null;
        fields.push({
          name: fieldName,
          type,
          list: !!list,
          optional: !!optional,
          column: /@map\("([^"]+)"\)/.exec(attrs)?.[1] ?? fieldName,
          bson: enums.has(type) ? 'string' : (BSON[type] ?? 'string'),
          kind: relation ? 'relation' : enums.has(type) ? 'enum' : 'scalar',
          unique: /@unique\b/.test(attrs),
          isId: /@id\b/.test(attrs),
          hasDefault: /@default\(/.test(attrs) || /@updatedAt\b/.test(attrs),
          relationFrom: fkMatch ? fkMatch[1].split(',').map((s) => s.trim()) : [],
        });
      }
      models.push({ name, collection, body, fields });
    }
  }
  return models;
}

export function buildManifest(schemaDir = SCHEMA_DIR) {
  const out = [];
  for (const model of parseSchema(schemaDir)) {
    const byName = new Map(model.fields.map((f) => [f.name, f]));
    const col = (n) => { const f = byName.get(n); if (!f) throw new Error(`${model.name}: index references unknown field ${n}`); return f; };
    const spec = (kind, names, map) => {
      const parsed = names.map((raw) => { const m = /^(\w+)(?:\(([^)]*)\))?$/.exec(raw.trim()); return { field: m[1], desc: /sort:\s*Desc/i.test(m[2] ?? '') }; });
      const cols = parsed.map((p) => col(p.field));
      const name = map ?? `${model.collection}_${cols.map((c) => c.column).join('_')}_${kind === 'index' ? 'idx' : 'key'}`;
      const key = Object.fromEntries(parsed.map((p, i) => [cols[i].column, p.desc ? -1 : 1]));
      const optional = kind === 'unique' ? cols.filter((c) => c.optional) : [];
      const s = { collection: model.collection, name, key };
      if (kind === 'unique') s.unique = true;
      if (optional.length) s.partialFilterExpression = Object.fromEntries(optional.map((c) => [c.column, { $type: c.bson }]));
      return s;
    };
    for (const f of model.fields) if (f.unique && !f.isId) out.push(spec('unique', [f.name], undefined));
    for (const u of model.body.matchAll(/@@unique\(\[([^\]]+)\](?:,\s*map:\s*"([^"]+)")?/g)) out.push(spec('unique', u[1].split(','), u[2]));
    for (const i of model.body.matchAll(/@@index\(\[([^\]]+)\](?:,\s*map:\s*"([^"]+)")?/g)) out.push(spec('index', i[1].split(','), i[2]));
  }
  const names = new Set();
  for (const s of out) { if (names.has(s.name)) throw new Error(`duplicate index name ${s.name}`); names.add(s.name); }
  return out;
}

export function buildModelManifest(schemaDir = SCHEMA_DIR) {
  const out = {};
  for (const model of parseSchema(schemaDir)) {
    const foreignKeys = new Set(model.fields.flatMap((f) => f.relationFrom));
    out[model.name] = {
      // Optional scalar/enum fields that Prisma would leave missing when omitted. Json is excluded: Prisma
      // requires Prisma.JsonNull/DbNull for it, and nothing filters Json fields by null.
      optionalScalars: model.fields.filter((f) => f.kind !== 'relation' && f.optional && !f.list && !f.hasDefault && f.type !== 'Json').map((f) => f.name),
      foreignKeys: [...foreignKeys],
      relations: Object.fromEntries(model.fields.filter((f) => f.kind === 'relation').map((f) => [f.name, f.type])),
    };
  }
  return out;
}

const literal = (v) => JSON.stringify(v, null, 2).replace(/"([a-zA-Z_$][\w$]*)":/g, '$1:');

export function renderIndexes(manifest) {
  return `// GENERATED by scripts/generate-index-manifest.mjs from prisma/schema — do not edit by hand.\n// Every index the Prisma schema declares, with partial filters where a unique index involves an optional field.\nimport type { IndexSpec } from './mongo-indexes.js';\n\nexport const SCHEMA_INDEXES: IndexSpec[] = ${literal(manifest)};\n`;
}

export function renderModels(manifest) {
  return `// GENERATED by scripts/generate-index-manifest.mjs from prisma/schema — do not edit by hand.\n// Per model: optional scalar fields (written as explicit null when omitted), foreign-key fields and relations.\nexport interface ModelMeta {\n  optionalScalars: string[];\n  foreignKeys: string[];\n  relations: Record<string, string>;\n}\n\nexport const MODELS: Record<string, ModelMeta> = ${literal(manifest)};\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const outputs = [
    [OUT_INDEXES, renderIndexes(buildManifest())],
    [OUT_MODELS, renderModels(buildModelManifest())],
  ];
  if (process.argv.includes('--check')) {
    const stale = outputs.filter(([file, text]) => !fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text).map(([file]) => path.relative(process.cwd(), file));
    if (stale.length) { console.error(`stale generated files: ${stale.join(', ')} — run \`npm run prisma:generate\``); process.exit(1); }
    console.log('generated manifests up to date');
  } else {
    for (const [file, text] of outputs) fs.writeFileSync(file, text);
    console.log(`wrote ${path.relative(process.cwd(), OUT_INDEXES)} (${buildManifest().length} indexes) and ${path.relative(process.cwd(), OUT_MODELS)} (${Object.keys(buildModelManifest()).length} models)`);
  }
}
