import express, { Router, type Request, type Response } from 'express';
import { noticeFields } from '../notifications/events.js';
import { notificationStreamHandler } from '../notifications/stream.js';
import { z } from 'zod';
import { defineRoute } from '../../http/route.js';
import { prisma } from '../../lib/prisma.js';
import { aggregate, ejsonDate, istDayStart, num } from '../../lib/mongo.js';
import { audit, logSensitiveAccess } from '../../lib/audit.js';
import { authenticate } from '../../middleware/auth.js';
import { getObject } from '../../lib/storage.js';
import { badRequest, conflict, notFound, preconditionFailed } from '../../lib/errors.js';
import { makeReference, REF } from '../../lib/reference.js';
import { PaginationQuery, buildPage, cursorOrderBy, cursorWhere } from '../../lib/pagination.js';
import { DateString, DateTimeString, MoneyInput, Phone, Pincode, iso, minor } from '../../http/dto.js';
import { env } from '../../config/env.js';
import { assertProviderAccess, assertProviderMember, getOwnDoctorProviderId } from '../providers/provider-access.js';
import { DEFAULT_WORDS, PORTAL_PAGES, PORTAL_TYPES, memberCapabilityMatrix, portalUi } from './portal-ui.js';
import { getSetting } from '../settings/settings.service.js';
import { AddMedicineInput, addProviderMedicine, searchMedicines } from '../catalogue/medicines.service.js';
import { medicineAddLimiter } from '../../middleware/rate-limit.js';
import { getPushConfig, subscribe as pushSubscribe, unsubscribe as pushUnsubscribe } from '../notifications/push.service.js';
import { LocationInput, UpdateProviderInput } from '../providers/providers.schemas.js';
import * as providers from '../providers/providers.service.js';
import * as admin from '../providers/provider-admin.service.js';
import * as verification from '../providers/verification.service.js';
import { caseGuidance } from '../providers/registries.service.js';
import { VERIFICATION_REQUIREMENTS } from '../providers/provider-state.js';
import * as appts from '../appointments/appointments.service.js';
import * as sched from '../scheduling/scheduling.service.js';
import { listDiagnosticOrders, loadDiagnosticOrder, scheduleDiagnosticOrder } from '../diagnostics/diagnostics.routes.js';
import { advancePharmacyOrder, listInventory, listPharmacyOrders, loadPharmacyOrder, upsertInventory } from '../pharmacy/pharmacy.routes.js';
import { CrewInput, VehicleInput, addCrew, listCrew, listVehicles, registerVehicle } from '../ambulance/ambulance.routes.js';
import * as settlements from '../finance/settlements.service.js';
import { txnDto } from '../finance/finance.routes.js';
import type { AuthContext } from '../../middleware/auth.js';

/**
 * Provider portal: what a hospital, clinic, lab, imaging centre, pharmacy,
 * ambulance operator or individual doctor can do for *their own* organisation.
 * Authorisation is per provider: the caller must be an ACTIVE member holding
 * the capability for the action (see PROVIDER_MEMBER_CAPABILITIES). Platform
 * staff with the matching permission can use the same endpoints, which keeps
 * one code path for "assisted" operations.
 */
const P = z.object({ providerId: z.uuid() });
const PI = z.object({ providerId: z.uuid(), id: z.uuid() });
const Passthrough = z.object({ id: z.uuid() }).passthrough();
const ProviderDetail = z.object({ id: z.uuid(), type: z.string(), status: z.string(), version: z.number().int() }).passthrough();
const DocumentTypeEnum = z.enum([
  'MEDICAL_REGISTRATION_CERTIFICATE', 'DEGREE_CERTIFICATE', 'IDENTITY_PROOF', 'GST_CERTIFICATE', 'CLINICAL_ESTABLISHMENT_REGISTRATION', 'TRADE_LICENSE', 'DRUG_LICENSE', 'PHARMACIST_REGISTRATION',
  'NABL_ACCREDITATION', 'AERB_LICENSE', 'PCPNDT_REGISTRATION', 'FIRE_NOC', 'BIOMEDICAL_WASTE_AUTHORISATION', 'VEHICLE_REGISTRATION_CERTIFICATE', 'VEHICLE_INSURANCE', 'VEHICLE_FITNESS_CERTIFICATE',
  'VEHICLE_PERMIT', 'DRIVING_LICENSE', 'BANK_PROOF', 'AGREEMENT', 'OTHER',
]);

/** Period helper for finance and analytics queries: defaults to the last 30 days, capped at 366. */
const Range = z.object({ from: DateTimeString.optional(), to: DateTimeString.optional() }).transform((q) => {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86_400_000);
  if (from >= to) throw badRequest('`from` must be before `to`');
  if (to.getTime() - from.getTime() > 366 * 86_400_000) throw badRequest('Range may not exceed 366 days');
  return { from, to };
});

export function portalRouter(): Router {
  const r = Router();
  const tags = ['Provider portal'];

  // ── Who am I, and which organisations can I act for ────────────────────
  defineRoute(r, '/portal', {
    method: 'get',
    path: '/me',
    summary: 'My provider memberships with the capabilities each role grants, plus my own doctor profile if any',
    tags,
    response: z.object({
      memberships: z.array(z.object({ providerId: z.uuid(), displayName: z.string(), type: z.string(), status: z.string(), isListed: z.boolean(), memberRole: z.string(), capabilities: z.array(z.string()), joinedAt: z.string().nullable(), specialities: z.array(z.string()) })),
      ownDoctorProviderId: z.uuid().nullable(),
    }),
    handler: async ({ auth }) => {
      const [rows, matrix] = await Promise.all([
        prisma.providerMember.findMany({ where: { userId: auth.userId, status: 'ACTIVE' }, include: { provider: { select: { id: true, displayName: true, type: true, status: true, isListed: true } } }, orderBy: { joinedAt: 'asc' } }),
        memberCapabilityMatrix(),
      ]);
      // A doctor's practice carries its specialities (primary first) so the portal can greet "Dr. X · Cardiologist".
      const doctorIds = rows.filter((m) => m.provider.type === 'DOCTOR').map((m) => m.provider.id);
      const specialityRows = doctorIds.length
        ? await prisma.doctorSpeciality.findMany({ where: { doctorProviderId: { in: doctorIds } }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }], select: { doctorProviderId: true, speciality: { select: { name: true } } } })
        : [];
      const specialities = new Map<string, string[]>();
      for (const s of specialityRows) specialities.set(s.doctorProviderId, [...(specialities.get(s.doctorProviderId) ?? []), s.speciality.name]);
      return {
        memberships: rows.map((m) => ({ providerId: m.provider.id, displayName: m.provider.displayName, type: m.provider.type, status: m.provider.status, isListed: m.provider.isListed, memberRole: m.memberRole, capabilities: [...(matrix[m.memberRole] ?? [])], joinedAt: iso(m.joinedAt), specialities: specialities.get(m.provider.id) ?? [] })),
        ownDoctorProviderId: await getOwnDoctorProviderId(auth),
      };
    },
  });

  // ── Portal configuration set by the super-admin ────────────────────────
  const UiDto = z.object({
    announcement: z.object({ text: z.string(), tone: z.string(), until: z.string().optional(), link: z.string().optional() }).nullable(),
    support: z.object({ email: z.string().optional(), phone: z.string().optional(), helpUrl: z.string().optional(), hours: z.string().optional() }),
    types: z.record(z.string(), z.object({ words: z.record(z.string(), z.string()).optional(), nav: z.record(z.string(), z.object({ label: z.string().optional(), hidden: z.boolean().optional() })).optional(), pages: z.record(z.string(), z.object({ title: z.string().optional(), description: z.string().optional() })).optional() })),
    emergencyNumber: z.string(),
  });
  const uiDto = async () => {
    const [ui, emergencyNumber] = await Promise.all([portalUi(), getSetting<string>('emergency.public_number', '112')]);
    return { announcement: ui.announcement ?? null, support: ui.support ?? {}, types: ui.types ?? {}, emergencyNumber };
  };

  defineRoute(r, '/public', {
    method: 'get',
    path: '/portal-ui',
    summary: 'Portal banner, support contacts and copy overrides (public, no secrets)',
    tags,
    auth: 'none',
    response: UiDto,
    handler: uiDto,
  });

  defineRoute(r, '/portal', {
    method: 'get',
    path: '/config',
    summary: 'Portal configuration plus the page catalogue and role matrix (for the portal app and the admin editor)',
    tags,
    response: UiDto.extend({
      catalogue: z.object({ types: z.array(z.string()), pages: z.array(z.object({ href: z.string(), label: z.string(), group: z.string(), types: z.array(z.string()), capabilities: z.array(z.string()) })), words: z.record(z.string(), z.record(z.string(), z.string())) }),
      roles: z.record(z.string(), z.array(z.string())),
    }),
    handler: async () => ({ ...(await uiDto()), catalogue: { types: [...PORTAL_TYPES], pages: PORTAL_PAGES, words: DEFAULT_WORDS }, roles: Object.fromEntries(Object.entries(await memberCapabilityMatrix()).map(([k, v]) => [k, [...v]])) }),
  });

  // Live notifications (SSE). A plain handler: defineRoute's JSON envelope does not fit a long-lived event stream.
  r.get('/portal/notifications/stream', authenticate, notificationStreamHandler);

  defineRoute(r, '/portal', {
    kind: 'list',
    method: 'get',
    path: '/notifications',
    summary: 'Messages the platform sent me (metadata only; one-time codes are never shown)',
    tags,
    query: PaginationQuery.extend({ channel: z.enum(['EMAIL', 'SMS', 'PUSH', 'IN_APP']).optional(), unread: z.enum(['true']).optional() }),
    response: Passthrough,
    handler: async ({ query, auth }) => {
      const rows = await prisma.notification.findMany({ where: { userId: auth.userId, ...(query.channel ? { channel: query.channel } : {}), ...(query.unread ? { channel: 'IN_APP', readAt: null } : {}), ...cursorWhere(query.cursor) }, orderBy: cursorOrderBy(), take: query.limit + 1 });
      const { items, page } = buildPage(rows, query.limit, (n) => n.createdAt);
      return { page, items: items.map((n) => ({ id: n.id, channel: n.channel, templateKey: n.templateKey, ...noticeFields(n.payload), status: n.status, title: n.title, body: n.body, link: n.link, readAt: iso(n.readAt), sentAt: iso(n.sentAt), createdAt: n.createdAt.toISOString() })) };
    },
  });

  defineRoute(r, '/portal', {
    method: 'get',
    path: '/notifications/unread-count',
    summary: 'How many in-app notifications I have not opened yet (for the bell)',
    tags,
    response: z.object({ unread: z.number().int(), latestAt: z.string().nullable() }),
    handler: async ({ auth }) => {
      const [unread, latest] = await Promise.all([
        prisma.notification.count({ where: { userId: auth.userId, channel: 'IN_APP', readAt: null } }),
        prisma.notification.findFirst({ where: { userId: auth.userId, channel: 'IN_APP' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      ]);
      return { unread, latestAt: iso(latest?.createdAt ?? null) };
    },
  });

  defineRoute(r, '/portal', {
    method: 'post',
    path: '/notifications/read',
    summary: 'Mark in-app notifications as read (specific ids, or everything)',
    tags,
    status: 200,
    body: z.object({ ids: z.array(z.uuid()).max(200).optional() }),
    response: z.object({ updated: z.number().int() }),
    handler: async ({ body, auth }) => {
      const res = await prisma.notification.updateMany({ where: { userId: auth.userId, channel: 'IN_APP', readAt: null, ...(body.ids ? { id: { in: body.ids } } : {}) }, data: { readAt: new Date() } });
      return { updated: res.count };
    },
  });

  // ── Web Push subscriptions for this browser / installed app ────────────
  defineRoute(r, '/portal', {
    method: 'get',
    path: '/push/public-key',
    summary: 'VAPID public key to subscribe with (null when push is not enabled on the platform)',
    tags,
    response: z.object({ publicKey: z.string().nullable(), subscribed: z.boolean() }),
    handler: async ({ auth }) => {
      const [cfg, count] = await Promise.all([getPushConfig(), prisma.pushSubscription.count({ where: { userId: auth.userId } })]);
      return { publicKey: cfg?.publicKey ?? null, subscribed: count > 0 };
    },
  });

  defineRoute(r, '/portal', {
    method: 'post',
    path: '/push/subscribe',
    summary: 'Register this device for push notifications',
    tags,
    status: 201,
    body: z.object({ endpoint: z.string().url().max(1000), keys: z.object({ p256dh: z.string().min(10).max(255), auth: z.string().min(10).max(255) }), userAgent: z.string().max(300).optional() }),
    response: z.object({ id: z.uuid() }),
    handler: async ({ body, auth }) => {
      const sub = await pushSubscribe(auth.userId, { endpoint: body.endpoint, keys: body.keys }, body.userAgent ?? null);
      await audit(prisma, { action: 'push.subscribed', entityType: 'user', entityId: auth.userId, actorUserId: auth.userId, metadata: { subscriptionId: sub.id } });
      return sub;
    },
  });

  defineRoute(r, '/portal', {
    method: 'post',
    path: '/push/unsubscribe',
    summary: 'Stop push notifications on this device',
    tags,
    status: 200,
    body: z.object({ endpoint: z.string().url().max(1000) }),
    response: z.object({ ok: z.boolean() }),
    handler: async ({ body, auth }) => {
      await pushUnsubscribe(auth.userId, body.endpoint);
      return { ok: true };
    },
  });

  // ── Organisation profile ───────────────────────────────────────────────
  const base = '/portal/providers/:providerId';

  defineRoute(r, base, {
    method: 'get',
    path: '',
    summary: 'My organisation: profile, locations, staff, departments, verification summary',
    tags,
    params: P,
    response: ProviderDetail.extend({ myRole: z.string().nullable(), myCapabilities: z.array(z.string()) }),
    handler: async ({ params, auth }) => {
      const access = await assertProviderMember(auth, params.providerId);
      const detail = await providers.getProvider(params.providerId);
      return { ...detail, myRole: access.role, myCapabilities: [...access.capabilities] };
    },
  });

  defineRoute(r, base, {
    method: 'patch',
    path: '',
    summary: 'Edit my organisation (optimistic concurrency via expectedVersion)',
    tags,
    params: P,
    body: UpdateProviderInput,
    response: ProviderDetail,
    handler: async ({ params, body, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'providers.update', capability: 'manage_profile' });
      await providers.updateProvider(auth, params.providerId, body);
      return providers.getProvider(params.providerId);
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/submit',
    summary: 'Submit my organisation for verification (or resubmit after changes were requested)',
    tags,
    status: 200,
    params: P,
    response: ProviderDetail,
    handler: async ({ params, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'providers.update', capability: 'manage_profile' });
      await providers.submitProvider(auth, params.providerId);
      return providers.getProvider(params.providerId);
    },
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/verification',
    summary: 'Where my verification stands: each check, what evidence it needs, and what is still missing',
    description: 'Shows the provider the same checklist the verifier works from, without internal notes or registry connectors.',
    tags,
    params: P,
    response: z.object({
      providerStatus: z.string(),
      caseStatus: z.string().nullable(),
      decisionNote: z.string().nullable(),
      requiredChecks: z.array(z.string()),
      optionalChecks: z.array(z.string()),
      checks: z.array(z.object({ checkType: z.string(), isRequired: z.boolean(), status: z.string(), validUntil: z.string().nullable(), identifiers: z.array(z.object({ label: z.string(), value: z.string() })), evidence: z.array(z.object({ documentType: z.string(), status: z.string() })), todo: z.array(z.string()) })),
      readyToSubmit: z.boolean(),
      blockers: z.array(z.string()),
    }),
    handler: async ({ params, auth }) => {
      await assertProviderMember(auth, params.providerId);
      const p = await prisma.provider.findUnique({ where: { id: params.providerId }, include: { locations: { where: { isActive: true }, select: { id: true } }, doctorProfile: { select: { registrations: { select: { id: true } } } }, verificationCases: { orderBy: { createdAt: 'desc' }, take: 1, include: { checks: true } } } });
      if (!p) throw notFound('Provider');
      const reqs = VERIFICATION_REQUIREMENTS[p.type];
      const kase = p.verificationCases[0] ?? null;
      const guidance = kase ? await caseGuidance(kase.id) : null;
      // Same readiness rules as submitProvider, surfaced before the button is pressed.
      const blockers: string[] = [];
      if (!p.locations.length) blockers.push('Add at least one active location');
      if (p.type === 'DOCTOR' && !p.doctorProfile?.registrations.length) blockers.push('Add the medical council registration');
      if (!p.contactPhone && !p.contactEmail) blockers.push('Add a contact phone or email');
      const checks = (kase?.checks ?? [...reqs.required.map((c) => ({ checkType: c, isRequired: true, status: 'PENDING', validUntil: null })), ...reqs.optional.map((c) => ({ checkType: c, isRequired: false, status: 'PENDING', validUntil: null }))]).map((k) => {
        const g = guidance?.checks.find((x) => x.checkType === k.checkType);
        // Only the actionable warnings are shown to the provider (never verifier-only hints).
        const todo = (g?.warnings ?? []).filter((w) => /No evidence document|not yet reviewed|expired|No .* on file|No vehicles|No active location|no map coordinates/i.test(w));
        return { checkType: k.checkType, isRequired: k.isRequired, status: k.status, validUntil: k.validUntil ? new Date(k.validUntil).toISOString().slice(0, 10) : null, identifiers: g?.identifiers ?? [], evidence: (g?.evidence ?? []).map((e) => ({ documentType: e.documentType, status: e.status })), todo };
      });
      return {
        providerStatus: p.status,
        caseStatus: kase?.status ?? null,
        decisionNote: kase && (kase.status === 'AWAITING_PROVIDER' || kase.status === 'REJECTED') ? kase.decisionNote : null,
        requiredChecks: reqs.required,
        optionalChecks: reqs.optional,
        checks,
        readyToSubmit: blockers.length === 0 && ['DRAFT', 'CHANGES_REQUESTED', 'REJECTED'].includes(p.status),
        blockers,
      };
    },
  });

  // ── Locations, hours, coverage ─────────────────────────────────────────
  defineRoute(r, base, {
    method: 'post',
    path: '/locations',
    summary: 'Add a location / branch / chamber',
    tags,
    params: P,
    body: LocationInput,
    response: ProviderDetail,
    handler: async ({ params, body, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'providers.update', capability: 'manage_profile' });
      await prisma.$transaction(async (tx) => {
        const loc = await providers.createLocation(tx, params.providerId, body);
        await audit(tx, { action: 'provider.location_added', entityType: 'provider', entityId: params.providerId, actorUserId: auth.userId, metadata: { locationId: loc.id, via: 'portal' } });
      });
      return providers.getProvider(params.providerId);
    },
  });

  defineRoute(r, base, {
    method: 'patch',
    path: '/locations/:id',
    summary: 'Edit or deactivate a location',
    tags,
    params: PI,
    body: LocationInput.partial().extend({ isActive: z.boolean().optional() }).strict(),
    response: ProviderDetail,
    handler: async ({ params, body, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'providers.update', capability: 'manage_profile' });
      await providers.updateLocation(auth, params.providerId, params.id, body);
      return providers.getProvider(params.providerId);
    },
  });

  defineRoute(r, base, {
    method: 'put',
    path: '/locations/:id/hours',
    summary: 'Replace weekly opening hours for a location',
    tags,
    status: 200,
    params: PI,
    body: z.object({ hours: z.array(z.object({ dayOfWeek: z.number().int().min(0).max(6), opensAtMin: z.number().int().min(0).max(1439), closesAtMin: z.number().int().min(1).max(1440), isClosed: z.boolean().optional() })).max(21) }),
    response: ProviderDetail,
    handler: async ({ params, body, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'providers.update', capability: 'manage_profile' });
      for (const h of body.hours) if (h.closesAtMin <= h.opensAtMin) throw badRequest('Closing time must be after opening time');
      await providers.setOperatingHours(auth, params.providerId, params.id, body.hours);
      return providers.getProvider(params.providerId);
    },
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/service-areas',
    summary: 'Coverage for home collection, delivery or ambulance response',
    tags,
    params: P,
    response: z.array(z.object({ purpose: z.string(), district: z.string(), pincode: z.string().nullable() })),
    handler: async ({ params, auth }) => {
      await assertProviderMember(auth, params.providerId);
      return prisma.providerServiceArea.findMany({ where: { providerId: params.providerId }, select: { purpose: true, district: true, pincode: true }, orderBy: [{ purpose: 'asc' }, { district: 'asc' }] });
    },
  });

  defineRoute(r, base, {
    method: 'put',
    path: '/service-areas',
    summary: 'Replace coverage areas (a district, optionally narrowed to a PIN code)',
    tags,
    status: 200,
    params: P,
    body: z.object({ areas: z.array(z.object({ purpose: z.enum(['HOME_COLLECTION', 'DELIVERY', 'AMBULANCE']), district: z.string().trim().min(2).max(80), pincode: Pincode.optional() })).max(200) }),
    response: z.array(z.object({ purpose: z.string(), district: z.string(), pincode: z.string().nullable() })),
    handler: async ({ params, body, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'providers.update', capability: 'manage_profile' });
      return admin.setServiceAreas(auth, params.providerId, body.areas);
    },
  });

  // ── Departments, amenities, priced services ────────────────────────────
  defineRoute(r, base, {
    method: 'put',
    path: '/departments',
    summary: 'Set the departments a hospital or clinic offers (verified separately by the platform)',
    tags,
    status: 200,
    params: P,
    body: z.object({ departmentCodes: z.array(z.string().max(64)).max(60) }),
    response: ProviderDetail,
    handler: async ({ params, body, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'providers.update', capability: 'manage_profile' });
      await admin.setDepartments(auth, params.providerId, body.departmentCodes);
      return providers.getProvider(params.providerId);
    },
  });

  defineRoute(r, base, {
    method: 'put',
    path: '/amenities',
    summary: 'Set facility amenities and capabilities',
    tags,
    status: 200,
    params: P,
    body: z.object({ amenityCodes: z.array(z.string().max(64)).max(60) }),
    response: ProviderDetail,
    handler: async ({ params, body, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'providers.update', capability: 'manage_profile' });
      await admin.setAmenities(auth, params.providerId, body.amenityCodes);
      return providers.getProvider(params.providerId);
    },
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/services',
    summary: 'My priced offerings (tests, scans, procedures, consultations)',
    tags,
    params: P,
    response: z.array(Passthrough),
    handler: async ({ params, auth }) => {
      await assertProviderMember(auth, params.providerId);
      return admin.listOfferings(params.providerId);
    },
  });

  defineRoute(r, base, {
    method: 'put',
    path: '/services/:serviceCode',
    summary: 'Create or update a priced offering from the platform catalogue',
    tags,
    status: 200,
    params: z.object({ providerId: z.uuid(), serviceCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/) }),
    body: z.object({ locationId: z.uuid().nullable().default(null), priceMinor: MoneyInput, homeServiceAvailable: z.boolean().default(false), turnaroundHours: z.number().int().min(1).max(720).optional(), isActive: z.boolean().default(true) }),
    response: z.object({ id: z.uuid() }),
    handler: async ({ params, body, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'providers.update', capability: 'manage_profile' });
      return admin.upsertOffering(auth, params.providerId, params.serviceCode, body);
    },
  });

  // ── Documents ──────────────────────────────────────────────────────────
  defineRoute(r, base, {
    method: 'get',
    path: '/documents',
    summary: 'My credential documents and their review status',
    tags,
    params: P,
    response: z.array(Passthrough),
    handler: async ({ params, auth }) => {
      await assertProviderMember(auth, params.providerId);
      return verification.listDocuments(params.providerId);
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/documents',
    summary: 'Upload a credential document (raw body: PDF, JPEG or PNG; metadata in the query string)',
    tags,
    params: P,
    query: z.object({ documentType: DocumentTypeEnum, fileName: z.string().min(1).max(255), documentNumber: z.string().max(80).optional(), issuedAt: DateString.optional(), expiresAt: DateString.optional() }),
    middleware: [express.raw({ type: ['application/pdf', 'image/jpeg', 'image/png'], limit: env.MAX_UPLOAD_BYTES })],
    response: Passthrough,
    handler: async ({ params, query, req, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'providers.update', capability: 'manage_profile' });
      if (!Buffer.isBuffer(req.body)) throw badRequest('Send the file as the raw request body with a supported Content-Type');
      return verification.uploadDocument(auth, params.providerId, req.body, { ...query, mimeType: String(req.headers['content-type']).split(';')[0]!.trim() });
    },
  });

  // ── Staff ──────────────────────────────────────────────────────────────
  defineRoute(r, base, {
    method: 'post',
    path: '/members',
    summary: 'Add staff: link an existing account by id, or invite by email / mobile',
    description: 'Invited people receive a one-time link to set their password. OWNER can only be granted by an owner.',
    tags,
    params: P,
    body: z.union([
      z.object({ userId: z.uuid(), memberRole: z.enum(['OWNER', 'ADMIN', 'STAFF', 'PHARMACIST', 'LAB_TECHNICIAN', 'DISPATCHER']) }),
      z.object({ fullName: z.string().trim().min(2).max(160), email: z.email().max(254).optional(), phone: Phone.optional(), memberRole: z.enum(['OWNER', 'ADMIN', 'STAFF', 'PHARMACIST', 'LAB_TECHNICIAN', 'DISPATCHER']) }),
    ]),
    response: ProviderDetail.extend({ invited: z.boolean() }),
    handler: async ({ params, body, auth }) => {
      const access = await assertProviderAccess(auth, params.providerId, { platformPermission: 'providers.members.manage', capability: 'manage_staff' });
      if (body.memberRole === 'OWNER' && access === 'MEMBER') {
        const me = await prisma.providerMember.findUnique({ where: { providerId_userId: { providerId: params.providerId, userId: auth.userId } }, select: { memberRole: true } });
        if (me?.memberRole !== 'OWNER') throw conflict('Only an owner can add another owner');
      }
      const { invited } = await admin.addMember(auth, params.providerId, body);
      return { ...(await providers.getProvider(params.providerId)), invited };
    },
  });

  defineRoute(r, base, {
    method: 'delete',
    path: '/members/:id',
    summary: 'Remove a staff member (the last owner cannot be removed)',
    tags,
    status: 200,
    params: PI,
    response: ProviderDetail,
    handler: async ({ params, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'providers.members.manage', capability: 'manage_staff' });
      await admin.removeMember(auth, params.providerId, params.id);
      return providers.getProvider(params.providerId);
    },
  });

  // ── Appointments (list exists in appointments module; detail + history here) ──
  defineRoute(r, base, {
    method: 'get',
    path: '/appointments/:id',
    summary: 'One appointment at my organisation, with its status history',
    tags,
    params: PI,
    response: Passthrough,
    handler: async ({ params, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'bookings.read', capability: 'manage_bookings' });
      const a = await prisma.appointment.findUnique({ where: { id: params.id }, select: { doctorProviderId: true, facilityProviderId: true } });
      if (!a || (a.doctorProviderId !== params.providerId && a.facilityProviderId !== params.providerId)) throw notFound('Appointment');
      const events = await prisma.appointmentEvent.findMany({ where: { appointmentId: params.id }, orderBy: { createdAt: 'asc' } });
      return { ...(await appts.getAppointment(params.id)), events: events.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })) };
    },
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/appointments-today',
    summary: "Today's appointments at my organisation in IST, ordered by slot time",
    tags,
    params: P,
    response: z.array(Passthrough),
    handler: async ({ params, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'bookings.read', capability: 'manage_bookings' });
      const p = await prisma.provider.findUniqueOrThrow({ where: { id: params.providerId }, select: { type: true } });
      // Today in IST, regardless of the server's zone: [start of IST day, +24h).
      const dayStart = istDayStart();
      const dayEnd = new Date(dayStart.getTime() + 86_400_000);
      const rows = await prisma.appointment.findMany({
        where: {
          ...(p.type === 'DOCTOR' ? { doctorProviderId: params.providerId } : { facilityProviderId: params.providerId }),
          status: { in: ['REQUESTED', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'NO_SHOW'] },
          slot: { startsAt: { gte: dayStart, lt: dayEnd } },
        },
        select: { id: true, slot: { select: { startsAt: true } } },
      });
      const ids = rows.sort((a, b) => a.slot.startsAt.getTime() - b.slot.startsAt.getTime()).slice(0, 500);
      return Promise.all(ids.map((x) => appts.getAppointment(x.id)));
    },
  });

  // ── Diagnostics (labs and imaging centres) ─────────────────────────────
  defineRoute(r, base, {
    kind: 'list',
    method: 'get',
    path: '/diagnostic-orders',
    summary: 'Diagnostic orders placed with my lab or centre',
    tags,
    params: P,
    query: PaginationQuery.extend({ status: z.enum(['REQUESTED', 'CONFIRMED', 'SAMPLE_COLLECTED', 'PROCESSING', 'REPORT_READY', 'COMPLETED', 'CANCELLED', 'REJECTED']).optional(), collectionMode: z.enum(['CENTRE_VISIT', 'HOME_COLLECTION']).optional() }),
    response: Passthrough,
    handler: async ({ params, query, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'diagnostics.read', capability: 'manage_bookings' });
      return listDiagnosticOrders({ providerId: params.providerId, ...(query.status ? { status: query.status } : {}), ...(query.collectionMode ? { collectionMode: query.collectionMode } : {}) }, query);
    },
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/diagnostic-orders/:id',
    summary: 'One diagnostic order (report metadata only)',
    tags,
    params: PI,
    response: Passthrough,
    handler: async ({ params, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'diagnostics.read', capability: 'manage_bookings' });
      const o = await loadDiagnosticOrder(params.id);
      if (o.provider.id !== params.providerId) throw notFound('Diagnostic order');
      return o;
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/diagnostic-orders/:id/schedule',
    summary: 'Set or move the collection / visit time',
    tags,
    status: 200,
    params: PI,
    body: z.object({ scheduledAt: DateTimeString }),
    response: Passthrough,
    handler: async ({ params, body, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'diagnostics.manage', capability: 'manage_bookings' });
      await scheduleDiagnosticOrder(params.providerId, params.id, body.scheduledAt, auth.userId);
      return loadDiagnosticOrder(params.id);
    },
  });

  // ── Pharmacy ───────────────────────────────────────────────────────────
  defineRoute(r, base, {
    method: 'get',
    path: '/inventory',
    summary: 'Stock by batch, expiring first',
    tags,
    params: P,
    query: z.object({ expiringWithinDays: z.coerce.number().int().min(1).max(365).optional(), locationId: z.uuid().optional(), q: z.string().max(100).optional() }),
    response: z.array(Passthrough),
    handler: async ({ params, query, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'pharmacy.read', capability: 'manage_inventory' });
      return listInventory(params.providerId, query);
    },
  });

  defineRoute(r, base, {
    method: 'put',
    path: '/inventory',
    summary: 'Add or correct a stock batch',
    tags,
    status: 200,
    params: P,
    body: z.object({ locationId: z.uuid(), medicineId: z.uuid(), batchNumber: z.string().trim().min(1).max(64), expiryDate: DateString, quantityOnHand: z.number().int().min(0).max(1_000_000), mrpMinor: MoneyInput, sellingPriceMinor: MoneyInput }),
    response: Passthrough,
    handler: async ({ params, body, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'pharmacy.manage', capability: 'manage_inventory' });
      return upsertInventory(auth.userId, params.providerId, body);
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/medicines',
    summary: "Add a medicine the catalogue doesn't have",
    description: 'Usable at once by this and every other pharmacy, and visible to patients (no approval step). Refused when the same name, strength and form already exist.',
    tags,
    status: 201,
    params: P,
    body: AddMedicineInput,
    response: Passthrough,
    middleware: [medicineAddLimiter],
    handler: async ({ params, body, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'pharmacy.manage', capability: 'manage_inventory' });
      if ((await prisma.provider.findUnique({ where: { id: params.providerId }, select: { type: true } }))?.type !== 'PHARMACY') throw badRequest('Only pharmacies add medicines');
      return addProviderMedicine(params.providerId, auth.userId, body);
    },
  });

  defineRoute(r, base, {
    kind: 'list',
    method: 'get',
    path: '/pharmacy-orders',
    summary: 'Medicine orders placed with my pharmacy',
    tags,
    params: P,
    query: PaginationQuery.extend({ status: z.enum(['PLACED', 'PRESCRIPTION_REVIEW', 'ACCEPTED', 'REJECTED', 'PREPARING', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'RETURNED']).optional() }),
    response: Passthrough,
    handler: async ({ params, query, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'pharmacy.read', capability: 'manage_bookings' });
      return listPharmacyOrders({ providerId: params.providerId, ...(query.status ? { status: query.status } : {}) }, query);
    },
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/pharmacy-orders/:id',
    summary: 'One medicine order',
    tags,
    params: PI,
    response: Passthrough,
    handler: async ({ params, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'pharmacy.read', capability: 'manage_bookings' });
      const o = await loadPharmacyOrder(params.id);
      if (o.provider.id !== params.providerId) throw notFound('Pharmacy order');
      return o;
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/pharmacy-orders/:id/status',
    summary: 'Accept, prepare, hand over, deliver, reject or cancel an order (stock moves with it)',
    tags,
    status: 200,
    params: PI,
    body: z.object({ status: z.enum(['PRESCRIPTION_REVIEW', 'ACCEPTED', 'REJECTED', 'PREPARING', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'RETURNED']), reason: z.string().max(1000).optional() }),
    response: Passthrough,
    handler: async ({ params, body, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'pharmacy.manage', capability: 'manage_bookings' });
      const o = await prisma.pharmacyOrder.findUnique({ where: { id: params.id }, select: { providerId: true } });
      if (!o || o.providerId !== params.providerId) throw notFound('Pharmacy order');
      await advancePharmacyOrder(params.id, body.status, auth.userId, body.reason);
      return loadPharmacyOrder(params.id);
    },
  });

  defineRoute(r, base, {
    kind: 'list',
    method: 'get',
    path: '/prescriptions',
    summary: 'Prescriptions attached to orders at my pharmacy, pending review first',
    tags,
    params: P,
    query: PaginationQuery.extend({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional() }),
    response: Passthrough,
    handler: async ({ params, query, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'pharmacy.read', capability: 'review_prescriptions' });
      const rows = await prisma.prescription.findMany({
        where: { pharmacyOrders: { some: { providerId: params.providerId } }, ...(query.status ? { reviewStatus: query.status } : {}), ...cursorWhere(query.cursor) },
        include: { patient: { select: { id: true, fullName: true } }, pharmacyOrders: { where: { providerId: params.providerId }, select: { id: true, reference: true, status: true } } },
        orderBy: cursorOrderBy(),
        take: query.limit + 1,
      });
      const { items, page } = buildPage(rows, query.limit, (x) => x.createdAt);
      return { page, items: items.map((p) => ({ id: p.id, patient: p.patient, reviewStatus: p.reviewStatus, reviewNote: p.reviewNote, reviewedAt: iso(p.reviewedAt), issuedOn: p.issuedOn ? p.issuedOn.toISOString().slice(0, 10) : null, validUntil: p.validUntil ? p.validUntil.toISOString().slice(0, 10) : null, orders: p.pharmacyOrders, createdAt: p.createdAt.toISOString() })) };
    },
  });

  // ── Ambulance operators: fleet and crew ────────────────────────────────
  defineRoute(r, base, {
    method: 'get',
    path: '/vehicles',
    summary: 'My ambulances',
    tags,
    params: P,
    response: z.array(Passthrough),
    handler: async ({ params, auth }) => {
      await assertProviderMember(auth, params.providerId, 'ambulance.read');
      return listVehicles(params.providerId);
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/vehicles',
    summary: 'Register an ambulance (verified by the platform before it can be dispatched)',
    tags,
    params: P,
    body: VehicleInput,
    response: Passthrough,
    handler: async ({ params, body, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'ambulance.manage', capability: 'manage_profile' });
      return registerVehicle(auth.userId, params.providerId, body);
    },
  });


  // ── Vehicle availability (operator-controlled, never bypasses verification) ─
  defineRoute(r, base, {
    method: 'post',
    path: '/vehicles/:vehicleId/status',
    summary: 'Take a verified vehicle off the road or put it back in service',
    description: 'Only vehicles the platform has verified can be made AVAILABLE, and only while the operator is approved and the insurance/fitness documents are current. A vehicle on a trip cannot be changed.',
    tags,
    status: 200,
    params: z.object({ providerId: z.uuid(), vehicleId: z.uuid() }),
    body: z.object({ status: z.enum(['AVAILABLE', 'OUT_OF_SERVICE']), reason: z.string().trim().max(500).optional() }),
    response: z.object({ id: z.uuid(), status: z.string() }).passthrough(),
    handler: async ({ params, body, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'ambulance.manage', capability: 'manage_dispatch' });
      return prisma.$transaction(async (tx) => {
        const v = await tx.ambulanceVehicle.findFirst({ where: { id: params.vehicleId, operatorProviderId: params.providerId }, include: { operator: { select: { status: true } } } });
        if (!v) throw notFound('Vehicle');
        if (v.status === 'ON_TRIP') throw conflict('The vehicle is on a trip; finish the trip first');
        if (v.status === 'SUSPENDED' || v.status === 'PENDING_VERIFICATION' || !v.verifiedAt) throw preconditionFailed('Only vehicles verified by the platform can be managed here');
        if (body.status === 'AVAILABLE') {
          if (v.operator.status !== 'APPROVED') throw preconditionFailed('Your organisation is not approved');
          const now = new Date();
          if ((v.insuranceValidUntil && v.insuranceValidUntil < now) || (v.fitnessValidUntil && v.fitnessValidUntil < now)) throw preconditionFailed('Insurance or fitness has expired; update the documents first');
        }
        if (v.status === body.status) return { id: v.id, status: v.status };
        const updated = await tx.ambulanceVehicle.update({ where: { id: v.id }, data: { status: body.status } });
        await audit(tx, { action: 'ambulance.vehicle_status', entityType: 'ambulance_vehicle', entityId: v.id, actorUserId: auth.userId, metadata: { from: v.status, to: body.status, reason: body.reason, by: 'OPERATOR' } });
        return { id: updated.id, status: updated.status };
      });
    },
  });

  // ── Incident on a trip → support case for the platform team ────────────
  defineRoute(r, base, {
    method: 'post',
    path: '/dispatch/requests/:requestId/incident',
    summary: 'Report an incident on a trip this operator accepted (breakdown, delay, patient condition, dispute)',
    tags,
    status: 201,
    params: z.object({ providerId: z.uuid(), requestId: z.uuid() }),
    body: z.object({ category: z.enum(['VEHICLE_BREAKDOWN', 'DELAY', 'PATIENT_CONDITION', 'HANDOVER_DISPUTE', 'SAFETY', 'OTHER']), description: z.string().trim().min(10).max(5000) }),
    response: z.object({ id: z.uuid(), reference: z.string() }),
    handler: async ({ params, body, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'ambulance.manage', capability: 'manage_dispatch' });
      const a = await prisma.dispatchAssignment.findFirst({ where: { requestId: params.requestId, operatorProviderId: params.providerId, status: { in: ['ACCEPTED', 'COMPLETED'] } }, include: { request: { select: { status: true, reference: true, transaction: { select: { id: true } } } } } });
      if (!a) throw notFound('Trip');
      return prisma.$transaction(async (tx) => {
        const c = await tx.supportCase.create({
          data: {
            reference: makeReference(REF.supportCase), type: 'PROVIDER_REPORT', category: `AMBULANCE_${body.category}`, priority: body.category === 'SAFETY' || body.category === 'PATIENT_CONDITION' ? 'URGENT' : 'HIGH',
            subject: `Incident on trip ${a.request.reference}`, description: body.description, reporterUserId: auth.userId, providerId: params.providerId, transactionId: a.request.transaction?.id, createdById: auth.userId,
            slaDueAt: new Date(Date.now() + 4 * 3_600_000),
          },
        });
        await tx.supportCaseEvent.create({ data: { caseId: c.id, authorId: auth.userId, kind: 'STATUS_CHANGE', body: 'Incident reported by the ambulance operator', metadata: { to: 'OPEN', requestId: params.requestId } } });
        await tx.dispatchEvent.create({ data: { requestId: params.requestId, fromStatus: a.request.status, toStatus: a.request.status, actorUserId: auth.userId, actorKind: 'OPERATOR', note: `Incident reported (${body.category}): case ${c.reference}` } });
        await audit(tx, { action: 'dispatch.incident_reported', entityType: 'dispatch_request', entityId: params.requestId, actorUserId: auth.userId, metadata: { caseId: c.id, category: body.category } });
        return { id: c.id, reference: c.reference };
      });
    },
  });

  // ── Refund request raised by the provider ──────────────────────────────
  defineRoute(r, base, {
    method: 'post',
    path: '/finance/transactions/:transactionId/refund-request',
    summary: 'Ask the platform to refund a paid transaction (service not delivered, overcharge, duplicate)',
    tags,
    status: 201,
    params: z.object({ providerId: z.uuid(), transactionId: z.uuid() }),
    body: z.object({ reason: z.string().trim().min(10).max(2000), amountMinor: MoneyInput.optional() }),
    response: z.object({ id: z.uuid(), reference: z.string() }),
    handler: async ({ params, body, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'finance.refunds.request', capability: 'view_finance' });
      const t = await prisma.serviceTransaction.findFirst({ where: { id: params.transactionId, providerId: params.providerId } });
      if (!t) throw notFound('Transaction');
      if (t.status !== 'PAID' && t.status !== 'PARTIALLY_REFUNDED') throw preconditionFailed('Only paid transactions can be refunded');
      const refundable = t.grossMinor - t.refundedMinor;
      if (body.amountMinor != null && BigInt(body.amountMinor) > refundable) throw badRequest(`At most ${Number(refundable) / 100} can still be refunded`);
      const open = await prisma.supportCase.count({ where: { transactionId: t.id, type: 'REFUND_REQUEST', status: { in: ['OPEN', 'IN_PROGRESS', 'AWAITING_REPORTER', 'ESCALATED'] } } });
      if (open) throw conflict('A refund request for this transaction is already open');
      return prisma.$transaction(async (tx) => {
        const c = await tx.supportCase.create({
          data: {
            reference: makeReference(REF.supportCase), type: 'REFUND_REQUEST', category: 'PROVIDER_REFUND_REQUEST', priority: 'MEDIUM', subject: `Refund request for ${t.reference}`,
            description: `${body.reason}\n\nAmount requested: ${body.amountMinor != null ? `Rs ${(body.amountMinor / 100).toFixed(2)}` : 'full'}`, reporterUserId: auth.userId, providerId: params.providerId, transactionId: t.id, createdById: auth.userId,
            slaDueAt: new Date(Date.now() + 72 * 3_600_000),
          },
        });
        await tx.supportCaseEvent.create({ data: { caseId: c.id, authorId: auth.userId, kind: 'STATUS_CHANGE', body: 'Refund requested by the provider', metadata: { to: 'OPEN', amountMinor: body.amountMinor ?? null } } });
        await audit(tx, { action: 'refund.requested_by_provider', entityType: 'service_transaction', entityId: t.id, actorUserId: auth.userId, metadata: { caseId: c.id, amountMinor: body.amountMinor ?? null } });
        return { id: c.id, reference: c.reference };
      });
    },
  });

  // ── Activity per day for charts ────────────────────────────────────────
  defineRoute(r, base, {
    method: 'get',
    path: '/analytics/daily',
    summary: 'Activity per day for the period: bookings (or orders / trips), completions, cancellations and completed gross',
    tags,
    params: P,
    query: Range,
    response: z.object({ kind: z.enum(['appointments', 'diagnostic_orders', 'pharmacy_orders', 'trips']), series: z.array(z.object({ date: z.string(), total: z.number().int(), completed: z.number().int(), cancelled: z.number().int(), grossMinor: z.number().int() })) }),
    handler: async ({ params, query, auth }) => {
      await assertProviderMember(auth, params.providerId, 'analytics.read');
      const p = await prisma.provider.findUniqueOrThrow({ where: { id: params.providerId }, select: { type: true } });
      const id = params.providerId;
      type Row = { date: string; total: number | bigint; completed: number | bigint; cancelled: number | bigint; gross: number | bigint | null };
      const range = { $gte: ejsonDate(query.from), $lt: ejsonDate(query.to) };
      const eq = (field: string, v: string) => ({ $eq: [field, v] });
      const oneOf = (field: string, vs: string[]) => ({ $in: [field, vs] });
      /** Group by IST calendar day (as `(created_at AT TIME ZONE 'Asia/Kolkata')::date` did), counting conditionally like `count(*) FILTER (WHERE ...)`. */
      const perDay = (collection: string, prefix: Record<string, unknown>[], match: Record<string, unknown>, completed: Record<string, unknown>, cancelled: Record<string, unknown>, grossField: string) =>
        aggregate<Row>(prisma, collection, [
          { $match: { ...match, created_at: range } },
          ...prefix,
          {
            $group: {
              _id: { $dateToString: { date: '$created_at', format: '%Y-%m-%d', timezone: 'Asia/Kolkata' } },
              total: { $sum: 1 },
              completed: { $sum: { $cond: [completed, 1, 0] } },
              cancelled: { $sum: { $cond: [cancelled, 1, 0] } },
              gross: { $sum: { $cond: [completed, grossField, 0] } },
            },
          },
          { $sort: { _id: 1 } },
          { $project: { _id: 0, date: '$_id', total: 1, completed: 1, cancelled: 1, gross: 1 } },
        ]);
      const apptCancelled = { $or: [{ $regexMatch: { input: '$status', regex: '^CANCELLED' } }, oneOf('$status', ['REJECTED', 'NO_SHOW'])] };
      let kind: 'appointments' | 'diagnostic_orders' | 'pharmacy_orders' | 'trips';
      let rows: Row[];
      if (p.type === 'DIAGNOSTIC_LAB' || p.type === 'IMAGING_CENTRE') {
        kind = 'diagnostic_orders';
        rows = await perDay('diagnostic_orders', [], { provider_id: id }, eq('$status', 'COMPLETED'), oneOf('$status', ['CANCELLED', 'REJECTED']), '$total_minor');
      } else if (p.type === 'PHARMACY') {
        kind = 'pharmacy_orders';
        rows = await perDay('pharmacy_orders', [], { provider_id: id }, eq('$status', 'DELIVERED'), oneOf('$status', ['CANCELLED', 'REJECTED', 'RETURNED']), '$total_minor');
      } else if (p.type === 'AMBULANCE_OPERATOR') {
        kind = 'trips';
        // Requests this operator accepted (inner join on the assignment), with the request's transaction if any (left join).
        rows = await perDay('dispatch_requests', [
          { $lookup: { from: 'dispatch_assignments', localField: '_id', foreignField: 'request_id', as: 'a' } },
          { $unwind: '$a' },
          { $match: { 'a.operator_provider_id': id, 'a.status': { $in: ['ACCEPTED', 'COMPLETED'] } } },
          { $lookup: { from: 'service_transactions', localField: '_id', foreignField: 'dispatch_request_id', as: 't' } },
          { $unwind: { path: '$t', preserveNullAndEmptyArrays: true } },
        ], {}, eq('$status', 'COMPLETED'), eq('$status', 'CANCELLED'), '$t.gross_minor');
      } else if (p.type === 'DOCTOR') {
        kind = 'appointments';
        rows = await perDay('appointments', [], { doctor_provider_id: id }, eq('$status', 'COMPLETED'), apptCancelled, '$fee_minor');
      } else {
        kind = 'appointments';
        rows = await perDay('appointments', [], { facility_provider_id: id }, eq('$status', 'COMPLETED'), apptCancelled, '$fee_minor');
      }
      return { kind, series: rows.map((x) => ({ date: x.date, total: num(x.total), completed: num(x.completed), cancelled: num(x.cancelled), grossMinor: num(x.gross) })) };
    },
  });
  defineRoute(r, base, {
    method: 'get',
    path: '/crew',
    summary: 'My drivers and medical crew',
    tags,
    params: P,
    response: z.array(Passthrough),
    handler: async ({ params, auth }) => {
      await assertProviderMember(auth, params.providerId, 'ambulance.read');
      return listCrew(params.providerId);
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/crew',
    summary: 'Add a crew member',
    tags,
    params: P,
    body: CrewInput,
    response: Passthrough,
    handler: async ({ params, body, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'ambulance.manage', capability: 'manage_profile' });
      return addCrew(auth.userId, params.providerId, body);
    },
  });

  // ── Finance (read-only for providers) ──────────────────────────────────
  defineRoute(r, base, {
    method: 'get',
    path: '/finance/summary',
    summary: 'What the platform owes me, what is unsettled, and this period\'s gross and commission',
    tags,
    params: P,
    query: Range,
    response: z.object({ balanceMinor: z.number().int(), unsettledMinor: z.number().int(), period: z.object({ from: z.string(), to: z.string(), grossMinor: z.number().int(), refundedMinor: z.number().int(), commissionMinor: z.number().int(), completedTransactions: z.number().int() }), lastPayout: z.object({ amountMinor: z.number().int(), paidAt: z.string().nullable(), reference: z.string().nullable() }).nullable() }),
    handler: async ({ params, query, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'finance.read', capability: 'view_finance' });
      const completedIn = { providerId: params.providerId, serviceCompletedAt: { gte: query.from, lt: query.to } };
      const [bal, txns, commission, lastPayout] = await Promise.all([
        settlements.providerBalance(params.providerId),
        prisma.serviceTransaction.aggregate({ _sum: { grossMinor: true, refundedMinor: true }, _count: { _all: true }, where: completedIn }),
        // FINAL snapshots of those transactions (the former LEFT JOIN ... AND c.status = 'FINAL').
        prisma.commissionSnapshot.aggregate({ _sum: { commissionMinor: true }, where: { status: 'FINAL', transaction: completedIn } }),
        prisma.settlementItem.findFirst({ where: { providerId: params.providerId, status: 'PAID' }, orderBy: { paidAt: 'desc' } }),
      ]);
      return {
        balanceMinor: minor(bal.balanceMinor)!,
        unsettledMinor: minor(bal.unsettledMinor)!,
        period: { from: query.from.toISOString(), to: query.to.toISOString(), grossMinor: Number(txns._sum.grossMinor ?? 0), refundedMinor: Number(txns._sum.refundedMinor ?? 0), commissionMinor: Number(commission._sum.commissionMinor ?? 0), completedTransactions: txns._count._all },
        lastPayout: lastPayout ? { amountMinor: minor(lastPayout.amountMinor)!, paidAt: iso(lastPayout.paidAt), reference: lastPayout.payoutReference } : null,
      };
    },
  });

  defineRoute(r, base, {
    kind: 'list',
    method: 'get',
    path: '/finance/transactions',
    summary: 'My service transactions',
    tags,
    params: P,
    query: PaginationQuery.extend({ status: z.enum(['PENDING_PAYMENT', 'PAID', 'PAY_AT_PROVIDER', 'PARTIALLY_REFUNDED', 'REFUNDED', 'CANCELLED']).optional() }),
    response: Passthrough,
    handler: async ({ params, query, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'finance.read', capability: 'view_finance' });
      const rows = await prisma.serviceTransaction.findMany({ where: { providerId: params.providerId, ...(query.status ? { status: query.status } : {}), ...cursorWhere(query.cursor) }, include: { provider: { select: { id: true, displayName: true, type: true } } }, orderBy: cursorOrderBy(), take: query.limit + 1 });
      const { items, page } = buildPage(rows, query.limit, (t) => t.createdAt);
      return { items: items.map(txnDto), page };
    },
  });

  defineRoute(r, base, {
    kind: 'list',
    method: 'get',
    path: '/finance/ledger',
    summary: 'My ledger: earnings, commission, refunds and payouts',
    tags,
    params: P,
    query: PaginationQuery,
    response: Passthrough,
    handler: async ({ params, query, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'finance.read', capability: 'view_finance' });
      const rows = await prisma.providerLedgerEntry.findMany({ where: { providerId: params.providerId, ...cursorWhere(query.cursor) }, orderBy: cursorOrderBy(), take: query.limit + 1 });
      const { items, page } = buildPage(rows, query.limit, (e) => e.createdAt);
      return { page, items: items.map((e) => ({ id: e.id, entryType: e.entryType, amountMinor: minor(e.amountMinor)!, transactionId: e.transactionId, settlementItemId: e.settlementItemId, description: e.description, createdAt: e.createdAt.toISOString() })) };
    },
  });

  defineRoute(r, base, {
    kind: 'list',
    method: 'get',
    path: '/finance/settlements',
    summary: 'Payouts made to me',
    tags,
    params: P,
    query: PaginationQuery,
    response: Passthrough,
    handler: async ({ params, query, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'finance.read', capability: 'view_finance' });
      const rows = await prisma.settlementItem.findMany({ where: { providerId: params.providerId, ...cursorWhere(query.cursor) }, include: { batch: { select: { reference: true, status: true, periodEnd: true } } }, orderBy: cursorOrderBy(), take: query.limit + 1 });
      const { items, page } = buildPage(rows, query.limit, (i) => i.createdAt);
      return { page, items: items.map((i) => ({ id: i.id, batchReference: i.batch.reference, batchStatus: i.batch.status, periodEnd: i.batch.periodEnd.toISOString(), amountMinor: minor(i.amountMinor)!, status: i.status, payoutReference: i.payoutReference, paidAt: iso(i.paidAt), failureReason: i.failureReason, createdAt: i.createdAt.toISOString() })) };
    },
  });

  // ── Analytics ──────────────────────────────────────────────────────────
  defineRoute(r, base, {
    method: 'get',
    path: '/analytics',
    summary: 'My activity for a period: bookings by status, completion and cancellation rates, orders, revenue',
    tags,
    params: P,
    query: Range,
    response: z.object({
      period: z.object({ from: z.string(), to: z.string() }),
      appointments: z.object({ byStatus: z.record(z.string(), z.number().int()), total: z.number().int(), completionRate: z.number().nullable(), cancellationRate: z.number().nullable(), noShowRate: z.number().nullable(), upcoming: z.number().int() }),
      diagnosticOrders: z.record(z.string(), z.number().int()),
      pharmacyOrders: z.record(z.string(), z.number().int()),
      revenue: z.object({ grossMinor: z.number().int(), completedTransactions: z.number().int() }),
      rating: z.object({ average: z.number().nullable(), count: z.number().int() }),
    }),
    handler: async ({ params, query, auth }) => {
      await assertProviderMember(auth, params.providerId, 'analytics.read');
      const p = await prisma.provider.findUniqueOrThrow({ where: { id: params.providerId }, select: { type: true, ratingAverage: true, ratingCount: true } });
      const apptWhere = p.type === 'DOCTOR' ? { doctorProviderId: params.providerId } : { facilityProviderId: params.providerId };
      const [appt, upcoming, dx, rx, rev] = await Promise.all([
        prisma.appointment.groupBy({ by: ['status'], _count: { _all: true }, where: { ...apptWhere, createdAt: { gte: query.from, lt: query.to } } }),
        prisma.appointment.count({ where: { ...apptWhere, status: { in: ['REQUESTED', 'CONFIRMED'] }, slot: { startsAt: { gte: new Date() } } } }),
        prisma.diagnosticOrder.groupBy({ by: ['status'], _count: { _all: true }, where: { providerId: params.providerId, createdAt: { gte: query.from, lt: query.to } } }),
        prisma.pharmacyOrder.groupBy({ by: ['status'], _count: { _all: true }, where: { providerId: params.providerId, createdAt: { gte: query.from, lt: query.to } } }),
        prisma.serviceTransaction.aggregate({ _sum: { grossMinor: true }, _count: { _all: true }, where: { providerId: params.providerId, serviceCompletedAt: { gte: query.from, lt: query.to } } }),
      ]);
      const byStatus = Object.fromEntries(appt.map((x) => [x.status, x._count._all]));
      const total = appt.reduce((s, x) => s + x._count._all, 0);
      const n = (k: string) => byStatus[k] ?? 0;
      const rate = (v: number) => (total ? Math.round((v / total) * 1000) / 10 : null);
      return {
        period: { from: query.from.toISOString(), to: query.to.toISOString() },
        appointments: { byStatus, total, completionRate: rate(n('COMPLETED')), cancellationRate: rate(n('CANCELLED_BY_PATIENT') + n('CANCELLED_BY_PROVIDER') + n('CANCELLED_BY_PLATFORM')), noShowRate: rate(n('NO_SHOW')), upcoming },
        diagnosticOrders: Object.fromEntries(dx.map((x) => [x.status, x._count._all])),
        pharmacyOrders: Object.fromEntries(rx.map((x) => [x.status, x._count._all])),
        revenue: { grossMinor: Number(rev._sum.grossMinor ?? 0n), completedTransactions: rev._count._all },
        rating: { average: p.ratingAverage ? Number(p.ratingAverage) : null, count: p.ratingCount },
      };
    },
  });

  // ── Scheduling (facility-aware) ────────────────────────────────────────
  /** Staff may schedule for their own doctor practice, or for doctors actively affiliated with their facility. */
  async function assertCanSchedule(auth: AuthContext, providerId: string, doctorProviderId: string) {
    if (providerId === doctorProviderId) {
      if ((await getOwnDoctorProviderId(auth)) === doctorProviderId) return;
      await assertProviderAccess(auth, providerId, { platformPermission: 'schedules.manage', capability: 'manage_schedules' });
      return;
    }
    await assertProviderAccess(auth, providerId, { platformPermission: 'schedules.manage', capability: 'manage_schedules' });
    const active = await prisma.doctorAffiliation.count({ where: { doctorProviderId, facilityProviderId: providerId, status: 'ACTIVE' } });
    if (!active) throw notFound('Doctor is not affiliated with this facility');
  }

  defineRoute(r, base, {
    method: 'get',
    path: '/doctors',
    summary: 'Doctors I can schedule for: myself (doctor practice) or doctors actively affiliated with my facility',
    tags,
    params: P,
    response: z.array(z.object({ doctorProviderId: z.uuid(), displayName: z.string(), affiliationId: z.uuid().nullable(), department: z.string().nullable(), departmentCode: z.string().nullable(), specialities: z.array(z.string()), engagementType: z.string().nullable(), consultationFeeMinor: z.number().int().nullable(), locationId: z.uuid().nullable() })),
    handler: async ({ params, auth }) => {
      await assertProviderMember(auth, params.providerId);
      const specs = { doctorProfile: { select: { specialities: { where: { verified: true }, orderBy: { isPrimary: 'desc' as const }, select: { speciality: { select: { name: true } } } } } } };
      const p = await prisma.provider.findUniqueOrThrow({ where: { id: params.providerId }, select: { type: true, displayName: true, ...specs } });
      if (p.type === 'DOCTOR') return [{ doctorProviderId: params.providerId, displayName: p.displayName, affiliationId: null, department: null, departmentCode: null, specialities: p.doctorProfile?.specialities.map((s) => s.speciality.name) ?? [], engagementType: null, consultationFeeMinor: null, locationId: null }];
      const rows = await prisma.doctorAffiliation.findMany({ where: { facilityProviderId: params.providerId, status: 'ACTIVE' }, include: { doctor: { select: { displayName: true, ...specs } }, department: { select: { code: true, name: true } } }, orderBy: { doctor: { displayName: 'asc' } } });
      return rows.map((a) => ({ doctorProviderId: a.doctorProviderId, displayName: a.doctor.displayName, affiliationId: a.id, department: a.department?.name ?? null, departmentCode: a.department?.code ?? null, specialities: a.doctor.doctorProfile?.specialities.map((s) => s.speciality.name) ?? [], engagementType: a.engagementType, consultationFeeMinor: minor(a.consultationFeeMinor), locationId: a.locationId }));
    },
  });

  // ── One doctor in full, as a facility is allowed to see them ───────────
  defineRoute(r, base, {
    method: 'get',
    path: '/doctors/:doctorProviderId',
    summary: 'Professional profile of a doctor affiliated with my facility (or my own practice): specialities, qualifications, registration, experience, other affiliations, and how they work here',
    tags,
    params: z.object({ providerId: z.uuid(), doctorProviderId: z.uuid() }),
    response: Passthrough,
    handler: async ({ params, auth }) => {
      await assertProviderMember(auth, params.providerId);
      const own = params.providerId === params.doctorProviderId;
      // Only doctors with a live or past relationship to this facility are visible; anything else is a 404, not a directory.
      const here = own ? null : await prisma.doctorAffiliation.findFirst({ where: { doctorProviderId: params.doctorProviderId, facilityProviderId: params.providerId, status: { in: ['INVITED', 'REQUESTED', 'PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'ENDED'] } }, orderBy: { createdAt: 'desc' }, include: { department: { select: { name: true } }, location: { select: { name: true } } } });
      if (!own && !here) throw notFound('Doctor');
      const d = await prisma.provider.findFirst({
        where: { id: params.doctorProviderId, type: 'DOCTOR' },
        include: {
          doctorProfile: { include: { specialities: { include: { speciality: { select: { code: true, name: true } } }, orderBy: { isPrimary: 'desc' } }, qualifications: { orderBy: { yearAwarded: 'asc' } }, registrations: true } },
          locations: { where: { isActive: true }, select: { name: true, city: true, district: true } },
          doctorAffiliations: { where: { status: { in: ['ACTIVE', 'PENDING_VERIFICATION', 'SUSPENDED'] } }, include: { facility: { select: { displayName: true, type: true } }, department: { select: { name: true } } } },
        },
      });
      if (!d) throw notFound('Doctor');
      const [activeSchedules, upcoming, completed] = here ? await Promise.all([
        prisma.doctorSchedule.count({ where: { affiliationId: here.id, isActive: true } }),
        prisma.appointment.count({ where: { doctorProviderId: d.id, facilityProviderId: params.providerId, status: { in: ['REQUESTED', 'CONFIRMED'] }, slot: { startsAt: { gte: new Date() } } } }),
        prisma.appointment.count({ where: { doctorProviderId: d.id, facilityProviderId: params.providerId, status: 'COMPLETED' } }),
      ]) : [0, 0, 0];
      return {
        id: d.id, displayName: d.displayName, status: d.status, gender: d.doctorProfile?.gender ?? null, yearsOfExperience: d.doctorProfile?.yearsOfExperience ?? null, languages: d.doctorProfile?.languages ?? [], bio: d.doctorProfile?.bio ?? null, defaultFeeMinor: minor(d.doctorProfile?.defaultFeeMinor ?? null),
        rating: { average: d.ratingAverage ? Number(d.ratingAverage) : null, count: d.ratingCount },
        specialities: d.doctorProfile?.specialities.map((s) => ({ code: s.speciality.code, name: s.speciality.name, isPrimary: s.isPrimary, verified: s.verified })) ?? [],
        qualifications: d.doctorProfile?.qualifications.map((q) => ({ degree: q.degree, institution: q.institution, yearAwarded: q.yearAwarded, verified: q.verified })) ?? [],
        registrations: d.doctorProfile?.registrations.map((x) => ({ council: x.council, registrationNumber: x.registrationNumber, registrationYear: x.registrationYear, validUntil: x.validUntil ? x.validUntil.toISOString().slice(0, 10) : null, verified: !!x.verifiedAt })) ?? [],
        practiceLocations: d.locations,
        affiliations: d.doctorAffiliations.map((a) => ({ facility: a.facility.displayName, type: a.facility.type, status: a.status, department: a.department?.name ?? null, engagementType: a.engagementType, isHere: a.facilityProviderId === params.providerId })),
        here: here ? { affiliationId: here.id, status: here.status, department: here.department?.name ?? null, roleTitle: here.roleTitle, engagementType: here.engagementType, consultationFeeMinor: minor(here.consultationFeeMinor), startDate: here.startDate ? here.startDate.toISOString().slice(0, 10) : null, location: here.location?.name ?? null, activeSchedules, upcomingAppointments: upcoming, completedAppointments: completed } : null,
      };
    },
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/schedules',
    summary: 'Weekly schedule templates at my organisation (optionally one doctor)',
    tags,
    params: P,
    query: z.object({ doctorProviderId: z.uuid().optional() }),
    response: z.array(Passthrough),
    handler: async ({ params, query, auth }) => {
      await assertProviderMember(auth, params.providerId);
      const p = await prisma.provider.findUniqueOrThrow({ where: { id: params.providerId }, select: { type: true } });
      const where = p.type === 'DOCTOR' ? { doctorProviderId: params.providerId } : { location: { providerId: params.providerId }, ...(query.doctorProviderId ? { doctorProviderId: query.doctorProviderId } : {}) };
      const rows = await prisma.doctorSchedule.findMany({ where, include: { location: { select: { name: true } }, doctor: { select: { displayName: true } } }, orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }] });
      return rows.map((s) => ({ id: s.id, doctorProviderId: s.doctorProviderId, doctorName: s.doctor.displayName, locationId: s.locationId, locationName: s.location.name, dayOfWeek: s.dayOfWeek, startMinute: s.startMinute, endMinute: s.endMinute, slotMinutes: s.slotMinutes, capacityPerSlot: s.capacityPerSlot, feeMinor: minor(s.feeMinor), validFrom: s.validFrom.toISOString().slice(0, 10), validTo: s.validTo ? s.validTo.toISOString().slice(0, 10) : null, isActive: s.isActive }));
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/schedules',
    summary: 'Create a weekly schedule for a doctor at one of my locations',
    tags,
    params: P,
    body: z.object({ doctorProviderId: z.uuid(), locationId: z.uuid(), dayOfWeek: z.number().int().min(0).max(6), startMinute: z.number().int().min(0).max(1439), endMinute: z.number().int().min(1).max(1440), slotMinutes: z.number().int().min(5).max(240), capacityPerSlot: z.number().int().min(1).max(200).default(1), feeMinor: MoneyInput.optional(), validFrom: DateString, validTo: DateString.optional() }),
    response: Passthrough,
    handler: async ({ params, body, auth }) => {
      await assertCanSchedule(auth, params.providerId, body.doctorProviderId);
      const loc = await prisma.providerLocation.findFirst({ where: { id: body.locationId, isActive: true }, select: { providerId: true } });
      if (!loc) throw notFound('Location');
      // A doctor may schedule at their own chambers or at the facility; facility staff only at the facility's locations.
      if (loc.providerId !== params.providerId) throw badRequest('Location does not belong to this organisation');
      return sched.createSchedule(auth, body);
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/schedules/:id/deactivate',
    summary: 'Stop a schedule template (slots already generated stay bookable; block them if needed)',
    tags,
    status: 200,
    params: PI,
    response: Passthrough,
    handler: async ({ params, auth }) => {
      const s = await prisma.doctorSchedule.findUnique({ where: { id: params.id }, include: { location: { select: { providerId: true } } } });
      if (!s || (s.location.providerId !== params.providerId && s.doctorProviderId !== params.providerId)) throw notFound('Schedule');
      await assertCanSchedule(auth, params.providerId, s.doctorProviderId);
      const updated = await prisma.doctorSchedule.update({ where: { id: s.id }, data: { isActive: false } });
      await audit(prisma, { action: 'schedule.deactivated', entityType: 'doctor_schedule', entityId: s.id, actorUserId: auth.userId });
      return sched.scheduleDto(updated);
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/schedules/:id/generate-slots',
    summary: 'Open bookable slots from a schedule for a date range (up to 62 days)',
    tags,
    status: 200,
    params: PI,
    body: z.object({ from: DateString, to: DateString }),
    response: z.object({ created: z.number().int(), skipped: z.number().int() }),
    handler: async ({ params, body, auth }) => {
      const s = await prisma.doctorSchedule.findUnique({ where: { id: params.id }, include: { location: { select: { providerId: true } } } });
      if (!s || (s.location.providerId !== params.providerId && s.doctorProviderId !== params.providerId)) throw notFound('Schedule');
      await assertCanSchedule(auth, params.providerId, s.doctorProviderId);
      return sched.generateSlots(auth, params.id, body.from, body.to);
    },
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/slots',
    summary: 'Slots at my organisation in a date range, with how many are booked',
    tags,
    params: P,
    query: z.object({ doctorProviderId: z.uuid().optional(), locationId: z.uuid().optional(), from: DateTimeString, to: DateTimeString, status: z.enum(['OPEN', 'BLOCKED', 'CANCELLED']).optional() }),
    response: z.array(Passthrough),
    handler: async ({ params, query, auth }) => {
      await assertProviderMember(auth, params.providerId, 'bookings.read');
      const from = new Date(query.from); const to = new Date(query.to);
      if (to <= from || to.getTime() - from.getTime() > 62 * 86_400_000) throw badRequest('Range must be positive and at most 62 days');
      const p = await prisma.provider.findUniqueOrThrow({ where: { id: params.providerId }, select: { type: true } });
      const rows = await prisma.appointmentSlot.findMany({
        where: { ...(p.type === 'DOCTOR' ? { doctorProviderId: params.providerId } : { location: { providerId: params.providerId } }), ...(query.doctorProviderId ? { doctorProviderId: query.doctorProviderId } : {}), ...(query.locationId ? { locationId: query.locationId } : {}), ...(query.status ? { status: query.status } : {}), startsAt: { gte: from, lt: to } },
        include: { location: { select: { name: true } }, doctor: { select: { displayName: true } } },
        orderBy: { startsAt: 'asc' },
        take: 2000,
      });
      return rows.map((s) => ({ ...sched.slotDto(s), doctorName: s.doctor.displayName }));
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/slots/:id/status',
    summary: 'Block a slot (e.g. doctor on leave) or reopen it; booked slots cannot be blocked',
    tags,
    status: 200,
    params: PI,
    body: z.object({ status: z.enum(['OPEN', 'BLOCKED']) }),
    response: Passthrough,
    handler: async ({ params, body, auth }) => {
      const s = await prisma.appointmentSlot.findUnique({ where: { id: params.id }, include: { location: { select: { providerId: true } } } });
      if (!s || (s.location.providerId !== params.providerId && s.doctorProviderId !== params.providerId)) throw notFound('Slot');
      await assertCanSchedule(auth, params.providerId, s.doctorProviderId);
      return sched.setSlotStatus(auth, params.id, body.status);
    },
  });

  // ── Reference lists for provider staff (read-only, no platform permission needed) ──
  const cat = '/portal/catalogue';
  defineRoute(r, cat, {
    kind: 'list',
    method: 'get',
    path: '/services',
    summary: 'Platform service catalogue (tests, scans, procedures) to price offerings from',
    tags,
    query: PaginationQuery.extend({ category: z.enum(['CONSULTATION', 'DIAGNOSTIC_TEST', 'IMAGING', 'PROCEDURE', 'SURGERY', 'PHARMACY', 'AMBULANCE', 'HOME_CARE', 'OTHER']).optional(), q: z.string().max(100).optional() }),
    response: Passthrough,
    handler: async ({ query }) => {
      const rows = await prisma.service.findMany({ where: { isActive: true, ...(query.category ? { category: query.category } : {}), ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {}), ...cursorWhere(query.cursor) }, orderBy: cursorOrderBy(), take: query.limit + 1 });
      const { items, page } = buildPage(rows, query.limit, (s) => s.createdAt);
      return { page, items: items.map((s) => ({ id: s.id, code: s.code, name: s.name, category: s.category, requiresPrescription: s.requiresPrescription, sampleType: s.sampleType, fastingRequired: s.fastingRequired, preparationInstructions: s.preparationInstructions, isPanel: s.isPanel })) };
    },
  });

  defineRoute(r, cat, {
    kind: 'list',
    method: 'get',
    path: '/medicines',
    summary: 'Medicine catalogue to add stock from',
    description: 'Case-insensitive prefix search over brand name then composition (CDCI codes plus pharmacy-added medicines). At least 2 characters, at most 20 results.',
    tags,
    query: z.object({ q: z.string().trim().min(2).max(100), limit: z.coerce.number().int().min(1).max(20).default(20) }),
    response: Passthrough,
    handler: async ({ query }) => ({ page: { limit: query.limit, nextCursor: null, hasMore: false }, items: await searchMedicines(query.q, query.limit) }),
  });

  defineRoute(r, cat, {
    method: 'get',
    path: '/departments',
    summary: 'Departments a hospital or clinic can offer',
    tags,
    response: z.array(z.object({ code: z.string(), name: z.string() })),
    handler: async () => prisma.department.findMany({ where: { isActive: true }, select: { code: true, name: true }, orderBy: { name: 'asc' } }),
  });

  defineRoute(r, cat, {
    method: 'get',
    path: '/specialities',
    summary: 'Medical specialities (for filtering doctors)',
    tags,
    response: z.array(z.object({ code: z.string(), name: z.string() })),
    handler: async () => prisma.speciality.findMany({ where: { isActive: true }, select: { code: true, name: true }, orderBy: { name: 'asc' } }),
  });

  defineRoute(r, cat, {
    method: 'get',
    path: '/amenities',
    summary: 'Facility amenities and capabilities',
    tags,
    response: z.array(z.object({ code: z.string(), name: z.string() })),
    handler: async () => prisma.amenity.findMany({ where: { isActive: true }, select: { code: true, name: true }, orderBy: { name: 'asc' } }),
  });

  defineRoute(r, cat, {
    method: 'get',
    path: '/regions',
    summary: 'Service regions the platform operates in',
    tags,
    response: z.array(z.object({ code: z.string(), name: z.string(), district: z.string(), state: z.string(), status: z.string() })),
    handler: async () => prisma.serviceRegion.findMany({ select: { code: true, name: true, district: true, state: true, status: true }, orderBy: { name: 'asc' } }),
  });

  defineRoute(r, cat, {
    kind: 'list',
    method: 'get',
    path: '/providers',
    summary: 'Find approved providers by name (for affiliations and referrals)',
    tags,
    query: PaginationQuery.extend({ q: z.string().trim().min(2).max(100), type: z.enum(['DOCTOR', 'HOSPITAL', 'CLINIC', 'DIAGNOSTIC_LAB', 'IMAGING_CENTRE', 'PHARMACY', 'AMBULANCE_OPERATOR']).optional() }),
    response: Passthrough,
    handler: async ({ query }) => {
      const res = await providers.listProviders({ limit: query.limit, cursor: query.cursor, q: query.q, type: query.type, status: 'APPROVED' });
      // Only what another organisation needs to recognise a provider — no legal identifiers.
      return { page: res.page, items: res.items.map((p) => ({ id: p.id, type: p.type, displayName: p.displayName, city: p.city, district: p.district, ratingAverage: p.ratingAverage, ratingCount: p.ratingCount })) };
    },
  });


  // ── The prescription file itself, for the pharmacist or lab reviewing an order ──
  // Only for a prescription attached to an order at this provider; every view is logged as sensitive access.
  r.get('/portal/providers/:providerId/prescriptions/:prescriptionId/file', authenticate, async (req: Request, res: Response) => {
    const auth = res.locals.auth as AuthContext;
    const providerId = z.uuid().safeParse(req.params.providerId);
    const prescriptionId = z.uuid().safeParse(req.params.prescriptionId);
    if (!providerId.success || !prescriptionId.success) throw badRequest('Invalid id');
    const provider = await prisma.provider.findUnique({ where: { id: providerId.data }, select: { type: true } });
    if (!provider) throw notFound('Provider');
    await assertProviderAccess(auth, providerId.data, provider.type === 'PHARMACY'
      ? { platformPermission: 'pharmacy.read', capability: 'review_prescriptions' }
      : { platformPermission: 'diagnostics.read', capability: 'manage_bookings' });
    const rx = await prisma.prescription.findFirst({
      where: { id: prescriptionId.data, OR: [{ pharmacyOrders: { some: { providerId: providerId.data } } }, { diagnosticOrders: { some: { providerId: providerId.data } } }] },
      select: { id: true, storageKey: true },
    });
    await logSensitiveAccess(prisma, { resourceType: 'PRESCRIPTION', resourceId: prescriptionId.data, purpose: 'Provider reviewing a prescription attached to an order', granted: !!rx, actorUserId: auth.userId });
    if (!rx) throw notFound('Prescription');
    const buf = await getObject(rx.storageKey);
    res.setHeader('Content-Type', rx.storageKey.endsWith('.pdf') ? 'application/pdf' : rx.storageKey.endsWith('.png') ? 'image/png' : rx.storageKey.endsWith('.webp') ? 'image/webp' : 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  });

  return r;
}

// Re-exported so the admin console can reuse the same capability vocabulary in its UI copy.
export type { AuthContext };
