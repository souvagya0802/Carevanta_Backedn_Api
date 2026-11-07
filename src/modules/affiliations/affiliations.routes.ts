import { Router } from 'express';
import { z } from 'zod';
import { defineRoute, IdParams } from '../../http/route.js';
import { PaginationQuery } from '../../lib/pagination.js';
import { DateString, MoneyInput, Reason } from '../../http/dto.js';
import { notFound } from '../../lib/errors.js';
import { assertProviderAccess, getOwnDoctorProviderId } from '../providers/provider-access.js';
import * as aff from './affiliations.service.js';

const StatusEnum = z.enum(['INVITED', 'REQUESTED', 'PENDING_VERIFICATION', 'ACTIVE', 'REJECTED', 'SUSPENDED', 'ENDED', 'CANCELLED']);
const AffiliationDto = z.object({ id: z.uuid(), status: StatusEnum, version: z.number().int() }).passthrough();
const Terms = z.object({
  locationId: z.uuid().nullable().optional(),
  departmentCode: z.string().max(64).nullable().optional(),
  roleTitle: z.string().max(120).optional(),
  engagementType: z.enum(['FULL_TIME', 'PART_TIME', 'VISITING', 'CONSULTANT']).optional(),
  consultationFeeMinor: MoneyInput.optional(),
  startDate: DateString.optional(),
});

export function affiliationsRouter(): Router {
  const r = Router();

  // ── Platform administration ────────────────────────────────────────────
  const admin = '/admin/affiliations';
  const adminTags = ['Admin · Affiliations'];

  defineRoute(r, admin, {
    kind: 'list',
    method: 'get',
    path: '',
    summary: 'List doctor–facility affiliations',
    tags: adminTags,
    permissions: ['affiliations.read'],
    query: PaginationQuery.extend({ status: StatusEnum.optional(), doctorProviderId: z.uuid().optional(), facilityProviderId: z.uuid().optional() }),
    response: AffiliationDto,
    handler: ({ query }) => aff.listAffiliations(query),
  });

  defineRoute(r, admin, {
    method: 'get',
    path: '/:id',
    summary: 'Affiliation with its event history',
    tags: adminTags,
    permissions: ['affiliations.read'],
    params: IdParams,
    response: AffiliationDto,
    handler: ({ params }) => aff.getAffiliation(params.id),
  });

  defineRoute(r, admin, {
    method: 'post',
    path: '',
    summary: 'Create an affiliation on documented evidence (platform-initiated)',
    description: 'Use when a hospital submits its doctor roster with signed consent. Still requires verification by a different user.',
    tags: adminTags,
    permissions: ['affiliations.manage'],
    body: Terms.extend({ doctorProviderId: z.uuid(), facilityProviderId: z.uuid(), evidenceNote: Reason }),
    response: AffiliationDto,
    handler: async ({ body, auth }) => {
      const { doctorProviderId, facilityProviderId, evidenceNote, ...terms } = body;
      return aff.getAffiliation(await aff.createByPlatform(auth, doctorProviderId, facilityProviderId, terms, evidenceNote));
    },
  });

  defineRoute(r, admin, {
    method: 'post',
    path: '/:id/actions',
    summary: 'Verify, reject, suspend, reactivate or end an affiliation',
    tags: adminTags,
    status: 200,
    permissions: ['affiliations.verify'],
    params: IdParams,
    body: z.object({ action: z.enum(['VERIFY', 'REJECT', 'SUSPEND', 'REACTIVATE', 'END']), note: z.string().max(1000).optional(), expectedVersion: z.number().int().optional() }),
    response: AffiliationDto.extend({ affectedAppointments: z.number().int() }),
    handler: async ({ params, body, auth }) => {
      const res = await aff.transition(auth, params.id, 'PLATFORM', body.action, body.note, body.expectedVersion);
      return { ...(await aff.getAffiliation(params.id)), ...res };
    },
  });

  // ── Facility portal (hospital / clinic staff) ──────────────────────────
  const facility = '/portal/providers/:providerId/affiliations';
  const portalTags = ['Provider portal · Affiliations'];

  defineRoute(r, facility, {
    method: 'post',
    path: '/invite',
    summary: 'Invite an existing verified doctor to this facility',
    description: 'Creates an invitation only. The facility cannot create or edit the doctor’s profile.',
    tags: portalTags,
    params: z.object({ providerId: z.uuid() }),
    body: Terms.extend({ doctorProviderId: z.uuid() }),
    response: AffiliationDto,
    handler: async ({ params, body, auth }) => {
      await assertProviderAccess(auth, params.providerId, { capability: 'manage_affiliations' });
      const { doctorProviderId, ...terms } = body;
      return aff.getAffiliation(await aff.inviteDoctor(auth, params.providerId, doctorProviderId, terms));
    },
  });

  defineRoute(r, facility, {
    kind: 'list',
    method: 'get',
    path: '',
    summary: 'Affiliations of this facility',
    tags: portalTags,
    params: z.object({ providerId: z.uuid() }),
    query: PaginationQuery.extend({ status: StatusEnum.optional(), departmentCode: z.string().max(64).optional(), specialityCode: z.string().max(64).optional(), engagementType: z.enum(['FULL_TIME', 'PART_TIME', 'VISITING', 'CONSULTANT']).optional(), q: z.string().trim().max(100).optional() }),
    response: AffiliationDto,
    handler: async ({ params, query, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'affiliations.read', capability: 'manage_affiliations' });
      return aff.listAffiliations({ ...query, facilityProviderId: params.providerId });
    },
  });

  defineRoute(r, facility, {
    method: 'post',
    path: '/:id/:action',
    summary: 'Facility side: accept/decline a doctor request, withdraw an invitation, or end',
    tags: portalTags,
    status: 200,
    params: z.object({ providerId: z.uuid(), id: z.uuid(), action: z.enum(['accept', 'decline', 'withdraw', 'end']) }),
    body: z.object({ note: z.string().max(1000).optional() }),
    response: AffiliationDto,
    handler: async ({ params, body, auth }) => {
      await assertProviderAccess(auth, params.providerId, { capability: 'manage_affiliations' });
      await aff.assertSide(auth, params.id, 'FACILITY', params.providerId);
      await aff.transition(auth, params.id, 'FACILITY', params.action.toUpperCase() as 'ACCEPT', body.note);
      return aff.getAffiliation(params.id);
    },
  });

  // ── Doctor app ─────────────────────────────────────────────────────────
  const doctor = '/portal/doctor/affiliations';
  const doctorTags = ['Doctor app · Affiliations'];

  const ownDoctor = async (auth: Parameters<typeof getOwnDoctorProviderId>[0]) => {
    const id = await getOwnDoctorProviderId(auth);
    if (!id) throw notFound('Doctor profile');
    return id;
  };

  defineRoute(r, doctor, {
    kind: 'list',
    method: 'get',
    path: '',
    summary: 'My affiliations',
    tags: doctorTags,
    query: PaginationQuery.extend({ status: StatusEnum.optional(), departmentCode: z.string().max(64).optional(), specialityCode: z.string().max(64).optional(), engagementType: z.enum(['FULL_TIME', 'PART_TIME', 'VISITING', 'CONSULTANT']).optional(), q: z.string().trim().max(100).optional() }),
    response: AffiliationDto,
    handler: async ({ query, auth }) => aff.listAffiliations({ ...query, doctorProviderId: await ownDoctor(auth) }),
  });

  defineRoute(r, doctor, {
    method: 'post',
    path: '/request',
    summary: 'Request to join a facility',
    tags: doctorTags,
    body: Terms.extend({ facilityProviderId: z.uuid() }),
    response: AffiliationDto,
    handler: async ({ body, auth }) => {
      const { facilityProviderId, ...terms } = body;
      return aff.getAffiliation(await aff.requestToJoin(auth, await ownDoctor(auth), facilityProviderId, terms));
    },
  });

  defineRoute(r, doctor, {
    method: 'post',
    path: '/:id/:action',
    summary: 'Doctor side: accept/decline an invitation, withdraw a request, or end',
    tags: doctorTags,
    status: 200,
    params: z.object({ id: z.uuid(), action: z.enum(['accept', 'decline', 'withdraw', 'end']) }),
    body: z.object({ note: z.string().max(1000).optional() }),
    response: AffiliationDto,
    handler: async ({ params, body, auth }) => {
      await aff.assertSide(auth, params.id, 'DOCTOR');
      await aff.transition(auth, params.id, 'DOCTOR', params.action.toUpperCase() as 'ACCEPT', body.note);
      return aff.getAffiliation(params.id);
    },
  });

  return r;
}
