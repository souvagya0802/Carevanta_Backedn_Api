import { createReadStream, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Prisma } from '../../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { ejsonDate } from '../../lib/mongo.js';
import { normaliseSpace, parseBrandName, searchKey, splitTsv, titleCase } from './cdci-parse.js';
import { cdciInfo, compositionKey, substituteKey, INFO_COLUMNS, INFO_FIELDS, type CdciGenericInfo, type CdciSubstanceInfo, type MedicineInfo } from './medicine-info.js';

/**
 * Imports (or refreshes) the medicine catalogue from a Common Drug Codes for India (CDCI) flat-file
 * release. Idempotent: rows are upserted by CDCI brand code in batches of 1000 with one raw `update` command per
 * batch (an unordered bulk write; never inside a Prisma transaction). The raw command goes through Prisma
 * rather than the native driver because Node's own DNS cannot resolve the Atlas SRV record on some
 * Windows set-ups, while Prisma's engine can. Descriptive fields are refreshed on every run; schedule,
 * requiresPrescription and isActive are only set when a row is first inserted, so admin edits survive.
 *
 * Patient information (therapeutic class, uses, contraindications, interactions from GenericMaster; how it
 * works and side effects from SubstanceMaster via the generic's substance ids) is filled with infoSource
 * 'CDCI' in a second update per batch that never touches rows whose infoSource is 'ADMIN'.
 *
 * CDCI carries no drug-schedule data, so new rows are imported as prescription-only with the strictest
 * non-narcotic schedule (SCHEDULE_H1). Admins relax individual medicines afterwards.
 */
export const CDCI_DEFAULT_SCHEDULE = 'SCHEDULE_H1';
export const CDCI_ATTRIBUTION = 'Medicine names from Common Drug Codes for India (CDCI), © C-DAC / NRCeS, MoHFW, CC BY 4.0.';
const BATCH = 1000;
/** License Status values that mean the brand is no longer on the market (the 2026-08 release has only UNKNOWN). */
const DEAD_LICENCE = /withdrawn|cancel|revoked|suspend|banned/iu;

export interface CdciImportResult {
  read: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  /** Rows whose CDCI information was filled or changed. */
  infoUpdated: number;
  ms: number;
}

/** RFC 9562 UUIDv7, the same id shape Prisma's uuid(7) default produces. */
export function uuidv7(): string {
  const b = randomBytes(16);
  const ts = BigInt(Date.now());
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function* rows(file: string): AsyncGenerator<Record<string, string>> {
  const rl = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let header: string[] | null = null;
  for await (const raw of rl) {
    const line = raw.startsWith('﻿') ? raw.slice(1) : raw;
    if (!line.trim()) continue;
    const cells = splitTsv(line);
    if (!header) {
      header = cells;
      continue;
    }
    yield Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
  }
}

async function lookup(file: string, key: string, value: string): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  if (!existsSync(file)) return m;
  for await (const r of rows(file)) if (r[key] && r[value]) m.set(r[key], normaliseSpace(r[value]));
  return m;
}

export async function importCdci(
  dir: string,
  opts: {
    db?: Pick<typeof prisma, '$runCommandRaw'>;
    log?: (msg: string) => void;
  } = {},
): Promise<CdciImportResult> {
  const started = Date.now();
  const brandFile = join(dir, 'BrandMaster.txt');
  if (!existsSync(brandFile)) throw new Error(`BrandMaster.txt not found in ${dir}`);
  const db = opts.db ?? prisma;

  const suppliers = await lookup(join(dir, 'SupplierMaster.txt'), 'Identifier', 'Supplier Name');
  const routes = await lookup(join(dir, 'RouteOfAdministrationMaster.txt'), 'Identifier', 'RouteOfAdministration');
  const generics = new Map<string, { name: string; route: string | null }>();
  const info = await loadCdciInfo(dir);
  if (existsSync(join(dir, 'GenericMaster.txt'))) {
    for await (const g of rows(join(dir, 'GenericMaster.txt'))) {
      const routeNames = (g['Route of Administration'] ?? '')
        .split('+')
        .map((id) => routes.get(id.trim()))
        .filter((x): x is string => !!x)
        .map((r) => titleCase(r.replace(/\s+route$/iu, '')));
      if (g.Identifier && g['Generic Name'])
        generics.set(g.Identifier, {
          name: normaliseSpace(g['Generic Name']),
          route: routeNames.length ? [...new Set(routeNames)].join(', ') : null,
        });
    }
  }

  const result: CdciImportResult = {
    read: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    infoUpdated: 0,
    ms: 0,
  };
  let ops: Record<string, unknown>[] = [];
  let infoOps: Record<string, unknown>[] = [];
  const flush = async () => {
    if (!ops.length) return;
    const res = (await db.$runCommandRaw({
      update: 'medicines',
      updates: ops,
      ordered: false,
    } as unknown as Prisma.InputJsonObject)) as unknown as {
      n?: number;
      nModified?: number;
      upserted?: unknown[];
      writeErrors?: { errmsg?: string }[];
    };
    if (res.writeErrors?.length) throw new Error(`CDCI import write error: ${res.writeErrors[0]?.errmsg ?? 'unknown'}`);
    const inserted = res.upserted?.length ?? 0;
    result.inserted += inserted;
    result.updated += res.nModified ?? 0;
    result.unchanged += (res.n ?? 0) - inserted - (res.nModified ?? 0);
    ops = [];
    // Information second, so a row inserted above is already there.
    if (infoOps.length) result.infoUpdated += await runUpdates(db, infoOps);
    infoOps = [];
    opts.log?.(`  ${result.read} rows read`);
  };

  for await (const b of rows(brandFile)) {
    result.read++;
    const code = b.Identifier?.trim();
    const brand = b['Brand Name']?.trim();
    if (!code || !brand || !/^\d+$/u.test(code) || DEAD_LICENCE.test(b['License Status'] ?? '')) {
      result.skipped++;
      continue;
    }
    const manufacturer = suppliers.get(b['Supplier Identifier'] ?? '') ?? null;
    const p = parseBrandName(brand, manufacturer);
    const generic = generics.get(b['Generic Identifier'] ?? '');
    const now = ejsonDate(new Date());
    ops.push({
      q: { code },
      u: {
        $set: {
          name: p.name.slice(0, 200),
          composition: p.composition,
          strength: p.strength?.slice(0, 64) ?? null,
          dosage_form: p.dosageForm?.slice(0, 64) ?? null,
          generic_name: generic?.name.slice(0, 200) ?? null,
          generic_code: b['Generic Identifier'] || null,
          route: generic?.route ?? null,
          manufacturer,
          search_name: searchKey(p.name, p.composition),
          composition_key: compositionKey(p.composition, p.strength, p.dosageForm),
          source: 'CDCI',
        },
        $setOnInsert: {
          _id: uuidv7(),
          pack_size: null,
          schedule: CDCI_DEFAULT_SCHEDULE,
          requires_prescription: true,
          is_active: true,
          proposed_by_provider_id: null,
          proposed_by_user_id: null,
          created_at: now,
          updated_at: now,
        },
      },
      upsert: true,
    });
    const filled = info.get(b['Generic Identifier'] ?? '');
    if (filled) infoOps.push(infoUpdate({ code }, filled, new Date()));
    if (ops.length >= BATCH) await flush();
  }
  await flush();
  result.ms = Date.now() - started;
  return result;
}

/** Runs an unordered raw `update` command (never inside a transaction) and returns how many rows changed. */
async function runUpdates(db: Pick<typeof prisma, '$runCommandRaw'>, updates: Record<string, unknown>[]): Promise<number> {
  const res = (await db.$runCommandRaw({ update: 'medicines', updates, ordered: false } as unknown as Prisma.InputJsonObject)) as unknown as { nModified?: number; writeErrors?: { errmsg?: string }[] };
  if (res.writeErrors?.length) throw new Error(`Medicine information write error: ${res.writeErrors[0]?.errmsg ?? 'unknown'}`);
  return res.nModified ?? 0;
}

/**
 * Update that sets the CDCI information on rows matching `filter` unless an admin edited it (infoSource 'ADMIN').
 * A pipeline update, so `info_updated_at` only moves when a value really changes and a re-run reports no change.
 */
function infoUpdate(filter: Record<string, unknown>, info: MedicineInfo, at: Date): Record<string, unknown> {
  const values: Record<string, unknown> = { info_source: 'CDCI' };
  for (const f of INFO_FIELDS) values[INFO_COLUMNS[f]] = info[f];
  const changed = { $or: Object.entries(values).map(([k, v]) => ({ $ne: [{ $ifNull: [`$${k}`, null] }, { $literal: v }] })) };
  const set: Record<string, unknown> = {
    info_updated_at: { $cond: [changed, ejsonDate(at), { $ifNull: ['$info_updated_at', null] }] },
    info_updated_by_id: { $cond: [changed, null, { $ifNull: ['$info_updated_by_id', null] }] },
  };
  for (const [k, v] of Object.entries(values)) set[k] = { $literal: v };
  return { q: { ...filter, info_source: { $ne: 'ADMIN' } }, u: [{ $set: set }], multi: false };
}

/** CDCI information per generic identifier, from GenericMaster.txt and SubstanceMaster.txt in `dir` (empty when the files are missing). */
export async function loadCdciInfo(dir: string): Promise<Map<string, MedicineInfo>> {
  const out = new Map<string, MedicineInfo>();
  const genericFile = join(dir, 'GenericMaster.txt');
  if (!existsSync(genericFile)) return out;
  const substances = new Map<string, CdciSubstanceInfo>();
  const substanceFile = join(dir, 'SubstanceMaster.txt');
  if (existsSync(substanceFile)) {
    for await (const s of rows(substanceFile)) {
      if (s.Identifier && s['Substance Name']) substances.set(s.Identifier, { name: normaliseSpace(s['Substance Name']), description: s['Substance Description'] ?? '', toxicity: s.Toxicity ?? '' });
    }
  }
  for await (const g of rows(genericFile)) {
    if (!g.Identifier) continue;
    const generic: CdciGenericInfo = {
      therapeuticRole: g['Therapeutic Role'] ?? '',
      indication: g.Indication ?? '',
      contraIndication: g['Contra Indication'] ?? '',
      interaction: g['Interaction with Drugs'] ?? '',
      substanceIds: (g['Substance Identifier'] ?? '').split('+').map((x) => x.trim()).filter(Boolean),
    };
    const filled = cdciInfo(generic, substances);
    if (filled) out.set(g.Identifier, filled);
  }
  return out;
}

export interface BackfillResult { scanned: number; keysUpdated: number; infoUpdated: number; infoSkippedAdmin: number; ms: number }

/**
 * Backfill for existing rows: sets `compositionKey` on every medicine and fills the CDCI information of CDCI rows
 * by generic code (never rows an admin edited). Reads the catalogue page by page, writes only rows whose value
 * differs, in raw unordered batches outside any transaction, so it is idempotent and cheap to re-run.
 */
export async function backfillMedicineInfo(dir: string | null, opts: { log?: (msg: string) => void; page?: number } = {}): Promise<BackfillResult> {
  const started = Date.now();
  const info = dir ? await loadCdciInfo(dir) : new Map<string, MedicineInfo>();
  const page = opts.page ?? 5000;
  const result: BackfillResult = { scanned: 0, keysUpdated: 0, infoUpdated: 0, infoSkippedAdmin: 0, ms: 0 };
  let cursor: string | undefined;
  const now = new Date();
  const genericByKey = new Map<string, string>();
  const orphans: ({ key: string; id: string; infoSource: string | null } & Record<(typeof INFO_FIELDS)[number], string | null>)[] = [];
  for (;;) {
    const batch = await prisma.medicine.findMany({
      where: cursor ? { id: { gt: cursor } } : {},
      orderBy: { id: 'asc' },
      take: page,
      select: { id: true, composition: true, genericName: true, source: true, strength: true, dosageForm: true, compositionKey: true, genericCode: true, infoSource: true, therapeuticClass: true, uses: true, howItWorks: true, sideEffects: true, contraindications: true, interactions: true },
    });
    if (!batch.length) break;
    cursor = batch[batch.length - 1]!.id;
    result.scanned += batch.length;
    const keyOps: Record<string, unknown>[] = [];
    const infoOps: Record<string, unknown>[] = [];
    for (const m of batch) {
      const key = substituteKey(m);
      if (key !== (m.compositionKey ?? null)) keyOps.push({ q: { _id: m.id }, u: { $set: { composition_key: key } }, multi: false });
      if (!m.genericCode) { if (key) orphans.push({ ...m, key }); continue; }
      const filled = info.get(m.genericCode);
      if (!filled) continue;
      if (key && !genericByKey.has(key)) genericByKey.set(key, m.genericCode);
      queueInfo(m, filled, infoOps);
    }
    await write(keyOps, infoOps);
    opts.log?.(`  ${result.scanned} scanned, ${result.keysUpdated} keys and ${result.infoUpdated} information rows written`);
  }
  // Medicines added by hand or by a pharmacy have no CDCI generic code: they take the CDCI text of a CDCI medicine with
  // the same salt, strength and form (CDCI information is per generic, so that is the same text).
  const borrowed: Record<string, unknown>[] = [];
  for (const m of orphans) {
    const code = genericByKey.get(m.key);
    const filled = code ? info.get(code) : undefined;
    if (filled) queueInfo(m, filled, borrowed);
  }
  await write([], borrowed);
  result.ms = Date.now() - started;
  return result;

  type Row = { id: string; infoSource: string | null } & Record<(typeof INFO_FIELDS)[number], string | null>;
  function queueInfo(m: Row, filled: MedicineInfo, into: Record<string, unknown>[]) {
    if (m.infoSource === 'ADMIN') { result.infoSkippedAdmin++; return; }
    if (m.infoSource === 'CDCI' && INFO_FIELDS.every((f) => (m[f] ?? null) === filled[f])) return;
    into.push(infoUpdate({ _id: m.id }, filled, now));
  }
  async function write(keyOps: Record<string, unknown>[], infoOps: Record<string, unknown>[]) {
    for (let i = 0; i < keyOps.length; i += BATCH) result.keysUpdated += await runUpdates(prisma, keyOps.slice(i, i + BATCH));
    for (let i = 0; i < infoOps.length; i += BATCH) result.infoUpdated += await runUpdates(prisma, infoOps.slice(i, i + BATCH));
  }
}
