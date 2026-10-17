import { prisma, type Tx } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { AppError, badRequest, conflict, isPgError, notFound, preconditionFailed } from '../../lib/errors.js';
import { assertTransition } from '../../lib/state-machine.js';
import { randomToken, sha256Hex } from '../../lib/crypto.js';
import { buildPage, cursorOrderBy, cursorWhere } from '../../lib/pagination.js';
import { dec, iso, isoDate, minor } from '../../http/dto.js';
import { enqueueNotification } from '../notifications/notifications.service.js';
import { PROVIDER_TRANSITIONS, VERIFICATION_REQUIREMENTS } from './provider-state.js';
import type { CreateProviderInput } from './providers.schemas.js';
import type { z } from 'zod';
import type { LocationInput, UpdateProviderInput } from './providers.schemas.js';
import type { AuthContext } from '../../middleware/auth.js';
import type { Prisma, ProviderStatus, ProviderType } from '../../../generated/prisma/client.js';

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 180);
}

async function uniqueSlug(tx: Tx, base: string): Promise<string> {
  const root = slugify(base) || 'provider';
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    if (!(await tx.provider.findUnique({ where: { slug: candidate }, select: { id: true } }))) return candidate;
  }
  return `${root}-${randomToken(4).toLowerCase()}`;
}

async function resolveOwner(
  tx: Tx,
  actor: AuthContext,
  owner: CreateProviderInput['owner'],
): Promise<{ userId: string; created: boolean } | undefined> {
  if (!owner) return undefined;
  if ('existingUserId' in owner) {
    const u = await tx.user.findUnique({ where: { id: owner.existingUserId } });
    if (!u) throw notFound('Owner user');
    if (u.status === 'ANONYMISED' || u.status === 'DEACTIVATED') throw conflict('The selected owner account is not active');
    return { userId: u.id, created: false };
  }
  if (!owner.email && !owner.phone) throw badRequest('Owner needs an email address or a mobile number');
  const u = await tx.user.create({
    data: {
      fullName: owner.fullName,
      email: owner.email?.toLowerCase(),
      phone: owner.phone,
      status: 'ACTIVE',
      mustChangePassword: true,
      createdById: actor.userId,
    },
  });
  const token = randomToken(32);
  await tx.verificationToken.create({
    data: { userId: u.id, purpose: 'PASSWORD_RESET', tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + 72 * 3600_000) },
  });
  await enqueueNotification(tx, {
    userId: u.id,
    channel: owner.email ? 'EMAIL' : 'SMS',
    templateKey: 'auth.account_created',
    recipient: (owner.email ?? owner.phone)!,
    payload: { token },
  });
  return { userId: u.id, created: true };
}

export async function createLocation(tx: Tx, providerId: string, loc: z.infer<typeof LocationInput>) {
  let regionId: string | null = null;
  if (loc.regionCode) {
    const region = await tx.serviceRegion.findUnique({ where: { code: loc.regionCode } });
    if (!region) throw badRequest(`Unknown service region ${loc.regionCode}`);
    regionId = region.id;
  }
  if (loc.isPrimary) await tx.providerLocation.updateMany({ where: { providerId, isPrimary: true }, data: { isPrimary: false } });
  const hasAny = await tx.providerLocation.count({ where: { providerId } });
  return tx.providerLocation.create({
    data: {
      providerId,
      regionId,
      name: loc.name,
      addressLine1: loc.addressLine1,
      addressLine2: loc.addressLine2,
      locality: loc.locality,
      city: loc.city,
      district: loc.district,
      state: loc.state,
      pincode: loc.pincode,
      latitude: loc.latitude,
      longitude: loc.longitude,
      phone: loc.phone,
      isPrimary: loc.isPrimary || hasAny === 0,
    },
  });
}

export async function createProvider(actor: AuthContext, input: CreateProviderInput): Promise<string> {
  try {
    return await prisma.$transaction(async (tx) => {
      const owner = await resolveOwner(tx, actor, input.owner);
      if (input.type === 'DOCTOR') {
        if (!owner) throw badRequest('A doctor provider must be linked to the doctor’s own user account');
        const existing = await tx.doctorProfile.findUnique({ where: { userId: owner.userId } });
        if (existing) throw conflict('This user already has a doctor profile; doctors are never duplicated');
      }

      const provider = await tx.provider.create({
        data: {
          type: input.type,
          status: 'DRAFT',
          legalName: input.legalName,
          displayName: input.displayName,
          slug: await uniqueSlug(tx, input.displayName),
          description: input.description,
          contactEmail: input.contactEmail?.toLowerCase(),
          contactPhone: input.contactPhone,
          gstin: input.gstin,
          registrationNumber: input.registrationNumber,
          createdById: actor.userId,
        },
      });
      await tx.providerStatusHistory.create({
        data: { providerId: provider.id, fromStatus: null, toStatus: 'DRAFT', changedById: actor.userId, reason: 'Created' },
      });

      switch (input.type) {
        case 'DOCTOR': {
          const d = input.doctor;
          await tx.doctorProfile.create({
            data: {
              providerId: provider.id,
              userId: owner!.userId,
              gender: d.gender,
              yearsOfExperience: d.yearsOfExperience,
              languages: d.languages,
              defaultFeeMinor: d.defaultFeeMinor != null ? BigInt(d.defaultFeeMinor) : null,
              bio: d.bio,
            },
          });
          await setDoctorSpecialities(tx, provider.id, d.specialityCodes, d.primarySpecialityCode);
          for (const q of d.qualifications) await tx.doctorQualification.create({ data: { doctorProviderId: provider.id, ...q } });
          for (const reg of d.registrations) {
            await tx.professionalRegistration.create({
              data: {
                doctorProviderId: provider.id,
                council: reg.council,
                registrationNumber: reg.registrationNumber.toUpperCase(),
                registrationYear: reg.registrationYear,
                validUntil: reg.validUntil ? new Date(reg.validUntil) : null,
              },
            });
          }
          break;
        }
        case 'HOSPITAL':
        case 'CLINIC':
          await tx.facilityProfile.create({ data: { providerId: provider.id, ...input.facility } });
          break;
        case 'DIAGNOSTIC_LAB':
        case 'IMAGING_CENTRE':
          await tx.diagnosticProfile.create({ data: { providerId: provider.id, ...input.diagnostic } });
          break;
        case 'PHARMACY':
          await tx.pharmacyProfile.create({
            data: {
              providerId: provider.id,
              ...input.pharmacy,
              drugLicenseValidUntil: input.pharmacy.drugLicenseValidUntil ? new Date(input.pharmacy.drugLicenseValidUntil) : null,
            },
          });
          break;
        case 'AMBULANCE_OPERATOR':
          await tx.ambulanceOperatorProfile.create({ data: { providerId: provider.id, ...input.ambulance } });
          break;
      }

      if (owner) {
        await tx.providerMember.create({
          data: { providerId: provider.id, userId: owner.userId, memberRole: 'OWNER', status: 'ACTIVE', invitedById: actor.userId, joinedAt: new Date() },
        });
      }
      const locations = input.locations?.length ? input.locations : input.location ? [input.location] : [];
      const primaryIndex = Math.max(0, locations.findIndex((l) => l.isPrimary));
      for (const [i, loc] of locations.entries()) await createLocation(tx, provider.id, { ...loc, isPrimary: i === primaryIndex });

      await audit(tx, {
        action: 'provider.created',
        entityType: 'provider',
        entityId: provider.id,
        metadata: { type: input.type, ownerCreated: owner?.created ?? false },
      });
      return provider.id;
    });
  } catch (err) {
    if (isPgError(err, '23505')) {
      throw conflict('A provider, user or registration with these identifiers already exists');
    }
    throw err;
  }
}

async function setDoctorSpecialities(tx: Tx, providerId: string, codes: string[], primary?: string) {
  if (!codes.length) return;
  const specs = await tx.speciality.findMany({ where: { code: { in: codes }, isActive: true } });
  if (specs.length !== new Set(codes).size) throw badRequest('One or more speciality codes are unknown or inactive');
  if (primary && !codes.includes(primary)) throw badRequest('primarySpecialityCode must be one of specialityCodes');
  await tx.doctorSpeciality.deleteMany({ where: { doctorProviderId: providerId } });
  await tx.doctorSpeciality.createMany({
    data: specs.map((s) => ({ doctorProviderId: providerId, specialityId: s.id, isPrimary: s.code === (primary ?? codes[0]) })),
  });
}

export async function listProviders(q: {
  limit: number;
  cursor?: string;
  type?: ProviderType;
  status?: ProviderStatus;
  district?: string;
  q?: string;
}) {
  const where: Prisma.ProviderWhereInput = {
    ...(q.type ? { type: q.type } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.district ? { locations: { some: { district: { equals: q.district, mode: 'insensitive' } } } } : {}),
    ...(q.q
      ? {
          OR: [
            { displayName: { contains: q.q, mode: 'insensitive' } },
            { legalName: { contains: q.q, mode: 'insensitive' } },
            { gstin: q.q.toUpperCase() },
            { registrationNumber: q.q },
          ],
        }
      : {}),
    ...cursorWhere(q.cursor),
  };
  const rows = await prisma.provider.findMany({
    where,
    orderBy: cursorOrderBy(),
    take: q.limit + 1,
    include: { locations: { where: { isPrimary: true }, select: { city: true, district: true } } },
  });
  const { items, page } = buildPage(rows, q.limit, (p) => p.createdAt);
  return {
    page,
    items: items.map((p) => ({
      id: p.id,
      type: p.type,
      status: p.status,
      displayName: p.displayName,
      legalName: p.legalName,
      isListed: p.isListed,
      city: p.locations[0]?.city ?? null,
      district: p.locations[0]?.district ?? null,
      ratingAverage: dec(p.ratingAverage),
      ratingCount: p.ratingCount,
      createdAt: p.createdAt.toISOString(),
    })),
  };
}

export async function getProvider(id: string) {
  const p = await prisma.provider.findUnique({
    where: { id },
    include: {
      doctorProfile: {
        include: {
          user: { select: { id: true, fullName: true, email: true, phone: true } },
          specialities: { include: { speciality: { select: { code: true, name: true } } } },
          qualifications: true,
          registrations: true,
        },
      },
      facilityProfile: true,
      diagnosticProfile: true,
      pharmacyProfile: true,
      ambulanceProfile: true,
      locations: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }], include: { region: { select: { code: true, name: true } }, operatingHours: true } },
      members: { include: { user: { select: { fullName: true, email: true, phone: true } } } },
      verificationCases: { orderBy: { createdAt: 'desc' }, take: 1, include: { checks: true } },
      statusHistory: { orderBy: { createdAt: 'desc' }, take: 20 },
      departments: { include: { department: { select: { code: true, name: true } } } },
      amenities: { include: { amenity: { select: { code: true, name: true } } } },
      _count: { select: { documents: true, facilityAffiliations: true, doctorAffiliations: true } },
    },
  });
  if (!p) throw notFound('Provider');
  const d = p.doctorProfile;
  return {
    id: p.id,
    type: p.type,
    status: p.status,
    version: p.version,
    legalName: p.legalName,
    displayName: p.displayName,
    slug: p.slug,
    description: p.description,
    contactEmail: p.contactEmail,
    contactPhone: p.contactPhone,
    gstin: p.gstin,
    registrationNumber: p.registrationNumber,
    isListed: p.isListed,
    statusReason: p.statusReason,
    submittedAt: iso(p.submittedAt),
    approvedAt: iso(p.approvedAt),
    suspendedAt: iso(p.suspendedAt),
    ratingAverage: dec(p.ratingAverage),
    ratingCount: p.ratingCount,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    doctor: d
      ? {
          user: d.user,
          gender: d.gender,
          yearsOfExperience: d.yearsOfExperience,
          languages: d.languages,
          defaultFeeMinor: minor(d.defaultFeeMinor),
          currency: d.currency,
          bio: d.bio,
          specialities: d.specialities.map((s) => ({ code: s.speciality.code, name: s.speciality.name, isPrimary: s.isPrimary, verified: s.verified })),
          qualifications: d.qualifications.map((q) => ({ id: q.id, degree: q.degree, institution: q.institution, yearAwarded: q.yearAwarded, verified: q.verified })),
          registrations: d.registrations.map((r) => ({
            id: r.id,
            council: r.council,
            registrationNumber: r.registrationNumber,
            registrationYear: r.registrationYear,
            validUntil: isoDate(r.validUntil),
            verifiedAt: iso(r.verifiedAt),
          })),
        }
      : null,
    facility: p.facilityProfile,
    diagnostic: p.diagnosticProfile,
    pharmacy: p.pharmacyProfile ? { ...p.pharmacyProfile, drugLicenseValidUntil: isoDate(p.pharmacyProfile.drugLicenseValidUntil) } : null,
    ambulance: p.ambulanceProfile,
    locations: p.locations.map((l) => ({
      id: l.id,
      name: l.name,
      addressLine1: l.addressLine1,
      addressLine2: l.addressLine2,
      locality: l.locality,
      city: l.city,
      district: l.district,
      state: l.state,
      pincode: l.pincode,
      latitude: dec(l.latitude),
      longitude: dec(l.longitude),
      phone: l.phone,
      isPrimary: l.isPrimary,
      isActive: l.isActive,
      region: l.region,
      operatingHours: l.operatingHours
        .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.opensAtMin - b.opensAtMin)
        .map((h) => ({ dayOfWeek: h.dayOfWeek, opensAtMin: h.opensAtMin, closesAtMin: h.closesAtMin, isClosed: h.isClosed })),
    })),
    members: p.members.map((m) => ({
      id: m.id,
      userId: m.userId,
      fullName: m.user.fullName,
      email: m.user.email,
      phone: m.user.phone,
      memberRole: m.memberRole,
      status: m.status,
      joinedAt: iso(m.joinedAt),
    })),
    latestVerificationCase: p.verificationCases[0]
      ? {
          id: p.verificationCases[0].id,
          status: p.verificationCases[0].status,
          kind: p.verificationCases[0].kind,
          checks: p.verificationCases[0].checks.map((c) => ({ checkType: c.checkType, status: c.status, isRequired: c.isRequired })),
        }
      : null,
    statusHistory: p.statusHistory.map((h) => ({
      fromStatus: h.fromStatus,
      toStatus: h.toStatus,
      changedById: h.changedById,
      reason: h.reason,
      createdAt: h.createdAt.toISOString(),
    })),
    departments: p.departments.map((x) => ({ code: x.department.code, name: x.department.name, isActive: x.isActive, verified: !!x.verifiedAt })),
    amenities: p.amenities.map((x) => ({ code: x.amenity.code, name: x.amenity.name, verified: !!x.verifiedAt })),
    counts: { documents: p._count.documents, affiliationsAsFacility: p._count.facilityAffiliations, affiliationsAsDoctor: p._count.doctorAffiliations },
  };
}

export async function updateProvider(actor: AuthContext, id: string, input: z.infer<typeof UpdateProviderInput>) {
  await prisma.$transaction(async (tx) => {
    const p = await tx.provider.findUnique({ where: { id } });
    if (!p) throw notFound('Provider');
    if (p.status === 'DEACTIVATED') throw conflict('Deactivated providers cannot be edited');
    const { expectedVersion, doctor, facility, diagnostic, pharmacy, ambulance, ...core } = input;
    const updated = await tx.provider.updateMany({
      where: { id, version: expectedVersion },
      data: {
        ...core,
        ...(core.contactEmail !== undefined ? { contactEmail: core.contactEmail?.toLowerCase() ?? null } : {}),
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new AppError(409, 'CONFLICT', 'This provider was changed by someone else. Reload and try again.', {
        currentVersion: p.version,
      });
    }
    const typeMismatch = (cond: boolean, field: string) => {
      if (cond) throw badRequest(`${field} details do not apply to a ${p.type} provider`);
    };
    if (doctor) {
      typeMismatch(p.type !== 'DOCTOR', 'doctor');
      await tx.doctorProfile.update({
        where: { providerId: id },
        data: {
          ...doctor,
          ...(doctor.defaultFeeMinor !== undefined ? { defaultFeeMinor: BigInt(doctor.defaultFeeMinor) } : {}),
        },
      });
    }
    if (facility) {
      typeMismatch(p.type !== 'HOSPITAL' && p.type !== 'CLINIC', 'facility');
      await tx.facilityProfile.update({ where: { providerId: id }, data: facility });
    }
    if (diagnostic) {
      typeMismatch(p.type !== 'DIAGNOSTIC_LAB' && p.type !== 'IMAGING_CENTRE', 'diagnostic');
      await tx.diagnosticProfile.update({ where: { providerId: id }, data: diagnostic });
    }
    if (pharmacy) {
      typeMismatch(p.type !== 'PHARMACY', 'pharmacy');
      await tx.pharmacyProfile.update({
        where: { providerId: id },
        data: {
          ...pharmacy,
          ...(pharmacy.drugLicenseValidUntil !== undefined ? { drugLicenseValidUntil: new Date(pharmacy.drugLicenseValidUntil) } : {}),
        },
      });
    }
    if (ambulance) {
      typeMismatch(p.type !== 'AMBULANCE_OPERATOR', 'ambulance');
      await tx.ambulanceOperatorProfile.update({ where: { providerId: id }, data: ambulance });
    }
    await audit(tx, {
      action: 'provider.updated',
      entityType: 'provider',
      entityId: id,
      actorUserId: actor.userId,
      metadata: { fields: Object.keys(input).filter((k) => k !== 'expectedVersion') },
    });
  });
}

/** The single path through which provider status changes (besides approval). */
export async function transitionProvider(
  tx: Tx,
  providerId: string,
  to: ProviderStatus,
  actorUserId: string | null,
  reason: string | null,
) {
  const p = await tx.provider.findUnique({ where: { id: providerId } });
  if (!p) throw notFound('Provider');
  assertTransition('Provider', PROVIDER_TRANSITIONS, p.status, to);
  const now = new Date();
  const hasLocation = (await tx.providerLocation.count({ where: { providerId, isActive: true } })) > 0;
  const res = await tx.provider.updateMany({
    where: { id: providerId, status: p.status },
    data: {
      status: to,
      statusReason: reason,
      version: { increment: 1 },
      isListed: to === 'APPROVED' && hasLocation,
      ...(to === 'SUBMITTED' ? { submittedAt: now } : {}),
      ...(to === 'APPROVED' ? { approvedAt: p.approvedAt ?? now, approvedById: p.approvedById ?? actorUserId, suspendedAt: null } : {}),
      ...(to === 'SUSPENDED' ? { suspendedAt: now } : {}),
    },
  });
  if (res.count !== 1) throw conflict('The provider changed concurrently; please retry');
  await tx.providerStatusHistory.create({ data: { providerId, fromStatus: p.status, toStatus: to, changedById: actorUserId, reason } });

  if (to === 'SUSPENDED' || to === 'DEACTIVATED') {
    // Stop new bookings immediately; existing appointments are handled by ops.
    await tx.appointmentSlot.updateMany({
      where: { doctorProviderId: providerId, status: 'OPEN', startsAt: { gt: now } },
      data: { status: 'BLOCKED' },
    });
    await tx.appointmentSlot.updateMany({
      where: { location: { providerId }, status: 'OPEN', startsAt: { gt: now } },
      data: { status: 'BLOCKED' },
    });
  }
  if (to === 'APPROVED' && p.status === 'SUSPENDED') {
    await tx.appointmentSlot.updateMany({
      where: { doctorProviderId: providerId, status: 'BLOCKED', startsAt: { gt: now } },
      data: { status: 'OPEN' },
    });
  }

  const owner = await tx.providerMember.findFirst({
    where: { providerId, memberRole: 'OWNER', status: 'ACTIVE' },
    include: { user: { select: { id: true, email: true, phone: true } } },
  });
  const recipient = p.contactEmail ?? owner?.user.email;
  if (recipient) {
    await enqueueNotification(tx, {
      userId: owner?.user.id ?? null,
      channel: 'EMAIL',
      templateKey: 'provider.status_changed',
      recipient,
      payload: { status: to },
    });
  }
  await audit(tx, {
    action: 'provider.status_changed',
    entityType: 'provider',
    entityId: providerId,
    actorUserId,
    metadata: { from: p.status, to, reason },
  });
  return { from: p.status, to };
}

/** Submit for verification: validates completeness and opens a verification case. */
export async function submitProvider(actor: AuthContext, providerId: string) {
  await prisma.$transaction(async (tx) => {
    const p = await tx.provider.findUnique({
      where: { id: providerId },
      include: { locations: true, doctorProfile: { include: { registrations: true } } },
    });
    if (!p) throw notFound('Provider');
    const problems: string[] = [];
    if (!p.locations.some((l) => l.isActive)) problems.push('At least one active location is required');
    if (p.type === 'DOCTOR' && !p.doctorProfile?.registrations.length) problems.push('A medical council registration is required');
    if (!p.contactPhone && !p.contactEmail) problems.push('A contact phone or email is required');
    if (problems.length) throw preconditionFailed('Provider is not ready for submission', { problems });

    await transitionProvider(tx, providerId, 'SUBMITTED', actor.userId, 'Submitted for verification');
    const open = await tx.verificationCase.findFirst({
      where: { providerId, status: { in: ['OPEN', 'IN_REVIEW', 'AWAITING_PROVIDER'] } },
    });
    if (open) {
      if (open.status === 'AWAITING_PROVIDER') await tx.verificationCase.update({ where: { id: open.id }, data: { status: 'OPEN' } });
      return;
    }
    const reqs = VERIFICATION_REQUIREMENTS[p.type];
    await tx.verificationCase.create({
      data: {
        providerId,
        kind: p.approvedAt ? 'CHANGE_REQUEST' : 'ONBOARDING',
        openedById: actor.userId,
        checks: {
          create: [
            ...reqs.required.map((checkType) => ({ checkType, isRequired: true })),
            ...reqs.optional.map((checkType) => ({ checkType, isRequired: false })),
          ],
        },
      },
    });
  });
}

export async function updateLocation(
  actor: AuthContext,
  providerId: string,
  locationId: string,
  input: Partial<z.infer<typeof LocationInput>> & { isActive?: boolean },
) {
  await prisma.$transaction(async (tx) => {
    const loc = await tx.providerLocation.findFirst({ where: { id: locationId, providerId } });
    if (!loc) throw notFound('Location');
    let regionId: string | null | undefined;
    if (input.regionCode !== undefined) {
      const region = await tx.serviceRegion.findUnique({ where: { code: input.regionCode } });
      if (!region) throw badRequest(`Unknown service region ${input.regionCode}`);
      regionId = region.id;
    }
    if (input.isPrimary) await tx.providerLocation.updateMany({ where: { providerId, isPrimary: true, id: { not: locationId } }, data: { isPrimary: false } });
    const { regionCode: _rc, ...rest } = input;
    await tx.providerLocation.update({ where: { id: locationId }, data: { ...rest, ...(regionId !== undefined ? { regionId } : {}) } });
    const p = await tx.provider.findUniqueOrThrow({ where: { id: providerId } });
    const active = await tx.providerLocation.count({ where: { providerId, isActive: true } });
    await tx.provider.update({ where: { id: providerId }, data: { isListed: p.status === 'APPROVED' && active > 0 } });
    await audit(tx, { action: 'provider.location_updated', entityType: 'provider', entityId: providerId, actorUserId: actor.userId, metadata: { locationId, fields: Object.keys(input) } });
  });
}

export async function setOperatingHours(
  actor: AuthContext,
  providerId: string,
  locationId: string,
  hours: { dayOfWeek: number; opensAtMin: number; closesAtMin: number; isClosed?: boolean }[],
) {
  await prisma.$transaction(async (tx) => {
    const loc = await tx.providerLocation.findFirst({ where: { id: locationId, providerId } });
    if (!loc) throw notFound('Location');
    // Reject overlapping windows on the same day.
    const byDay = new Map<number, { o: number; c: number }[]>();
    for (const h of hours) {
      const list = byDay.get(h.dayOfWeek) ?? [];
      if (list.some((x) => h.opensAtMin < x.c && x.o < h.closesAtMin)) throw badRequest(`Overlapping hours on day ${h.dayOfWeek}`);
      list.push({ o: h.opensAtMin, c: h.closesAtMin });
      byDay.set(h.dayOfWeek, list);
    }
    await tx.providerOperatingHours.deleteMany({ where: { locationId } });
    await tx.providerOperatingHours.createMany({ data: hours.map((h) => ({ locationId, ...h, isClosed: h.isClosed ?? false })) });
    await audit(tx, { action: 'provider.hours_updated', entityType: 'provider', entityId: providerId, actorUserId: actor.userId, metadata: { locationId, windows: hours.length } });
  });
}
