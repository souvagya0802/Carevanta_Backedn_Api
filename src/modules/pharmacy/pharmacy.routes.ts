import { Router } from 'express';
import { z } from 'zod';
import { defineRoute, IdParams } from '../../http/route.js';
import { prisma, type Tx } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { AppError, badRequest, conflict, notFound, preconditionFailed } from '../../lib/errors.js';
import { assertTransition, type TransitionMap } from '../../lib/state-machine.js';
import { buildPage, cursorOrderBy, cursorWhere, PaginationQuery } from '../../lib/pagination.js';
import { makeReference, REF } from '../../lib/reference.js';
import { DateString, MoneyInput, Pincode, isoDate, minor } from '../../http/dto.js';
import { assertProviderAccess } from '../providers/provider-access.js';
import { createTransaction, onServiceCompleted, onSourceCancelled } from '../finance/commission.service.js';
import type { PharmacyOrderStatus, Prisma } from '../../../generated/prisma/client.js';

export const PHARMACY_TRANSITIONS: TransitionMap<PharmacyOrderStatus> = {
  PLACED: ['PRESCRIPTION_REVIEW', 'ACCEPTED', 'REJECTED', 'CANCELLED'],
  PRESCRIPTION_REVIEW: ['ACCEPTED', 'REJECTED', 'CANCELLED'],
  ACCEPTED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'CANCELLED'],
  READY_FOR_PICKUP: ['DELIVERED', 'CANCELLED'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'RETURNED'],
  DELIVERED: [],
  REJECTED: [],
  CANCELLED: [],
  RETURNED: [],
};
const RELEASES_STOCK: PharmacyOrderStatus[] = ['REJECTED', 'CANCELLED', 'RETURNED'];
const StatusEnum = z.enum(['PLACED', 'PRESCRIPTION_REVIEW', 'ACCEPTED', 'REJECTED', 'PREPARING', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'RETURNED']);
const Passthrough = z.object({ id: z.uuid() }).passthrough();

const include = {
  provider: { select: { id: true, displayName: true } },
  patient: { select: { id: true, fullName: true } },
  items: { include: { medicine: { select: { name: true, strength: true, schedule: true } }, inventory: { select: { batchNumber: true, expiryDate: true } } } },
  transaction: { select: { id: true, status: true } },
} satisfies Prisma.PharmacyOrderInclude;

function orderDto(o: Prisma.PharmacyOrderGetPayload<{ include: typeof include }>) {
  return {
    id: o.id,
    reference: o.reference,
    status: o.status,
    provider: o.provider,
    patient: o.patient,
    fulfilment: o.fulfilment,
    deliveryPincode: o.deliveryPincode,
    prescriptionId: o.prescriptionId,
    totalMinor: minor(o.totalMinor)!,
    currency: o.currency,
    statusReason: o.statusReason,
    items: o.items.map((i) => ({
      id: i.id,
      medicine: i.medicine,
      batchNumber: i.inventory?.batchNumber ?? null,
      expiryDate: isoDate(i.inventory?.expiryDate),
      quantity: i.quantity,
      unitPriceMinor: minor(i.unitPriceMinor)!,
    })),
    transaction: o.transaction,
    createdAt: o.createdAt.toISOString(),
  };
}

async function load(id: string) {
  const o = await prisma.pharmacyOrder.findUnique({ where: { id }, include });
  if (!o) throw notFound('Pharmacy order');
  return orderDto(o);
}

/**
 * Reserve stock first-expiry-first-out across batches. Each reservation is a
 * conditional UPDATE (available ≥ qty) so concurrent orders cannot oversell;
 * expired batches and batches expiring within 30 days are never dispensed.
 */
async function reserve(tx: Tx, locationId: string, medicineId: string, qty: number) {
  const minExpiry = new Date(Date.now() + 30 * 86_400_000);
  const batches = await tx.pharmacyInventory.findMany({ where: { locationId, medicineId, expiryDate: { gt: minExpiry } }, orderBy: { expiryDate: 'asc' } });
  const picks: { inventoryId: string; quantity: number; unitPriceMinor: bigint }[] = [];
  let remaining = qty;
  for (const b of batches) {
    if (remaining === 0) break;
    const take = Math.min(remaining, b.quantityOnHand - b.quantityReserved);
    if (take <= 0) continue;
    const n = await tx.$executeRaw`
      UPDATE pharmacy_inventory SET quantity_reserved = quantity_reserved + ${take}, version = version + 1, updated_at = now()
       WHERE id = ${b.id}::uuid AND quantity_on_hand - quantity_reserved >= ${take}`;
    if (n === 1) {
      picks.push({ inventoryId: b.id, quantity: take, unitPriceMinor: b.sellingPriceMinor });
      remaining -= take;
    }
  }
  if (remaining > 0) throw new AppError(409, 'CONFLICT', 'Insufficient stock for one or more medicines');
  return picks;
}

export function pharmacyRouter(): Router {
  const r = Router();
  const tags = ['Admin · Pharmacy'];

  defineRoute(r, '/admin/pharmacies', {
    method: 'get',
    path: '/:id/inventory',
    summary: 'Pharmacy stock by batch',
    tags,
    permissions: ['pharmacy.read'],
    params: IdParams,
    query: z.object({ expiringWithinDays: z.coerce.number().int().min(1).max(365).optional() }),
    response: z.array(Passthrough),
    handler: async ({ params, query }) =>
      (
        await prisma.pharmacyInventory.findMany({
          where: { providerId: params.id, ...(query.expiringWithinDays ? { expiryDate: { lte: new Date(Date.now() + query.expiringWithinDays * 86_400_000) } } : {}) },
          include: { medicine: { select: { name: true, strength: true, schedule: true } } },
          orderBy: [{ expiryDate: 'asc' }],
          take: 1000,
        })
      ).map((i) => ({
        id: i.id,
        locationId: i.locationId,
        medicine: i.medicine,
        batchNumber: i.batchNumber,
        expiryDate: isoDate(i.expiryDate),
        quantityOnHand: i.quantityOnHand,
        quantityReserved: i.quantityReserved,
        available: i.quantityOnHand - i.quantityReserved,
        mrpMinor: minor(i.mrpMinor)!,
        sellingPriceMinor: minor(i.sellingPriceMinor)!,
        expired: i.expiryDate < new Date(),
      })),
  });

  defineRoute(r, '/admin/pharmacies', {
    method: 'put',
    path: '/:id/inventory',
    summary: 'Add or adjust a stock batch',
    description: 'Selling price may not exceed MRP. Reducing on-hand below reserved quantity is refused.',
    tags,
    status: 200,
    permissions: ['pharmacy.manage'],
    params: IdParams,
    body: z.object({
      locationId: z.uuid(),
      medicineId: z.uuid(),
      batchNumber: z.string().trim().min(1).max(64),
      expiryDate: DateString,
      quantityOnHand: z.number().int().min(0).max(1_000_000),
      mrpMinor: MoneyInput,
      sellingPriceMinor: MoneyInput,
    }),
    response: Passthrough,
    handler: async ({ params, body, auth }) =>
      prisma.$transaction(async (tx) => {
        const p = await tx.provider.findUnique({ where: { id: params.id } });
        if (!p || p.type !== 'PHARMACY') throw notFound('Pharmacy');
        if (!(await tx.providerLocation.findFirst({ where: { id: body.locationId, providerId: p.id } }))) throw badRequest('Location does not belong to this pharmacy');
        if (body.sellingPriceMinor > body.mrpMinor) throw badRequest('Selling price cannot exceed MRP');
        const existing = await tx.pharmacyInventory.findUnique({ where: { locationId_medicineId_batchNumber: { locationId: body.locationId, medicineId: body.medicineId, batchNumber: body.batchNumber } } });
        if (existing && body.quantityOnHand < existing.quantityReserved) throw conflict('On-hand quantity cannot go below reserved quantity');
        const data = { expiryDate: new Date(body.expiryDate), quantityOnHand: body.quantityOnHand, mrpMinor: BigInt(body.mrpMinor), sellingPriceMinor: BigInt(body.sellingPriceMinor) };
        const row = existing
          ? await tx.pharmacyInventory.update({ where: { id: existing.id }, data: { ...data, version: { increment: 1 } } })
          : await tx.pharmacyInventory.create({ data: { providerId: p.id, locationId: body.locationId, medicineId: body.medicineId, batchNumber: body.batchNumber, ...data } });
        await audit(tx, { action: 'pharmacy.inventory_saved', entityType: 'provider', entityId: p.id, actorUserId: auth.userId, metadata: { inventoryId: row.id, quantityOnHand: body.quantityOnHand } });
        return { id: row.id, quantityOnHand: row.quantityOnHand, quantityReserved: row.quantityReserved };
      }),
  });

  defineRoute(r, '/admin/pharmacy-orders', {
    kind: 'list',
    method: 'get',
    path: '',
    summary: 'Pharmacy orders',
    tags,
    permissions: ['pharmacy.read'],
    query: PaginationQuery.extend({ status: StatusEnum.optional(), providerId: z.uuid().optional() }),
    response: Passthrough,
    handler: async ({ query }) => {
      const rows = await prisma.pharmacyOrder.findMany({
        where: { ...(query.status ? { status: query.status } : {}), ...(query.providerId ? { providerId: query.providerId } : {}), ...cursorWhere(query.cursor) },
        include,
        orderBy: cursorOrderBy(),
        take: query.limit + 1,
      });
      const { items, page } = buildPage(rows, query.limit, (o) => o.createdAt);
      return { items: items.map(orderDto), page };
    },
  });

  defineRoute(r, '/admin/pharmacy-orders', {
    method: 'get',
    path: '/:id',
    summary: 'Pharmacy order',
    tags,
    permissions: ['pharmacy.read'],
    params: IdParams,
    response: Passthrough,
    handler: ({ params }) => load(params.id),
  });

  defineRoute(r, '/admin/pharmacy-orders', {
    method: 'post',
    path: '',
    summary: 'Assisted medicine order (reserves stock FEFO)',
    description:
      'Prescription-only medicines (Schedule H/H1/X or flagged) require an APPROVED prescription for the same patient. Substitutions are not automatic.',
    tags,
    idempotent: true,
    permissions: ['pharmacy.manage'],
    body: z.object({
      patientProfileId: z.uuid(),
      providerId: z.uuid(),
      locationId: z.uuid(),
      fulfilment: z.enum(['PICKUP', 'DELIVERY']),
      deliveryPincode: Pincode.optional(),
      prescriptionId: z.uuid().optional(),
      items: z.array(z.object({ medicineId: z.uuid(), quantity: z.number().int().min(1).max(1000) })).min(1).max(50),
    }),
    response: Passthrough,
    handler: async ({ body, auth }) => {
      const id = await prisma.$transaction(async (tx) => {
        const patient = await tx.patientProfile.findUnique({ where: { id: body.patientProfileId } });
        if (!patient) throw notFound('Patient profile');
        const pharmacy = await tx.provider.findUnique({ where: { id: body.providerId }, include: { pharmacyProfile: true } });
        if (!pharmacy || pharmacy.type !== 'PHARMACY') throw badRequest('Provider must be a pharmacy');
        if (pharmacy.status !== 'APPROVED') throw preconditionFailed('This pharmacy is not accepting orders');
        if (body.fulfilment === 'DELIVERY') {
          if (!body.deliveryPincode) throw badRequest('deliveryPincode is required for delivery');
          if (!pharmacy.pharmacyProfile?.homeDeliveryAvailable) throw preconditionFailed('This pharmacy does not deliver');
          const covered = await tx.providerServiceArea.count({ where: { providerId: pharmacy.id, purpose: 'DELIVERY', OR: [{ pincode: body.deliveryPincode }, { pincode: null }] } });
          if (!covered) throw preconditionFailed('Delivery is not available at this PIN code');
        }
        const medicines = await tx.medicine.findMany({ where: { id: { in: body.items.map((i) => i.medicineId) }, isActive: true } });
        if (medicines.length !== new Set(body.items.map((i) => i.medicineId)).size) throw badRequest('Unknown or inactive medicine');
        const needsRx = medicines.some((m) => m.requiresPrescription);
        if (needsRx) {
          if (!body.prescriptionId) throw preconditionFailed('A prescription is required for one or more medicines');
          const rx = await tx.prescription.findFirst({ where: { id: body.prescriptionId, patientProfileId: patient.id } });
          if (!rx) throw badRequest('Prescription not found for this patient');
          if (rx.reviewStatus === 'REJECTED') throw preconditionFailed('The prescription was rejected by the pharmacist');
          if (rx.validUntil && rx.validUntil < new Date()) throw preconditionFailed('The prescription has expired');
        }
        const lines: { medicineId: string; inventoryId: string; quantity: number; unitPriceMinor: bigint }[] = [];
        for (const item of body.items) {
          for (const pick of await reserve(tx, body.locationId, item.medicineId, item.quantity)) lines.push({ medicineId: item.medicineId, ...pick });
        }
        const total = lines.reduce((s, l) => s + l.unitPriceMinor * BigInt(l.quantity), 0n);
        const order = await tx.pharmacyOrder.create({
          data: {
            reference: makeReference(REF.pharmacyOrder),
            patientProfileId: patient.id,
            bookedByUserId: patient.accountUserId,
            providerId: pharmacy.id,
            locationId: body.locationId,
            fulfilment: body.fulfilment,
            deliveryPincode: body.deliveryPincode,
            prescriptionId: body.prescriptionId,
            status: needsRx ? 'PRESCRIPTION_REVIEW' : 'PLACED',
            source: 'ADMIN_CONSOLE',
            attribution: 'ADMIN_ASSISTED',
            totalMinor: total,
            items: { create: lines },
          },
        });
        await createTransaction(tx, { sourceType: 'PHARMACY_ORDER', sourceId: order.id, providerId: pharmacy.id, patientProfileId: patient.id, grossMinor: total, attribution: 'ADMIN_ASSISTED', payAtProvider: true });
        await audit(tx, { action: 'pharmacy_order.created', entityType: 'pharmacy_order', entityId: order.id, actorUserId: auth.userId, metadata: { lines: lines.length, needsRx } });
        return order.id;
      });
      return load(id);
    },
  });

  const advance = async (id: string, to: PharmacyOrderStatus, actorUserId: string, reason?: string) =>
    prisma.$transaction(async (tx) => {
      const o = await tx.pharmacyOrder.findUnique({ where: { id }, include: { items: true, transaction: true, prescription: true } });
      if (!o) throw notFound('Pharmacy order');
      assertTransition('Pharmacy order', PHARMACY_TRANSITIONS, o.status, to);
      if (to === 'ACCEPTED' && o.status === 'PRESCRIPTION_REVIEW' && o.prescription?.reviewStatus !== 'APPROVED') {
        throw preconditionFailed('A pharmacist must approve the prescription before the order can be accepted');
      }
      if (RELEASES_STOCK.includes(to) && !reason) throw badRequest('A reason is required');
      const res = await tx.pharmacyOrder.updateMany({
        where: { id, status: o.status, version: o.version },
        data: { status: to, statusReason: reason ?? null, version: { increment: 1 }, ...(to === 'DELIVERED' ? { completedAt: new Date() } : {}) },
      });
      if (res.count !== 1) throw conflict('The order changed concurrently');
      for (const item of o.items.filter((i) => i.inventoryId)) {
        if (RELEASES_STOCK.includes(to)) {
          await tx.$executeRaw`UPDATE pharmacy_inventory SET quantity_reserved = quantity_reserved - ${item.quantity}, updated_at = now() WHERE id = ${item.inventoryId}::uuid`;
        } else if (to === 'DELIVERED') {
          await tx.$executeRaw`UPDATE pharmacy_inventory SET quantity_reserved = quantity_reserved - ${item.quantity}, quantity_on_hand = quantity_on_hand - ${item.quantity}, updated_at = now() WHERE id = ${item.inventoryId}::uuid`;
        }
      }
      if (RELEASES_STOCK.includes(to) && o.transaction) await onSourceCancelled(tx, o.transaction.id, actorUserId, reason!);
      if (to === 'DELIVERED' && o.transaction) await onServiceCompleted(tx, o.transaction.id, actorUserId);
      await audit(tx, { action: `pharmacy_order.${to.toLowerCase()}`, entityType: 'pharmacy_order', entityId: id, actorUserId, metadata: { from: o.status, to } });
    });

  defineRoute(r, '/admin/pharmacy-orders', {
    method: 'post',
    path: '/:id/status',
    summary: 'Advance, cancel or return an order (stock released on cancel)',
    tags,
    status: 200,
    permissions: ['pharmacy.manage'],
    params: IdParams,
    body: z.object({ status: StatusEnum.exclude(['PLACED']), reason: z.string().max(1000).optional() }),
    response: Passthrough,
    handler: async ({ params, body, auth }) => {
      await advance(params.id, body.status, auth.userId, body.reason);
      return load(params.id);
    },
  });

  // Prescriptions: listed for platform oversight; reviewed only by the dispensing pharmacy's pharmacist.
  defineRoute(r, '/admin/prescriptions', {
    kind: 'list',
    method: 'get',
    path: '',
    summary: 'Prescription review queue (metadata only)',
    tags,
    permissions: ['pharmacy.read'],
    query: PaginationQuery.extend({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional() }),
    response: Passthrough,
    handler: async ({ query }) => {
      const rows = await prisma.prescription.findMany({ where: { ...(query.status ? { reviewStatus: query.status } : {}), ...cursorWhere(query.cursor) }, orderBy: cursorOrderBy(), take: query.limit + 1 });
      const { items, page } = buildPage(rows, query.limit, (x) => x.createdAt);
      return {
        page,
        items: items.map((p) => ({ id: p.id, patientProfileId: p.patientProfileId, reviewStatus: p.reviewStatus, reviewedAt: p.reviewedAt?.toISOString() ?? null, issuedOn: isoDate(p.issuedOn), validUntil: isoDate(p.validUntil), createdAt: p.createdAt.toISOString() })),
      };
    },
  });

  defineRoute(r, '/portal/providers/:providerId/prescriptions', {
    method: 'post',
    path: '/:id/review',
    summary: 'Pharmacist reviews a prescription attached to an order at this pharmacy',
    tags: ['Provider portal · Pharmacy'],
    status: 200,
    params: z.object({ providerId: z.uuid(), id: z.uuid() }),
    body: z.object({ decision: z.enum(['APPROVED', 'REJECTED']), note: z.string().max(1000).optional(), validUntil: DateString.optional() }),
    response: Passthrough,
    handler: async ({ params, body, auth }) => {
      await assertProviderAccess(auth, params.providerId, { capability: 'review_prescriptions' });
      const linked = await prisma.pharmacyOrder.count({ where: { prescriptionId: params.id, providerId: params.providerId } });
      if (!linked) throw notFound('Prescription');
      const p = await prisma.prescription.update({
        where: { id: params.id },
        data: { reviewStatus: body.decision, reviewNote: body.note, reviewedByUserId: auth.userId, reviewedAt: new Date(), validUntil: body.validUntil ? new Date(body.validUntil) : undefined },
      });
      await audit(prisma, { action: 'prescription.reviewed', entityType: 'prescription', entityId: p.id, metadata: { decision: body.decision } });
      return { id: p.id, reviewStatus: p.reviewStatus };
    },
  });

  return r;
}
