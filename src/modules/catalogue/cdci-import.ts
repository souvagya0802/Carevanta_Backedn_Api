import { createReadStream, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Prisma } from '../../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { ejsonDate } from '../../lib/mongo.js';
import { normaliseSpace, parseBrandName, searchKey, splitTsv, titleCase } from './cdci-parse.js';

/**
 * Imports (or refreshes) the medicine catalogue from a Common Drug Codes for India (CDCI) flat-file
 * release. Idempotent: rows are upserted by CDCI brand code in batches of 1000 with one raw `update` command per
 * batch (an unordered bulk write; never inside a Prisma transaction). The raw command goes through Prisma
 * rather than the native driver because Node's own DNS cannot resolve the Atlas SRV record on some
 * Windows set-ups, while Prisma's engine can. Descriptive fields are refreshed on every run; schedule,
 * requiresPrescription and isActive are only set when a row is first inserted, so admin edits survive.
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
    ms: 0,
  };
  let ops: Record<string, unknown>[] = [];
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
    if (ops.length >= BATCH) await flush();
  }
  await flush();
  result.ms = Date.now() - started;
  return result;
}
