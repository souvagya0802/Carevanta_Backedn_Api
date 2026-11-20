import { z } from 'zod';
import type { Prisma } from '../../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { aggregate, ejsonDate } from '../../lib/mongo.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { dedupeKey, normaliseSpace, searchKey, titleCase } from './cdci-parse.js';
import { medicineImageUrl } from './medicine-image-url.js';

/**
 * "Same salt, same strength, same form" keys come from one place (medicine-info.ts), so the CDCI
 * import, admin edits and pharmacy-added medicines always produce identical keys.
 */
import { compositionKey } from './medicine-info.js';
export { compositionKey, substituteKey } from './medicine-info.js';

/** Fields the portal picker shows for a medicine. */
export function pickerDto(m: { id: string; name: string; composition: string | null; genericName: string | null; strength: string | null; dosageForm: string | null; packSize: string | null; manufacturer: string | null; schedule: string; requiresPrescription: boolean; source: string; code: string | null; imageSha256?: string | null; imageSource?: string | null; imageUpdatedByProviderId?: string | null }) {
  return {
    id: m.id, name: m.name, composition: m.composition, genericName: m.genericName, strength: m.strength, dosageForm: m.dosageForm, packSize: m.packSize, manufacturer: m.manufacturer, schedule: m.schedule, requiresPrescription: m.requiresPrescription, source: m.source, code: m.code,
    // Photo: the portal shows Add / Change / "Set by Carevanta" from these.
    imageUrl: medicineImageUrl(m),
    imageSource: m.imageSha256 ? (m.imageSource ?? null) : null,
    imageProviderId: m.imageSha256 && m.imageSource === 'PROVIDER' ? (m.imageUpdatedByProviderId ?? null) : null,
  };
}

/**
 * Case-insensitive prefix search over the catalogue (name, then composition). Uses the lower-case
 * `searchName` index; rows created before searchName existed fall back to a name prefix match.
 */
export async function searchMedicines(q: string, limit = 20) {
  const term = normaliseSpace(q).toLocaleLowerCase('en-IN');
  if (term.length < 2) throw badRequest('Type at least 2 characters');
  const rows = await prisma.medicine.findMany({
    where: { isActive: true, OR: [{ searchName: { startsWith: term } }, { searchName: null, name: { startsWith: term, mode: 'insensitive' } }] },
    orderBy: [{ searchName: 'asc' }, { id: 'asc' }],
    take: Math.min(Math.max(limit, 1), 20),
  });
  return rows.map(pickerDto);
}

export const AddMedicineInput = z.object({
  name: z.string().trim().min(2).max(120),
  composition: z.string().trim().min(2).max(300),
  strength: z.string().trim().min(1).max(64),
  dosageForm: z.string().trim().min(2).max(64),
  manufacturer: z.string().trim().max(160).optional(),
  packSize: z.string().trim().max(64).optional(),
  requiresPrescription: z.boolean().default(true),
});
export type AddMedicineInput = z.infer<typeof AddMedicineInput>;

/**
 * A pharmacy adds a medicine it could not find. It is usable straight away (founder decision 2026-11-10:
 * no approval step); admins can review or edit pharmacy-added rows later (filter source = PROVIDER).
 * Refuses a duplicate of an existing active medicine with the same name, strength and form.
 */
export async function addProviderMedicine(providerId: string, userId: string, input: AddMedicineInput) {
  const name = normaliseSpace(input.name);
  const composition = titleCase(input.composition);
  const strength = normaliseSpace(input.strength);
  const dosageForm = titleCase(input.dosageForm);
  const key = dedupeKey(name, strength, dosageForm);
  const sameName = await prisma.medicine.findMany({
    where: { isActive: true, OR: [{ searchName: { startsWith: name.toLocaleLowerCase('en-IN') } }, { name: { equals: name, mode: 'insensitive' } }] },
    select: { id: true, name: true, strength: true, dosageForm: true },
    take: 500,
  });
  const dup = sameName.find((m) => dedupeKey(m.name, m.strength, m.dosageForm) === key);
  if (dup) throw conflict('This medicine is already in the catalogue; search for it and pick it', { medicineId: dup.id });
  return prisma.$transaction(async (tx) => {
    const m = await tx.medicine.create({
      data: {
        name,
        composition,
        strength,
        dosageForm,
        manufacturer: input.manufacturer ? normaliseSpace(input.manufacturer) : null,
        packSize: input.packSize ? normaliseSpace(input.packSize) : null,
        // Pharmacies cannot classify a schedule; a prescription-only flag keeps patients on the safe side.
        schedule: input.requiresPrescription ? 'SCHEDULE_H' : 'OTC',
        requiresPrescription: input.requiresPrescription,
        source: 'PROVIDER',
        proposedByProviderId: providerId,
        proposedByUserId: userId,
        searchName: searchKey(name, composition),
        compositionKey: compositionKey(composition, strength, dosageForm),
      },
    });
    await audit(tx, { action: 'catalogue.medicine_added_by_provider', entityType: 'medicine', entityId: m.id, actorUserId: userId, metadata: { providerId, name, strength, dosageForm } });
    return pickerDto(m);
  });
}

// ── Admin catalogue tools ─────────────────────────────────────────────────────

/** Patient-information fields an admin can edit. */
export const INFO_FIELDS = ['therapeuticClass', 'uses', 'howItWorks', 'sideEffects', 'contraindications', 'interactions', 'precautions', 'storage'] as const;
export type InfoField = (typeof INFO_FIELDS)[number];
/** Schedules that always need a prescription (mirrors the edit route). */
export const RX_SCHEDULES = ['SCHEDULE_H', 'SCHEDULE_H1', 'SCHEDULE_X'];

const sellable = () => ({ quantityOnHand: { gt: 0 }, expiryDate: { gt: new Date() } });

/** How many pharmacies hold sellable stock (on hand, not expired) of each medicine. */
export async function stockedCounts(ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const rows = await prisma.pharmacyInventory.findMany({ where: { medicineId: { in: ids }, ...sellable() }, select: { medicineId: true, providerId: true } });
  const sets = new Map<string, Set<string>>();
  for (const r of rows) {
    const s = sets.get(r.medicineId) ?? new Set<string>();
    s.add(r.providerId);
    sets.set(r.medicineId, s);
  }
  for (const [id, s] of sets) out.set(id, s.size);
  return out;
}

/** Ids of every medicine some pharmacy currently has in stock. */
export async function stockedMedicineIds(): Promise<string[]> {
  const rows = await aggregate<{ _id: string }>(prisma, 'pharmacy_inventory', [
    { $match: { quantity_on_hand: { $gt: 0 }, expiry_date: { $gt: ejsonDate(new Date()) } } },
    { $group: { _id: '$medicine_id' } },
  ]);
  return rows.map((r) => r._id);
}

export const MedicineListFilters = z.object({
  prescription: z.enum(['required', 'not_required']).optional(),
  visibility: z.enum(['shown', 'hidden']).optional(),
  hasInfo: z.enum(['yes', 'no']).optional(),
  inStock: z.enum(['yes', 'no']).optional(),
  hasPhoto: z.enum(['yes', 'no']).optional(),
  addedSince: z.coerce.date().optional(),
});
export type MedicineListFilters = z.infer<typeof MedicineListFilters>;

/** Prisma `where` clauses for the admin list filters (the caller combines them with AND). */
export async function medicineFilterWhere(f: MedicineListFilters): Promise<Prisma.MedicineWhereInput[]> {
  const and: Prisma.MedicineWhereInput[] = [];
  if (f.prescription) and.push({ requiresPrescription: f.prescription === 'required' });
  if (f.visibility) and.push({ isActive: f.visibility === 'shown' });
  if (f.hasInfo === 'yes') and.push({ uses: { isSet: true } }, { uses: { not: null } }, { NOT: { uses: '' } });
  if (f.hasInfo === 'no') and.push({ OR: [{ uses: { isSet: false } }, { uses: null }, { uses: '' }] });
  if (f.hasPhoto === 'yes') and.push({ imageSha256: { isSet: true } }, { imageSha256: { not: null } });
  if (f.hasPhoto === 'no') and.push({ OR: [{ imageSha256: { isSet: false } }, { imageSha256: null }] });
  if (f.addedSince) and.push({ createdAt: { gte: f.addedSince } });
  if (f.inStock) {
    const ids = await stockedMedicineIds();
    and.push(f.inStock === 'yes' ? { id: { in: ids } } : { id: { notIn: ids } });
  }
  return and;
}

/** Plain-language overview tiles: one aggregation over the catalogue plus one over stock. */
export async function medicineOverview() {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const count = (match: Record<string, unknown>) => [{ $match: match }, { $count: 'n' }];
  const [facets] = await aggregate<Record<string, { n: number }[]>>(prisma, 'medicines', [
    {
      $facet: {
        total: [{ $count: 'n' }],
        addedByPharmacies: count({ source: 'PROVIDER', created_at: { $gte: ejsonDate(since) } }),
        missingInfo: count({ uses: { $in: [null, ''] } }),
        prescriptionRequired: count({ requires_prescription: true }),
        hidden: count({ is_active: false }),
        noPhoto: count({ image_sha256: null }),
      },
    },
  ]);
  const n = (k: string) => Number(facets?.[k]?.[0]?.n ?? 0);
  const stocked = (await stockedMedicineIds()).length;
  return { total: n('total'), stocked, addedByPharmaciesLast30Days: n('addedByPharmacies'), missingInfo: n('missingInfo'), prescriptionRequired: n('prescriptionRequired'), hidden: n('hidden'), withoutPhoto: n('noPhoto'), addedSince: since.toISOString() };
}

/** Possible duplicates of a medicine about to be added: same name, strength and form first, then same-name rows. */
export async function findDuplicates(name: string, strength?: string, dosageForm?: string) {
  const clean = normaliseSpace(name);
  if (clean.length < 2) return [];
  const key = dedupeKey(clean, strength, dosageForm);
  const nameKey = dedupeKey(clean).split('|')[0];
  const rows = await prisma.medicine.findMany({
    where: { OR: [{ searchName: { startsWith: clean.toLocaleLowerCase('en-IN') } }, { name: { equals: clean, mode: 'insensitive' } }] },
    select: { id: true, name: true, strength: true, dosageForm: true, manufacturer: true, composition: true, isActive: true },
    take: 200,
  });
  return rows
    .map((m) => ({ ...m, exact: dedupeKey(m.name, m.strength, m.dosageForm) === key }))
    .filter((m) => m.exact || dedupeKey(m.name).split('|')[0] === nameKey)
    .sort((a, b) => Number(b.exact) - Number(a.exact))
    .slice(0, 5);
}

async function loadMedicine(id: string) {
  const m = await prisma.medicine.findUnique({ where: { id } });
  if (!m) throw notFound('Medicine');
  return m;
}

/** What the medicine page needs beyond the row: who edited the information, stock and order usage. */
export async function medicineDetail(id: string) {
  const m = await loadMedicine(id);
  const [stocked, inventoryRows, orderItems, substitutedIn, editor] = await Promise.all([
    stockedCounts([id]),
    prisma.pharmacyInventory.count({ where: { medicineId: id } }),
    prisma.pharmacyOrderItem.count({ where: { medicineId: id } }),
    prisma.pharmacyOrderItem.count({ where: { substitutedForMedicineId: id } }),
    m.infoUpdatedById ? prisma.user.findUnique({ where: { id: m.infoUpdatedById }, select: { fullName: true } }) : null,
  ]);
  const photoPharmacy = m.imageSha256 && m.imageSource === 'PROVIDER' && m.imageUpdatedByProviderId ? await prisma.provider.findUnique({ where: { id: m.imageUpdatedByProviderId }, select: { displayName: true } }) : null;
  return {
    medicine: m,
    stockedAt: stocked.get(id) ?? 0,
    infoUpdatedByName: editor?.fullName ?? null,
    imageAddedByPharmacy: photoPharmacy?.displayName ?? null,
    hasGovernmentSource: !!m.genericCode || m.source === 'CDCI',
    usage: { inventoryRows, orderItems: orderItems + substitutedIn },
  };
}

const infoText = (max: number) => z.string().trim().max(max).nullable().optional();
export const InfoInput = z.object({
  therapeuticClass: infoText(120),
  uses: infoText(4000),
  howItWorks: infoText(4000),
  sideEffects: infoText(4000),
  contraindications: infoText(4000),
  interactions: infoText(4000),
  precautions: infoText(4000),
  storage: infoText(4000),
  reason: z.string().trim().max(500).optional(),
});
export type InfoInput = z.infer<typeof InfoInput>;

/** An admin writes the patient information; imports never overwrite it afterwards (infoSource ADMIN). */
export async function updateMedicineInfo(id: string, userId: string, input: InfoInput) {
  const changes: Partial<Record<InfoField, string | null>> = {};
  for (const k of INFO_FIELDS) {
    const v = input[k];
    if (v !== undefined) changes[k] = v ? v : null;
  }
  if (!Object.keys(changes).length) throw badRequest('Nothing to save');
  return prisma.$transaction(async (tx) => {
    const before = await tx.medicine.findUnique({ where: { id }, select: { infoSource: true } });
    if (!before) throw notFound('Medicine');
    const m = await tx.medicine.update({ where: { id }, data: { ...changes, infoSource: 'ADMIN', infoUpdatedAt: new Date(), infoUpdatedById: userId } });
    await audit(tx, { action: 'catalogue.medicine_info_updated', entityType: 'medicine', entityId: id, metadata: { fields: Object.keys(changes), previousSource: before.infoSource ?? null, reason: input.reason ?? null } });
    return m;
  });
}

/**
 * Puts the government (CDCI) information back. The text is per generic, so when another medicine with the same
 * CDCI generic still carries it, it is copied at once; otherwise the fields are cleared and the next medicine list
 * update fills them (imports refresh rows whose infoSource is not ADMIN).
 */
export async function restoreGovernmentInfo(id: string, reason?: string) {
  const m = await loadMedicine(id);
  if (!m.genericCode && m.source !== 'CDCI') throw conflict('This medicine is not on the government list, so there is no government text to use');
  const donor = m.genericCode ? await prisma.medicine.findFirst({ where: { genericCode: m.genericCode, id: { not: id }, infoSource: 'CDCI', uses: { not: null } } }) : null;
  const data: Partial<Record<InfoField, string | null>> = {};
  for (const k of INFO_FIELDS) data[k] = donor ? (donor[k] ?? null) : null;
  return prisma.$transaction(async (tx) => {
    const updated = await tx.medicine.update({ where: { id }, data: { ...data, infoSource: 'CDCI', infoUpdatedAt: donor?.infoUpdatedAt ?? null, infoUpdatedById: null } });
    await audit(tx, { action: 'catalogue.medicine_info_restored', entityType: 'medicine', entityId: id, metadata: { restored: donor ? 'now' : 'next_update', fromMedicineId: donor?.id ?? null, reason: reason ?? null } });
    return { medicine: updated, restored: donor ? ('now' as const) : ('next_update' as const) };
  });
}

export const BulkInput = z.object({
  ids: z
    .array(z.uuid())
    .min(1)
    .max(200)
    .transform((xs) => [...new Set(xs)]),
  action: z.enum(['hide', 'show', 'require_prescription', 'no_prescription']),
  reason: z.string().trim().min(3).max(500),
});
export type BulkInput = z.infer<typeof BulkInput>;

/**
 * Hide/show or change the prescription rule for up to 200 medicines at once, one audit row each.
 * "No prescription" moves Schedule H/H1 rows to OTC; Schedule X (narcotic) rows are never relaxed in bulk.
 */
export async function bulkUpdateMedicines(input: BulkInput) {
  const found = await prisma.medicine.findMany({ where: { id: { in: input.ids } }, select: { id: true, schedule: true, isActive: true, requiresPrescription: true } });
  const skipped: { id: string; reason: string }[] = input.ids.filter((id) => !found.some((m) => m.id === id)).map((id) => ({ id, reason: 'Not found' }));
  const targets = found.filter((m) => {
    if (input.action === 'no_prescription' && m.schedule === 'SCHEDULE_X') {
      skipped.push({ id: m.id, reason: 'Schedule X (narcotic) medicines always need a prescription' });
      return false;
    }
    return true;
  });
  await prisma.$transaction(async (tx) => {
    for (const m of targets) {
      let data: Prisma.MedicineUpdateInput;
      if (input.action === 'hide' || input.action === 'show') data = { isActive: input.action === 'show' };
      else if (input.action === 'require_prescription') data = { requiresPrescription: true };
      else data = { requiresPrescription: false, ...(RX_SCHEDULES.includes(m.schedule) ? { schedule: 'OTC' as const } : {}) };
      await tx.medicine.update({ where: { id: m.id }, data });
      await audit(tx, { action: 'catalogue.medicine_bulk_updated', entityType: 'medicine', entityId: m.id, metadata: { bulkAction: input.action, reason: input.reason, before: { isActive: m.isActive, requiresPrescription: m.requiresPrescription, schedule: m.schedule }, batchSize: targets.length } });
    }
  });
  return { updated: targets.length, skipped };
}

/**
 * Merge a duplicate into the medicine to keep. Guarded: only when no pharmacy stocks the duplicate and no
 * order refers to it (order lines keep the medicine the patient chose, so they are never rewritten). The
 * duplicate is hidden rather than deleted, so a government re-import cannot bring it back as a new row.
 */
export async function mergeMedicine(duplicateId: string, keepId: string, reason: string) {
  if (duplicateId === keepId) throw badRequest('Choose a different medicine to keep');
  const [dup, keep] = await Promise.all([loadMedicine(duplicateId), prisma.medicine.findUnique({ where: { id: keepId } })]);
  if (!keep) throw notFound('Medicine to keep');
  if (!keep.isActive) throw conflict('The medicine to keep is hidden from patients; show it first');
  const [inventoryRows, orderItems, substitutedIn] = await Promise.all([
    prisma.pharmacyInventory.count({ where: { medicineId: duplicateId } }),
    prisma.pharmacyOrderItem.count({ where: { medicineId: duplicateId } }),
    prisma.pharmacyOrderItem.count({ where: { substitutedForMedicineId: duplicateId } }),
  ]);
  if (inventoryRows || orderItems || substitutedIn) {
    throw conflict('This medicine cannot be merged because pharmacies stock it or orders use it. Hide it from patients instead.', { inventoryRows, orderItems: orderItems + substitutedIn });
  }
  return prisma.$transaction(async (tx) => {
    const hidden = await tx.medicine.update({ where: { id: duplicateId }, data: { isActive: false } });
    await audit(tx, { action: 'catalogue.medicine_merged', entityType: 'medicine', entityId: duplicateId, metadata: { keptMedicineId: keepId, keptName: keep.name, reason, wasActive: dup.isActive } });
    await audit(tx, { action: 'catalogue.medicine_merge_kept', entityType: 'medicine', entityId: keepId, metadata: { mergedMedicineId: duplicateId, mergedName: dup.name, reason } });
    return hidden;
  });
}

/** Pharmacies (per store) holding the medicine: quantity, batches, nearest expiry and price range. Read-only. */
export async function medicineStock(id: string) {
  await loadMedicine(id);
  const rows = await prisma.pharmacyInventory.findMany({
    where: { medicineId: id },
    select: { providerId: true, locationId: true, quantityOnHand: true, quantityReserved: true, expiryDate: true, sellingPriceMinor: true, mrpMinor: true, provider: { select: { displayName: true } }, location: { select: { name: true, city: true } } },
    take: 2000,
  });
  const now = Date.now();
  type Row = { providerId: string; providerName: string; locationId: string; locationName: string; city: string; quantity: number; reserved: number; batches: number; expiredBatches: number; nearestExpiry: Date | null; minPriceMinor: number; maxPriceMinor: number; maxMrpMinor: number };
  const byLoc = new Map<string, Row>();
  for (const r of rows) {
    const e: Row = byLoc.get(r.locationId) ?? { providerId: r.providerId, providerName: r.provider.displayName, locationId: r.locationId, locationName: r.location.name, city: r.location.city, quantity: 0, reserved: 0, batches: 0, expiredBatches: 0, nearestExpiry: null, minPriceMinor: Number.MAX_SAFE_INTEGER, maxPriceMinor: 0, maxMrpMinor: 0 };
    e.batches++;
    if (r.expiryDate.getTime() <= now) e.expiredBatches++;
    else {
      e.quantity += r.quantityOnHand;
      e.reserved += r.quantityReserved;
      if (r.quantityOnHand > 0 && (!e.nearestExpiry || r.expiryDate < e.nearestExpiry)) e.nearestExpiry = r.expiryDate;
    }
    const price = Number(r.sellingPriceMinor);
    e.minPriceMinor = Math.min(e.minPriceMinor, price);
    e.maxPriceMinor = Math.max(e.maxPriceMinor, price);
    e.maxMrpMinor = Math.max(e.maxMrpMinor, Number(r.mrpMinor));
    byLoc.set(r.locationId, e);
  }
  return [...byLoc.values()]
    .map((e) => ({ ...e, nearestExpiry: e.nearestExpiry?.toISOString() ?? null }))
    .sort((a, b) => b.quantity - a.quantity || a.providerName.localeCompare(b.providerName));
}

/** Other medicines with the same salt, strength and form (same compositionKey). Information only. */
export async function medicineSubstitutes(id: string) {
  const m = await loadMedicine(id);
  const key = m.compositionKey ?? compositionKey(m.composition, m.strength, m.dosageForm);
  if (!key) return { compositionKey: null, items: [] };
  const rows = await prisma.medicine.findMany({
    where: { compositionKey: key, id: { not: id } },
    select: { id: true, name: true, strength: true, dosageForm: true, manufacturer: true, isActive: true, requiresPrescription: true, source: true, imageSha256: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    take: 50,
  });
  const stocked = await stockedCounts(rows.map((r) => r.id));
  return { compositionKey: key, items: rows.map(({ imageSha256, ...r }) => ({ ...r, imageUrl: medicineImageUrl({ id: r.id, imageSha256 }), stockedAt: stocked.get(r.id) ?? 0 })).sort((a, b) => b.stockedAt - a.stockedAt) };
}

/** Audit trail for one medicine, newest first, with the admin's name. */
export async function medicineHistory(id: string, limit = 50) {
  await loadMedicine(id);
  const events = await prisma.auditEvent.findMany({
    where: { entityType: 'medicine', entityId: id },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    take: Math.min(Math.max(limit, 1), 100),
  });
  const actorIds = [...new Set(events.map((e) => e.actorUserId).filter((x): x is string => !!x))];
  const users = actorIds.length ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, fullName: true } }) : [];
  const names = new Map(users.map((u) => [u.id, u.fullName]));
  return events.map((e) => ({ id: e.id, action: e.action, occurredAt: e.occurredAt.toISOString(), actorName: e.actorUserId ? (names.get(e.actorUserId) ?? 'Unknown Admin') : 'System', metadata: (e.metadata ?? null) as Record<string, unknown> | null }));
}
