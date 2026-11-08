/**
 * Application events that provider staff, patients and platform staff should
 * hear about, delivered in-app (always), live over the notification stream,
 * and by push (when the person has a subscribed device). Written inside the
 * same transaction as the business change, so a notification never exists for
 * something that was rolled back.
 *
 * Who hears about it is decided by capability or permission, not by role name,
 * so the super-admin's role matrix applies here too: "everyone who manages
 * bookings at this facility" is whoever the matrix says that is.
 */
import type { Db, Prisma } from '../../lib/prisma.js';
import { memberCapabilityMatrix } from '../portal/portal-ui.js';

/** How loudly the apps surface a notice: critical and important pop up live; light only updates the bell. */
export type NoticeLevel = 'critical' | 'important' | 'light';
export const NOTICE_LEVELS: readonly NoticeLevel[] = ['critical', 'important', 'light'];

/** What the notice is about, so a pop-up can offer a quick action (e.g. Confirm on a new appointment request). */
export type NoticeKind = 'appointment' | 'diagnostic_order' | 'pharmacy_order' | 'prescription' | 'dispatch' | 'affiliation' | 'application' | 'support_case' | 'review' | 'verification' | 'refund';
export interface NoticeMeta { kind: NoticeKind; id: string; providerId?: string; status?: string }

export interface AppNotice {
  /** Stable key for analytics and user preferences, e.g. portal.appointment_booked. */
  key: string;
  title: string;
  body: string;
  /** Path to open when tapped (portal, patient app or dashboard, depending on the recipient). */
  link?: string;
  /** Legacy flag; maps to `important` when `level` is not given. */
  urgent?: boolean;
  level?: NoticeLevel;
  meta?: NoticeMeta;
  /** Do not notify this person (usually the one who performed the action). */
  exceptUserId?: string | null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Effective level of a notice: explicit level, else `urgent` → important, else light. */
export const noticeLevel = (n: { level?: NoticeLevel; urgent?: boolean }): NoticeLevel => n.level ?? (n.urgent ? 'important' : 'light');

/** Level and meta as stored in a notification row's payload (tolerates rows written before levels existed). */
export function noticeFields(payload: unknown): { level: NoticeLevel; meta: NoticeMeta | null } {
  const p = (payload && typeof payload === 'object' ? payload : {}) as { level?: unknown; urgent?: unknown; meta?: unknown };
  const level = NOTICE_LEVELS.includes(p.level as NoticeLevel) ? (p.level as NoticeLevel) : p.urgent === true ? 'important' : 'light';
  const m = p.meta as Partial<NoticeMeta> | undefined;
  const meta = m && typeof m === 'object' && typeof m.kind === 'string' && typeof m.id === 'string' ? ({ kind: m.kind, id: m.id, ...(m.providerId ? { providerId: m.providerId } : {}), ...(m.status ? { status: m.status } : {}) } as NoticeMeta) : null;
  return { level, meta };
}

/** In-app row (already "delivered") plus a queued push for each person with a subscribed device. */
export async function notifyUsers(db: Db, userIds: readonly string[], n: AppNotice) {
  const ids = [...new Set(userIds)].filter((id) => id && id !== n.exceptUserId);
  if (!ids.length) return 0;
  const now = new Date();
  const title = clip(n.title, 200);
  const body = clip(n.body, 1000);
  const link = n.link ? clip(n.link, 300) : null;
  const level = noticeLevel(n);
  const payload = { level, ...(n.meta ? { meta: n.meta } : {}) } as unknown as Prisma.InputJsonObject;
  await db.notification.createMany({ data: ids.map((userId) => ({ userId, channel: 'IN_APP' as const, templateKey: n.key, recipient: userId, payload, status: 'SENT' as const, sentAt: now, title, body, link })) });
  const withPush = await db.pushSubscription.findMany({ where: { userId: { in: ids } }, distinct: ['userId'], select: { userId: true } });
  if (withPush.length) {
    await db.notification.createMany({ data: withPush.map((s) => ({ userId: s.userId, channel: 'PUSH' as const, templateKey: n.key, recipient: s.userId, payload: { ...payload, urgent: level !== 'light' } as Prisma.InputJsonObject, title, body, link })) });
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

/** Active platform users whose live roles carry the permission (super admins included through their role). */
export async function usersWithPermission(db: Db, permission: string): Promise<string[]> {
  const grants = await db.userRole.findMany({
    where: { revokedAt: null, user: { status: 'ACTIVE' }, role: { permissions: { some: { permission: { key: permission } } } } },
    select: { userId: true },
  });
  return [...new Set(grants.map((g) => g.userId))];
}

/** Notify everyone on the platform side who can act on it, e.g. verification officers for a new application. */
export async function notifyUsersWithPermission(db: Db, permission: string, n: AppNotice) {
  return notifyUsers(db, await usersWithPermission(db, permission), n);
}
