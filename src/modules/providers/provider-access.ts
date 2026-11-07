import { prisma } from '../../lib/prisma.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { auditDetached } from '../../lib/audit.js';
import type { AuthContext } from '../../middleware/auth.js';
import type { PermissionKey, ProviderCapability } from '../access/permissions.js';
import { capabilitiesForRole } from '../portal/portal-ui.js';

export { capabilitiesForRole };

/**
 * Object-level authorisation for provider-scoped resources (prevents IDOR /
 * BOLA). Access is granted when the caller either holds the platform
 * permission, or is an ACTIVE member of *this specific* provider with the
 * required capability. Being a member of provider A never grants access to B.
 *
 * Which capabilities a role carries is the shipped matrix, adjustable by the
 * super-admin (`portal.member_capabilities`); owners always hold everything.
 */
export async function assertProviderAccess(
  auth: AuthContext,
  providerId: string,
  opts: { platformPermission?: PermissionKey; capability?: ProviderCapability },
): Promise<'PLATFORM' | 'MEMBER'> {
  if (opts.platformPermission && auth.has(opts.platformPermission)) return 'PLATFORM';
  if (opts.capability && auth.status === 'ACTIVE') {
    const member = await prisma.providerMember.findUnique({
      where: { providerId_userId: { providerId, userId: auth.userId } },
      select: { status: true, memberRole: true },
    });
    if (member?.status === 'ACTIVE') {
      const caps = await capabilitiesForRole(member.memberRole);
      if (caps.includes(opts.capability)) return 'MEMBER';
    }
  }
  await auditDetached({
    action: 'access.denied',
    entityType: 'provider',
    entityId: providerId,
    actorUserId: auth.userId,
    outcome: 'DENIED',
    metadata: { capability: opts.capability, permission: opts.platformPermission },
  });
  // 404 rather than 403 for non-members, so provider ids cannot be probed.
  const exists = await prisma.provider.count({ where: { id: providerId } });
  if (!exists) throw notFound('Provider');
  throw forbidden();
}

/**
 * Read access for provider staff: any ACTIVE member of this provider (or a
 * platform user with the permission) may see their own organisation's data.
 * Returns the caller's role so handlers can tailor what they show.
 */
export async function assertProviderMember(auth: AuthContext, providerId: string, platformPermission: PermissionKey = 'providers.read'): Promise<{ via: 'PLATFORM' | 'MEMBER'; role: string | null; capabilities: readonly ProviderCapability[] }> {
  if (auth.has(platformPermission)) return { via: 'PLATFORM', role: null, capabilities: [] };
  if (auth.status === 'ACTIVE') {
    const member = await prisma.providerMember.findUnique({ where: { providerId_userId: { providerId, userId: auth.userId } }, select: { status: true, memberRole: true } });
    if (member?.status === 'ACTIVE') return { via: 'MEMBER', role: member.memberRole, capabilities: await capabilitiesForRole(member.memberRole) };
  }
  await auditDetached({ action: 'access.denied', entityType: 'provider', entityId: providerId, actorUserId: auth.userId, outcome: 'DENIED', metadata: { permission: platformPermission, membership: 'required' } });
  const exists = await prisma.provider.count({ where: { id: providerId } });
  if (!exists) throw notFound('Provider');
  throw forbidden();
}

/** The Doctor provider owned by the calling user, if any. */
export async function getOwnDoctorProviderId(auth: AuthContext): Promise<string | null> {
  const p = await prisma.doctorProfile.findUnique({ where: { userId: auth.userId }, select: { providerId: true } });
  return p?.providerId ?? null;
}
