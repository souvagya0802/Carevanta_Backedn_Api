import { prisma } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, isPgError, notFound, preconditionFailed, separationOfDuties } from '../../lib/errors.js';
import { isProduction } from '../../config/env.js';
import { iso, minor } from '../../http/dto.js';
import { calculateCommission, resolvePolicy } from './commission.service.js';
import type { AuthContext } from '../../middleware/auth.js';
import type { CommissionCategory, CommissionMethod, CommissionPolicy, LegalReviewStatus, ProviderType } from '../../../generated/prisma/client.js';

/**
 * Categories where a commission could be read as a fee for referring patients
 * for treatment (NMC Code of Ethics 6.4.1). These can never be activated
 * without a recorded legal approval, in any environment.
 */
export const HIGH_RISK_CATEGORIES: readonly CommissionCategory[] = ['PROCEDURE', 'SURGERY'];

export function policyDto(p: CommissionPolicy) {
  return {
    id: p.id,
    code: p.code,
    version: p.version,
    name: p.name,
    description: p.description,
    category: p.category,
    providerType: p.providerType,
    providerId: p.providerId,
    agreementId: p.agreementId,
    method: p.method,
    rateBps: p.rateBps,
    flatMinor: minor(p.flatMinor),
    minMinor: minor(p.minMinor),
    maxMinor: minor(p.maxMinor),
    taxRateBps: p.taxRateBps,
    currency: p.currency,
    status: p.status,
    legalReviewStatus: p.legalReviewStatus,
    legalReviewNote: p.legalReviewNote,
    highRisk: HIGH_RISK_CATEGORIES.includes(p.category),
    effectiveFrom: p.effectiveFrom.toISOString(),
    effectiveTo: iso(p.effectiveTo),
    createdById: p.createdById,
    approvedById: p.approvedById,
    approvedAt: iso(p.approvedAt),
    createdAt: p.createdAt.toISOString(),
  };
}

export interface PolicyInput {
  code: string;
  name: string;
  description?: string;
  category: CommissionCategory;
  providerType?: ProviderType;
  providerId?: string;
  agreementId?: string;
  method: CommissionMethod;
  rateBps?: number;
  flatMinor?: number;
  minMinor?: number;
  maxMinor?: number;
  taxRateBps: number;
  effectiveFrom: string;
  effectiveTo?: string;
}

export async function createPolicy(actor: AuthContext, input: PolicyInput) {
  if (input.method === 'PERCENTAGE' && input.rateBps == null) throw badRequest('rateBps is required for PERCENTAGE');
  if (input.method === 'FLAT' && input.flatMinor == null) throw badRequest('flatMinor is required for FLAT');
  if (input.providerId) {
    const p = await prisma.provider.findUnique({ where: { id: input.providerId } });
    if (!p) throw badRequest('Unknown provider');
    if (input.providerType && input.providerType !== p.type) throw badRequest('providerType does not match the provider');
  }
  if (input.agreementId) {
    const a = await prisma.providerAgreement.findUnique({ where: { id: input.agreementId } });
    if (!a || (input.providerId && a.providerId !== input.providerId)) throw badRequest('Agreement does not belong to this provider');
  }
  const latest = await prisma.commissionPolicy.findFirst({ where: { code: input.code }, orderBy: { version: 'desc' } });
  try {
    return await prisma.$transaction(async (tx) => {
      const p = await tx.commissionPolicy.create({
        data: {
          code: input.code,
          version: (latest?.version ?? 0) + 1,
          name: input.name,
          description: input.description,
          category: input.category,
          providerType: input.providerType ?? null,
          providerId: input.providerId ?? null,
          agreementId: input.agreementId ?? null,
          method: input.method,
          rateBps: input.method === 'PERCENTAGE' ? input.rateBps! : null,
          flatMinor: input.method === 'FLAT' ? BigInt(input.flatMinor!) : null,
          minMinor: input.minMinor != null ? BigInt(input.minMinor) : null,
          maxMinor: input.maxMinor != null ? BigInt(input.maxMinor) : null,
          taxRateBps: input.taxRateBps,
          effectiveFrom: new Date(input.effectiveFrom),
          effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : null,
          createdById: actor.userId,
          status: 'DRAFT',
        },
      });
      await audit(tx, { action: 'commission_policy.created', entityType: 'commission_policy', entityId: p.id, metadata: { code: p.code, version: p.version, category: p.category } });
      return policyDto(p);
    });
  } catch (err) {
    if (isPgError(err, '23514')) throw badRequest('The policy values violate a data rule (check rate, bounds and dates)');
    throw err;
  }
}

export async function submitPolicy(actor: AuthContext, id: string) {
  return prisma.$transaction(async (tx) => {
    const res = await tx.commissionPolicy.updateMany({ where: { id, status: 'DRAFT' }, data: { status: 'PENDING_APPROVAL' } });
    if (res.count !== 1) throw conflict('Only a DRAFT policy can be submitted');
    await audit(tx, { action: 'commission_policy.submitted', entityType: 'commission_policy', entityId: id, actorUserId: actor.userId });
    return policyDto(await tx.commissionPolicy.findUniqueOrThrow({ where: { id } }));
  });
}

export async function recordLegalReview(actor: AuthContext, id: string, status: Exclude<LegalReviewStatus, 'NOT_REVIEWED'>, note: string) {
  return prisma.$transaction(async (tx) => {
    const p = await tx.commissionPolicy.findUnique({ where: { id } });
    if (!p) throw notFound('Commission policy');
    if (p.status === 'RETIRED') throw conflict('Policy is retired');
    const updated = await tx.commissionPolicy.update({ where: { id }, data: { legalReviewStatus: status, legalReviewNote: note, legalReviewedById: actor.userId } });
    await audit(tx, { action: 'commission_policy.legal_review', entityType: 'commission_policy', entityId: id, metadata: { status } });
    return policyDto(updated);
  });
}

/**
 * Activate (checker). If `supersede` is set, an ACTIVE policy for the same
 * scope that started earlier is closed at this policy's effectiveFrom, so
 * history stays continuous without overlaps.
 */
export async function activatePolicy(actor: AuthContext, id: string, supersede: boolean) {
  try {
    return await prisma.$transaction(async (tx) => {
      const p = await tx.commissionPolicy.findUnique({ where: { id } });
      if (!p) throw notFound('Commission policy');
      if (p.status !== 'PENDING_APPROVAL') throw conflict('Only a policy pending approval can be activated');
      if (p.createdById === actor.userId) throw separationOfDuties('A policy must be approved by someone other than its author');
      if (HIGH_RISK_CATEGORIES.includes(p.category) && p.legalReviewStatus !== 'APPROVED') {
        throw preconditionFailed('Commission on procedures/surgery requires a recorded legal approval before activation');
      }
      if (isProduction && p.legalReviewStatus !== 'APPROVED') {
        throw preconditionFailed('In production every commission policy requires legal approval before activation');
      }
      if (p.legalReviewStatus === 'REJECTED') throw preconditionFailed('Legal review rejected this policy');

      // No two ACTIVE policies may cover the same scope (category + provider type + provider) at the same time.
      // PostgreSQL enforced this with an EXCLUDE constraint; here it is checked inside the activation transaction.
      const clashes = await tx.commissionPolicy.findMany({
        where: {
          id: { not: p.id },
          status: 'ACTIVE',
          category: p.category,
          providerType: p.providerType,
          providerId: p.providerId,
          ...(p.effectiveTo ? { effectiveFrom: { lt: p.effectiveTo } } : {}),
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: p.effectiveFrom } }],
        },
        select: { id: true, effectiveFrom: true, effectiveTo: true },
      });
      // Supersede can only close policies that started earlier; anything starting inside the new period still clashes.
      const unresolvable = clashes.filter((o) => !supersede || o.effectiveFrom >= p.effectiveFrom);
      if (unresolvable.length) throw conflict('Another ACTIVE policy covers the same scope and period; use supersede or adjust dates', { policyIds: unresolvable.map((o) => o.id) });

      if (supersede) {
        const overlapping = await tx.commissionPolicy.findMany({
          where: {
            status: 'ACTIVE',
            category: p.category,
            providerType: p.providerType,
            providerId: p.providerId,
            effectiveFrom: { lt: p.effectiveFrom },
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: p.effectiveFrom } }],
          },
        });
        for (const o of overlapping) {
          await tx.commissionPolicy.update({ where: { id: o.id }, data: { effectiveTo: p.effectiveFrom } });
          await audit(tx, { action: 'commission_policy.superseded', entityType: 'commission_policy', entityId: o.id, metadata: { by: p.id } });
        }
      }
      const updated = await tx.commissionPolicy.update({
        where: { id },
        data: { status: 'ACTIVE', approvedById: actor.userId, approvedAt: new Date() },
      });
      await audit(tx, { action: 'commission_policy.activated', entityType: 'commission_policy', entityId: id, metadata: { code: p.code, version: p.version } });
      return policyDto(updated);
    });
  } catch (err) {
    if (isPgError(err, '23P01')) throw conflict('Another ACTIVE policy covers the same scope and period; use supersede or adjust dates');
    throw err;
  }
}

export async function retirePolicy(actor: AuthContext, id: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const p = await tx.commissionPolicy.findUnique({ where: { id } });
    if (!p) throw notFound('Commission policy');
    if (p.status === 'RETIRED') throw conflict('Already retired');
    const now = new Date();
    const updated = await tx.commissionPolicy.update({
      where: { id },
      data: { status: 'RETIRED', effectiveTo: p.effectiveTo && p.effectiveTo < now ? p.effectiveTo : p.effectiveFrom > now ? p.effectiveFrom : now },
    });
    await audit(tx, { action: 'commission_policy.retired', entityType: 'commission_policy', entityId: id, actorUserId: actor.userId, metadata: { reason } });
    return policyDto(updated);
  });
}

export async function previewCommission(input: { category: CommissionCategory; providerId: string; amountMinor: bigint; at?: Date }) {
  const provider = await prisma.provider.findUnique({ where: { id: input.providerId } });
  if (!provider) throw notFound('Provider');
  const policy = await prisma.$transaction((tx) =>
    resolvePolicy(tx, { category: input.category, providerId: provider.id, providerType: provider.type, at: input.at ?? new Date() }),
  );
  if (!policy) return { policy: null, result: null };
  const r = calculateCommission(policy, input.amountMinor);
  return {
    policy: policyDto(policy),
    result: { baseMinor: Number(r.baseMinor), commissionMinor: Number(r.commissionMinor), taxMinor: Number(r.taxMinor), providerNetMinor: Number(r.providerNetMinor) },
  };
}
