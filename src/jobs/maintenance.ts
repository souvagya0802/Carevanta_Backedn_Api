import { prisma } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { transitionProvider } from '../modules/providers/providers.service.js';
import { VERIFICATION_REQUIREMENTS } from '../modules/providers/provider-state.js';

/**
 * Scheduled maintenance. Each function is idempotent and safe to re-run.
 * Expired credentials restrict the affected provider automatically; a human
 * reinstates it through a RENEWAL verification case.
 */
export async function enforceCredentialExpiry(now = new Date()): Promise<{ documentsExpired: number; providersSuspended: number; vehiclesGrounded: number }> {
  const result = { documentsExpired: 0, providersSuspended: 0, vehiclesGrounded: 0 };

  const expiredDocs = await prisma.providerDocument.findMany({ where: { status: 'ACCEPTED', expiresAt: { lt: now } }, select: { id: true, providerId: true, documentType: true } });
  if (expiredDocs.length) {
    await prisma.providerDocument.updateMany({ where: { id: { in: expiredDocs.map((d) => d.id) } }, data: { status: 'EXPIRED' } });
    result.documentsExpired = expiredDocs.length;
  }

  // Licences whose lapse makes the provider ineligible to operate.
  // Decided in code, not in a relation filter: on MongoDB, Prisma evaluates date comparisons inside relation
  // filters as aggregation expressions, where a missing or null date sorts BEFORE every date. `validUntil < now`
  // then matched credentials with no expiry at all and suspended every doctor and pharmacy on staging.
  // A blank expiry date means the credential does not expire.
  const lapsed = (d: Date | null | undefined) => d instanceof Date && d.getTime() < now.getTime();
  const pharmacies = await prisma.provider.findMany({ where: { type: 'PHARMACY', status: 'APPROVED' }, select: { id: true, pharmacyProfile: { select: { drugLicenseValidUntil: true } } } });
  const lapsedPharmacies = pharmacies.filter((p) => lapsed(p.pharmacyProfile?.drugLicenseValidUntil));
  // A doctor needs at least one verified registration that has not lapsed.
  const doctors = await prisma.provider.findMany({ where: { type: 'DOCTOR', status: 'APPROVED' }, select: { id: true, doctorProfile: { select: { registrations: { select: { validUntil: true, verifiedAt: true } } } } } });
  const lapsedDoctors = doctors.filter((p) => !(p.doctorProfile?.registrations ?? []).some((r) => r.verifiedAt != null && !lapsed(r.validUntil)));
  const docExpired = new Set(expiredDocs.filter((d) => ['DRUG_LICENSE', 'MEDICAL_REGISTRATION_CERTIFICATE', 'CLINICAL_ESTABLISHMENT_REGISTRATION'].includes(d.documentType)).map((d) => d.providerId));
  const toSuspend = new Set([...lapsedPharmacies.map((p) => p.id), ...lapsedDoctors.map((p) => p.id), ...docExpired]);
  for (const providerId of toSuspend) {
    try {
      await prisma.$transaction(async (tx) => {
        const p = await tx.provider.findUniqueOrThrow({ where: { id: providerId } });
        if (p.status !== 'APPROVED') return;
        await transitionProvider(tx, providerId, 'SUSPENDED', null, 'Automatic: a required licence or registration has expired');
        const open = await tx.verificationCase.count({ where: { providerId, status: { in: ['OPEN', 'IN_REVIEW', 'AWAITING_PROVIDER'] } } });
        if (!open) {
          const reqs = VERIFICATION_REQUIREMENTS[p.type];
          await tx.verificationCase.create({ data: { providerId, kind: 'RENEWAL', checks: { create: reqs.required.map((checkType) => ({ checkType, isRequired: true })) } } });
        }
        result.providersSuspended++;
      });
    } catch (err) {
      logger.error({ err, providerId }, 'failed to suspend provider with expired credentials');
    }
  }

  const grounded = await prisma.ambulanceVehicle.updateMany({
    where: { status: 'AVAILABLE', OR: [{ insuranceValidUntil: { lt: now } }, { fitnessValidUntil: { lt: now } }] },
    data: { status: 'OUT_OF_SERVICE' },
  });
  result.vehiclesGrounded = grounded.count;
  if (result.documentsExpired || result.providersSuspended || result.vehiclesGrounded) {
    await audit(prisma, { action: 'maintenance.credential_expiry', entityType: 'system', actorType: 'SYSTEM', metadata: result });
  }
  return result;
}

/** Open RENEWAL cases 30 days before a credential expires so operators have time. */
export async function openRenewalReminders(now = new Date()): Promise<number> {
  const soon = new Date(now.getTime() + 30 * 86_400_000);
  const docs = await prisma.providerDocument.findMany({
    where: { status: 'ACCEPTED', expiresAt: { gte: now, lte: soon }, provider: { status: 'APPROVED', verificationCases: { none: { status: { in: ['OPEN', 'IN_REVIEW', 'AWAITING_PROVIDER'] } } } } },
    select: { providerId: true, provider: { select: { type: true } } },
    distinct: ['providerId'],
  });
  for (const d of docs) {
    const reqs = VERIFICATION_REQUIREMENTS[d.provider.type];
    await prisma.verificationCase.create({ data: { providerId: d.providerId, kind: 'RENEWAL', status: 'AWAITING_PROVIDER', decisionNote: 'A credential expires within 30 days; please upload the renewed document.', checks: { create: reqs.required.map((checkType) => ({ checkType, isRequired: true })) } } });
  }
  return docs.length;
}

/** Remove expired short-lived rows. Audit and ledger tables are never touched. */
export async function cleanupExpired(now = new Date()): Promise<Record<string, number>> {
  const [idem, tokens, sessions, exports] = await Promise.all([
    prisma.idempotencyRecord.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.verificationToken.deleteMany({ where: { OR: [{ expiresAt: { lt: now } }, { consumedAt: { lt: new Date(now.getTime() - 7 * 86_400_000) } }] } }),
    prisma.session.deleteMany({ where: { OR: [{ expiresAt: { lt: new Date(now.getTime() - 30 * 86_400_000) } }, { revokedAt: { lt: new Date(now.getTime() - 30 * 86_400_000) } }] } }),
    prisma.exportJob.updateMany({ where: { status: 'COMPLETED', expiresAt: { lt: now } }, data: { status: 'EXPIRED' } }),
  ]);
  return { idempotencyRecords: idem.count, verificationTokens: tokens.count, sessions: sessions.count, exportsExpired: exports.count };
}

/** Mark confirmed appointments whose slot ended > 6 h ago without check-in as NO_SHOW. */
export async function autoNoShow(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 6 * 3_600_000);
  const stale = await prisma.appointment.findMany({ where: { status: { in: ['REQUESTED', 'CONFIRMED'] }, slot: { endsAt: { lt: cutoff } } }, select: { id: true, status: true, version: true }, take: 500 });
  let n = 0;
  for (const a of stale) {
    const res = await prisma.appointment.updateMany({ where: { id: a.id, status: a.status, version: a.version }, data: { status: 'NO_SHOW', statusReason: 'Automatic: no check-in recorded', version: { increment: 1 } } });
    if (res.count === 1) {
      await prisma.appointmentEvent.create({ data: { appointmentId: a.id, fromStatus: a.status, toStatus: 'NO_SHOW', actorKind: 'SYSTEM', note: 'Automatic' } });
      n++;
    }
  }
  return n;
}
