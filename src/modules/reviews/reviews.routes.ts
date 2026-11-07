import { Router } from 'express';
import { z } from 'zod';
import { defineRoute, IdParams } from '../../http/route.js';
import { prisma } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import { buildPage, cursorOrderBy, cursorWhere, PaginationQuery } from '../../lib/pagination.js';
import { recomputeRatings, shortName } from './reviews.service.js';

/**
 * Review moderation. Patients' reviews arrive as PENDING_MODERATION and are
 * public only once a moderator publishes them. Publishing, rejecting or hiding
 * recomputes the facility's and the doctor's public rating.
 */
const STATUSES = ['PENDING_MODERATION', 'PUBLISHED', 'REJECTED', 'HIDDEN'] as const;

export function reviewsRouter(): Router {
  const r = Router();
  const base = '/admin/reviews';
  const tags = ['Admin · Reviews'];

  const load = async (ids: string[]) => {
    const rows = await prisma.review.findMany({ where: { id: { in: ids } }, include: { provider: { select: { id: true, displayName: true, type: true } } } });
    const [authors, appts] = await Promise.all([
      prisma.user.findMany({ where: { id: { in: rows.map((x) => x.authorUserId) } }, select: { id: true, fullName: true } }),
      prisma.appointment.findMany({ where: { id: { in: rows.map((x) => x.appointmentId).filter((x): x is string => !!x) } }, select: { id: true, reference: true, doctor: { select: { id: true, displayName: true } } } }),
    ]);
    const author = new Map(authors.map((a) => [a.id, a.fullName]));
    const appt = new Map(appts.map((a) => [a.id, a]));
    const byId = new Map(rows.map((x) => {
      const a = x.appointmentId ? appt.get(x.appointmentId) : undefined;
      return [x.id, {
        id: x.id, rating: x.rating, comment: x.comment, status: x.status,
        createdAt: x.createdAt.toISOString(), moderatedAt: x.moderatedAt?.toISOString() ?? null,
        provider: x.provider, doctor: a?.doctor ?? null, author: shortName(author.get(x.authorUserId)),
        appointmentReference: a?.reference ?? null,
      }];
    }));
    return ids.map((id) => byId.get(id)!).filter(Boolean);
  };

  defineRoute(r, base, {
    kind: 'list',
    method: 'get',
    path: '',
    summary: 'Patient reviews for moderation, newest first',
    tags,
    permissions: ['reviews.read'],
    query: PaginationQuery.extend({ status: z.enum(STATUSES).default('PENDING_MODERATION'), providerId: z.uuid().optional() }),
    response: z.object({ id: z.uuid() }).passthrough(),
    handler: async ({ query }) => {
      const rows = await prisma.review.findMany({
        where: { status: query.status, ...(query.providerId ? { providerId: query.providerId } : {}), ...cursorWhere(query.cursor) },
        orderBy: cursorOrderBy(),
        take: query.limit + 1,
        select: { id: true, createdAt: true },
      });
      const { items, page } = buildPage(rows, query.limit, (x) => x.createdAt);
      return { page, items: await load(items.map((x) => x.id)) };
    },
  });

  defineRoute(r, base, {
    method: 'post',
    path: '/:id/moderate',
    summary: 'Publish, reject or hide a review (recomputes ratings)',
    tags,
    status: 200,
    permissions: ['reviews.moderate'],
    params: IdParams,
    body: z.object({ decision: z.enum(['PUBLISHED', 'REJECTED', 'HIDDEN']), note: z.string().trim().max(500).optional() }),
    response: z.object({ id: z.uuid() }).passthrough(),
    handler: async ({ params, body, auth }) => {
      await prisma.$transaction(async (tx) => {
        const review = await tx.review.findUnique({ where: { id: params.id } });
        if (!review) throw notFound('Review');
        if (review.status === body.decision) throw conflict(`This review is already ${body.decision.toLowerCase().replace('_', ' ')}`);
        await tx.review.update({ where: { id: review.id }, data: { status: body.decision, moderatedById: auth.userId, moderatedAt: new Date() } });
        const doctor = review.appointmentId ? await tx.appointment.findUnique({ where: { id: review.appointmentId }, select: { doctorProviderId: true } }) : null;
        await recomputeRatings(tx, [review.providerId, ...(doctor ? [doctor.doctorProviderId] : [])]);
        await audit(tx, { action: 'review.moderated', entityType: 'review', entityId: review.id, actorUserId: auth.userId, metadata: { from: review.status, to: body.decision, note: body.note ?? null } });
      });
      return (await load([params.id]))[0]!;
    },
  });

  return r;
}
