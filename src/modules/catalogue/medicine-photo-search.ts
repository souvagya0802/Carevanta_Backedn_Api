/**
 * Openly licensed medicine photos from the internet (founder request 2026-11-20).
 *
 * Legal: product photos on shopping and manufacturer sites are copyrighted, so we only search
 * Openverse (CC images from Wikimedia, Flickr and others) and Wikimedia Commons, keep only licences
 * that allow commercial use (CC0, public domain, CC BY, CC BY-SA; never NC or ND) and store the
 * credit, licence and source page with the photo (CC BY requires the credit to be shown).
 *
 * Safety: a wrong photo on a medicine is a patient-safety problem, so nothing is attached
 * automatically. An admin picks a candidate; a match found by salt instead of brand is labelled
 * "Representative image (not this brand's pack)".
 */
import { env } from '../../config/env.js';

export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string>; method?: string; body?: string; redirect?: 'manual' | 'follow' }) => Promise<Response>;

export interface PhotoCandidate {
  provider: 'openverse' | 'commons';
  id: string;
  title: string;
  thumbUrl: string;
  fullUrl: string;
  width: number | null;
  height: number | null;
  mime: string;
  licence: string;
  licenceUrl: string | null;
  creator: string | null;
  sourcePageUrl: string;
  attribution: string;
  matchedOn: 'brand' | 'composition';
}

export interface PhotoSearchInput { brand: string; strength?: string | null; composition?: string | null; genericName?: string | null; dosageForm?: string | null }
export interface PhotoSearchResult { candidates: PhotoCandidate[]; queries: string[]; exhausted: boolean; calls: { openverse: number; commons: number } }

const TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 60 * 60_000;
const CACHE_MAX = 300;
const CANDIDATE_MAX = 3000;
const USER_AGENT = 'Carevanta/0.1 (medicine catalogue photo search; openly licensed images only)';
export const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'];

let fetchImpl: FetchLike = (url, init) => fetch(url, init);
/** Tests inject a fake upstream; pass null to restore the real fetch. */
export function setPhotoSearchFetch(f: FetchLike | null) {
  fetchImpl = f ?? ((url, init) => fetch(url, init));
  queryCache.clear();
  candidateCache.clear();
  token = null;
}
export const photoFetch: FetchLike = (url, init) => fetchImpl(url, init);

// ── Licences ─────────────────────────────────────────────────────────────

const VERSIONS = ['2.0', '3.0', '4.0'];
/**
 * Normalises a licence name to "CC0", "Public Domain", "CC BY 4.0" or "CC BY-SA 3.0", or null when it is
 * not on the allowlist (commercial use allowed, derivatives allowed). NC and ND are always refused.
 */
export function allowedLicence(name: string | null | undefined, version?: string | null): string | null {
  if (!name) return null;
  const s = String(name).toLowerCase().replace(/[_]/g, '-').replace(/\s+/g, ' ').trim();
  if (/\bnc\b|-nc\b|nc-|\bnd\b|-nd\b|nd-|noncommercial|non-commercial|noderiv/.test(s)) return null;
  if (/^(cc0|cc-0|cc zero|cc0 1\.0|cc-zero)/.test(s) || s === 'cc0') return 'CC0';
  if (s === 'pdm' || s.startsWith('public domain') || s === 'pd' || s.startsWith('pd-')) return 'Public Domain';
  const m = /^(?:cc[ -])?(by|by-sa)(?:[ -](\d\.\d))?$/.exec(s);
  if (!m) return null;
  const v = m[2] ?? (version ? String(version).trim() : '');
  if (!VERSIONS.includes(v)) return null;
  return `CC ${m[1]!.toUpperCase()} ${v}`;
}

export function licenceUrlFor(licence: string): string | null {
  if (licence === 'CC0') return 'https://creativecommons.org/publicdomain/zero/1.0/';
  if (licence === 'Public Domain') return 'https://creativecommons.org/publicdomain/mark/1.0/';
  const m = /^CC (BY|BY-SA) (\d\.\d)$/.exec(licence);
  return m ? `https://creativecommons.org/licenses/${m[1]!.toLowerCase()}/${m[2]}/` : null;
}

const stripHtml = (s: unknown) => (typeof s === 'string' ? s.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim() : '');
const mimeFromExt = (u: string) => {
  const ext = /\.([a-z0-9]{3,4})(?:$|[?#])/i.exec(u)?.[1]?.toLowerCase();
  return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : '';
};
const https = (u: unknown): u is string => typeof u === 'string' && /^https:\/\//i.test(u);

// ── Caches ───────────────────────────────────────────────────────────────

const queryCache = new Map<string, { at: number; items: Omit<PhotoCandidate, 'matchedOn'>[] }>();
const candidateCache = new Map<string, { at: number; c: PhotoCandidate }>();

function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value as K);
}

/** A candidate our own search returned in the last hour, looked up by its download URL (the SSRF guard uses this). */
export function cachedCandidate(fullUrl: string): PhotoCandidate | null {
  const hit = candidateCache.get(fullUrl);
  if (!hit || Date.now() - hit.at > CACHE_TTL_MS) return null;
  return hit.c;
}

// ── Upstreams ────────────────────────────────────────────────────────────

class Exhausted extends Error {}

let token: { value: string; until: number } | null = null;
async function openverseAuth(): Promise<Record<string, string>> {
  const id = env.OPENVERSE_CLIENT_ID;
  const secret = env.OPENVERSE_CLIENT_SECRET;
  if (!id || !secret) return {};
  if (token && token.until > Date.now()) return { Authorization: `Bearer ${token.value}` };
  try {
    const res = await fetchImpl('https://api.openverse.org/v1/auth_tokens/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return {};
    const j = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) return {};
    token = { value: j.access_token, until: Date.now() + Math.max(60, (j.expires_in ?? 3600) - 60) * 1000 };
    return { Authorization: `Bearer ${token.value}` };
  } catch {
    return {}; // fall back to anonymous
  }
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 429) throw new Exhausted('upstream limit');
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return res.json();
}

type Raw = Omit<PhotoCandidate, 'matchedOn'>;

async function searchOpenverse(q: string): Promise<Raw[]> {
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&license_type=commercial&page_size=20`;
  const body = (await getJson(url, await openverseAuth())) as { results?: Record<string, unknown>[] };
  const out: Raw[] = [];
  for (const r of body.results ?? []) {
    const licence = allowedLicence(r.license as string, r.license_version as string);
    const full = r.url;
    if (!licence || !https(full)) continue;
    const mime = (typeof r.mime_type === 'string' && r.mime_type) || (typeof r.filetype === 'string' && mimeFromExt(`x.${r.filetype}`)) || mimeFromExt(full);
    if (!IMAGE_MIMES.includes(mime)) continue;
    const creator = stripHtml(r.creator) || null;
    out.push({
      provider: 'openverse', id: String(r.id), title: stripHtml(r.title) || 'Untitled', thumbUrl: https(r.thumbnail) ? r.thumbnail : full, fullUrl: full,
      width: typeof r.width === 'number' ? r.width : null, height: typeof r.height === 'number' ? r.height : null, mime, licence,
      licenceUrl: (https(r.license_url) ? r.license_url : null) ?? licenceUrlFor(licence), creator,
      sourcePageUrl: https(r.foreign_landing_url) ? r.foreign_landing_url : full,
      attribution: stripHtml(r.attribution) || `"${stripHtml(r.title) || 'Photo'}"${creator ? ` by ${creator}` : ''}, ${licence}`,
    });
  }
  return out;
}

async function searchCommons(q: string): Promise<Raw[]> {
  const url = `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=20&gsrsearch=${encodeURIComponent(q)}&prop=imageinfo&iiprop=url|extmetadata|mime|size&iiurlwidth=800`;
  const body = (await getJson(url)) as { query?: { pages?: Record<string, { pageid?: number; title?: string; index?: number; imageinfo?: Record<string, unknown>[] }> } };
  const pages = Object.values(body.query?.pages ?? {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const out: Raw[] = [];
  for (const p of pages) {
    const ii = p.imageinfo?.[0];
    if (!ii) continue;
    const mime = String(ii.mime ?? '');
    if (!IMAGE_MIMES.includes(mime)) continue;
    const meta = (ii.extmetadata ?? {}) as Record<string, { value?: unknown } | undefined>;
    const licence = allowedLicence(stripHtml(meta.LicenseShortName?.value)) ?? allowedLicence(stripHtml(meta.License?.value));
    // Prefer the 800 px rendition: small, fast and on upload.wikimedia.org like the original.
    const full = https(ii.thumburl) ? ii.thumburl : ii.url;
    if (!licence || !https(full)) continue;
    const creator = stripHtml(meta.Artist?.value) || null;
    const title = stripHtml(meta.ObjectName?.value) || String(p.title ?? '').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '') || 'Untitled';
    const lurl = stripHtml(meta.LicenseUrl?.value);
    out.push({
      provider: 'commons', id: String(p.pageid ?? p.title), title, thumbUrl: full, fullUrl: full,
      width: typeof ii.thumbwidth === 'number' ? ii.thumbwidth : typeof ii.width === 'number' ? ii.width : null,
      height: typeof ii.thumbheight === 'number' ? ii.thumbheight : typeof ii.height === 'number' ? ii.height : null,
      mime, licence, licenceUrl: https(lurl) ? lurl : licenceUrlFor(licence), creator,
      sourcePageUrl: https(ii.descriptionurl) ? ii.descriptionurl : full,
      attribution: `"${title}"${creator ? ` by ${creator}` : ''}, ${licence}, via Wikimedia Commons`,
    });
  }
  return out;
}

const PROVIDERS = { openverse: searchOpenverse, commons: searchCommons } as const;

async function cachedSearch(provider: keyof typeof PROVIDERS, q: string, calls: PhotoSearchResult['calls']): Promise<{ items: Raw[]; exhausted: boolean }> {
  const key = `${provider}:${q.toLowerCase()}`;
  const hit = queryCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { items: hit.items, exhausted: false };
  calls[provider] += 1;
  try {
    const items = await PROVIDERS[provider](q);
    remember(queryCache, key, { at: Date.now(), items }, CACHE_MAX);
    return { items, exhausted: false };
  } catch (e) {
    return { items: [], exhausted: e instanceof Exhausted };
  }
}

/** Merges two lists, dropping repeats (same provider id, or the same file found through both providers). */
export function mergeCandidates(lists: PhotoCandidate[][]): PhotoCandidate[] {
  const seen = new Set<string>();
  const out: PhotoCandidate[] = [];
  for (const c of lists.flat()) {
    const fileKey = decodeURIComponent(c.fullUrl.split('?')[0]!.split('/').pop() ?? '').toLowerCase();
    const keys = [`${c.provider}:${c.id}`, `url:${c.fullUrl}`, `page:${c.sourcePageUrl}`, ...(fileKey.length > 6 ? [`file:${fileKey}`] : [])];
    if (keys.some((k) => seen.has(k))) continue;
    keys.forEach((k) => seen.add(k));
    out.push(c);
  }
  return out;
}

const clean = (...parts: (string | null | undefined)[]) => parts.map((p) => (p ?? '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

/**
 * Brand (+ strength) first; when that finds fewer than 3 photos, the salt or generic name with the dosage
 * form ("Azithromycin Tablet"). Results from both providers are merged and de-duplicated.
 */
export async function searchOpenImages(input: PhotoSearchInput): Promise<PhotoSearchResult> {
  const calls = { openverse: 0, commons: 0 };
  const queries: string[] = [];
  let exhausted = false;
  const run = async (q: string, matchedOn: PhotoCandidate['matchedOn']) => {
    queries.push(q);
    const res = await Promise.all((Object.keys(PROVIDERS) as (keyof typeof PROVIDERS)[]).map((p) => cachedSearch(p, q, calls)));
    if (res.some((r) => r.exhausted)) exhausted = true;
    return res.map((r) => r.items.map((c) => ({ ...c, matchedOn })));
  };
  const lists: PhotoCandidate[][] = [];
  const brandQ = clean(input.brand, input.strength);
  if (brandQ) lists.push(...(await run(brandQ, 'brand')));
  const salt = clean(input.composition || input.genericName);
  const saltQ = salt ? clean(salt.replace(/\([^)]*\)/g, ' ').replace(/\s*\+\s*/g, ' '), input.dosageForm) : '';
  if (mergeCandidates(lists).length < 3 && saltQ && saltQ.toLowerCase() !== brandQ.toLowerCase()) lists.push(...(await run(saltQ, 'composition')));
  const candidates = mergeCandidates(lists).slice(0, 40);
  for (const c of candidates) remember(candidateCache, c.fullUrl, { at: Date.now(), c }, CANDIDATE_MAX);
  return { candidates, queries, exhausted, calls };
}

// ── Download (SSRF-guarded) ──────────────────────────────────────────────

const FIXED_HOSTS = ['upload.wikimedia.org', 'live.staticflickr.com'];
export function allowedPhotoHost(host: string, extra: string[] = []): boolean {
  const h = host.toLowerCase();
  return FIXED_HOSTS.includes(h) || h.endsWith('.staticflickr.com') || extra.includes(h);
}

export const MAX_WEB_PHOTO_BYTES = 5 * 1024 * 1024;

/**
 * Downloads a candidate photo: https only, host on the allowlist (or the host an Openverse result named),
 * at most 3 redirects each re-checked, 10 s, 5 MB, image types only. Returns the bytes and type.
 */
export async function downloadPhoto(fullUrl: string, extraHosts: string[] = []): Promise<{ buffer: Buffer; mimeType: string }> {
  let url = fullUrl;
  const signal = AbortSignal.timeout(10_000);
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !allowedPhotoHost(u.hostname, extraHosts) || u.port) throw new DownloadError('That photo address is not allowed');
    const res = await fetchImpl(u.toString(), { headers: { 'User-Agent': USER_AGENT, Accept: IMAGE_MIMES.join(',') }, signal, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new DownloadError('The photo could not be downloaded');
      url = new URL(loc, u).toString();
      continue;
    }
    if (!res.ok) throw new DownloadError('The photo could not be downloaded');
    const mimeType = String(res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!IMAGE_MIMES.includes(mimeType)) throw new DownloadError('That address did not return a JPEG, PNG or WebP photo', 415);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_WEB_PHOTO_BYTES) throw new DownloadError('The photo is larger than 5 MB', 413);
    const chunks: Buffer[] = [];
    let size = 0;
    const reader = res.body?.getReader();
    if (!reader) throw new DownloadError('The photo could not be downloaded');
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_WEB_PHOTO_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new DownloadError('The photo is larger than 5 MB', 413);
      }
      chunks.push(Buffer.from(value));
    }
    return { buffer: Buffer.concat(chunks), mimeType };
  }
  throw new DownloadError('The photo could not be downloaded');
}

export class DownloadError extends Error {
  constructor(message: string, public status = 422) { super(message); }
}
