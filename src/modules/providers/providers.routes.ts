import express, { Router, type Request, type Response, type RequestHandler } from 'express';
import { authenticate, requirePermissions, type AuthContext } from '../../middleware/auth.js';
import { z } from 'zod';
import { defineRoute, IdParams } from '../../http/route.js';
import { PaginationQuery } from '../../lib/pagination.js';
import { prisma } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, isPgError, notFound, separationOfDuties } from '../../lib/errors.js';
import { encryptField } from '../../lib/crypto.js';
import { DateString, Pincode, Reason, SearchText, iso } from '../../http/dto.js';
import { env } from '../../config/env.js';
import { assertTransition } from '../../lib/state-machine.js';
import {
  CreateProviderInput,
  LocationInput,
  ProviderStatusEnum,
  ProviderTypeEnum,
  UpdateProviderInput,
} from './providers.schemas.js';
import * as providers from './providers.service.js';
import * as verification from './verification.service.js';
import * as registries from './registries.service.js';
import { PROVIDER_TRANSITIONS, VERIFICATION_REQUIREMENTS } from './provider-state.js';

const ProviderSummary = z.object({
  id: z.uuid(),
  type: ProviderTypeEnum,
  status: ProviderStatusEnum,
  displayName: z.string(),
  legalName: z.string(),
  isListed: z.boolean(),
  city: z.string().nullable(),
  district: z.string().nullable(),
  ratingAverage: z.number().nullable(),
  ratingCount: z.number().int(),
  createdAt: z.string(),
});

// Detailed provider shape is large and type-dependent; documented loosely.
const ProviderDetail = z.object({ id: z.uuid(), type: ProviderTypeEnum, status: ProviderStatusEnum, version: z.number().int() }).passthrough();

const DocumentTypeEnum = z.enum([
  'MEDICAL_REGISTRATION_CERTIFICATE',
  'DEGREE_CERTIFICATE',
  'IDENTITY_PROOF',
  'GST_CERTIFICATE',
  'CLINICAL_ESTABLISHMENT_REGISTRATION',
  'TRADE_LICENSE',
  'DRUG_LICENSE',
  'PHARMACIST_REGISTRATION',
  'NABL_ACCREDITATION',
  'AERB_LICENSE',
  'PCPNDT_REGISTRATION',
  'FIRE_NOC',
  'BIOMEDICAL_WASTE_AUTHORISATION',
  'VEHICLE_REGISTRATION_CERTIFICATE',
  'VEHICLE_INSURANCE',
  'VEHICLE_FITNESS_CERTIFICATE',
  'VEHICLE_PERMIT',
  'DRIVING_LICENSE',
  'BANK_PROOF',
  'AGREEMENT',
  'OTHER',
]);
const CheckTypeEnum = z.enum([
  'IDENTITY',
  'PROFESSIONAL_REGISTRATION',
  'QUALIFICATION',
  'FACILITY_REGISTRATION',
  'TAX_REGISTRATION',
  'DRUG_LICENSE',
  'RADIOLOGY_LICENSE',
  'ACCREDITATION',
  'VEHICLE_REGISTRATION',
  'VEHICLE_INSURANCE',
  'ADDRESS',
  'BANK_ACCOUNT',
]);

const DocumentDto = z.object({
  id: z.uuid(),
  documentType: DocumentTypeEnum,
  status: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  documentNumber: z.string().nullable(),
  issuedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  expired: z.boolean(),
  reviewedById: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  reviewNote: z.string().nullable(),
  uploadedById: z.string().nullable(),
  createdAt: z.string(),
});

const PayoutDto = z.object({
  id: z.uuid(),
  accountHolderName: z.string(),
  accountNumberMasked: z.string(),
  ifsc: z.string(),
  status: z.string(),
  verifiedAt: z.string().nullable(),
  createdAt: z.string(),
});

function payoutDto(a: { id: string; accountHolderName: string; accountNumberLast4: string; ifsc: string; status: string; verifiedAt: Date | null; createdAt: Date }) {
  return {
    id: a.id,
    accountHolderName: a.accountHolderName,
    accountNumberMasked: `XXXXXX${a.accountNumberLast4}`,
    ifsc: a.ifsc,
    status: a.status,
    verifiedAt: iso(a.verifiedAt),
    createdAt: a.createdAt.toISOString(),
  };
}

export function providersRouter(): Router {
  const r = Router();
  const base = '/admin/providers';
  const tags = ['Admin · Providers'];

  defineRoute(r, base, {
    kind: 'list',
    method: 'get',
    path: '',
    summary: 'Search providers',
    tags,
    permissions: ['providers.read'],
    query: PaginationQuery.extend({
      type: ProviderTypeEnum.optional(),
      status: ProviderStatusEnum.optional(),
      district: z.string().max(80).optional(),
      q: SearchText.optional(),
    }),
    response: ProviderSummary,
    handler: ({ query }) => providers.listProviders(query),
  });

  defineRoute(r, base, {
    method: 'post',
    path: '',
    summary: 'Register a provider (any type)',
    description:
      'Creates the provider in DRAFT with its type-specific profile. A DOCTOR must be linked to the doctor’s own user account (existing or invited) — one doctor identity is reused across every facility through affiliations.',
    tags,
    permissions: ['providers.create'],
    body: CreateProviderInput,
    response: ProviderDetail,
    handler: async ({ body, auth }) => providers.getProvider(await providers.createProvider(auth, body)),
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/:id',
    summary: 'Provider details',
    tags,
    permissions: ['providers.read'],
    params: IdParams,
    response: ProviderDetail,
    handler: ({ params }) => providers.getProvider(params.id),
  });

  defineRoute(r, base, {
    method: 'patch',
    path: '/:id',
    summary: 'Edit provider details (optimistic concurrency)',
    tags,
    permissions: ['providers.update'],
    params: IdParams,
    body: UpdateProviderInput,
    response: ProviderDetail,
    handler: async ({ params, body, auth }) => {
      await providers.updateProvider(auth, params.id, body);
      return providers.getProvider(params.id);
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/:id/submit',
    summary: 'Submit a provider for verification',
    tags,
    status: 200,
    permissions: ['providers.update'],
    params: IdParams,
    response: ProviderDetail,
    handler: async ({ params, auth }) => {
      await providers.submitProvider(auth, params.id);
      return providers.getProvider(params.id);
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/:id/status',
    summary: 'Suspend, reactivate or deactivate a provider',
    description: 'Approval happens only through a verification decision. Suspension blocks all future open slots.',
    tags,
    status: 200,
    permissions: ['providers.suspend'],
    params: IdParams,
    body: z.object({ action: z.enum(['SUSPEND', 'REACTIVATE', 'DEACTIVATE']), reason: Reason }),
    response: ProviderDetail,
    handler: async ({ params, body, auth }) => {
      await prisma.$transaction(async (tx) => {
        const p = await tx.provider.findUnique({ where: { id: params.id } });
        if (!p) throw notFound('Provider');
        const to = body.action === 'SUSPEND' ? 'SUSPENDED' : body.action === 'DEACTIVATE' ? 'DEACTIVATED' : 'APPROVED';
        if (body.action === 'REACTIVATE' && p.status !== 'SUSPENDED') throw conflict('Only suspended providers can be reactivated');
        assertTransition('Provider', PROVIDER_TRANSITIONS, p.status, to);
        await providers.transitionProvider(tx, p.id, to, auth.userId, body.reason);
      });
      return providers.getProvider(params.id);
    },
  });

  // ── Locations & hours ──────────────────────────────────────────────────
  defineRoute(r, base, {
    method: 'post',
    path: '/:id/locations',
    summary: 'Add a location / branch',
    tags,
    permissions: ['providers.update'],
    params: IdParams,
    body: LocationInput,
    response: ProviderDetail,
    handler: async ({ params, body, auth }) => {
      await prisma.$transaction(async (tx) => {
        if (!(await tx.provider.findUnique({ where: { id: params.id }, select: { id: true } }))) throw notFound('Provider');
        const loc = await providers.createLocation(tx, params.id, body);
        await audit(tx, { action: 'provider.location_added', entityType: 'provider', entityId: params.id, actorUserId: auth.userId, metadata: { locationId: loc.id } });
      });
      return providers.getProvider(params.id);
    },
  });

  defineRoute(r, base, {
    method: 'patch',
    path: '/:id/locations/:locationId',
    summary: 'Edit or deactivate a location',
    tags,
    permissions: ['providers.update'],
    params: z.object({ id: z.uuid(), locationId: z.uuid() }),
    body: LocationInput.partial().extend({ isActive: z.boolean().optional() }).strict(),
    response: ProviderDetail,
    handler: async ({ params, body, auth }) => {
      await providers.updateLocation(auth, params.id, params.locationId, body);
      return providers.getProvider(params.id);
    },
  });

  defineRoute(r, base, {
    method: 'put',
    path: '/:id/locations/:locationId/hours',
    summary: 'Replace weekly opening hours for a location',
    tags,
    permissions: ['providers.update'],
    params: z.object({ id: z.uuid(), locationId: z.uuid() }),
    body: z.object({
      hours: z
        .array(
          z
            .object({
              dayOfWeek: z.number().int().min(0).max(6),
              opensAtMin: z.number().int().min(0).max(1439),
              closesAtMin: z.number().int().min(1).max(1440),
              isClosed: z.boolean().optional(),
            })
            .refine((h) => h.closesAtMin > h.opensAtMin, 'closesAtMin must be after opensAtMin'),
        )
        .max(28),
    }),
    response: ProviderDetail,
    handler: async ({ params, body, auth }) => {
      await providers.setOperatingHours(auth, params.id, params.locationId, body.hours);
      return providers.getProvider(params.id);
    },
  });

  defineRoute(r, base, {
    method: 'put',
    path: '/:id/service-areas',
    summary: 'Replace service coverage (home collection / delivery / ambulance)',
    tags,
    permissions: ['providers.update'],
    params: IdParams,
    body: z.object({
      areas: z
        .array(z.object({ purpose: z.enum(['HOME_COLLECTION', 'DELIVERY', 'AMBULANCE']), district: z.string().min(2).max(80), pincode: Pincode.optional() }))
        .max(200),
    }),
    response: z.array(z.object({ purpose: z.string(), district: z.string(), pincode: z.string().nullable() })),
    handler: async ({ params, body, auth }) => {
      return prisma.$transaction(async (tx) => {
        if (!(await tx.provider.findUnique({ where: { id: params.id }, select: { id: true } }))) throw notFound('Provider');
        await tx.providerServiceArea.deleteMany({ where: { providerId: params.id } });
        const unique = new Map(body.areas.map((a) => [`${a.purpose}|${a.district}|${a.pincode ?? ''}`, a]));
        await tx.providerServiceArea.createMany({ data: [...unique.values()].map((a) => ({ providerId: params.id, ...a, pincode: a.pincode ?? null })) });
        await audit(tx, { action: 'provider.service_areas_updated', entityType: 'provider', entityId: params.id, actorUserId: auth.userId, metadata: { count: unique.size } });
        return tx.providerServiceArea.findMany({ where: { providerId: params.id }, select: { purpose: true, district: true, pincode: true } });
      });
    },
  });

  // ── Members ────────────────────────────────────────────────────────────
  defineRoute(r, base, {
    method: 'post',
    path: '/:id/members',
    summary: 'Add a staff member / authorised user to a provider',
    tags,
    permissions: ['providers.members.manage'],
    params: IdParams,
    body: z.object({
      userId: z.uuid(),
      memberRole: z.enum(['OWNER', 'ADMIN', 'STAFF', 'PHARMACIST', 'LAB_TECHNICIAN', 'DISPATCHER']),
    }),
    response: ProviderDetail,
    handler: async ({ params, body, auth }) => {
      try {
        await prisma.$transaction(async (tx) => {
          const provider = await tx.provider.findUnique({ where: { id: params.id } });
          if (!provider) throw notFound('Provider');
          const user = await tx.user.findUnique({ where: { id: body.userId } });
          if (!user || user.status === 'ANONYMISED' || user.status === 'DEACTIVATED') throw badRequest('User must be an active account');
          await tx.providerMember.create({
            data: { providerId: params.id, userId: body.userId, memberRole: body.memberRole, status: 'ACTIVE', invitedById: auth.userId, joinedAt: new Date() },
          });
          await audit(tx, { action: 'provider.member_added', entityType: 'provider', entityId: params.id, metadata: { userId: body.userId, memberRole: body.memberRole } });
        });
      } catch (err) {
        if (isPgError(err, '23505')) throw conflict('This user is already a member of the provider');
        throw err;
      }
      return providers.getProvider(params.id);
    },
  });

  defineRoute(r, base, {
    method: 'delete',
    path: '/:id/members/:memberId',
    summary: 'Remove a provider member',
    tags,
    status: 200,
    permissions: ['providers.members.manage'],
    params: z.object({ id: z.uuid(), memberId: z.uuid() }),
    response: ProviderDetail,
    handler: async ({ params }) => {
      await prisma.$transaction(async (tx) => {
        const m = await tx.providerMember.findFirst({ where: { id: params.memberId, providerId: params.id, status: { not: 'REMOVED' } } });
        if (!m) throw notFound('Member');
        if (m.memberRole === 'OWNER') {
          const owners = await tx.providerMember.count({ where: { providerId: params.id, memberRole: 'OWNER', status: 'ACTIVE' } });
          if (owners <= 1) throw conflict('Assign another owner before removing the last one');
        }
        await tx.providerMember.update({ where: { id: m.id }, data: { status: 'REMOVED', removedAt: new Date() } });
        await audit(tx, { action: 'provider.member_removed', entityType: 'provider', entityId: params.id, metadata: { userId: m.userId } });
      });
      return providers.getProvider(params.id);
    },
  });

  // ── Documents ──────────────────────────────────────────────────────────
  defineRoute(r, base, {
    method: 'get',
    path: '/:id/documents',
    summary: 'List credential documents (metadata only)',
    tags,
    permissions: ['providers.read'],
    params: IdParams,
    response: z.array(DocumentDto),
    handler: ({ params }) => verification.listDocuments(params.id),
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/:id/documents',
    summary: 'Upload a credential document (raw body)',
    description:
      'Send the file as the raw request body with Content-Type application/pdf, image/jpeg or image/png. The file signature is verified; metadata goes in query parameters.',
    tags,
    permissions: ['providers.update'],
    params: IdParams,
    query: z.object({
      documentType: DocumentTypeEnum,
      fileName: z.string().min(1).max(255),
      documentNumber: z.string().max(80).optional(),
      issuedAt: DateString.optional(),
      expiresAt: DateString.optional(),
    }),
    middleware: [express.raw({ type: ['application/pdf', 'image/jpeg', 'image/png'], limit: env.MAX_UPLOAD_BYTES })],
    response: DocumentDto,
    handler: async ({ params, query, req, auth }) => {
      if (!Buffer.isBuffer(req.body)) throw badRequest('Send the file as the raw request body with a supported Content-Type');
      return verification.uploadDocument(auth, params.id, req.body, { ...query, mimeType: String(req.headers['content-type']).split(';')[0]!.trim() });
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/:id/documents/:documentId/review',
    summary: 'Accept or reject a document',
    tags,
    status: 200,
    permissions: ['providers.documents.review'],
    params: z.object({ id: z.uuid(), documentId: z.uuid() }),
    body: z.object({ decision: z.enum(['ACCEPTED', 'REJECTED']), note: z.string().max(1000).optional() }),
    response: DocumentDto,
    handler: ({ params, body, auth }) => verification.reviewDocument(auth, params.id, params.documentId, body.decision, body.note),
  });

  r.get(`${base}/:id/documents/:documentId/file`, ...documentFileHandlers());

  // ── Payout accounts ────────────────────────────────────────────────────
  defineRoute(r, base, {
    method: 'get',
    path: '/:id/payout-accounts',
    summary: 'List payout accounts (masked)',
    tags,
    permissions: ['providers.payout.read'],
    params: IdParams,
    response: z.array(PayoutDto),
    handler: async ({ params }) =>
      (await prisma.providerPayoutAccount.findMany({ where: { providerId: params.id }, orderBy: { createdAt: 'desc' } })).map(payoutDto),
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/:id/payout-accounts',
    summary: 'Add a payout bank account (stored encrypted)',
    tags,
    permissions: ['providers.payout.manage'],
    params: IdParams,
    body: z.object({
      accountHolderName: z.string().trim().min(2).max(160),
      accountNumber: z.string().regex(/^\d{9,18}$/, 'Account number must be 9–18 digits'),
      ifsc: z.string().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC'),
    }),
    response: PayoutDto,
    handler: async ({ params, body, auth }) =>
      prisma.$transaction(async (tx) => {
        if (!(await tx.provider.findUnique({ where: { id: params.id }, select: { id: true } }))) throw notFound('Provider');
        const acct = await tx.providerPayoutAccount.create({
          data: {
            providerId: params.id,
            accountHolderName: body.accountHolderName,
            accountNumberEncrypted: encryptField(body.accountNumber),
            accountNumberLast4: body.accountNumber.slice(-4),
            ifsc: body.ifsc,
            createdById: auth.userId,
          },
        });
        await audit(tx, { action: 'provider.payout_account_added', entityType: 'provider', entityId: params.id, metadata: { accountId: acct.id, last4: acct.accountNumberLast4 } });
        return payoutDto(acct);
      }),
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/:id/payout-accounts/:accountId/verify',
    summary: 'Verify a payout account (maker ≠ checker)',
    description: 'Making this account VERIFIED disables any previously verified account for the provider.',
    tags,
    status: 200,
    permissions: ['providers.payout.verify'],
    params: z.object({ id: z.uuid(), accountId: z.uuid() }),
    body: z.object({ method: z.enum(['PENNY_DROP', 'CANCELLED_CHEQUE', 'BANK_LETTER']), note: z.string().max(500).optional() }),
    response: PayoutDto,
    handler: async ({ params, body, auth }) =>
      prisma.$transaction(async (tx) => {
        const acct = await tx.providerPayoutAccount.findFirst({ where: { id: params.accountId, providerId: params.id } });
        if (!acct) throw notFound('Payout account');
        if (acct.status !== 'PENDING_VERIFICATION') throw conflict(`Account is ${acct.status}`);
        if (acct.createdById === auth.userId) throw separationOfDuties('You added this account and cannot verify it');
        await tx.providerPayoutAccount.updateMany({ where: { providerId: params.id, status: 'VERIFIED' }, data: { status: 'DISABLED', disabledAt: new Date() } });
        const updated = await tx.providerPayoutAccount.update({
          where: { id: acct.id },
          data: { status: 'VERIFIED', verifiedById: auth.userId, verifiedAt: new Date() },
        });
        await audit(tx, { action: 'provider.payout_account_verified', entityType: 'provider', entityId: params.id, metadata: { accountId: acct.id, method: body.method } });
        return payoutDto(updated);
      }),
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/:id/payout-accounts/:accountId/disable',
    summary: 'Disable a payout account',
    tags,
    status: 200,
    permissions: ['providers.payout.manage'],
    params: z.object({ id: z.uuid(), accountId: z.uuid() }),
    body: z.object({ reason: Reason }),
    response: PayoutDto,
    handler: async ({ params, body }) =>
      prisma.$transaction(async (tx) => {
        const acct = await tx.providerPayoutAccount.findFirst({ where: { id: params.accountId, providerId: params.id } });
        if (!acct) throw notFound('Payout account');
        if (acct.status === 'DISABLED') throw conflict('Already disabled');
        const updated = await tx.providerPayoutAccount.update({ where: { id: acct.id }, data: { status: 'DISABLED', disabledAt: new Date() } });
        await audit(tx, { action: 'provider.payout_account_disabled', entityType: 'provider', entityId: params.id, metadata: { accountId: acct.id, reason: body.reason } });
        return payoutDto(updated);
      }),
  });

  // ── Departments & amenities ────────────────────────────────────────────
  defineRoute(r, base, {
    method: 'put',
    path: '/:id/departments',
    summary: 'Set departments offered by a hospital/clinic',
    description: 'New departments start unverified; verification is a separate action.',
    tags,
    permissions: ['providers.update'],
    params: IdParams,
    body: z.object({ departmentCodes: z.array(z.string().max(64)).max(60) }),
    response: ProviderDetail,
    handler: async ({ params, body, auth }) => {
      await prisma.$transaction(async (tx) => {
        const p = await tx.provider.findUnique({ where: { id: params.id } });
        if (!p) throw notFound('Provider');
        if (p.type !== 'HOSPITAL' && p.type !== 'CLINIC') throw badRequest('Departments apply to hospitals and clinics only');
        const depts = await tx.department.findMany({ where: { code: { in: body.departmentCodes }, isActive: true } });
        if (depts.length !== new Set(body.departmentCodes).size) throw badRequest('Unknown department code');
        const keep = new Set(depts.map((d) => d.id));
        await tx.facilityDepartment.updateMany({ where: { providerId: p.id, departmentId: { notIn: [...keep] } }, data: { isActive: false } });
        for (const d of depts) {
          await tx.facilityDepartment.upsert({
            where: { providerId_departmentId: { providerId: p.id, departmentId: d.id } },
            create: { providerId: p.id, departmentId: d.id },
            update: { isActive: true },
          });
        }
        await audit(tx, { action: 'provider.departments_updated', entityType: 'provider', entityId: p.id, actorUserId: auth.userId, metadata: { codes: body.departmentCodes } });
      });
      return providers.getProvider(params.id);
    },
  });

  defineRoute(r, base, {
    method: 'put',
    path: '/:id/amenities',
    summary: 'Set facility amenities / capabilities',
    tags,
    permissions: ['providers.update'],
    params: IdParams,
    body: z.object({ amenityCodes: z.array(z.string().max(64)).max(60) }),
    response: ProviderDetail,
    handler: async ({ params, body, auth }) => {
      await prisma.$transaction(async (tx) => {
        if (!(await tx.provider.findUnique({ where: { id: params.id }, select: { id: true } }))) throw notFound('Provider');
        const items = await tx.amenity.findMany({ where: { code: { in: body.amenityCodes } } });
        if (items.length !== new Set(body.amenityCodes).size) throw badRequest('Unknown amenity code');
        await tx.providerAmenity.deleteMany({ where: { providerId: params.id, amenityId: { notIn: items.map((i) => i.id) } } });
        await tx.providerAmenity.createMany({ data: items.map((i) => ({ providerId: params.id, amenityId: i.id })), skipDuplicates: true });
        await audit(tx, { action: 'provider.amenities_updated', entityType: 'provider', entityId: params.id, actorUserId: auth.userId, metadata: { codes: body.amenityCodes } });
      });
      return providers.getProvider(params.id);
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/:id/claims/verify',
    summary: 'Mark a department or amenity claim as verified',
    tags,
    status: 200,
    permissions: ['providers.verify'],
    params: IdParams,
    body: z.object({ kind: z.enum(['DEPARTMENT', 'AMENITY']), code: z.string().max(64), verified: z.boolean() }),
    response: ProviderDetail,
    handler: async ({ params, body, auth }) => {
      await prisma.$transaction(async (tx) => {
        const data = body.verified ? { verifiedAt: new Date(), verifiedById: auth.userId } : { verifiedAt: null, verifiedById: null };
        const res =
          body.kind === 'DEPARTMENT'
            ? await tx.facilityDepartment.updateMany({ where: { providerId: params.id, department: { code: body.code } }, data })
            : await tx.providerAmenity.updateMany({ where: { providerId: params.id, amenity: { code: body.code } }, data });
        if (res.count === 0) throw notFound('Claim');
        await audit(tx, { action: 'provider.claim_verified', entityType: 'provider', entityId: params.id, metadata: body });
      });
      return providers.getProvider(params.id);
    },
  });

  return r;
}


/** Streams a document file with strict headers; requires a stated purpose. */
function documentFileHandlers(): RequestHandler[] {
  return [
    authenticate,
    requirePermissions(['providers.documents.read']),
    async (req: Request, res: Response) => {
      const params = z.object({ id: z.uuid(), documentId: z.uuid() }).safeParse(req.params);
      const purpose = z.string().trim().min(5).max(300).safeParse(req.query.purpose);
      if (!params.success) throw badRequest('Invalid document id');
      if (!purpose.success) throw badRequest('A ?purpose= of at least 5 characters is required to open a credential document');
      const { doc, buffer } = await verification.readDocumentFile(res.locals.auth as AuthContext, params.data.id, params.data.documentId, purpose.data);
      res.setHeader('Content-Type', doc.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${doc.fileName.replace(/"/g, '')}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(buffer);
    },
  ];
}

export function verificationRouter(): Router {
  const r = Router();
  const base = '/admin/verification-cases';
  const tags = ['Admin · Verification'];

  const CaseSummary = z.object({
    id: z.uuid(),
    status: z.string(),
    kind: z.string(),
    provider: z.object({ id: z.uuid(), displayName: z.string(), type: z.string(), status: z.string() }),
    assignedToId: z.string().nullable(),
    requiredChecks: z.number().int(),
    requiredPassed: z.number().int(),
    failedChecks: z.number().int(),
    createdAt: z.string(),
    ageHours: z.number().int(),
  });
  const CaseDetail = z.object({ id: z.uuid(), status: z.string(), checks: z.array(z.object({ checkType: z.string(), status: z.string() }).passthrough()) }).passthrough();

  defineRoute(r, base, {
    kind: 'list',
    method: 'get',
    path: '',
    summary: 'Verification queue (open cases by default)',
    tags,
    permissions: ['providers.read'],
    query: PaginationQuery.extend({
      q: SearchText.optional(),
      status: z.enum(['OPEN', 'IN_REVIEW', 'AWAITING_PROVIDER', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
      decidedOnly: z.enum(['true', 'false']).optional(),
      assignedToMe: z.enum(['true', 'false']).optional(),
      unassignedOnly: z.enum(['true', 'false']).optional(),
      overdueOnly: z.enum(['true', 'false']).optional(),
      kind: z.enum(['ONBOARDING', 'CHANGE_REQUEST']).optional(),
      providerType: ProviderTypeEnum.optional(),
    }),
    response: CaseSummary,
    handler: ({ query, auth }) =>
      verification.listCases({
        limit: query.limit, cursor: query.cursor, status: query.status, providerType: query.providerType, kind: query.kind, q: query.q,
        decidedOnly: query.decidedOnly === 'true', assignedToMe: query.assignedToMe === 'true', unassignedOnly: query.unassignedOnly === 'true', overdueOnly: query.overdueOnly === 'true',
        userId: auth.userId,
      }),
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/stats',
    summary: 'Verification queue health: open cases by type, unassigned, overdue, 7-day decisions',
    tags,
    permissions: ['providers.read'],
    response: z.object({ byStatus: z.record(z.string(), z.number().int()), openByProviderType: z.record(z.string(), z.number().int()), open: z.number().int(), unassigned: z.number().int(), mine: z.number().int(), overdue: z.number().int(), awaitingProvider: z.number().int(), slaHours: z.number().int(), decided7d: z.number().int(), approved7d: z.number().int(), avgDecisionHours7d: z.number().nullable() }),
    handler: ({ auth }) => verification.caseStats(auth.userId),
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/registries',
    summary: 'Which registry is authoritative for each check, how it can be looked up, and which connectors are configured',
    tags,
    permissions: ['providers.read'],
    response: z.object({
      registries: z.array(z.object({ key: z.string(), name: z.string(), authority: z.string(), checkTypes: z.array(z.string()), providerTypes: z.array(z.string()), mode: z.string(), portalUrl: z.string().nullable(), connector: z.string().nullable(), guidance: z.string(), evidenceDocuments: z.array(z.string()) })),
      requirements: z.record(z.string(), z.object({ required: z.array(z.string()), optional: z.array(z.string()) })),
      connectors: z.record(z.string(), z.enum(['configured', 'not_configured'])),
    }),
    handler: async () => ({ registries: registries.REGISTRIES.map((x) => ({ ...x })), requirements: VERIFICATION_REQUIREMENTS, connectors: await registries.connectorStatus() }),
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/:id/guidance',
    summary: 'Per-check guidance: identifiers on file, format and expiry warnings, registries to consult, evidence status',
    tags,
    permissions: ['providers.read'],
    params: IdParams,
    response: z.object({
      caseId: z.uuid(),
      checks: z.array(z.object({
        checkType: z.string(),
        registries: z.array(z.object({ key: z.string(), name: z.string(), mode: z.string(), portalUrl: z.string().nullable(), lookupAvailable: z.boolean(), connector: z.string().nullable(), guidance: z.string() })),
        identifiers: z.array(z.object({ label: z.string(), value: z.string() })),
        warnings: z.array(z.string()),
        evidence: z.array(z.object({ documentType: z.string(), status: z.enum(['ACCEPTED', 'UPLOADED', 'REJECTED', 'EXPIRED', 'MISSING']), documentId: z.string().nullable(), expiresAt: z.string().nullable() })),
      })),
      connectors: z.record(z.string(), z.enum(['configured', 'not_configured'])),
    }),
    handler: ({ params }) => registries.caseGuidance(params.id),
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/:id/checks/:checkType/lookup',
    summary: 'Run the configured registry connector for a check (audited; never auto-passes the check)',
    tags,
    status: 200,
    permissions: ['providers.verify'],
    params: z.object({ id: z.uuid(), checkType: CheckTypeEnum }),
    response: z.object({ registry: z.string(), outcome: z.enum(['MATCH', 'NO_MATCH', 'UNAVAILABLE']), reference: z.string().nullable(), summary: z.string(), raw: z.record(z.string(), z.unknown()).nullable() }),
    handler: ({ params, auth }) => registries.runLookup(auth, params.id, params.checkType),
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/:id',
    summary: 'Verification case with checks',
    tags,
    permissions: ['providers.read'],
    params: IdParams,
    response: CaseDetail,
    handler: ({ params }) => verification.getCase(params.id),
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/:id/assign',
    summary: 'Assign or unassign a case',
    tags,
    status: 200,
    permissions: ['providers.verify'],
    params: IdParams,
    body: z.object({ assigneeId: z.uuid().nullable() }),
    response: CaseDetail,
    handler: async ({ params, body, auth }) => {
      await verification.assignCase(auth, params.id, body.assigneeId);
      return verification.getCase(params.id);
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/:id/checks/:checkType',
    summary: 'Record the outcome of one verification check',
    description:
      'PASSED requires evidence (an ACCEPTED document or a source reference). WAIVED requires a justification. You cannot verify a provider you registered.',
    tags,
    status: 200,
    permissions: ['providers.verify'],
    params: z.object({ id: z.uuid(), checkType: CheckTypeEnum }),
    body: z.object({
      status: z.enum(['PASSED', 'FAILED', 'WAIVED']),
      method: z.enum(['MANUAL_DOCUMENT_REVIEW', 'OFFICIAL_REGISTRY_LOOKUP', 'AUTHORISED_THIRD_PARTY_API', 'ISSUER_CONFIRMATION', 'PHYSICAL_INSPECTION']),
      sourceReference: z.string().max(500).optional(),
      evidenceDocumentId: z.uuid().optional(),
      notes: z.string().max(2000).optional(),
      validUntil: DateString.optional(),
    }),
    response: CaseDetail,
    handler: async ({ params, body, auth }) => {
      await verification.recordCheck(auth, params.id, params.checkType, body);
      return verification.getCase(params.id);
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/:id/decision',
    summary: 'Approve, reject or request changes',
    tags,
    status: 200,
    permissions: ['providers.approve'],
    params: IdParams,
    body: z.object({ decision: z.enum(['APPROVE', 'REJECT', 'REQUEST_CHANGES']), note: Reason }),
    response: CaseDetail,
    handler: async ({ params, body, auth }) => {
      await verification.decideCase(auth, params.id, body.decision, body.note);
      return verification.getCase(params.id);
    },
  });

  return r;
}

