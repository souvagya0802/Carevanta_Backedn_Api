import { prisma, type Tx } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, isPgError, notFound } from '../../lib/errors.js';
import { minor } from '../../http/dto.js';
import { createUser } from '../users/users.service.js';
import type { AuthContext } from '../../middleware/auth.js';
import type { ProviderMemberRole } from '../../../generated/prisma/client.js';

/**
 * Provider sub-resources that both the admin console and the provider portal
 * edit: coverage areas, staff, departments, amenities and priced offerings.
 * Routes decide *who* may call these; the functions here own the rules.
 */

export type ServiceAreaInput = { purpose: 'HOME_COLLECTION' | 'DELIVERY' | 'AMBULANCE'; district: string; pincode?: string };

export async function setServiceAreas(actor: AuthContext, providerId: string, areas: ServiceAreaInput[]) {
  return prisma.$transaction(async (tx) => {
    if (!(await tx.provider.findUnique({ where: { id: providerId }, select: { id: true } }))) throw notFound('Provider');
    await tx.providerServiceArea.deleteMany({ where: { providerId } });
    const unique = new Map(areas.map((a) => [`${a.purpose}|${a.district}|${a.pincode ?? ''}`, a]));
    await tx.providerServiceArea.createMany({ data: [...unique.values()].map((a) => ({ providerId, ...a, pincode: a.pincode ?? null })) });
    await audit(tx, { action: 'provider.service_areas_updated', entityType: 'provider', entityId: providerId, actorUserId: actor.userId, metadata: { count: unique.size } });
    return tx.providerServiceArea.findMany({ where: { providerId }, select: { purpose: true, district: true, pincode: true } });
  });
}

export type MemberInput =
  | { userId: string; memberRole: ProviderMemberRole }
  | { fullName: string; email?: string; phone?: string; memberRole: ProviderMemberRole };

/**
 * Add staff. Either link an existing account by id, or invite someone by
 * email/phone: an existing account with that contact is reused, otherwise a
 * new one is created and sent the set-your-password link.
 */
export async function addMember(actor: AuthContext, providerId: string, input: MemberInput) {
  let userId: string;
  let invited = false;
  if ('userId' in input) {
    userId = input.userId;
  } else {
    if (!input.email && !input.phone) throw badRequest('Give an email address or a mobile number for the staff member');
    const existing = await prisma.user.findFirst({ where: { OR: [...(input.email ? [{ email: input.email.toLowerCase() }] : []), ...(input.phone ? [{ phone: input.phone }] : [])] }, select: { id: true } });
    if (existing) userId = existing.id;
    else {
      userId = await createUser(actor, { fullName: input.fullName, email: input.email, phone: input.phone, roles: [], sendInvite: true });
      invited = true;
    }
  }
  try {
    await prisma.$transaction(async (tx) => {
      const provider = await tx.provider.findUnique({ where: { id: providerId } });
      if (!provider) throw notFound('Provider');
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user || user.status === 'ANONYMISED' || user.status === 'DEACTIVATED') throw badRequest('User must be an active account');
      await tx.providerMember.create({
        data: { providerId, userId, memberRole: input.memberRole, status: 'ACTIVE', invitedById: actor.userId, joinedAt: new Date() },
      });
      await audit(tx, { action: 'provider.member_added', entityType: 'provider', entityId: providerId, actorUserId: actor.userId, metadata: { userId, memberRole: input.memberRole, invited } });
    });
  } catch (err) {
    if (isPgError(err, '23505')) throw conflict('This user is already a member of the provider');
    throw err;
  }
  return { userId, invited };
}

export async function removeMember(actor: AuthContext, providerId: string, memberId: string) {
  await prisma.$transaction(async (tx) => {
    const m = await tx.providerMember.findFirst({ where: { id: memberId, providerId, status: { not: 'REMOVED' } } });
    if (!m) throw notFound('Member');
    if (m.userId === actor.userId) throw conflict('You cannot remove yourself; ask another owner');
    if (m.memberRole === 'OWNER') {
      const owners = await tx.providerMember.count({ where: { providerId, memberRole: 'OWNER', status: 'ACTIVE' } });
      if (owners <= 1) throw conflict('Assign another owner before removing the last one');
    }
    await tx.providerMember.update({ where: { id: m.id }, data: { status: 'REMOVED', removedAt: new Date() } });
    await audit(tx, { action: 'provider.member_removed', entityType: 'provider', entityId: providerId, actorUserId: actor.userId, metadata: { userId: m.userId } });
  });
}

/** Departments a hospital or clinic offers. New ones start unverified; verification is a separate admin action. */
export async function setDepartments(actor: AuthContext, providerId: string, departmentCodes: string[]) {
  await prisma.$transaction(async (tx) => {
    const p = await tx.provider.findUnique({ where: { id: providerId } });
    if (!p) throw notFound('Provider');
    if (p.type !== 'HOSPITAL' && p.type !== 'CLINIC') throw badRequest('Departments apply to hospitals and clinics only');
    const depts = await tx.department.findMany({ where: { code: { in: departmentCodes }, isActive: true } });
    if (depts.length !== new Set(departmentCodes).size) throw badRequest('Unknown department code');
    const keep = new Set(depts.map((d) => d.id));
    await tx.facilityDepartment.updateMany({ where: { providerId: p.id, departmentId: { notIn: [...keep] } }, data: { isActive: false } });
    for (const d of depts) {
      await tx.facilityDepartment.upsert({
        where: { providerId_departmentId: { providerId: p.id, departmentId: d.id } },
        create: { providerId: p.id, departmentId: d.id },
        update: { isActive: true },
      });
    }
    await audit(tx, { action: 'provider.departments_updated', entityType: 'provider', entityId: p.id, actorUserId: actor.userId, metadata: { codes: departmentCodes } });
  });
}

export async function setAmenities(actor: AuthContext, providerId: string, amenityCodes: string[]) {
  await prisma.$transaction(async (tx) => {
    if (!(await tx.provider.findUnique({ where: { id: providerId }, select: { id: true } }))) throw notFound('Provider');
    const items = await tx.amenity.findMany({ where: { code: { in: amenityCodes } } });
    if (items.length !== new Set(amenityCodes).size) throw badRequest('Unknown amenity code');
    await tx.providerAmenity.deleteMany({ where: { providerId, amenityId: { notIn: items.map((i) => i.id) } } });
    const present = new Set((await tx.providerAmenity.findMany({ where: { providerId }, select: { amenityId: true } })).map((a) => a.amenityId));
    const missing = items.filter((i) => !present.has(i.id));
    if (missing.length) await tx.providerAmenity.createMany({ data: missing.map((i) => ({ providerId, amenityId: i.id })) });
    await audit(tx, { action: 'provider.amenities_updated', entityType: 'provider', entityId: providerId, actorUserId: actor.userId, metadata: { codes: amenityCodes } });
  });
}

// ─── Priced offerings (tests, scans, procedures, consultations) ────────────
export async function listOfferings(providerId: string, db: Tx | typeof prisma = prisma) {
  const rows = await db.providerService.findMany({ where: { providerId }, include: { service: true, location: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } });
  return rows.map((o) => ({
    id: o.id,
    serviceCode: o.service.code,
    serviceName: o.service.name,
    category: o.service.category,
    requiresPrescription: o.service.requiresPrescription,
    locationId: o.locationId,
    locationName: o.location?.name ?? null,
    priceMinor: minor(o.priceMinor)!,
    currency: o.currency,
    homeServiceAvailable: o.homeServiceAvailable,
    turnaroundHours: o.turnaroundHours,
    isActive: o.isActive,
  }));
}

export type OfferingInput = { locationId: string | null; priceMinor: number; homeServiceAvailable: boolean; turnaroundHours?: number; isActive: boolean };

export async function upsertOffering(actor: AuthContext, providerId: string, serviceCode: string, body: OfferingInput) {
  return prisma.$transaction(async (tx) => {
    const service = await tx.service.findUnique({ where: { code: serviceCode } });
    if (!service || !service.isActive) throw badRequest('Unknown or inactive service');
    const provider = await tx.provider.findUnique({ where: { id: providerId } });
    if (!provider) throw notFound('Provider');
    if (body.locationId && !(await tx.providerLocation.findFirst({ where: { id: body.locationId, providerId } }))) {
      throw badRequest('Location does not belong to this provider');
    }
    const existing = await tx.providerService.findFirst({ where: { providerId, serviceId: service.id, locationId: body.locationId } });
    const data = { priceMinor: BigInt(body.priceMinor), homeServiceAvailable: body.homeServiceAvailable, turnaroundHours: body.turnaroundHours ?? null, isActive: body.isActive };
    const o = existing
      ? await tx.providerService.update({ where: { id: existing.id }, data })
      : await tx.providerService.create({ data: { providerId, serviceId: service.id, locationId: body.locationId, ...data } });
    await audit(tx, { action: 'provider.offering_saved', entityType: 'provider', entityId: providerId, actorUserId: actor.userId, metadata: { serviceCode, priceMinor: body.priceMinor } });
    return { id: o.id };
  });
}
