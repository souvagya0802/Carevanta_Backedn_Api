import { z } from 'zod';
import { badRequest } from './errors.js';

/**
 * Keyset (cursor) pagination over (createdAt DESC, id DESC). The cursor is an
 * opaque base64url token; offsets are never used, so deep pages stay O(log n)
 * with the matching composite index.
 */
export const MAX_PAGE_SIZE = 100;

export const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(25),
  cursor: z.string().max(200).optional(),
});

interface CursorPayload {
  t: string; // ISO timestamp
  i: string; // id
}

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt.toISOString(), i: id } satisfies CursorPayload)).toString(
    'base64url',
  );
}

export function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorPayload;
    const createdAt = new Date(parsed.t);
    if (Number.isNaN(createdAt.getTime()) || typeof parsed.i !== 'string' || !/^[0-9a-f-]{36}$/i.test(parsed.i)) {
      throw new Error('bad cursor');
    }
    return { createdAt, id: parsed.i };
  } catch {
    throw badRequest('Invalid pagination cursor');
  }
}

/** Prisma `where` fragment for rows strictly after the cursor in DESC order. */
export function cursorWhere(cursor: string | undefined, field: string = 'createdAt') {
  const c = decodeCursor(cursor);
  if (!c) return {};
  return {
    OR: [{ [field]: { lt: c.createdAt } }, { [field]: c.createdAt, id: { lt: c.id } }],
  };
}

export function cursorOrderBy(field: string = 'createdAt') {
  return [{ [field]: 'desc' as const }, { id: 'desc' as const }];
}

export interface Page<T> {
  data: T[];
  page: { limit: number; nextCursor: string | null; hasMore: boolean };
}

/** Call with `limit + 1` rows fetched; trims the sentinel and builds the cursor. */
export function buildPage<T extends { id: string }>(
  rows: T[],
  limit: number,
  getTime: (row: T) => Date,
): { items: T[]; page: Page<unknown>['page'] } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    page: { limit, hasMore, nextCursor: hasMore && last ? encodeCursor(getTime(last), last.id) : null },
  };
}
