import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict } from '../../lib/errors.js';
import { dedupeKey, normaliseSpace, searchKey, titleCase } from './cdci-parse.js';

/** Fields the portal picker shows for a medicine. */
export function pickerDto(m: { id: string; name: string; composition: string | null; genericName: string | null; strength: string | null; dosageForm: string | null; packSize: string | null; manufacturer: string | null; schedule: string; requiresPrescription: boolean; source: string; code: string | null }) {
  return { id: m.id, name: m.name, composition: m.composition, genericName: m.genericName, strength: m.strength, dosageForm: m.dosageForm, packSize: m.packSize, manufacturer: m.manufacturer, schedule: m.schedule, requiresPrescription: m.requiresPrescription, source: m.source, code: m.code };
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
      },
    });
    await audit(tx, { action: 'catalogue.medicine_added_by_provider', entityType: 'medicine', entityId: m.id, actorUserId: userId, metadata: { providerId, name, strength, dosageForm } });
    return pickerDto(m);
  });
}
