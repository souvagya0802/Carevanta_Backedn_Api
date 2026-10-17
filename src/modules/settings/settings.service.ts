import { prisma } from '../../lib/prisma.js';

/**
 * Typed read of a platform setting with a code default. Settings are small and
 * read on hot paths, so values are cached per process for 30 s; writes through
 * the admin API invalidate the local cache immediately.
 */
const cache = new Map<string, { value: unknown; at: number }>();
const TTL_MS = 30_000;

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
  const row = await prisma.platformSetting.findUnique({ where: { key } });
  const value = (row?.value ?? fallback) as T;
  cache.set(key, { value, at: Date.now() });
  return value;
}

export function invalidateSetting(key?: string) {
  if (key) cache.delete(key);
  else cache.clear();
}
