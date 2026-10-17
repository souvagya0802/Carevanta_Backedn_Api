import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { AppointmentStatus, ProviderStatus, SettlementItemStatus, TransactionStatus, UserStatus } from '../../../generated/prisma/enums.js';

/**
 * CSV exports run in the background, are capped at MAX_ROWS, never include
 * clinical content or secrets, expire after 24 h and every download is logged.
 */
export const EXPORT_TYPES = ['providers', 'appointments', 'transactions', 'settlements', 'audit_events', 'users'] as const;
export type ExportType = (typeof EXPORT_TYPES)[number];
export const MAX_ROWS = 50_000;
export const RETENTION_HOURS = 24;
const PAGE = 1_000;

/**
 * What each data set offers. Served to clients so filter controls stay in
 * step with the schema instead of being retyped in every UI.
 */
export interface ExportTypeInfo {
  type: ExportType;
  label: string;
  description: string;
  /** Allowed values for the `status` filter; empty when the data set has no status. */
  statuses: readonly string[];
  /** Whether `providerId` narrows this data set. */
  supportsProvider: boolean;
  /** The date column the range filter applies to. */
  dateField: string;
  /** When true a from/to range is mandatory (unbounded exports of this set are never useful). */
  requiresRange: boolean;
  columns: readonly string[];
}
export const EXPORT_CATALOGUE: readonly ExportTypeInfo[] = [
  { type: 'providers', label: 'Providers', description: 'Every provider organisation with its status, legal identity and primary location.', statuses: Object.values(ProviderStatus), supportsProvider: false, dateField: 'createdAt', requiresRange: false, columns: ['id', 'type', 'status', 'displayName', 'legalName', 'gstin', 'city', 'district', 'pincode', 'isListed', 'createdAt', 'approvedAt'] },
  { type: 'appointments', label: 'Appointments', description: 'Bookings with doctor, facility, slot time, fee and lifecycle timestamps. No patient identity.', statuses: Object.values(AppointmentStatus), supportsProvider: true, dateField: 'createdAt', requiresRange: false, columns: ['reference', 'status', 'source', 'attribution', 'doctor', 'facility', 'startsAt', 'feeMinor', 'createdAt', 'completedAt', 'cancelledAt'] },
  { type: 'transactions', label: 'Transactions', description: 'Service transactions with gross, refunded and final commission amounts (paise).', statuses: Object.values(TransactionStatus), supportsProvider: true, dateField: 'createdAt', requiresRange: false, columns: ['reference', 'sourceType', 'provider', 'category', 'status', 'attribution', 'grossMinor', 'refundedMinor', 'commissionEligible', 'commissionMinor', 'taxMinor', 'serviceCompletedAt', 'createdAt'] },
  { type: 'settlements', label: 'Settlements', description: 'Settlement line items per provider with batch reference, payout reference and paid time.', statuses: Object.values(SettlementItemStatus), supportsProvider: true, dateField: 'createdAt', requiresRange: false, columns: ['batch', 'batchStatus', 'provider', 'amountMinor', 'status', 'payoutReference', 'paidAt', 'createdAt'] },
  { type: 'audit_events', label: 'Audit Events', description: 'Who did what and when. A date range is required; metadata is excluded.', statuses: [], supportsProvider: false, dateField: 'occurredAt', requiresRange: true, columns: ['occurredAt', 'action', 'entityType', 'entityId', 'actorUserId', 'actorType', 'outcome', 'requestId'] },
  { type: 'users', label: 'Users', description: 'Account status, roles and verification flags. Never includes names, emails or phone numbers.', statuses: Object.values(UserStatus), supportsProvider: false, dateField: 'createdAt', requiresRange: false, columns: ['id', 'status', 'roles', 'emailVerified', 'phoneVerified', 'createdAt', 'lastLoginAt'] },
];
export const exportInfo = (type: ExportType): ExportTypeInfo => EXPORT_CATALOGUE.find((c) => c.type === type)!;

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : typeof v === 'bigint' ? v.toString() : String(v);
  // Neutralise spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

type Filters = { from?: string; to?: string; status?: string; providerId?: string };

async function* rows(type: ExportType, f: Filters): AsyncGenerator<Record<string, unknown>> {
  const range = f.from || f.to ? { gte: f.from ? new Date(f.from) : undefined, lt: f.to ? new Date(f.to) : undefined } : undefined;
  let cursor: string | undefined;
  let yielded = 0;
  while (yielded < MAX_ROWS) {
    let batch: Record<string, unknown>[] = [];
    switch (type) {
      case 'providers': {
        const rs = await prisma.provider.findMany({
          where: { ...(f.status ? { status: f.status as never } : {}), ...(range ? { createdAt: range } : {}) },
          include: { locations: { where: { isPrimary: true }, select: { city: true, district: true, pincode: true } } },
          orderBy: { id: 'asc' }, take: PAGE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        });
        batch = rs.map((p) => ({ id: p.id, type: p.type, status: p.status, displayName: p.displayName, legalName: p.legalName, gstin: p.gstin, city: p.locations[0]?.city, district: p.locations[0]?.district, pincode: p.locations[0]?.pincode, isListed: p.isListed, createdAt: p.createdAt, approvedAt: p.approvedAt }));
        cursor = rs[rs.length - 1]?.id; break;
      }
      case 'appointments': {
        const rs = await prisma.appointment.findMany({
          where: { ...(f.status ? { status: f.status as never } : {}), ...(f.providerId ? { OR: [{ doctorProviderId: f.providerId }, { facilityProviderId: f.providerId }] } : {}), ...(range ? { createdAt: range } : {}) },
          include: { slot: { select: { startsAt: true } }, doctor: { select: { displayName: true } }, facility: { select: { displayName: true } } },
          orderBy: { id: 'asc' }, take: PAGE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        });
        batch = rs.map((a) => ({ reference: a.reference, status: a.status, source: a.source, attribution: a.attribution, doctor: a.doctor.displayName, facility: a.facility.displayName, startsAt: a.slot.startsAt, feeMinor: a.feeMinor, createdAt: a.createdAt, completedAt: a.completedAt, cancelledAt: a.cancelledAt }));
        cursor = rs[rs.length - 1]?.id; break;
      }
      case 'transactions': {
        const rs = await prisma.serviceTransaction.findMany({
          where: { ...(f.status ? { status: f.status as never } : {}), ...(f.providerId ? { providerId: f.providerId } : {}), ...(range ? { createdAt: range } : {}) },
          include: { provider: { select: { displayName: true } }, commissions: { where: { status: 'FINAL' }, take: 1 } },
          orderBy: { id: 'asc' }, take: PAGE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        });
        batch = rs.map((t) => ({ reference: t.reference, sourceType: t.sourceType, provider: t.provider.displayName, category: t.category, status: t.status, attribution: t.attribution, grossMinor: t.grossMinor, refundedMinor: t.refundedMinor, commissionEligible: t.commissionEligible, commissionMinor: t.commissions[0]?.commissionMinor ?? null, taxMinor: t.commissions[0]?.taxMinor ?? null, serviceCompletedAt: t.serviceCompletedAt, createdAt: t.createdAt }));
        cursor = rs[rs.length - 1]?.id; break;
      }
      case 'settlements': {
        const rs = await prisma.settlementItem.findMany({
          where: { ...(f.status ? { status: f.status as never } : {}), ...(f.providerId ? { providerId: f.providerId } : {}), ...(range ? { createdAt: range } : {}) },
          include: { batch: { select: { reference: true, status: true } }, provider: { select: { displayName: true } } },
          orderBy: { id: 'asc' }, take: PAGE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        });
        batch = rs.map((i) => ({ batch: i.batch.reference, batchStatus: i.batch.status, provider: i.provider.displayName, amountMinor: i.amountMinor, status: i.status, payoutReference: i.payoutReference, paidAt: i.paidAt, createdAt: i.createdAt }));
        cursor = rs[rs.length - 1]?.id; break;
      }
      case 'audit_events': {
        const rs = await prisma.auditEvent.findMany({
          where: { ...(range ? { occurredAt: range } : {}) },
          orderBy: { id: 'asc' }, take: PAGE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        });
        batch = rs.map((e) => ({ occurredAt: e.occurredAt, action: e.action, entityType: e.entityType, entityId: e.entityId, actorUserId: e.actorUserId, actorType: e.actorType, outcome: e.outcome, requestId: e.requestId }));
        cursor = rs[rs.length - 1]?.id; break;
      }
      case 'users': {
        const rs = await prisma.user.findMany({
          where: { ...(f.status ? { status: f.status as never } : {}), ...(range ? { createdAt: range } : {}) },
          include: { roles: { where: { revokedAt: null }, select: { role: { select: { key: true } } } } },
          orderBy: { id: 'asc' }, take: PAGE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        });
        // Deliberately minimal: no contact details in bulk exports.
        batch = rs.map((u) => ({ id: u.id, status: u.status, roles: u.roles.map((x) => x.role.key).join('|'), emailVerified: !!u.emailVerifiedAt, phoneVerified: !!u.phoneVerifiedAt, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt }));
        cursor = rs[rs.length - 1]?.id; break;
      }
    }
    for (const row of batch) {
      yield row;
      if (++yielded >= MAX_ROWS) return;
    }
    if (batch.length < PAGE) return;
  }
}

export async function runExportJob(jobId: string): Promise<void> {
  const claimed = await prisma.exportJob.updateMany({ where: { id: jobId, status: 'QUEUED' }, data: { status: 'RUNNING', startedAt: new Date() } });
  if (claimed.count !== 1) return;
  const job = await prisma.exportJob.findUniqueOrThrow({ where: { id: jobId } });
  try {
    const lines: string[] = [];
    let header: string[] | undefined;
    let count = 0;
    for await (const row of rows(job.exportType as ExportType, job.filters as Filters)) {
      header ??= Object.keys(row);
      if (lines.length === 0) lines.push(header.join(','));
      lines.push(header.map((h) => csvEscape(row[h])).join(','));
      count++;
    }
    if (lines.length === 0) lines.push('(no rows)');
    const key = `exports/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.csv`;
    const full = path.resolve(env.STORAGE_LOCAL_DIR, key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, lines.join('\r\n'), { flag: 'wx', mode: 0o600 });
    await prisma.exportJob.update({ where: { id: jobId }, data: { status: 'COMPLETED', rowCount: count, storageKey: key, completedAt: new Date(), expiresAt: new Date(Date.now() + RETENTION_HOURS * 3_600_000) } });
    await audit(prisma, { action: 'export.completed', entityType: 'export_job', entityId: jobId, actorType: 'SYSTEM', metadata: { exportType: job.exportType, rowCount: count, truncated: count >= MAX_ROWS } });
  } catch (err) {
    logger.error({ err, jobId }, 'export failed');
    await prisma.exportJob.update({ where: { id: jobId }, data: { status: 'FAILED', error: (err instanceof Error ? err.message : String(err)).slice(0, 1000), completedAt: new Date() } });
  }
}

export async function runQueuedExports(limit = 5): Promise<number> {
  const jobs = await prisma.exportJob.findMany({ where: { status: 'QUEUED' }, orderBy: { createdAt: 'asc' }, take: limit, select: { id: true } });
  for (const j of jobs) await runExportJob(j.id);
  return jobs.length;
}

