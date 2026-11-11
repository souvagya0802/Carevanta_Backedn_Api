import { Router } from 'express';
import { z } from 'zod';
import { defineRoute, IdParams } from '../../http/route.js';
import { prisma } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, isPgError, notFound, separationOfDuties } from '../../lib/errors.js';
import { buildPage, cursorOrderBy, cursorWhere, PaginationQuery } from '../../lib/pagination.js';
import { MoneyInput, SearchText } from '../../http/dto.js';
import { listOfferings, upsertOffering } from '../providers/provider-admin.service.js';
import { clearSearchVocabulary } from '../discovery/smart-search.js';
import { searchKey } from './cdci-parse.js';
import type { Medicine } from '../../../generated/prisma/client.js';

/** Everyday words patients type for a speciality or test. Lowercase, de-duplicated. */
const Synonyms = z.array(z.string().trim().toLowerCase().min(2).max(120)).max(40).transform((xs) => [...new Set(xs)]);

const Code = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, 'UPPER_SNAKE_CASE code');
const ServiceCategoryEnum = z.enum(['CONSULTATION', 'DIAGNOSTIC_TEST', 'IMAGING', 'PROCEDURE', 'SURGERY', 'PHARMACY', 'AMBULANCE', 'HOME_CARE', 'OTHER']);

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 180);
}

async function uniqueGuard<T>(fn: () => Promise<T>, what: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isPgError(err, '23505')) throw conflict(`${what} with this code or name already exists`);
    throw err;
  }
}

export function catalogueRouter(): Router {
  const r = Router();
  const base = '/admin/catalogue';
  const tags = ['Admin · Catalogue'];

  // Patient search keeps a short-lived copy of the catalogue vocabulary; any successful edit here refreshes it at once.
  r.use(base, (req, res, next) => {
    if (req.method !== 'GET') res.on('finish', () => { if (res.statusCode < 400) clearSearchVocabulary(); });
    next();
  });

  // ── Specialities ───────────────────────────────────────────────────────
  const SpecialityDto = z.object({ id: z.uuid(), code: z.string(), name: z.string(), parentCode: z.string().nullable(), description: z.string().nullable(), synonyms: z.array(z.string()), isActive: z.boolean(), doctorCount: z.number().int() });
  const loadSpecialities = async () => {
    const rows = await prisma.speciality.findMany({ orderBy: { name: 'asc' }, include: { parent: { select: { code: true } }, _count: { select: { doctors: true } } } });
    return rows.map((s) => ({ id: s.id, code: s.code, name: s.name, parentCode: s.parent?.code ?? null, description: s.description, synonyms: s.synonyms, isActive: s.isActive, doctorCount: s._count.doctors }));
  };

  defineRoute(r, base, {
    method: 'get',
    path: '/specialities',
    summary: 'List specialities',
    tags,
    permissions: ['catalogue.read'],
    response: z.array(SpecialityDto),
    handler: loadSpecialities,
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/specialities',
    summary: 'Create a speciality or sub-speciality',
    tags,
    permissions: ['catalogue.manage'],
    body: z.object({ code: Code, name: z.string().trim().min(2).max(120), parentCode: Code.optional(), description: z.string().max(1000).optional(), synonyms: Synonyms.default([]) }),
    response: SpecialityDto,
    handler: async ({ body }) => {
      const parent = body.parentCode ? await prisma.speciality.findUnique({ where: { code: body.parentCode } }) : null;
      if (body.parentCode && !parent) throw badRequest('Unknown parent speciality');
      const s = await uniqueGuard(
        () =>
          prisma.$transaction(async (tx) => {
            const created = await tx.speciality.create({ data: { code: body.code, name: body.name, description: body.description, synonyms: body.synonyms, parentId: parent?.id } });
            await audit(tx, { action: 'catalogue.speciality_created', entityType: 'speciality', entityId: created.id, metadata: { code: body.code } });
            return created;
          }),
        'A speciality',
      );
      return (await loadSpecialities()).find((x) => x.id === s.id)!;
    },
  });

  defineRoute(r, base, {
    method: 'patch',
    path: '/specialities/:id',
    summary: 'Edit or deactivate a speciality',
    tags,
    permissions: ['catalogue.manage'],
    params: IdParams,
    body: z.object({ name: z.string().trim().min(2).max(120).optional(), description: z.string().max(1000).nullable().optional(), synonyms: Synonyms.optional(), isActive: z.boolean().optional() }).strict(),
    response: SpecialityDto,
    handler: async ({ params, body }) => {
      await uniqueGuard(
        () =>
          prisma.$transaction(async (tx) => {
            if (!(await tx.speciality.findUnique({ where: { id: params.id } }))) throw notFound('Speciality');
            await tx.speciality.update({ where: { id: params.id }, data: body });
            await audit(tx, { action: 'catalogue.speciality_updated', entityType: 'speciality', entityId: params.id, metadata: body });
          }),
        'A speciality',
      );
      return (await loadSpecialities()).find((x) => x.id === params.id)!;
    },
  });

  // ── Conditions & mappings ──────────────────────────────────────────────
  const ConditionDto = z.object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    kind: z.string(),
    synonyms: z.array(z.string()),
    isRedFlag: z.boolean(),
    isActive: z.boolean(),
    mappings: z.array(z.object({ id: z.uuid(), specialityCode: z.string(), specialityName: z.string(), relevance: z.string(), reviewStatus: z.string() })),
  });
  const conditionDto = (c: any) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    kind: c.kind,
    synonyms: c.synonyms,
    isRedFlag: c.isRedFlag,
    isActive: c.isActive,
    mappings: c.specialities.map((m: any) => ({ id: m.id, specialityCode: m.speciality.code, specialityName: m.speciality.name, relevance: m.relevance, reviewStatus: m.reviewStatus })),
  });

  defineRoute(r, base, {
    kind: 'list',
    method: 'get',
    path: '/conditions',
    summary: 'List searchable conditions and symptoms',
    tags,
    permissions: ['catalogue.read'],
    query: PaginationQuery.extend({ q: SearchText.optional() }),
    response: ConditionDto,
    handler: async ({ query }) => {
      const rows = await prisma.condition.findMany({
        where: {
          ...(query.q ? { OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { synonyms: { has: query.q.toLowerCase() } }] } : {}),
          ...cursorWhere(query.cursor),
        },
        orderBy: cursorOrderBy(),
        take: query.limit + 1,
        include: { specialities: { include: { speciality: { select: { code: true, name: true } } } } },
      });
      const { items, page } = buildPage(rows, query.limit, (c) => c.createdAt);
      return { items: items.map(conditionDto), page };
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/conditions',
    summary: 'Create a condition / symptom term',
    tags,
    permissions: ['catalogue.manage'],
    body: z.object({
      name: z.string().trim().min(2).max(160),
      kind: z.enum(['CONDITION', 'SYMPTOM']).default('CONDITION'),
      synonyms: z.array(z.string().trim().toLowerCase().min(2).max(120)).max(40).default([]),
      isRedFlag: z.boolean().default(false),
    }),
    response: ConditionDto,
    handler: async ({ body }) => {
      const c = await uniqueGuard(
        () =>
          prisma.$transaction(async (tx) => {
            const created = await tx.condition.create({ data: { ...body, slug: slugify(body.name) } });
            await audit(tx, { action: 'catalogue.condition_created', entityType: 'condition', entityId: created.id, metadata: { name: body.name, isRedFlag: body.isRedFlag } });
            return created;
          }),
        'A condition',
      );
      return conditionDto(await prisma.condition.findUniqueOrThrow({ where: { id: c.id }, include: { specialities: { include: { speciality: true } } } }));
    },
  });

  defineRoute(r, base, {
    method: 'patch',
    path: '/conditions/:id',
    summary: 'Edit a condition term',
    tags,
    permissions: ['catalogue.manage'],
    params: IdParams,
    body: z
      .object({
        synonyms: z.array(z.string().trim().toLowerCase().min(2).max(120)).max(40).optional(),
        isRedFlag: z.boolean().optional(),
        isActive: z.boolean().optional(),
      })
      .strict(),
    response: ConditionDto,
    handler: async ({ params, body }) => {
      await prisma.$transaction(async (tx) => {
        if (!(await tx.condition.findUnique({ where: { id: params.id } }))) throw notFound('Condition');
        await tx.condition.update({ where: { id: params.id }, data: body });
        await audit(tx, { action: 'catalogue.condition_updated', entityType: 'condition', entityId: params.id, metadata: body });
      });
      return conditionDto(await prisma.condition.findUniqueOrThrow({ where: { id: params.id }, include: { specialities: { include: { speciality: true } } } }));
    },
  });

  const MappingDto = z.object({
    id: z.uuid(),
    condition: z.string(),
    speciality: z.string(),
    relevance: z.string(),
    reviewStatus: z.string(),
    rationale: z.string().nullable(),
    proposedById: z.string().nullable(),
    reviewedById: z.string().nullable(),
    reviewedAt: z.string().nullable(),
    reviewNote: z.string().nullable(),
  });
  const mappingDto = (m: any) => ({
    id: m.id,
    condition: m.condition.name,
    speciality: m.speciality.name,
    relevance: m.relevance,
    reviewStatus: m.reviewStatus,
    rationale: m.rationale,
    proposedById: m.proposedById,
    reviewedById: m.reviewedById,
    reviewedAt: m.reviewedAt?.toISOString() ?? null,
    reviewNote: m.reviewNote,
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/mappings',
    summary: 'Condition → speciality mappings (review queue)',
    tags,
    permissions: ['catalogue.read'],
    query: z.object({ reviewStatus: z.enum(['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'RETIRED']).optional() }),
    response: z.array(MappingDto),
    handler: async ({ query }) =>
      (
        await prisma.conditionSpecialityMapping.findMany({
          where: query.reviewStatus ? { reviewStatus: query.reviewStatus } : {},
          include: { condition: true, speciality: true },
          orderBy: [{ condition: { name: 'asc' } }, { relevance: 'asc' }],
          take: 500,
        })
      ).map(mappingDto),
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/mappings',
    summary: 'Propose a condition → speciality mapping',
    description: 'Proposals enter PENDING_REVIEW and do not affect search until a different clinical reviewer approves them.',
    tags,
    permissions: ['catalogue.manage'],
    body: z.object({ conditionId: z.uuid(), specialityCode: Code, relevance: z.enum(['PRIMARY', 'SECONDARY']), rationale: z.string().min(10).max(1000) }),
    response: MappingDto,
    handler: async ({ body, auth }) => {
      const spec = await prisma.speciality.findUnique({ where: { code: body.specialityCode } });
      if (!spec) throw badRequest('Unknown speciality');
      const m = await uniqueGuard(
        () =>
          prisma.$transaction(async (tx) => {
            const created = await tx.conditionSpecialityMapping.create({
              data: { conditionId: body.conditionId, specialityId: spec.id, relevance: body.relevance, rationale: body.rationale, reviewStatus: 'PENDING_REVIEW', proposedById: auth.userId },
              include: { condition: true, speciality: true },
            });
            await audit(tx, { action: 'catalogue.mapping_proposed', entityType: 'condition_mapping', entityId: created.id, metadata: { conditionId: body.conditionId, speciality: body.specialityCode } });
            return created;
          }),
        'This mapping',
      );
      return mappingDto(m);
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/mappings/:id/review',
    summary: 'Clinical review: approve or retire a mapping',
    tags,
    status: 200,
    permissions: ['catalogue.mappings.review'],
    params: IdParams,
    body: z.object({ decision: z.enum(['APPROVED', 'RETIRED']), note: z.string().min(5).max(1000) }),
    response: MappingDto,
    handler: async ({ params, body, auth }) =>
      prisma.$transaction(async (tx) => {
        const m = await tx.conditionSpecialityMapping.findUnique({ where: { id: params.id } });
        if (!m) throw notFound('Mapping');
        if (m.proposedById === auth.userId) throw separationOfDuties('A mapping must be reviewed by someone other than its proposer');
        if (m.reviewStatus === body.decision) throw conflict(`Mapping is already ${body.decision}`);
        const updated = await tx.conditionSpecialityMapping.update({
          where: { id: params.id },
          data: { reviewStatus: body.decision, reviewedById: auth.userId, reviewedAt: new Date(), reviewNote: body.note },
          include: { condition: true, speciality: true },
        });
        await audit(tx, { action: 'catalogue.mapping_reviewed', entityType: 'condition_mapping', entityId: params.id, metadata: { decision: body.decision } });
        return mappingDto(updated);
      }),
  });

  // ── Departments / amenities ────────────────────────────────────────────
  defineRoute(r, base, {
    method: 'get',
    path: '/departments',
    summary: 'List departments',
    tags,
    permissions: ['catalogue.read'],
    response: z.array(z.object({ id: z.uuid(), code: z.string(), name: z.string(), specialityCode: z.string().nullable(), isActive: z.boolean() })),
    handler: async () =>
      (await prisma.department.findMany({ orderBy: { name: 'asc' }, include: { speciality: { select: { code: true } } } })).map((d) => ({
        id: d.id,
        code: d.code,
        name: d.name,
        specialityCode: d.speciality?.code ?? null,
        isActive: d.isActive,
      })),
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/departments',
    summary: 'Create a department',
    tags,
    permissions: ['catalogue.manage'],
    body: z.object({ code: Code, name: z.string().trim().min(2).max(120), specialityCode: Code.optional() }),
    response: z.object({ id: z.uuid(), code: z.string(), name: z.string() }),
    handler: async ({ body }) => {
      const spec = body.specialityCode ? await prisma.speciality.findUnique({ where: { code: body.specialityCode } }) : null;
      if (body.specialityCode && !spec) throw badRequest('Unknown speciality');
      return uniqueGuard(
        () =>
          prisma.$transaction(async (tx) => {
            const d = await tx.department.create({ data: { code: body.code, name: body.name, specialityId: spec?.id } });
            await audit(tx, { action: 'catalogue.department_created', entityType: 'department', entityId: d.id });
            return { id: d.id, code: d.code, name: d.name };
          }),
        'A department',
      );
    },
  });

  defineRoute(r, base, {
    method: 'patch',
    path: '/departments/:id',
    summary: 'Edit or deactivate a department',
    description: 'The code is permanent (facilities and affiliations refer to it). A deactivated department cannot be newly assigned; facilities that already list it keep it.',
    tags,
    permissions: ['catalogue.manage'],
    params: IdParams,
    body: z
      .object({ name: z.string().trim().min(2).max(120).optional(), specialityCode: Code.nullable().optional(), isActive: z.boolean().optional() })
      .strict()
      .refine((b) => Object.keys(b).length > 0, 'Nothing to change'),
    response: z.object({ id: z.uuid(), code: z.string(), name: z.string(), specialityCode: z.string().nullable(), isActive: z.boolean() }),
    handler: async ({ params, body }) => {
      let specialityId: string | null | undefined;
      if (body.specialityCode === null) specialityId = null;
      else if (body.specialityCode) {
        const spec = await prisma.speciality.findUnique({ where: { code: body.specialityCode } });
        if (!spec) throw badRequest('Unknown speciality');
        specialityId = spec.id;
      }
      return uniqueGuard(
        () =>
          prisma.$transaction(async (tx) => {
            if (!(await tx.department.findUnique({ where: { id: params.id } }))) throw notFound('Department');
            const d = await tx.department.update({
              where: { id: params.id },
              data: { ...(body.name !== undefined ? { name: body.name } : {}), ...(specialityId !== undefined ? { specialityId } : {}), ...(body.isActive !== undefined ? { isActive: body.isActive } : {}) },
              include: { speciality: { select: { code: true } } },
            });
            await audit(tx, { action: 'catalogue.department_updated', entityType: 'department', entityId: d.id, metadata: body });
            return { id: d.id, code: d.code, name: d.name, specialityCode: d.speciality?.code ?? null, isActive: d.isActive };
          }),
        'A department',
      );
    },
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/amenities',
    summary: 'List facility amenities',
    tags,
    permissions: ['catalogue.read'],
    response: z.array(z.object({ id: z.uuid(), code: z.string(), name: z.string(), category: z.string(), isActive: z.boolean() })),
    handler: async () => prisma.amenity.findMany({ orderBy: [{ category: 'asc' }, { name: 'asc' }], select: { id: true, code: true, name: true, category: true, isActive: true } }),
  });

  defineRoute(r, base, {
    method: 'patch',
    path: '/amenities/:id',
    summary: 'Edit or deactivate an amenity',
    description: 'The code is permanent. A deactivated amenity cannot be newly assigned and is no longer offered to providers; providers that already list it keep it.',
    tags,
    permissions: ['catalogue.manage'],
    params: IdParams,
    body: z
      .object({ name: z.string().trim().min(2).max(120).optional(), category: z.string().trim().min(2).max(48).optional(), isActive: z.boolean().optional() })
      .strict()
      .refine((b) => Object.keys(b).length > 0, 'Nothing to change'),
    response: z.object({ id: z.uuid(), code: z.string(), name: z.string(), category: z.string(), isActive: z.boolean() }),
    handler: async ({ params, body }) =>
      prisma.$transaction(async (tx) => {
        if (!(await tx.amenity.findUnique({ where: { id: params.id } }))) throw notFound('Amenity');
        const a = await tx.amenity.update({ where: { id: params.id }, data: body });
        await audit(tx, { action: 'catalogue.amenity_updated', entityType: 'amenity', entityId: a.id, metadata: body });
        return { id: a.id, code: a.code, name: a.name, category: a.category, isActive: a.isActive };
      }),
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/amenities',
    summary: 'Create an amenity',
    tags,
    permissions: ['catalogue.manage'],
    body: z.object({ code: Code, name: z.string().trim().min(2).max(120), category: z.string().trim().min(2).max(48) }),
    response: z.object({ id: z.uuid(), code: z.string(), name: z.string(), category: z.string() }),
    handler: async ({ body }) =>
      uniqueGuard(
        () =>
          prisma.$transaction(async (tx) => {
            const a = await tx.amenity.create({ data: body });
            await audit(tx, { action: 'catalogue.amenity_created', entityType: 'amenity', entityId: a.id });
            return { id: a.id, code: a.code, name: a.name, category: a.category };
          }),
        'An amenity',
      ),
  });

  // ── Services ───────────────────────────────────────────────────────────
  const ServiceDto = z.object({
    id: z.uuid(),
    code: z.string(),
    name: z.string(),
    category: ServiceCategoryEnum,
    specialityCode: z.string().nullable(),
    requiresPrescription: z.boolean(),
    sampleType: z.string().nullable(),
    fastingRequired: z.boolean().nullable(),
    preparationInstructions: z.string().nullable(),
    synonyms: z.array(z.string()),
    isActive: z.boolean(),
    createdAt: z.string(),
  });
  const serviceDto = (s: any) => ({
    id: s.id,
    code: s.code,
    name: s.name,
    category: s.category,
    specialityCode: s.speciality?.code ?? null,
    requiresPrescription: s.requiresPrescription,
    sampleType: s.sampleType,
    fastingRequired: s.fastingRequired,
    preparationInstructions: s.preparationInstructions,
    synonyms: s.synonyms ?? [],
    isActive: s.isActive,
    createdAt: s.createdAt.toISOString(),
  });

  defineRoute(r, base, {
    kind: 'list',
    method: 'get',
    path: '/services',
    summary: 'List catalogue services and tests',
    tags,
    permissions: ['catalogue.read'],
    query: PaginationQuery.extend({ category: ServiceCategoryEnum.optional(), q: SearchText.optional() }),
    response: ServiceDto,
    handler: async ({ query }) => {
      const rows = await prisma.service.findMany({
        where: {
          ...(query.category ? { category: query.category } : {}),
          ...(query.q ? { OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { synonyms: { has: query.q.toLowerCase() } }] } : {}),
          ...cursorWhere(query.cursor),
        },
        include: { speciality: { select: { code: true } } },
        orderBy: cursorOrderBy(),
        take: query.limit + 1,
      });
      const { items, page } = buildPage(rows, query.limit, (s) => s.createdAt);
      return { items: items.map(serviceDto), page };
    },
  });

  const ServiceInput = z.object({
    code: Code,
    name: z.string().trim().min(2).max(200),
    category: ServiceCategoryEnum,
    specialityCode: Code.optional(),
    description: z.string().max(2000).optional(),
    requiresPrescription: z.boolean().default(false),
    sampleType: z.string().max(64).optional(),
    fastingRequired: z.boolean().optional(),
    preparationInstructions: z.string().max(2000).optional(),
    synonyms: Synonyms.default([]),
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/services',
    summary: 'Create a catalogue service / test',
    tags,
    permissions: ['catalogue.manage'],
    body: ServiceInput,
    response: ServiceDto,
    handler: async ({ body }) => {
      const spec = body.specialityCode ? await prisma.speciality.findUnique({ where: { code: body.specialityCode } }) : null;
      if (body.specialityCode && !spec) throw badRequest('Unknown speciality');
      const { specialityCode: _s, ...data } = body;
      return uniqueGuard(
        () =>
          prisma.$transaction(async (tx) => {
            const s = await tx.service.create({ data: { ...data, specialityId: spec?.id }, include: { speciality: true } });
            await audit(tx, { action: 'catalogue.service_created', entityType: 'service', entityId: s.id, metadata: { code: s.code } });
            return serviceDto(s);
          }),
        'A service',
      );
    },
  });

  defineRoute(r, base, {
    method: 'patch',
    path: '/services/:id',
    summary: 'Edit or deactivate a catalogue service',
    tags,
    permissions: ['catalogue.manage'],
    params: IdParams,
    body: ServiceInput.omit({ code: true, category: true, specialityCode: true, synonyms: true }).partial().extend({ synonyms: Synonyms.optional(), isActive: z.boolean().optional() }).strict(),
    response: ServiceDto,
    handler: async ({ params, body }) =>
      prisma.$transaction(async (tx) => {
        if (!(await tx.service.findUnique({ where: { id: params.id } }))) throw notFound('Service');
        const s = await tx.service.update({ where: { id: params.id }, data: body, include: { speciality: true } });
        await audit(tx, { action: 'catalogue.service_updated', entityType: 'service', entityId: s.id, metadata: { fields: Object.keys(body) } });
        return serviceDto(s);
      }),
  });

  // ── Provider offerings (pricing) ───────────────────────────────────────
  const OfferingDto = z.object({
    id: z.uuid(),
    serviceCode: z.string(),
    serviceName: z.string(),
    category: z.string(),
    locationId: z.string().nullable(),
    priceMinor: z.number().int(),
    currency: z.string(),
    homeServiceAvailable: z.boolean(),
    turnaroundHours: z.number().int().nullable(),
    isActive: z.boolean(),
  });

  defineRoute(r, '/admin/providers', {
    method: 'get',
    path: '/:id/services',
    summary: 'Priced services offered by a provider',
    tags,
    permissions: ['providers.read'],
    params: IdParams,
    response: z.array(OfferingDto),
    handler: ({ params }) => listOfferings(params.id),
  });

  defineRoute(r, '/admin/providers', {
    method: 'put',
    path: '/:id/services/:serviceCode',
    summary: 'Create or update a priced offering',
    tags,
    status: 200,
    permissions: ['providers.update'],
    params: z.object({ id: z.uuid(), serviceCode: Code }),
    body: z.object({
      locationId: z.uuid().nullable().default(null),
      priceMinor: MoneyInput,
      homeServiceAvailable: z.boolean().default(false),
      turnaroundHours: z.number().int().min(1).max(720).optional(),
      isActive: z.boolean().default(true),
    }),
    response: z.object({ id: z.uuid() }),
    handler: ({ params, body, auth }) => upsertOffering(auth, params.id, params.serviceCode, body),
  });

  // ── Medicines ──────────────────────────────────────────────────────────
  const MedicineDto = z.object({
    id: z.uuid(),
    name: z.string(),
    genericName: z.string().nullable(),
    strength: z.string().nullable(),
    dosageForm: z.string().nullable(),
    packSize: z.string().nullable(),
    manufacturer: z.string().nullable(),
    composition: z.string().nullable(),
    route: z.string().nullable(),
    code: z.string().nullable(),
    source: z.string(),
    proposedByProviderId: z.string().nullable(),
    schedule: z.string(),
    requiresPrescription: z.boolean(),
    isActive: z.boolean(),
    createdAt: z.string(),
  });
  const medicineDto = (m: Medicine) => ({ ...m, createdAt: m.createdAt.toISOString(), updatedAt: undefined });
  const ScheduleEnum = z.enum(['OTC', 'SCHEDULE_G', 'SCHEDULE_H', 'SCHEDULE_H1', 'SCHEDULE_X', 'OTHER']);
  const RX_SCHEDULES = ['SCHEDULE_H', 'SCHEDULE_H1', 'SCHEDULE_X'];

  defineRoute(r, base, {
    kind: 'list',
    method: 'get',
    path: '/medicines',
    summary: 'Medicine catalogue',
    tags,
    permissions: ['catalogue.read'],
    query: PaginationQuery.extend({ q: SearchText.optional(), source: z.enum(['CDCI', 'MANUAL', 'PROVIDER']).optional() }),
    response: MedicineDto,
    handler: async ({ query }) => {
      const rows = await prisma.medicine.findMany({
        where: {
          ...(query.source ? { source: query.source } : {}),
          ...(query.q ? { OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { genericName: { contains: query.q, mode: 'insensitive' } }] } : {}),
          ...cursorWhere(query.cursor),
        },
        orderBy: cursorOrderBy(),
        take: query.limit + 1,
      });
      const { items, page } = buildPage(rows, query.limit, (m) => m.createdAt);
      return { items: items.map(medicineDto), page };
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/medicines',
    summary: 'Add a medicine to the catalogue',
    description: 'Scheduled drugs (H, H1, X) always require a prescription regardless of the flag sent.',
    tags,
    permissions: ['catalogue.manage'],
    body: z.object({
      name: z.string().trim().min(2).max(200),
      genericName: z.string().max(200).optional(),
      strength: z.string().max(64).optional(),
      dosageForm: z.string().max(64).optional(),
      packSize: z.string().max(64).optional(),
      manufacturer: z.string().max(160).optional(),
      composition: z.string().max(300).optional(),
      schedule: ScheduleEnum.default('OTC'),
      requiresPrescription: z.boolean().default(false),
    }),
    response: MedicineDto,
    handler: async ({ body }) => {
      const requiresPrescription = body.requiresPrescription || RX_SCHEDULES.includes(body.schedule);
      return uniqueGuard(
        () =>
          prisma.$transaction(async (tx) => {
            const m = await tx.medicine.create({ data: { ...body, requiresPrescription, source: 'MANUAL', searchName: searchKey(body.name, body.composition) } });
            await audit(tx, { action: 'catalogue.medicine_created', entityType: 'medicine', entityId: m.id, metadata: { schedule: m.schedule } });
            return medicineDto(m);
          }),
        'This medicine',
      );
    },
  });

  defineRoute(r, base, {
    method: 'patch',
    path: '/medicines/:id',
    summary: 'Edit a medicine (for example a pharmacy-added one, or a CDCI row whose schedule is known)',
    description: 'A CDCI re-import refreshes names but never overwrites schedule, requiresPrescription or isActive set here.',
    tags,
    permissions: ['catalogue.manage'],
    params: z.object({ id: z.uuid() }),
    body: z
      .object({
        name: z.string().trim().min(2).max(200),
        composition: z.string().trim().max(300).nullable(),
        genericName: z.string().max(200).nullable(),
        strength: z.string().max(64).nullable(),
        dosageForm: z.string().max(64).nullable(),
        packSize: z.string().max(64).nullable(),
        manufacturer: z.string().max(160).nullable(),
        schedule: ScheduleEnum,
        requiresPrescription: z.boolean(),
        isActive: z.boolean(),
        reason: z.string().trim().min(3).max(500),
      })
      .partial()
      .required({ reason: true }),
    response: MedicineDto,
    handler: async ({ params, body }) => {
      const { reason, ...changes } = body;
      return uniqueGuard(
        () =>
          prisma.$transaction(async (tx) => {
            const before = await tx.medicine.findUnique({ where: { id: params.id } });
            if (!before) throw notFound('Medicine');
            const schedule = changes.schedule ?? before.schedule;
            const requiresPrescription = (changes.requiresPrescription ?? before.requiresPrescription) || RX_SCHEDULES.includes(schedule);
            const name = changes.name ?? before.name;
            const composition = changes.composition === undefined ? before.composition : changes.composition;
            const m = await tx.medicine.update({ where: { id: params.id }, data: { ...changes, requiresPrescription, searchName: searchKey(name, composition) } });
            await audit(tx, { action: 'catalogue.medicine_updated', entityType: 'medicine', entityId: m.id, metadata: { reason, fields: Object.keys(changes), source: m.source } });
            return medicineDto(m);
          }),
        'This medicine',
      );
    },
  });

  return r;
}
