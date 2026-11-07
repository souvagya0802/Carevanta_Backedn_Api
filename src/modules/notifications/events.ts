/**
 * Application events that provider staff and patients should hear about,
 * delivered in-app (always) and by push (when the person has a subscribed
 * device). Written inside the same transaction as the business change, so a
 * notification never exists for something that was rolled back.
 *
 * Who hears about it is decided by capability, not by role name, so the
 * super-admin's role matrix applies here too: "everyone who manages bookings
 * at this facility" is whoever the matrix says that is.
 */
import type { Db } from '../../lib/prisma.js';
import { memberCapabilityMatrix } from '../portal/portal-ui.js';

export interface AppNotice {
  /** Stable key for analytics and user preferences, e.g. portal.appointment_booked. */
  key: string;
  title: string;
  body: string;
  /** Portal path to open when tapped. */
  link?: string;
  urgent?: boolean;
  /** Do not notify this person (usually the one who performed the action). */
  exceptUserId?: string | null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** In-app row (already "delivered") plus a queued push for each person with a subscribed device. */
export async function notifyUsers(db: Db, userIds: readonly string[], n: AppNotice) {
  const ids = [...new Set(userIds)].filter((id) => id && id !== n.exceptUserId);
  if (!ids.length) return 0;
  const now = new Date();
  const title = clip(n.title, 200);
  const body = clip(n.body, 1000);
  const link = n.link ? clip(n.link, 300) : null;
  await db.notification.createMany({ data: ids.map((userId) => ({ userId, channel: 'IN_APP' as const, templateKey: n.key, recipient: userId, payload: {}, status: 'SENT' as const, sentAt: now, title, body, link })) });
  const withPush = await db.pushSubscription.findMany({ where: { userId: { in: ids } }, distinct: ['userId'], select: { userId: true } });
  if (withPush.length) {
    await db.notification.createMany({ data: withPush.map((s) => ({ userId: s.userId, channel: 'PUSH' as const, templateKey: n.key, recipient: s.userId, payload: { urgent: !!n.urgent }, title, body, link })) });
  }
  return ids.length;
}

/** Active members of one provider whose role carries the capability. */
export async function staffWithCapability(db: Db, providerIds: readonly string[], capability: string): Promise<string[]> {
  if (!providerIds.length) return [];
  const [members, matrix] = await Promise.all([
    db.providerMember.findMany({ where: { providerId: { in: [...providerIds] }, status: 'ACTIVE' }, select: { userId: true, memberRole: true } }),
    memberCapabilityMatrix(),
  ]);
  return members.filter((m) => (matrix[m.memberRole] ?? []).includes(capability as never)).map((m) => m.userId);
}

export async function notifyProviderStaff(db: Db, providerId: string, capability: string, n: AppNotice) {
  return notifyUsers(db, await staffWithCapability(db, [providerId], capability), n);
}

export async function notifyProviderStaffMany(db: Db, providerIds: readonly string[], capability: string, n: AppNotice) {
  return notifyUsers(db, await staffWithCapability(db, providerIds, capability), n);
}
