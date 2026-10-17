import { prisma, Prisma } from '../../lib/prisma.js';
import { minor } from '../../http/dto.js';
import { getSetting } from '../settings/settings.service.js';

/**
 * Patient-facing discovery. Pipeline:
 *   query → Condition (name / synonyms, trigram similarity)
 *         → APPROVED condition→speciality mappings only
 *         → APPROVED + listed doctors with those specialities
 *         → APPROVED + listed hospitals/clinics with matching departments
 *   … filtered by distance (bounding-box prefilter on the lat/lng index, then
 *   haversine), ordered by distance.
 *
 * It is a routing aid for finding a relevant specialist, NOT a diagnosis. A
 * red-flag term (e.g. chest pain) returns `emergency` guidance first.
 */
const EARTH_KM = 6371;

function boundingBox(lat: number, lng: number, radiusKm: number) {
  const dLat = (radiusKm / EARTH_KM) * (180 / Math.PI);
  const dLng = dLat / Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}

export async function resolveConditions(q: string) {
  const term = q.trim().toLowerCase();
  return prisma.$queryRaw<{ id: string; name: string; is_red_flag: boolean; score: number }[]>`
    SELECT id, name, is_red_flag, GREATEST(similarity(lower(name), ${term}), CASE WHEN ${term} = ANY(synonyms) THEN 1 ELSE 0 END) AS score
    FROM conditions
    WHERE is_active AND (lower(name) % ${term} OR lower(name) LIKE ${'%' + term + '%'} OR ${term} = ANY(synonyms))
    ORDER BY score DESC
    LIMIT 5`;
}

export async function search(input: { q: string; lat?: number; lng?: number; radiusKm?: number; limit: number }) {
  const radiusKm = input.radiusKm ?? (await getSetting<number>('search.default_radius_km', 15));
  const conditions = await resolveConditions(input.q);
  const redFlag = conditions.some((c) => c.is_red_flag);

  const mappings = conditions.length
    ? await prisma.conditionSpecialityMapping.findMany({
        where: { conditionId: { in: conditions.map((c) => c.id) }, reviewStatus: 'APPROVED' },
        include: { speciality: { select: { id: true, code: true, name: true } } },
      })
    : [];
  const specialityIds = [...new Set(mappings.map((m) => m.specialityId))];

  const hasGeo = input.lat != null && input.lng != null;
  const box = hasGeo ? boundingBox(input.lat!, input.lng!, radiusKm) : undefined;
  const distanceSql = hasGeo
    ? Prisma.sql`(2 * ${EARTH_KM} * asin(sqrt(power(sin(radians((l.latitude::float8 - ${input.lat}) / 2)), 2) + cos(radians(${input.lat})) * cos(radians(l.latitude::float8)) * power(sin(radians((l.longitude::float8 - ${input.lng}) / 2)), 2))))`
    : Prisma.sql`NULL::float8`;
  const geoFilter = box
    ? Prisma.sql`AND l.latitude BETWEEN ${box.minLat} AND ${box.maxLat} AND l.longitude BETWEEN ${box.minLng} AND ${box.maxLng}`
    : Prisma.empty;

  type Row = { provider_id: string; display_name: string; location_id: string; location_name: string; locality: string | null; city: string; distance_km: number | null; fee_minor: bigint | null };

  let doctors: Row[] = [];
  let facilities: Row[] = [];
  if (specialityIds.length) {
    doctors = await prisma.$queryRaw<Row[]>`
      SELECT * FROM (
        SELECT DISTINCT ON (p.id) p.id AS provider_id, p.display_name, l.id AS location_id, l.name AS location_name, l.locality, l.city,
               ${distanceSql} AS distance_km, COALESCE(a.consultation_fee_minor, dp.default_fee_minor) AS fee_minor
        FROM providers p
        JOIN doctor_profiles dp ON dp.provider_id = p.id
        JOIN doctor_specialities ds ON ds.doctor_provider_id = p.id AND ds.speciality_id = ANY(${specialityIds}::uuid[])
        LEFT JOIN doctor_affiliations a ON a.doctor_provider_id = p.id AND a.status = 'ACTIVE'
        LEFT JOIN providers f ON f.id = a.facility_provider_id AND f.status = 'APPROVED'
        JOIN provider_locations l ON l.is_active AND (
             l.provider_id = p.id OR (f.id IS NOT NULL AND l.provider_id = f.id AND (a.location_id IS NULL OR a.location_id = l.id)))
        WHERE p.type = 'DOCTOR' AND p.status = 'APPROVED' AND p.is_listed
          ${geoFilter}
        ORDER BY p.id, distance_km ASC NULLS LAST
      ) d
      WHERE ${hasGeo ? Prisma.sql`d.distance_km <= ${radiusKm}` : Prisma.sql`TRUE`}
      ORDER BY d.distance_km ASC NULLS LAST, d.display_name
      LIMIT ${input.limit}`;

    facilities = await prisma.$queryRaw<Row[]>`
      SELECT * FROM (
        SELECT DISTINCT ON (p.id) p.id AS provider_id, p.display_name, l.id AS location_id, l.name AS location_name, l.locality, l.city,
               ${distanceSql} AS distance_km, NULL::bigint AS fee_minor
        FROM providers p
        JOIN facility_departments fd ON fd.provider_id = p.id AND fd.is_active
        JOIN departments d ON d.id = fd.department_id AND d.speciality_id = ANY(${specialityIds}::uuid[])
        JOIN provider_locations l ON l.provider_id = p.id AND l.is_active
        WHERE p.type IN ('HOSPITAL', 'CLINIC') AND p.status = 'APPROVED' AND p.is_listed
          ${geoFilter}
        ORDER BY p.id, distance_km ASC NULLS LAST
      ) f
      WHERE ${hasGeo ? Prisma.sql`f.distance_km <= ${radiusKm}` : Prisma.sql`TRUE`}
      ORDER BY f.distance_km ASC NULLS LAST, f.display_name
      LIMIT ${input.limit}`;
  }

  const mapRow = (r: Row) => ({
    providerId: r.provider_id,
    name: r.display_name,
    locationId: r.location_id,
    locationName: r.location_name,
    locality: r.locality,
    city: r.city,
    distanceKm: r.distance_km == null ? null : Math.round(r.distance_km * 10) / 10,
    feeMinor: minor(r.fee_minor),
  });

  return {
    query: input.q,
    emergency: redFlag
      ? {
          message: 'These symptoms can be a medical emergency. Call 112 now or go to the nearest emergency department.',
          number: await getSetting<string>('emergency.public_number', '112'),
        }
      : null,
    matchedConditions: conditions.map((c) => ({ id: c.id, name: c.name })),
    specialities: [...new Map(mappings.map((m) => [m.speciality.id, { code: m.speciality.code, name: m.speciality.name, relevance: m.relevance }])).values()],
    doctors: doctors.map(mapRow),
    facilities: facilities.map(mapRow),
    radiusKm: hasGeo ? radiusKm : null,
    disclaimer: 'Results suggest relevant specialists to consult. They are not a diagnosis or medical advice.',
  };
}
