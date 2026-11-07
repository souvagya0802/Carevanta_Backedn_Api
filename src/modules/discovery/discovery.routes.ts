import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../http/route.js';
import { prisma } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { DateTimeString, minor } from '../../http/dto.js';
import { search } from './discovery.service.js';
import { MIN_LEAD_MS } from '../appointments/appointments.service.js';
import { smartSearch } from './smart-search.js';

export function discoveryRouter(): Router {
  const r = Router();
  const base = '/discovery';
  const tags = ['Discovery (public)'];

  const ResultRow = z.object({
    providerId: z.uuid(),
    name: z.string(),
    locationId: z.uuid(),
    locationName: z.string(),
    locality: z.string().nullable(),
    city: z.string(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    distanceKm: z.number().nullable(),
    feeMinor: z.number().int().nullable(),
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/search',
    summary: 'Find relevant doctors and hospitals for a condition or symptom near a location',
    description: 'Only clinically reviewed (APPROVED) mappings and verified, listed providers are returned. Red-flag symptoms return emergency guidance.',
    tags,
    auth: 'none',
    query: z.object({
      q: z.string().trim().min(2).max(100),
      lat: z.coerce.number().min(-90).max(90).optional(),
      lng: z.coerce.number().min(-180).max(180).optional(),
      radiusKm: z.coerce.number().min(1).max(100).optional(),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    }),
    response: z.object({
      query: z.string(),
      emergency: z.object({ message: z.string(), number: z.string() }).nullable(),
      matchedConditions: z.array(z.object({ id: z.uuid(), name: z.string() })),
      specialities: z.array(z.object({ code: z.string(), name: z.string(), relevance: z.string() })),
      doctors: z.array(ResultRow),
      facilities: z.array(ResultRow),
      radiusKm: z.number().nullable(),
      disclaimer: z.string(),
    }),
    handler: ({ query }) => search(query),
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/doctors/:id/slots',
    summary: 'Open appointment slots for a verified doctor',
    tags,
    auth: 'none',
    params: z.object({ id: z.uuid() }),
    query: z.object({ from: DateTimeString.optional(), to: DateTimeString.optional(), locationId: z.uuid().optional() }),
    response: z.array(
      z.object({ id: z.uuid(), startsAt: z.string(), endsAt: z.string(), locationId: z.uuid(), locationName: z.string(), available: z.number().int(), feeMinor: z.number().int(), currency: z.string() }),
    ),
    handler: async ({ params, query }) => {
      const doctor = await prisma.provider.findFirst({ where: { id: params.id, type: 'DOCTOR', status: 'APPROVED', isListed: true } });
      if (!doctor) throw notFound('Doctor');
      // Never offer a slot that cannot be booked online any more (it would fail with 409).
      const earliest = new Date(Date.now() + MIN_LEAD_MS);
      const from = query.from && new Date(query.from) > earliest ? new Date(query.from) : earliest;
      const to = query.to ? new Date(query.to) : new Date(from.getTime() + 14 * 86_400_000);
      const slots = await prisma.appointmentSlot.findMany({
        where: {
          doctorProviderId: params.id,
          status: 'OPEN',
          startsAt: { gte: from, lte: to },
          ...(query.locationId ? { locationId: query.locationId } : {}),
          location: { isActive: true, provider: { status: 'APPROVED' } },
          OR: [{ affiliationId: null }, { affiliation: { status: 'ACTIVE' } }],
        },
        include: { location: { select: { name: true } } },
        orderBy: { startsAt: 'asc' },
        take: 200,
      });
      return slots
        .filter((s) => s.bookedCount < s.capacity)
        .map((s) => ({
          id: s.id,
          startsAt: s.startsAt.toISOString(),
          endsAt: s.endsAt.toISOString(),
          locationId: s.locationId,
          locationName: s.location.name,
          available: s.capacity - s.bookedCount,
          feeMinor: minor(s.feeMinor)!,
          currency: s.currency,
        }));
    },
  });

  defineRoute(r, base, {
    method: 'get',
    path: '/suggest',
    summary: 'Smart search: understands symptoms, everyday words, typos and local words; suggests specialists, doctors, places, tests and medicines',
    description: 'Symptoms lead to specialists only through APPROVED clinical mappings; red-flag symptoms return emergency guidance. Tests and medicines are matched by their own names, never suggested for a symptom.',
    tags,
    auth: 'none',
    query: z.object({
      q: z.string().trim().min(2).max(120),
      lat: z.coerce.number().min(-90).max(90).optional(),
      lng: z.coerce.number().min(-180).max(180).optional(),
      limit: z.coerce.number().int().min(1).max(20).default(6),
    }),
    response: z.any(),
    handler: ({ query }) => smartSearch(query),
  });

  return r;
}
