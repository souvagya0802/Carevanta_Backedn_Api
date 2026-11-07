import { prisma, type Prisma } from '../../lib/prisma.js';
import { minor } from '../../http/dto.js';
import { getSetting } from '../settings/settings.service.js';
import { cmpAscNullsLast, cmpName, matchConditions, nearestPlacement, placementSelect } from './smart-search.js';

/**
 * Patient-facing discovery. Pipeline:
 *   query → Condition (name / synonyms, typo-tolerant matcher)
 *         → APPROVED condition→speciality mappings only
 *         → APPROVED + listed doctors with those specialities
 *         → APPROVED + listed hospitals/clinics with matching departments
 *   … filtered by distance (bounding-box prefilter on the lat/lng index, then
 *   haversine in JS), one row per provider at their nearest location, ordered
 *   by distance.
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

/** Symptom words → conditions, using the same typo-tolerant matcher as smart search. */
export const resolveConditions = matchConditions;

type Row = { provider_id: string; display_name: string; location_id: string; location_name: string; locality: string | null; city: string; latitude: number | null; longitude: number | null; distance_km: number | null; fee_minor: bigint | null };

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
  // Only locations inside the bounding box take part when coordinates are given (locations without coordinates drop out, as before).
  const locationWhere: Prisma.ProviderLocationWhereInput = box
    ? { latitude: { gte: box.minLat, lte: box.maxLat }, longitude: { gte: box.minLng, lte: box.maxLng } }
    : {};

  /** Nearest eligible location per provider, within the radius when coordinates are given; ordered by distance then name. */
  const rank = (rows: Row[]) =>
    rows
      .filter((r) => !hasGeo || (r.distance_km != null && r.distance_km <= radiusKm))
      .sort((a, b) => cmpAscNullsLast(a.distance_km, b.distance_km) || cmpName(a.display_name, b.display_name))
      .slice(0, input.limit);

  let doctors: Row[] = [];
  let facilities: Row[] = [];
  if (specialityIds.length) {
    // Doctors: any speciality claim (verified or not, as before) in the mapped specialities; must have a doctor profile and
    // at least one eligible location (own, or at an APPROVED facility they are ACTIVELY affiliated with).
    const claims = await prisma.doctorSpeciality.findMany({ where: { specialityId: { in: specialityIds } }, select: { doctorProviderId: true } });
    const doctorIds = [...new Set(claims.map((c) => c.doctorProviderId))];
    const doctorProviders = doctorIds.length
      ? await prisma.provider.findMany({
          where: { id: { in: doctorIds }, type: 'DOCTOR', status: 'APPROVED', isListed: true },
          select: { id: true, displayName: true, ...placementSelect(locationWhere) },
        })
      : [];
    const doctorRows: Row[] = [];
    for (const p of doctorProviders) {
      if (!p.doctorProfile) continue;
      const place = nearestPlacement(p, input.lat, input.lng, true);
      if (!place?.location) continue;
      doctorRows.push({ provider_id: p.id, display_name: p.displayName, location_id: place.location.id, location_name: place.location.name, locality: place.location.locality, city: place.location.city, latitude: place.location.latitude, longitude: place.location.longitude, distance_km: place.distanceKm, fee_minor: place.feeMinor });
    }
    doctors = rank(doctorRows);

    // Facilities: hospitals/clinics with an active department whose speciality is mapped; own active locations only, no fee.
    const facilityProviders = await prisma.provider.findMany({
      where: { type: { in: ['HOSPITAL', 'CLINIC'] }, status: 'APPROVED', isListed: true, departments: { some: { isActive: true, department: { specialityId: { in: specialityIds } } } } },
      select: { id: true, displayName: true, locations: { where: { isActive: true, ...locationWhere }, select: { id: true, name: true, locality: true, city: true, latitude: true, longitude: true } } },
    });
    const facilityRows: Row[] = [];
    for (const p of facilityProviders) {
      const place = nearestPlacement({ locations: p.locations }, input.lat, input.lng, true);
      if (!place?.location) continue;
      facilityRows.push({ provider_id: p.id, display_name: p.displayName, location_id: place.location.id, location_name: place.location.name, locality: place.location.locality, city: place.location.city, latitude: place.location.latitude, longitude: place.location.longitude, distance_km: place.distanceKm, fee_minor: null });
    }
    facilities = rank(facilityRows);
  }

  const mapRow = (r: Row) => ({
    providerId: r.provider_id,
    name: r.display_name,
    locationId: r.location_id,
    locationName: r.location_name,
    locality: r.locality,
    city: r.city,
    latitude: r.latitude,
    longitude: r.longitude,
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
