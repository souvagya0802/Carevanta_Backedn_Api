import { prisma } from '../../lib/prisma.js';
import { audit, logSensitiveAccess } from '../../lib/audit.js';
import { badRequest, conflict, notFound, preconditionFailed, separationOfDuties } from '../../lib/errors.js';
import { buildPage, cursorOrderBy, cursorWhere } from '../../lib/pagination.js';
import { getObject, putObject } from '../../lib/storage.js';
import { iso, isoDate } from '../../http/dto.js';
import { transitionProvider } from './providers.service.js';
import type { AuthContext } from '../../middleware/auth.js';
import type {
  DocumentType,
  Prisma,
  VerificationCaseStatus,
  VerificationCheckStatus,
  VerificationCheckType,
  VerificationMethod,
} from '../../../generated/prisma/client.js';

const OPEN_CASE: VerificationCaseStatus[] = ['OPEN', 'IN_REVIEW', 'AWAITING_PROVIDER'];

/** Working-hours target for a decision on an onboarding case; the queue flags anything older. */
export const CASE_SLA_HOURS = 72;

async function namesFor(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids.filter((x): x is string => !!x)));
  if (!unique.length) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, fullName: true } });
  return new Map(users.map((u) => [u.id, u.fullName]));
}

export async function listCases(q: {
  limit: number; cursor?: string; status?: VerificationCaseStatus; openOnly?: boolean; decidedOnly?: boolean; assignedToMe?: boolean; unassignedOnly?: boolean;
  providerType?: string; kind?: 'ONBOARDING' | 'CHANGE_REQUEST'; q?: string; overdueOnly?: boolean; userId: string;
}) {
  const where: Prisma.VerificationCaseWhereInput = {
    ...(q.status ? { status: q.status } : q.decidedOnly ? { status: { in: ['APPROVED', 'REJECTED', 'CANCELLED'] } } : { status: { in: OPEN_CASE } }),
    ...(q.assignedToMe ? { assignedToId: q.userId } : q.unassignedOnly ? { assignedToId: null } : {}),
    ...(q.providerType || q.q ? { provider: { ...(q.providerType ? { type: q.providerType as never } : {}), ...(q.q ? { OR: [{ displayName: { contains: q.q, mode: 'insensitive' } }, { legalName: { contains: q.q, mode: 'insensitive' } }] } : {}) } } : {}),
    ...(q.kind ? { kind: q.kind } : {}),
    ...(q.overdueOnly ? { createdAt: { lt: new Date(Date.now() - CASE_SLA_HOURS * 3_600_000) }, status: { in: OPEN_CASE } } : {}),
    ...cursorWhere(q.cursor),
  };
  const rows = await prisma.verificationCase.findMany({
    where,
    orderBy: cursorOrderBy(),
    take: q.limit + 1,
    include: {
      provider: { select: { id: true, displayName: true, type: true, status: true, locations: { where: { isPrimary: true }, select: { district: true }, take: 1 } } },
      checks: { select: { status: true, isRequired: true, checkType: true } },
    },
  });
  const { items, page } = buildPage(rows, q.limit, (c) => c.createdAt);
  const names = await namesFor(items.map((c) => c.assignedToId));
  const now = Date.now();
  return {
    page,
    items: items.map((c) => {
      const ageHours = Math.round((now - c.createdAt.getTime()) / 3_600_000);
      const open = OPEN_CASE.includes(c.status);
      return {
        id: c.id,
        status: c.status,
        kind: c.kind,
        provider: { id: c.provider.id, displayName: c.provider.displayName, type: c.provider.type, status: c.provider.status, district: c.provider.locations[0]?.district ?? null },
        assignedToId: c.assignedToId,
        assignedToName: c.assignedToId ? (names.get(c.assignedToId) ?? null) : null,
        requiredChecks: c.checks.filter((x) => x.isRequired).length,
        requiredPassed: c.checks.filter((x) => x.isRequired && (x.status === 'PASSED' || x.status === 'WAIVED')).length,
        failedChecks: c.checks.filter((x) => x.status === 'FAILED').length,
        outstanding: c.checks.filter((x) => x.isRequired && x.status !== 'PASSED' && x.status !== 'WAIVED').map((x) => x.checkType),
        createdAt: c.createdAt.toISOString(),
        ageHours,
        overdue: open && ageHours > CASE_SLA_HOURS,
      };
    }),
  };
}

export async function caseStats(userId: string) {
  const now = new Date();
  const openWhere = { status: { in: OPEN_CASE } } as const;
  const [byStatus, byType, unassigned, mine, overdue, awaiting, decided7d, decidedRows] = await Promise.all([
    prisma.verificationCase.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.verificationCase.findMany({ where: openWhere, select: { provider: { select: { type: true } } } }),
    prisma.verificationCase.count({ where: { ...openWhere, assignedToId: null } }),
    prisma.verificationCase.count({ where: { ...openWhere, assignedToId: userId } }),
    prisma.verificationCase.count({ where: { ...openWhere, createdAt: { lt: new Date(now.getTime() - CASE_SLA_HOURS * 3_600_000) } } }),
    prisma.verificationCase.count({ where: { status: 'AWAITING_PROVIDER' } }),
    prisma.verificationCase.count({ where: { decidedAt: { gte: new Date(now.getTime() - 7 * 86_400_000) } } }),
    prisma.verificationCase.findMany({ where: { decidedAt: { gte: new Date(now.getTime() - 7 * 86_400_000) } }, select: { createdAt: true, decidedAt: true, status: true } }),
  ]);
  const open = byStatus.filter((x) => OPEN_CASE.includes(x.status)).reduce((s, x) => s + x._count._all, 0);
  const hours = decidedRows.map((c) => (c.decidedAt!.getTime() - c.createdAt.getTime()) / 3_600_000);
  return {
    byStatus: Object.fromEntries(byStatus.map((x) => [x.status, x._count._all])),
    openByProviderType: byType.reduce<Record<string, number>>((m, c) => ({ ...m, [c.provider.type]: (m[c.provider.type] ?? 0) + 1 }), {}),
    open,
    unassigned,
    mine,
    overdue,
    awaitingProvider: awaiting,
    slaHours: CASE_SLA_HOURS,
    decided7d,
    approved7d: decidedRows.filter((c) => c.status === 'APPROVED').length,
    avgDecisionHours7d: hours.length ? Math.round((hours.reduce((s, h) => s + h, 0) / hours.length) * 10) / 10 : null,
  };
}

export async function getCase(id: string) {
  const c = await prisma.verificationCase.findUnique({
    where: { id },
    include: {
      provider: { select: { id: true, displayName: true, legalName: true, type: true, status: true, createdById: true } },
      checks: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!c) throw notFound('Verification case');
  const names = await namesFor([c.assignedToId, c.openedById, c.decidedById, c.provider.createdById, ...c.checks.map((k) => k.checkedById)]);
  const ageHours = Math.round((Date.now() - c.createdAt.getTime()) / 3_600_000);
  return {
    id: c.id,
    status: c.status,
    kind: c.kind,
    provider: c.provider,
    registrarName: c.provider.createdById ? (names.get(c.provider.createdById) ?? null) : null,
    assignedToId: c.assignedToId,
    assignedToName: c.assignedToId ? (names.get(c.assignedToId) ?? null) : null,
    openedById: c.openedById,
    openedByName: c.openedById ? (names.get(c.openedById) ?? null) : null,
    decidedById: c.decidedById,
    decidedByName: c.decidedById ? (names.get(c.decidedById) ?? null) : null,
    decidedAt: iso(c.decidedAt),
    decisionNote: c.decisionNote,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    ageHours,
    slaHours: CASE_SLA_HOURS,
    overdue: OPEN_CASE.includes(c.status) && ageHours > CASE_SLA_HOURS,
    checks: c.checks.map((k) => ({
      id: k.id,
      checkType: k.checkType,
      status: k.status,
      method: k.method,
      isRequired: k.isRequired,
      sourceReference: k.sourceReference,
      evidenceDocumentId: k.evidenceDocumentId,
      checkedById: k.checkedById,
      checkedByName: k.checkedById ? (names.get(k.checkedById) ?? null) : null,
      checkedAt: iso(k.checkedAt),
      notes: k.notes,
      validUntil: isoDate(k.validUntil),
      expired: !!(k.validUntil && k.validUntil < new Date()),
    })),
  };
}

export async function assignCase(actor: AuthContext, id: string, assigneeId: string | null) {
  await prisma.$transaction(async (tx) => {
    const c = await tx.verificationCase.findUnique({ where: { id } });
    if (!c) throw notFound('Verification case');
    if (!OPEN_CASE.includes(c.status)) throw conflict('Only open cases can be assigned');
    if (assigneeId) {
      const assignee = await tx.user.findUnique({
        where: { id: assigneeId },
        include: { roles: { where: { revokedAt: null }, include: { role: { include: { permissions: { include: { permission: true } } } } } } },
      });
      const can = assignee?.status === 'ACTIVE' && assignee.roles.some((r) => r.role.permissions.some((p) => p.permission.key === 'providers.verify'));
      if (!can) throw badRequest('Assignee must be an active user with providers.verify');
    }
    await tx.verificationCase.update({
      where: { id },
      data: { assignedToId: assigneeId, status: c.status === 'OPEN' && assigneeId ? 'IN_REVIEW' : c.status },
    });
    if (assigneeId) {
      const p = await tx.provider.findUniqueOrThrow({ where: { id: c.providerId } });
      if (p.status === 'SUBMITTED') await transitionProvider(tx, p.id, 'UNDER_REVIEW', actor.userId, 'Verification started');
    }
    await audit(tx, { action: 'verification.assigned', entityType: 'verification_case', entityId: id, metadata: { assigneeId } });
  });
}

export async function recordCheck(
  actor: AuthContext,
  caseId: string,
  checkType: VerificationCheckType,
  input: {
    status: Exclude<VerificationCheckStatus, 'PENDING'>;
    method: VerificationMethod;
    sourceReference?: string;
    evidenceDocumentId?: string;
    notes?: string;
    validUntil?: string;
  },
) {
  if (input.status === 'WAIVED' && (!input.notes || input.notes.length < 10)) {
    throw badRequest('Waiving a check requires a justification note (min 10 characters)');
  }
  if (input.status === 'PASSED' && !input.evidenceDocumentId && !input.sourceReference) {
    throw badRequest('A passed check needs evidence: an accepted document or a source reference (registry URL / confirmation id)');
  }
  await prisma.$transaction(async (tx) => {
    const c = await tx.verificationCase.findUnique({ where: { id: caseId }, include: { provider: true } });
    if (!c) throw notFound('Verification case');
    if (!OPEN_CASE.includes(c.status)) throw conflict('This case is closed');
    if (c.provider.createdById === actor.userId) throw separationOfDuties('You registered this provider and cannot verify it');
    const check = await tx.verificationCheck.findUnique({ where: { caseId_checkType: { caseId, checkType } } });
    if (!check) throw notFound('Verification check');
    if (input.evidenceDocumentId) {
      const doc = await tx.providerDocument.findFirst({ where: { id: input.evidenceDocumentId, providerId: c.providerId } });
      if (!doc) throw badRequest('Evidence document does not belong to this provider');
      if (input.status === 'PASSED' && doc.status !== 'ACCEPTED') throw preconditionFailed('Evidence document must be ACCEPTED first');
    }
    await tx.verificationCheck.update({
      where: { id: check.id },
      data: {
        status: input.status,
        method: input.method,
        sourceReference: input.sourceReference ?? null,
        evidenceDocumentId: input.evidenceDocumentId ?? null,
        notes: input.notes ?? null,
        validUntil: input.validUntil ? new Date(input.validUntil) : null,
        checkedById: actor.userId,
        checkedAt: new Date(),
      },
    });
    if (checkType === 'PROFESSIONAL_REGISTRATION' && c.provider.type === 'DOCTOR') {
      await tx.professionalRegistration.updateMany({
        where: { doctorProviderId: c.providerId },
        data: input.status === 'PASSED' ? { verifiedAt: new Date(), verifiedById: actor.userId } : { verifiedAt: null, verifiedById: null },
      });
    }
    if (checkType === 'QUALIFICATION' && c.provider.type === 'DOCTOR') {
      await tx.doctorQualification.updateMany({ where: { doctorProviderId: c.providerId }, data: { verified: input.status === 'PASSED' } });
      await tx.doctorSpeciality.updateMany({ where: { doctorProviderId: c.providerId }, data: { verified: input.status === 'PASSED' } });
    }
    if (c.status === 'OPEN') await tx.verificationCase.update({ where: { id: caseId }, data: { status: 'IN_REVIEW', assignedToId: c.assignedToId ?? actor.userId } });
    if (c.provider.status === 'SUBMITTED') await transitionProvider(tx, c.providerId, 'UNDER_REVIEW', actor.userId, 'Verification started');
    await audit(tx, {
      action: 'verification.check_recorded',
      entityType: 'verification_case',
      entityId: caseId,
      metadata: { checkType, status: input.status, method: input.method },
    });
  });
}

/**
 * Close a case. APPROVE requires every required check PASSED/WAIVED and is
 * forbidden for whoever registered the provider (separation of duties).
 */
export async function decideCase(actor: AuthContext, caseId: string, decision: 'APPROVE' | 'REJECT' | 'REQUEST_CHANGES', note: string) {
  await prisma.$transaction(async (tx) => {
    const c = await tx.verificationCase.findUnique({ where: { id: caseId }, include: { checks: true, provider: true } });
    if (!c) throw notFound('Verification case');
    if (!OPEN_CASE.includes(c.status)) throw conflict('This case is already closed');
    if (c.provider.createdById === actor.userId) throw separationOfDuties('You registered this provider and cannot decide its verification');
    const member = await tx.providerMember.count({ where: { providerId: c.providerId, userId: actor.userId, status: 'ACTIVE' } });
    if (member) throw separationOfDuties('Members of a provider cannot verify it');

    if (decision === 'APPROVE') {
      const blocking = c.checks.filter((k) => k.isRequired && k.status !== 'PASSED' && k.status !== 'WAIVED');
      if (blocking.length) {
        throw preconditionFailed('All required checks must pass before approval', {
          outstanding: blocking.map((k) => ({ checkType: k.checkType, status: k.status })),
        });
      }
      if (c.provider.status === 'SUBMITTED') await transitionProvider(tx, c.providerId, 'UNDER_REVIEW', actor.userId, 'Verification started');
      await transitionProvider(tx, c.providerId, 'APPROVED', actor.userId, note);
      await tx.provider.update({ where: { id: c.providerId }, data: { approvedById: actor.userId } });
      await tx.verificationCase.update({ where: { id: caseId }, data: { status: 'APPROVED', decidedById: actor.userId, decidedAt: new Date(), decisionNote: note } });
    } else if (decision === 'REJECT') {
      if (c.provider.status === 'APPROVED') throw conflict('Use suspension for an approved provider');
      await transitionProvider(tx, c.providerId, 'REJECTED', actor.userId, note);
      await tx.verificationCase.update({ where: { id: caseId }, data: { status: 'REJECTED', decidedById: actor.userId, decidedAt: new Date(), decisionNote: note } });
    } else {
      if (c.provider.status !== 'APPROVED') await transitionProvider(tx, c.providerId, 'CHANGES_REQUESTED', actor.userId, note);
      await tx.verificationCase.update({ where: { id: caseId }, data: { status: 'AWAITING_PROVIDER', decisionNote: note } });
    }
    await audit(tx, { action: `verification.${decision.toLowerCase()}`, entityType: 'verification_case', entityId: caseId, metadata: { providerId: c.providerId, note } });
  });
}

// ─── Documents ─────────────────────────────────────────────────────────────

export function documentDto(d: {
  id: string;
  documentType: DocumentType;
  status: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  documentNumber: string | null;
  issuedAt: Date | null;
  expiresAt: Date | null;
  reviewedById: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  uploadedById: string | null;
  createdAt: Date;
}) {
  return {
    id: d.id,
    documentType: d.documentType,
    status: d.status,
    fileName: d.fileName,
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    sha256: d.sha256,
    documentNumber: d.documentNumber,
    issuedAt: isoDate(d.issuedAt),
    expiresAt: isoDate(d.expiresAt),
    expired: !!(d.expiresAt && d.expiresAt < new Date()),
    reviewedById: d.reviewedById,
    reviewedAt: iso(d.reviewedAt),
    reviewNote: d.reviewNote,
    uploadedById: d.uploadedById,
    createdAt: d.createdAt.toISOString(),
  };
}

export async function uploadDocument(
  actor: AuthContext,
  providerId: string,
  file: Buffer,
  meta: { mimeType: string; fileName: string; documentType: DocumentType; documentNumber?: string; issuedAt?: string; expiresAt?: string },
) {
  const provider = await prisma.provider.findUnique({ where: { id: providerId }, select: { id: true, status: true } });
  if (!provider) throw notFound('Provider');
  if (provider.status === 'DEACTIVATED') throw conflict('Provider is deactivated');
  if (meta.expiresAt && new Date(meta.expiresAt) < new Date()) throw badRequest('This document has already expired');
  const stored = await putObject(`providers/${providerId}`, file, meta.mimeType);
  return prisma.$transaction(async (tx) => {
    // A newer document of the same type supersedes older pending/accepted ones.
    await tx.providerDocument.updateMany({
      where: { providerId, documentType: meta.documentType, status: { in: ['UPLOADED', 'ACCEPTED'] } },
      data: { status: 'SUPERSEDED' },
    });
    const doc = await tx.providerDocument.create({
      data: {
        providerId,
        documentType: meta.documentType,
        storageKey: stored.key,
        fileName: meta.fileName.replace(/[^\w.\- ]/g, '_').slice(0, 255),
        mimeType: meta.mimeType,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        documentNumber: meta.documentNumber,
        issuedAt: meta.issuedAt ? new Date(meta.issuedAt) : null,
        expiresAt: meta.expiresAt ? new Date(meta.expiresAt) : null,
        uploadedById: actor.userId,
      },
    });
    await audit(tx, { action: 'provider.document_uploaded', entityType: 'provider', entityId: providerId, metadata: { documentId: doc.id, documentType: meta.documentType, sizeBytes: stored.sizeBytes } });
    return documentDto(doc);
  });
}

export async function reviewDocument(actor: AuthContext, providerId: string, documentId: string, decision: 'ACCEPTED' | 'REJECTED', note?: string) {
  return prisma.$transaction(async (tx) => {
    const doc = await tx.providerDocument.findFirst({ where: { id: documentId, providerId }, include: { provider: true } });
    if (!doc) throw notFound('Document');
    if (doc.status !== 'UPLOADED') throw conflict(`Document is ${doc.status} and cannot be reviewed again`);
    if (doc.uploadedById === actor.userId) throw separationOfDuties('You cannot review a document you uploaded');
    if (decision === 'REJECTED' && !note) throw badRequest('A rejection note is required');
    const updated = await tx.providerDocument.update({
      where: { id: documentId },
      data: { status: decision, reviewedById: actor.userId, reviewedAt: new Date(), reviewNote: note ?? null },
    });
    await audit(tx, { action: 'provider.document_reviewed', entityType: 'provider', entityId: providerId, metadata: { documentId, decision } });
    return documentDto(updated);
  });
}

export async function listDocuments(providerId: string) {
  const docs = await prisma.providerDocument.findMany({ where: { providerId }, orderBy: { createdAt: 'desc' } });
  return docs.map(documentDto);
}

/** Every open of a credential document is recorded with its stated purpose. */
export async function readDocumentFile(actor: AuthContext, providerId: string, documentId: string, purpose: string) {
  const doc = await prisma.providerDocument.findFirst({ where: { id: documentId, providerId } });
  if (!doc) throw notFound('Document');
  await logSensitiveAccess(prisma, { resourceType: 'PROVIDER_DOCUMENT', resourceId: doc.id, purpose, granted: true, actorUserId: actor.userId });
  return { doc, buffer: await getObject(doc.storageKey) };
}
