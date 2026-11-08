import { notifyProviderStaff, notifyUsers } from '../notifications/events.js';
import { prisma, type Tx } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, isPgError, notFound, preconditionFailed } from '../../lib/errors.js';
import { assertTransition, type TransitionMap } from '../../lib/state-machine.js';
import { buildPage, cursorOrderBy, cursorWhere } from '../../lib/pagination.js';
import { iso, isoDate, minor } from '../../http/dto.js';
import type { AuthContext } from '../../middleware/auth.js';
import type { AffiliationStatus, EngagementType, Prisma } from '../../../generated/prisma/client.js';
import { FACILITY_TYPES } from '../providers/provider-state.js';

export const AFFILIATION_TRANSITIONS: TransitionMap<AffiliationStatus> = {
  INVITED: ['PENDING_VERIFICATION', 'REJECTED', 'CANCELLED'],
  REQUESTED: ['PENDING_VERIFICATION', 'REJECTED', 'CANCELLED'],
  PENDING_VERIFICATION: ['ACTIVE', 'REJECTED', 'CANCELLED'],
  ACTIVE: ['SUSPENDED', 'ENDED'],
  SUSPENDED: ['ACTIVE', 'ENDED'],
  REJECTED: [],
  ENDED: [],
  CANCELLED: [],
};

type ActorKind = 'DOCTOR' | 'FACILITY' | 'PLATFORM';

export interface AffiliationTerms {
  locationId?: string | null;
  departmentCode?: string | null;
  roleTitle?: string;
  engagementType?: EngagementType;
  consultationFeeMinor?: number;
  startDate?: string;
}

const include = {
  doctor: { select: { id: true, displayName: true, status: true, ratingAverage: true, ratingCount: true, doctorProfile: { select: { yearsOfExperience: true, specialities: { where: { verified: true }, orderBy: { isPrimary: 'desc' as const }, select: { isPrimary: true, speciality: { select: { code: true, name: true } } } } } } } },
  facility: { select: { id: true, displayName: true, type: true, status: true } },
  location: { select: { id: true, name: true } },
  department: { select: { code: true, name: true } },
  events: { orderBy: { createdAt: 'asc' as const } },
} satisfies Prisma.DoctorAffiliationInclude;

export function affiliationDto(a: Prisma.DoctorAffiliationGetPayload<{ include: typeof include }>) {
  return {
    id: a.id,
    status: a.status,
    initiatedBy: a.initiatedBy,
    // The doctor's own verified specialities travel with the affiliation so a facility never confuses them with the department it filed the doctor under.
    doctor: {
      id: a.doctor.id,
      displayName: a.doctor.displayName,
      status: a.doctor.status,
      specialities: a.doctor.doctorProfile?.specialities.map((s) => s.speciality.name) ?? [],
      yearsOfExperience: a.doctor.doctorProfile?.yearsOfExperience ?? null,
      ratingAverage: a.doctor.ratingAverage ? Number(a.doctor.ratingAverage) : null,
      ratingCount: a.doctor.ratingCount,
    },
    facility: a.facility,
    location: a.location,
    department: a.department,
    roleTitle: a.roleTitle,
    engagementType: a.engagementType,
    consultationFeeMinor: minor(a.consultationFeeMinor),
    currency: a.currency,
    doctorConfirmedAt: iso(a.doctorConfirmedAt),
    facilityConfirmedAt: iso(a.facilityConfirmedAt),
    verifiedAt: iso(a.verifiedAt),
    verifiedById: a.verifiedById,
    startDate: isoDate(a.startDate),
    endDate: isoDate(a.endDate),
    statusReason: a.statusReason,
    version: a.version,
    createdAt: a.createdAt.toISOString(),
    events: a.events.map((e) => ({ fromStatus: e.fromStatus, toStatus: e.toStatus, actorKind: e.actorKind, actorUserId: e.actorUserId, note: e.note, createdAt: e.createdAt.toISOString() })),
  };
}

export async function getAffiliation(id: string) {
  const a = await prisma.doctorAffiliation.findUnique({ where: { id }, include });
  if (!a) throw notFound('Affiliation');
  return affiliationDto(a);
}

export async function listAffiliations(q: { limit: number; cursor?: string; status?: AffiliationStatus; doctorProviderId?: string; facilityProviderId?: string; departmentCode?: string; specialityCode?: string; engagementType?: string; q?: string }) {
  const rows = await prisma.doctorAffiliation.findMany({
    where: {
      ...(q.status ? { status: q.status } : {}),
      ...(q.doctorProviderId ? { doctorProviderId: q.doctorProviderId } : {}),
      ...(q.facilityProviderId ? { facilityProviderId: q.facilityProviderId } : {}),
      ...(q.departmentCode ? { department: { code: q.departmentCode } } : {}),
      ...(q.engagementType ? { engagementType: q.engagementType as never } : {}),
      ...(q.specialityCode ? { doctor: { doctorProfile: { specialities: { some: { speciality: { code: q.specialityCode } } } } } } : {}),
      ...(q.q ? { OR: [{ doctor: { displayName: { contains: q.q, mode: 'insensitive' } } }, { facility: { displayName: { contains: q.q, mode: 'insensitive' } } }] } : {}),
      ...cursorWhere(q.cursor),
    },
    include,
    orderBy: cursorOrderBy(),
    take: q.limit + 1,
  });
  const { items, page } = buildPage(rows, q.limit, (a) => a.createdAt);
  return { items: items.map(affiliationDto), page };
}

async function resolveTerms(tx: Tx, facilityProviderId: string, terms: AffiliationTerms) {
  let departmentId: string | null = null;
  if (terms.departmentCode) {
    const fd = await tx.facilityDepartment.findFirst({ where: { providerId: facilityProviderId, department: { code: terms.departmentCode }, isActive: true } });
    if (!fd) throw badRequest('The facility does not offer this department');
    departmentId = fd.departmentId;
  }
  if (terms.locationId && !(await tx.providerLocation.findFirst({ where: { id: terms.locationId, providerId: facilityProviderId, isActive: true } }))) {
    throw badRequest('Location does not belong to the facility');
  }
  return {
    locationId: terms.locationId ?? null,
    departmentId,
    roleTitle: terms.roleTitle,
    engagementType: terms.engagementType ?? 'VISITING',
    consultationFeeMinor: terms.consultationFeeMinor != null ? BigInt(terms.consultationFeeMinor) : null,
    startDate: terms.startDate ? new Date(terms.startDate) : null,
  };
}

async function assertParties(tx: Tx, doctorProviderId: string, facilityProviderId: string) {
  const [doctor, facility] = await Promise.all([
    tx.provider.findUnique({ where: { id: doctorProviderId } }),
    tx.provider.findUnique({ where: { id: facilityProviderId } }),
  ]);
  if (!doctor || doctor.type !== 'DOCTOR') throw badRequest('doctorProviderId must reference a doctor provider');
  if (!facility || !FACILITY_TYPES.includes(facility.type)) throw badRequest('facilityProviderId must reference a hospital or clinic');
  if (doctor.status === 'DEACTIVATED' || doctor.status === 'REJECTED') throw conflict('The doctor is not eligible for affiliations');
  if (facility.status === 'DEACTIVATED' || facility.status === 'REJECTED') throw conflict('The facility is not eligible for affiliations');
  return { doctor, facility };
}

async function createAffiliation(
  actor: AuthContext,
  kind: ActorKind,
  doctorProviderId: string,
  facilityProviderId: string,
  terms: AffiliationTerms,
  note?: string,
) {
  try {
    return await prisma.$transaction(async (tx) => {
      await assertParties(tx, doctorProviderId, facilityProviderId);
      const data = await resolveTerms(tx, facilityProviderId, terms);
      const now = new Date();
      const status: AffiliationStatus = kind === 'FACILITY' ? 'INVITED' : kind === 'DOCTOR' ? 'REQUESTED' : 'PENDING_VERIFICATION';
      const a = await tx.doctorAffiliation.create({
        data: {
          doctorProviderId,
          facilityProviderId,
          ...data,
          status,
          initiatedBy: kind,
          requestedById: actor.userId,
          ...(kind === 'FACILITY' ? { facilityConfirmedAt: now } : {}),
          ...(kind === 'DOCTOR' ? { doctorConfirmedAt: now } : {}),
          statusReason: note,
        },
      });
      await tx.affiliationEvent.create({ data: { affiliationId: a.id, fromStatus: null, toStatus: status, actorUserId: actor.userId, actorKind: kind, note } });
      await audit(tx, { action: 'affiliation.created', entityType: 'affiliation', entityId: a.id, metadata: { kind, doctorProviderId, facilityProviderId } });
      if (kind === 'FACILITY') {
        const dp = await tx.doctorProfile.findUnique({ where: { providerId: doctorProviderId }, select: { userId: true } });
        if (dp) await notifyUsers(tx, [dp.userId], { key: 'portal.affiliation_invited', title: 'A hospital or clinic invited you', body: 'Open Hospitals & Clinics to accept or decline', link: '/affiliations', level: 'important', meta: { kind: 'affiliation', id: a.id, providerId: facilityProviderId, status }, exceptUserId: actor.userId });
      } else if (kind === 'DOCTOR') {
        await notifyProviderStaff(tx, facilityProviderId, 'manage_affiliations', { key: 'portal.affiliation_requested', title: 'A doctor asked to join', body: 'Open Doctors to accept or decline', link: '/affiliations', level: 'important', meta: { kind: 'affiliation', id: a.id, providerId: facilityProviderId, status }, exceptUserId: actor.userId });
      }
      return a.id;
    });
  } catch (err) {
    if (isPgError(err, '23505')) throw conflict('An affiliation between this doctor and facility is already in progress or active');
    throw err;
  }
}

/** Facility (hospital/clinic) invites a doctor. The doctor must accept. */
export const inviteDoctor = (actor: AuthContext, facilityProviderId: string, doctorProviderId: string, terms: AffiliationTerms) =>
  createAffiliation(actor, 'FACILITY', doctorProviderId, facilityProviderId, terms);

/** Doctor requests to join a facility. The facility must accept. */
export const requestToJoin = (actor: AuthContext, doctorProviderId: string, facilityProviderId: string, terms: AffiliationTerms) =>
  createAffiliation(actor, 'DOCTOR', doctorProviderId, facilityProviderId, terms);

/**
 * Platform-created affiliation (e.g. onboarding a hospital's roster from a
 * signed letter). Starts at PENDING_VERIFICATION and still needs a verifier who
 * is not the creator.
 */
export const createByPlatform = (actor: AuthContext, doctorProviderId: string, facilityProviderId: string, terms: AffiliationTerms, evidenceNote: string) =>
  createAffiliation(actor, 'PLATFORM', doctorProviderId, facilityProviderId, terms, evidenceNote);

/**
 * Apply a transition. `side` declares which party is acting; each side may only
 * perform its own moves (a facility can never accept on the doctor's behalf).
 */
export async function transition(
  actor: AuthContext,
  id: string,
  side: ActorKind,
  action: 'ACCEPT' | 'DECLINE' | 'WITHDRAW' | 'VERIFY' | 'REJECT' | 'SUSPEND' | 'REACTIVATE' | 'END',
  note: string | undefined,
  expectedVersion?: number,
) {
  return prisma.$transaction(async (tx) => {
    const a = await tx.doctorAffiliation.findUnique({ where: { id } });
    if (!a) throw notFound('Affiliation');
    let to: AffiliationStatus;
    const now = new Date();
    const extra: Prisma.DoctorAffiliationUpdateManyMutationInput = {};

    switch (action) {
      case 'ACCEPT':
        if (side === 'DOCTOR' && a.status !== 'INVITED') throw conflict('Only an invitation can be accepted by the doctor');
        if (side === 'FACILITY' && a.status !== 'REQUESTED') throw conflict('Only a doctor’s request can be accepted by the facility');
        if (side === 'PLATFORM') throw forbidden('The platform cannot accept on behalf of a party');
        to = 'PENDING_VERIFICATION';
        if (side === 'DOCTOR') extra.doctorConfirmedAt = now;
        else extra.facilityConfirmedAt = now;
        break;
      case 'DECLINE':
        if (side === 'DOCTOR' && a.status !== 'INVITED') throw conflict('Nothing to decline');
        if (side === 'FACILITY' && a.status !== 'REQUESTED') throw conflict('Nothing to decline');
        if (side === 'PLATFORM') throw forbidden('Use REJECT');
        to = 'REJECTED';
        break;
      case 'WITHDRAW':
        if (side === 'FACILITY' && a.initiatedBy !== 'FACILITY') throw forbidden('Only the initiating party can withdraw');
        if (side === 'DOCTOR' && a.initiatedBy !== 'DOCTOR') throw forbidden('Only the initiating party can withdraw');
        to = 'CANCELLED';
        break;
      case 'VERIFY': {
        if (side !== 'PLATFORM') throw forbidden();
        if (a.requestedById === actor.userId) throw forbidden('You created this affiliation and cannot verify it');
        if (a.initiatedBy !== 'PLATFORM' && (!a.doctorConfirmedAt || !a.facilityConfirmedAt)) {
          throw preconditionFailed('Both the doctor and the facility must confirm before verification');
        }
        const [doctor, facility] = await Promise.all([
          tx.provider.findUniqueOrThrow({ where: { id: a.doctorProviderId } }),
          tx.provider.findUniqueOrThrow({ where: { id: a.facilityProviderId } }),
        ]);
        if (doctor.status !== 'APPROVED' || facility.status !== 'APPROVED') {
          throw preconditionFailed('Both the doctor and the facility must be verified (APPROVED) providers');
        }
        to = 'ACTIVE';
        extra.verifiedAt = now;
        extra.verifiedById = actor.userId;
        extra.startDate = a.startDate ?? now;
        break;
      }
      case 'REJECT':
        if (side !== 'PLATFORM') throw forbidden();
        to = 'REJECTED';
        break;
      case 'SUSPEND':
        if (side !== 'PLATFORM') throw forbidden();
        to = 'SUSPENDED';
        break;
      case 'REACTIVATE':
        if (side !== 'PLATFORM') throw forbidden();
        to = 'ACTIVE';
        break;
      case 'END':
        // Either party (or the platform) may end an active relationship.
        to = 'ENDED';
        extra.endDate = now;
        break;
    }
    assertTransition('Affiliation', AFFILIATION_TRANSITIONS, a.status, to);

    const res = await tx.doctorAffiliation.updateMany({
      where: { id, status: a.status, ...(expectedVersion ? { version: expectedVersion } : {}) },
      data: { status: to, statusReason: note ?? null, version: { increment: 1 }, ...extra },
    });
    if (res.count !== 1) throw conflict('The affiliation changed concurrently; reload and retry');
    await tx.affiliationEvent.create({ data: { affiliationId: id, fromStatus: a.status, toStatus: to, actorUserId: actor.userId, actorKind: side, note } });

    let affectedAppointments = 0;
    if (to === 'ENDED' || to === 'SUSPENDED') {
      await tx.appointmentSlot.updateMany({ where: { affiliationId: id, status: 'OPEN', startsAt: { gt: now } }, data: { status: 'BLOCKED' } });
      affectedAppointments = await tx.appointment.count({ where: { affiliationId: id, status: { in: ['REQUESTED', 'CONFIRMED'] }, slot: { startsAt: { gt: now } } } });
    } else if (to === 'ACTIVE' && a.status === 'SUSPENDED') {
      await tx.appointmentSlot.updateMany({ where: { affiliationId: id, status: 'BLOCKED', startsAt: { gt: now } }, data: { status: 'OPEN' } });
    }
    // The other party hears the answer to an invitation or request.
    if (action === 'ACCEPT' || action === 'DECLINE') {
      const accepted = action === 'ACCEPT';
      const meta = { kind: 'affiliation' as const, id, providerId: a.facilityProviderId, status: to };
      if (side === 'DOCTOR') {
        await notifyProviderStaff(tx, a.facilityProviderId, 'manage_affiliations', { key: `portal.affiliation_${accepted ? 'accepted' : 'declined'}`, title: accepted ? 'Doctor accepted your invitation' : 'Doctor declined your invitation', body: accepted ? 'Verification by Carevanta comes next.' : (note ?? 'No reason given.'), link: '/affiliations', level: 'light', meta, exceptUserId: actor.userId });
      } else if (side === 'FACILITY') {
        const dp = await tx.doctorProfile.findUnique({ where: { providerId: a.doctorProviderId }, select: { userId: true } });
        if (dp) await notifyUsers(tx, [dp.userId], { key: `portal.affiliation_${accepted ? 'accepted' : 'declined'}`, title: accepted ? 'Your request was accepted' : 'Your request was declined', body: accepted ? 'Verification by Carevanta comes next.' : (note ?? 'No reason given.'), link: '/affiliations', level: 'light', meta, exceptUserId: actor.userId });
      }
    }
    await audit(tx, { action: `affiliation.${action.toLowerCase()}`, entityType: 'affiliation', entityId: id, metadata: { from: a.status, to, side, affectedAppointments } });
    return { affectedAppointments };
  });
}

/** Confirm the caller acts for the given side of this affiliation. */
export async function assertSide(auth: AuthContext, affiliationId: string, side: 'DOCTOR' | 'FACILITY', facilityProviderId?: string) {
  const a = await prisma.doctorAffiliation.findUnique({ where: { id: affiliationId }, select: { doctorProviderId: true, facilityProviderId: true } });
  if (!a) throw notFound('Affiliation');
  if (side === 'DOCTOR') {
    const own = await prisma.doctorProfile.findUnique({ where: { userId: auth.userId }, select: { providerId: true } });
    if (own?.providerId !== a.doctorProviderId) throw notFound('Affiliation');
  } else {
    if (facilityProviderId !== a.facilityProviderId) throw notFound('Affiliation');
  }
}
