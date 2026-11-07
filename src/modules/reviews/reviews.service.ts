import { prisma, type Db } from '../../lib/prisma.js';
import { aggregate, ejsonDate } from '../../lib/mongo.js';

/** First name plus last initial: enough to feel human, not enough to identify a patient. */
export function shortName(full: string | null | undefined): string {
  const parts = (full ?? 'Patient').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Patient';
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1]![0]}.` : parts[0]!;
}

/**
 * Recompute the public rating of providers from PUBLISHED reviews.
 * A review is stored against the facility (or the doctor's own practice); a
 * doctor's rating also counts reviews of visits with that doctor elsewhere.
 *
 * Typed queries only: this usually runs inside the moderation transaction,
 * where raw commands are not available. `Review.appointmentId` has no relation
 * field, so the doctor's visits are resolved first and matched by id.
 */
export async function recomputeRatings(db: Db, providerIds: string[]) {
  for (const id of [...new Set(providerIds)]) {
    const visits = await db.appointment.findMany({ where: { doctorProviderId: id }, select: { id: true } });
    const reviews = await db.review.findMany({
      where: { status: 'PUBLISHED', OR: [{ providerId: id }, ...(visits.length ? [{ appointmentId: { in: visits.map((v) => v.id) } }] : [])] },
      select: { rating: true },
    });
    const n = reviews.length;
    // round(avg::numeric, 2): ratings are integers, so sum*100/n is exact before rounding.
    const avg = n ? Math.round((reviews.reduce((s, r) => s + r.rating, 0) * 100) / n) / 100 : null;
    // updateMany: a missing provider is a no-op (as the SQL UPDATE ... WHERE was), never a P2025.
    await db.provider.updateMany({ where: { id }, data: { ratingAverage: avg, ratingCount: n } });
  }
}

/**
 * Ids of PUBLISHED reviews about a provider: its own, plus (for doctors) visits
 * with that doctor at any facility. Newest first, keyset-paginated on
 * (created_at, id). Runs on the root client, so the doctor side is a join:
 * appointments of the doctor → their (unique) review.
 */
export async function publishedReviewIdsFor(providerId: string, limit: number, before?: { createdAt: Date; id: string }): Promise<{ id: string }[]> {
  const published: Record<string, unknown> = {
    status: 'PUBLISHED',
    ...(before ? { $or: [{ created_at: { $lt: ejsonDate(before.createdAt) } }, { created_at: ejsonDate(before.createdAt), _id: { $lt: before.id } }] } : {}),
  };
  const rows = await aggregate<{ id: string }>(prisma, 'reviews', [
    { $match: { provider_id: providerId, ...published } },
    { $project: { _id: 1, created_at: 1 } },
    {
      $unionWith: {
        coll: 'appointments',
        pipeline: [
          { $match: { doctor_provider_id: providerId } },
          { $lookup: { from: 'reviews', localField: '_id', foreignField: 'appointment_id', as: 'rv' } },
          { $unwind: '$rv' },
          { $replaceRoot: { newRoot: '$rv' } },
          { $match: published },
          { $project: { _id: 1, created_at: 1 } },
        ],
      },
    },
    // DISTINCT: a review of the doctor's own practice appears on both sides.
    { $group: { _id: '$_id', created_at: { $first: '$created_at' } } },
    { $sort: { created_at: -1, _id: -1 } },
    { $limit: limit },
    { $project: { _id: 0, id: '$_id' } },
  ]);
  return rows.map((r) => ({ id: r.id }));
}
