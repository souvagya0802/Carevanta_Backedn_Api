/**
 * Email side of application events. The in-app and push notices are written by
 * `events.ts`; these helpers queue an EMAIL outbox row (rendered from the
 * active template for the key) for each recipient who has an email address,
 * inside the caller's transaction so a rolled-back change sends nothing.
 *
 * The person who performed the action is never emailed about it, and people
 * without an email address (or whose account is deactivated) are skipped.
 */
import type { Db } from '../../lib/prisma.js';
import { staffWithCapability } from './events.js';
import { enqueueNotification } from './notifications.service.js';

/** SAMPLE_COLLECTED → "Sample Collected", for statuses shown in emails. */
export const titleCaseStatus = (status: string): string =>
  status.toLowerCase().split('_').filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');

export async function emailUsers(db: Db, userIds: readonly (string | null | undefined)[], templateKey: string, payload: Record<string, unknown>, exceptUserId?: string | null): Promise<number> {
  const ids = [...new Set(userIds.filter((id): id is string => !!id && id !== exceptUserId))];
  if (!ids.length) return 0;
  const users = await db.user.findMany({ where: { id: { in: ids }, email: { not: null }, status: { not: 'DEACTIVATED' } }, select: { id: true, email: true } });
  let sent = 0;
  for (const u of users) {
    if (!u.email) continue;
    await enqueueNotification(db, { userId: u.id, channel: 'EMAIL', templateKey, recipient: u.email, payload });
    sent++;
  }
  return sent;
}

/** Email the active members of a provider whose role carries the capability (e.g. manage_bookings). */
export async function emailProviderStaff(db: Db, providerId: string, capability: string, templateKey: string, payload: Record<string, unknown>, exceptUserId?: string | null): Promise<number> {
  return emailUsers(db, await staffWithCapability(db, [providerId], capability), templateKey, payload, exceptUserId);
}
