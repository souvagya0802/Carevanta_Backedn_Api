import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { runWithLease } from '../lib/job-lease.js';
import { getSetting, invalidateSetting } from '../modules/settings/settings.service.js';
import { enqueueNotification } from '../modules/notifications/notifications.service.js';
import { notifyUsers, usersWithPermission } from '../modules/notifications/events.js';
import { importCdci } from '../modules/catalogue/cdci-import.js';
import { splitTsv } from '../modules/catalogue/cdci-parse.js';

/**
 * Keeps the medicine catalogue in step with Common Drug Codes for India (CDCI) releases with no manual
 * work: check the source for a new release, download the flat files, validate them, apply them through
 * the regular importer, mark brands that left the list inactive (never deleted), record the release and
 * tell the catalogue admins. Anything suspicious (missing file, changed header, a big row drop, a licence
 * change) blocks the update and keeps the current data. Runs monthly under the worker lease, or on demand
 * from POST /admin/catalogue/medicines/sync.
 */
export const CDCI_SYNC_JOB = 'catalogue.cdci_sync';
export const CDCI_SYNC_LEASE_MS = 30 * 60_000;
export const CDCI_SYNC_ENABLED_KEY = 'catalogue.cdci_sync_enabled';
export const CDCI_SOURCE_KEY = 'catalogue.cdci_source_base_url';
export const CDCI_RELEASE_KEY = 'catalogue.cdci_last_release';
export const CDCI_LAST_RUN_KEY = 'catalogue.cdci_last_run';
export const CDCI_TEMPLATE_KEY = 'catalogue.medicines_synced';
export const CDCI_MANAGE_PERMISSION = 'catalogue.manage';
export const DEFAULT_CDCI_SOURCE = 'https://raw.githubusercontent.com/ohcnetwork/cdci/main/data/source';

/** Every file of the flat-file package and the columns the importer (or a sanity check) relies on. */
export const CDCI_FILES: Readonly<Record<string, readonly string[]>> = {
  'BrandMaster.txt': ['Identifier', 'Brand Name', 'Product Identifier', 'Supplier Identifier', 'Generic Identifier', 'License Status'],
  'GenericMaster.txt': ['Identifier', 'Generic Name', 'Substance Identifier', 'Route of Administration'],
  'ProductMaster.txt': ['Identifier', 'Product Name'],
  'SupplierMaster.txt': ['Identifier', 'Supplier Name'],
  'DrugFormMaster.txt': ['Identifier', 'Dose Form'],
  'RouteOfAdministrationMaster.txt': ['Identifier', 'RouteOfAdministration'],
  'SubstanceMaster.txt': ['Identifier', 'Substance Name'],
  'License.txt': [],
};
const LICENCE_TEXT = /Creative Commons Attribution 4\.0/iu;
/** Same rule as the importer: brands whose licence status says they are off the market are not imported. */
const DEAD_LICENCE = /withdrawn|cancel|revoked|suspend|banned/iu;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 120_000;
const MIN_RATIO = 0.8;
const MIN_FIRST_ROWS = 50_000;
const CHUNK = 1000;
const PAGE = 5000;

export interface CdciCounts { rows: number; added: number; updated: number; unchanged: number; discontinued: number; skipped: number }
export interface CdciRelease { sha: string; date: string | null; appliedAt: string; counts: CdciCounts; durations: { downloadMs: number; importMs: number; totalMs: number } }
export type CdciSyncStatus = 'applied' | 'unchanged' | 'blocked' | 'disabled' | 'failed';
export interface CdciSyncResult { status: CdciSyncStatus; at: string; sha?: string | null; releaseDate?: string | null; reason?: string; counts?: CdciCounts; ms: number }

export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;
export interface CdciSyncOptions {
  now?: Date;
  force?: boolean;
  fetchImpl?: FetchLike;
  /** Rows BrandMaster must have when there is no previous release to compare with (tests pass a small number). */
  minFirstRows?: number;
  /** Who asked (admin trigger); recorded on the run. */
  triggeredBy?: string | null;
}

class Blocked extends Error {}

const USER_AGENT = 'carevanta-cdci-sync';

/** For a raw.githubusercontent.com base, the GitHub API URL of the latest commit touching that folder. */
export function releaseCheckUrl(base: string): string | null {
  const m = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+?)\/?$/u.exec(base);
  if (!m) return null;
  return `https://api.github.com/repos/${m[1]}/${m[2]}/commits?path=${encodeURIComponent(m[4]!)}&sha=${encodeURIComponent(m[3]!)}&per_page=1`;
}

const get = (fetchImpl: FetchLike, url: string, headers: Record<string, string> = {}) =>
  fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'User-Agent': USER_AGENT, ...headers } });

async function latestCommit(fetchImpl: FetchLike, base: string): Promise<{ sha: string; date: string | null } | null> {
  const url = releaseCheckUrl(base);
  if (!url) return null;
  const res = await get(fetchImpl, url, { Accept: 'application/vnd.github+json' });
  if (!res.ok) throw new Error(`Release check failed: HTTP ${res.status}`);
  const body = (await res.json()) as { sha?: string; commit?: { committer?: { date?: string }; author?: { date?: string } } }[];
  const c = Array.isArray(body) ? body[0] : undefined;
  if (!c?.sha) throw new Error('Release check returned no commit');
  return { sha: c.sha, date: c.commit?.committer?.date ?? c.commit?.author?.date ?? null };
}

/** Body as bytes, refusing anything over the size cap (checked on the header and while reading). */
async function readCapped(res: Response, file: string): Promise<Buffer> {
  const tooBig = () => new Blocked(`${file} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  if (Number(res.headers.get('content-length') ?? 0) > MAX_FILE_BYTES) throw tooBig();
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FILE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooBig();
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

/** One file, retried once on a network or server error. A 404 or an oversized file blocks at once. */
async function download(fetchImpl: FetchLike, base: string, file: string): Promise<Buffer> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await get(fetchImpl, `${base}/${file}`);
      if (res.status === 404) throw new Blocked(`${file} is missing from the release`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await readCapped(res, file);
    } catch (err) {
      if (err instanceof Blocked) throw err;
      lastErr = err;
    }
  }
  throw new Blocked(`Could not download ${file}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
const headerOf = (text: string): string[] => splitTsv(stripBom(text).split(/\r?\n/u)[0] ?? '').map((h) => h.trim());

/** Brand rows and the codes the importer keeps (numeric code, a brand name, not withdrawn). */
async function brandCodes(file: string): Promise<{ rows: number; codes: Set<string> }> {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let header: string[] | null = null;
  let rows = 0;
  const codes = new Set<string>();
  for await (const raw of rl) {
    const line = stripBom(raw);
    if (!line.trim()) continue;
    const cells = splitTsv(line);
    if (!header) {
      header = cells.map((h) => h.trim());
      continue;
    }
    rows++;
    const h = header;
    const at = (name: string) => cells[h.indexOf(name)]?.trim() ?? '';
    const code = at('Identifier');
    if (/^\d+$/u.test(code) && at('Brand Name') && !DEAD_LICENCE.test(at('License Status'))) codes.add(code);
  }
  return { rows, codes };
}

async function saveSetting(key: string, value: unknown, description: string) {
  await prisma.platformSetting.upsert({
    where: { key },
    create: { key, value: value as object, description },
    update: { value: value as object, version: { increment: 1 } },
  });
  invalidateSetting(key);
}

/** CDCI medicines (source CDCI, still active) whose code is not in the new release become inactive. Never deletes; PROVIDER and MANUAL rows are never touched. */
async function discontinueMissing(present: Set<string>): Promise<number> {
  const missing: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await prisma.medicine.findMany({
      where: { source: 'CDCI', isActive: true },
      select: { id: true, code: true },
      orderBy: { id: 'asc' },
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const m of page) if (!m.code || !present.has(m.code)) missing.push(m.id);
    if (page.length < PAGE) break;
    cursor = page[page.length - 1]!.id;
  }
  let changed = 0;
  for (let i = 0; i < missing.length; i += CHUNK) {
    const res = await prisma.medicine.updateMany({ where: { id: { in: missing.slice(i, i + CHUNK) }, source: 'CDCI' }, data: { isActive: false } });
    changed += res.count;
  }
  return changed;
}

/** IN_APP (+ push) and EMAIL to everyone holding catalogue.manage. Never throws. */
async function notifyAdmins(result: CdciSyncResult) {
  const c = result.counts;
  const ok = result.status === 'applied';
  const summary = ok
    ? `Medicine list updated: ${c?.added ?? 0} added, ${c?.updated ?? 0} updated, ${c?.discontinued ?? 0} discontinued.`
    : `Medicine list update blocked: ${result.reason ?? 'unknown reason'}. The current list is unchanged.`;
  const vars = {
    status: ok ? 'Updated' : 'Blocked',
    added: String(c?.added ?? 0),
    updated: String(c?.updated ?? 0),
    discontinued: String(c?.discontinued ?? 0),
    reason: result.reason ?? '',
    releaseDate: result.releaseDate ? result.releaseDate.slice(0, 10) : 'unknown',
    summary,
  };
  try {
    const ids = await usersWithPermission(prisma, CDCI_MANAGE_PERMISSION);
    if (!ids.length) return;
    await notifyUsers(prisma, ids, { key: CDCI_TEMPLATE_KEY, title: ok ? 'Medicine list updated' : 'Medicine list update blocked', body: summary, link: '/catalogue', level: ok ? 'light' : 'important' });
    const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true } });
    for (const u of users) if (u.email) await enqueueNotification(prisma, { userId: u.id, channel: 'EMAIL', templateKey: CDCI_TEMPLATE_KEY, recipient: u.email, payload: vars });
  } catch (err) {
    logger.error({ err }, 'cdci sync: failed to notify admins');
  }
}

/** One sync pass. Safe to call repeatedly; does nothing when the source has no new release (unless forced). */
export async function syncCdci(opts: CdciSyncOptions = {}): Promise<CdciSyncResult> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const finish = async (r: Omit<CdciSyncResult, 'at' | 'ms'>): Promise<CdciSyncResult> => {
    const result: CdciSyncResult = { ...r, at: now.toISOString(), ms: Date.now() - started };
    await saveSetting(CDCI_LAST_RUN_KEY, { ...result, triggeredBy: opts.triggeredBy ?? null }, 'Outcome of the last medicine list sync run (written by the sync job).').catch((err: unknown) => logger.error({ err }, 'cdci sync: could not record the run'));
    if (result.status === 'applied' || result.status === 'blocked' || result.status === 'failed') await notifyAdmins(result);
    logger.info({ job: CDCI_SYNC_JOB, status: result.status, reason: result.reason, counts: result.counts }, 'cdci sync finished');
    return result;
  };

  if (!(await getSetting<boolean>(CDCI_SYNC_ENABLED_KEY, true))) return finish({ status: 'disabled', reason: 'Medicine list sync is turned off' });
  const base = (String((await getSetting<string>(CDCI_SOURCE_KEY, DEFAULT_CDCI_SOURCE)) || DEFAULT_CDCI_SOURCE)).trim().replace(/\/+$/u, '');
  if (!/^https:\/\//u.test(base)) return finish({ status: 'blocked', reason: 'The source address must start with https://' });
  const previous = await getSetting<CdciRelease | null>(CDCI_RELEASE_KEY, null);

  let commit: { sha: string; date: string | null } | null;
  try {
    commit = await latestCommit(fetchImpl, base);
  } catch (err) {
    return finish({ status: 'failed', reason: err instanceof Error ? err.message : String(err) });
  }
  if (commit && previous?.sha === commit.sha && !opts.force) return finish({ status: 'unchanged', sha: commit.sha, releaseDate: commit.date });

  const dir = await mkdtemp(join(tmpdir(), 'cdci-sync-'));
  let sha = commit?.sha ?? null;
  const releaseDate = commit?.date ?? null;
  try {
    // b. Download every file (timeout, size cap, one retry).
    const dlStart = Date.now();
    const hash = createHash('sha256');
    for (const file of Object.keys(CDCI_FILES)) {
      const bytes = await download(fetchImpl, base, file);
      hash.update(file).update(bytes);
      await writeFile(join(dir, file), bytes);
    }
    const downloadMs = Date.now() - dlStart;
    // A non-GitHub source has no commit to compare with: the release id is the hash of the files.
    if (!sha) {
      sha = `sha256:${hash.digest('hex')}`;
      if (previous?.sha === sha && !opts.force) return await finish({ status: 'unchanged', sha, releaseDate });
    }

    // c. Validate before touching the catalogue.
    for (const [file, cols] of Object.entries(CDCI_FILES)) {
      if (!cols.length) continue;
      const header = headerOf((await readFile(join(dir, file), 'utf8')).slice(0, 4096));
      const missing = cols.filter((c) => !header.includes(c));
      if (missing.length) throw new Blocked(`${file} has an unexpected header (missing ${missing.join(', ')})`);
    }
    if (!LICENCE_TEXT.test(await readFile(join(dir, 'License.txt'), 'utf8'))) throw new Blocked('License.txt no longer says "Creative Commons Attribution 4.0"');
    const brands = await brandCodes(join(dir, 'BrandMaster.txt'));
    const prevRows = previous?.counts?.rows ?? 0;
    const minRows = prevRows ? Math.ceil(prevRows * MIN_RATIO) : (opts.minFirstRows ?? MIN_FIRST_ROWS);
    if (brands.rows < minRows) {
      throw new Blocked(prevRows
        ? `BrandMaster has ${brands.rows} rows, under 80% of the previous ${prevRows}`
        : `BrandMaster has ${brands.rows} rows, fewer than the ${minRows} expected for a first import`);
    }

    // d. Apply (upsert by code; schedule / prescription flag / isActive kept on existing rows). e. Discontinue.
    const imp = await importCdci(dir, { log: (m) => logger.debug({ job: CDCI_SYNC_JOB }, m) });
    const discontinued = await discontinueMissing(brands.codes);
    const counts: CdciCounts = { rows: brands.rows, added: imp.inserted, updated: imp.updated, unchanged: imp.unchanged, discontinued, skipped: imp.skipped };

    // f. Release marker.
    const release: CdciRelease = { sha, date: releaseDate, appliedAt: new Date().toISOString(), counts, durations: { downloadMs, importMs: imp.ms, totalMs: Date.now() - started } };
    await saveSetting(CDCI_RELEASE_KEY, release, 'Last CDCI medicine list release applied (written by the sync job).');
    return await finish({ status: 'applied', sha, releaseDate, counts });
  } catch (err) {
    if (err instanceof Blocked) return finish({ status: 'blocked', sha, releaseDate, reason: err.message });
    logger.error({ err, job: CDCI_SYNC_JOB }, 'cdci sync failed');
    return finish({ status: 'failed', sha, releaseDate, reason: err instanceof Error ? err.message.slice(0, 300) : String(err) });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The sync under the shared job lease; null when another run (worker or admin trigger) holds it. */
export function runCdciSyncWithLease(opts: CdciSyncOptions = {}): Promise<CdciSyncResult | null> {
  return runWithLease(CDCI_SYNC_JOB, CDCI_SYNC_LEASE_MS, () => syncCdci(opts));
}
