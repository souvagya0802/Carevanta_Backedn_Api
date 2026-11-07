import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../http/route.js';
import { geoLimiter } from '../../middleware/rate-limit.js';
import { listCities, listCountries, listStates, lookupPincode, approximateCoordinates } from './geo.service.js';
import { reverseGeocode, searchPlaces } from './geocoder.js';

const PlaceDto = z.object({
  label: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  address: z.object({
    addressLine1: z.string().nullable(),
    locality: z.string().nullable(),
    city: z.string().nullable(),
    district: z.string().nullable(),
    state: z.string().nullable(),
    pincode: z.string().nullable(),
  }),
});
const Lat = z.coerce.number().min(-90).max(90);
const Lng = z.coerce.number().min(-180).max(180);

const Country = z.object({ code: z.string(), name: z.string(), phoneCode: z.string(), flag: z.string() });
const StateDto = z.object({ code: z.string(), name: z.string(), latitude: z.number().nullable(), longitude: z.number().nullable() });
const CityDto = z.object({ name: z.string(), latitude: z.number().nullable(), longitude: z.number().nullable() });
const PincodeDto = z.object({
  pincode: z.string(),
  country: z.string(),
  state: z.string(),
  district: z.string(),
  block: z.string().nullable(),
  division: z.string().nullable(),
  offices: z.array(z.object({ name: z.string(), branchType: z.string() })),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  /** How the point was found: providers at this PIN, a matching town/block, the district, or the state centre. */
  accuracy: z.enum(['providers', 'locality', 'district', 'state']).nullable(),
});
const CountryCode = z.string().length(2).toUpperCase();
const STATIC_CACHE = 'public, max-age=86400, stale-while-revalidate=604800';

/** Public reference geography: ISO countries/states/cities and the Indian PIN directory. */
export function geoRouter(): Router {
  const r = Router();

  defineRoute(r, '/public/geo', {
    method: 'get',
    path: '/countries',
    summary: 'All countries (ISO 3166-1)',
    tags: ['Public'],
    auth: 'none',
    response: z.array(Country),
    handler: async ({ res }) => { res.setHeader('Cache-Control', STATIC_CACHE); return listCountries(); },
  });

  defineRoute(r, '/public/geo', {
    method: 'get',
    path: '/states',
    summary: 'States / union territories of a country',
    tags: ['Public'],
    auth: 'none',
    query: z.object({ country: CountryCode }),
    response: z.array(StateDto),
    handler: async ({ query, res }) => { res.setHeader('Cache-Control', STATIC_CACHE); return listStates(query.country); },
  });

  defineRoute(r, '/public/geo', {
    method: 'get',
    path: '/cities',
    summary: 'Cities and towns of a state',
    tags: ['Public'],
    auth: 'none',
    query: z.object({ country: CountryCode, state: z.string().min(1).max(10).toUpperCase() }),
    response: z.array(CityDto),
    handler: async ({ query, res }) => { res.setHeader('Cache-Control', STATIC_CACHE); return listCities(query.country, query.state); },
  });

  defineRoute(r, '/public/geo', {
    method: 'get',
    path: '/pincode/:pin',
    summary: 'Resolve an Indian PIN code to state, district, block and post offices',
    tags: ['Public'],
    auth: 'none',
    params: z.object({ pin: z.string().regex(/^[0-9]{6}$/) }),
    response: PincodeDto,
    handler: async ({ params, res }) => {
      res.setHeader('Cache-Control', 'public, max-age=3600');
      const found = await lookupPincode(params.pin);
      // Approximate point for distance sorting; accuracy says how approximate (providers, locality, district, state).
      return { ...found, ...(await approximateCoordinates(found)) };
    },
  });

  defineRoute(r, '/public/geo', {
    method: 'get',
    path: '/search',
    summary: 'Search places and addresses in India (free geocoder proxied by the API; results biased to lat/lng)',
    description: 'Backed by OpenStreetMap data through Nominatim or LocationIQ, chosen by GEOCODER_PROVIDER. Cached 24 h; at most 30 requests per minute per IP. Answers 503 when the geocoder is unavailable.',
    tags: ['Public'],
    auth: 'none',
    middleware: [geoLimiter],
    query: z.object({ q: z.string().trim().min(3).max(200), lat: Lat.optional(), lng: Lng.optional(), limit: z.coerce.number().int().min(1).max(10).default(6) }),
    response: z.array(PlaceDto),
    handler: async ({ query, res }) => {
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return searchPlaces({ q: query.q, lat: query.lat, lng: query.lng, limit: query.limit });
    },
  });

  defineRoute(r, '/public/geo', {
    method: 'get',
    path: '/reverse',
    summary: 'Nearest address for a point (free geocoder proxied by the API)',
    tags: ['Public'],
    auth: 'none',
    middleware: [geoLimiter],
    query: z.object({ lat: Lat, lng: Lng }),
    response: PlaceDto.nullable(),
    handler: async ({ query, res }) => {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return reverseGeocode(query.lat, query.lng);
    },
  });

  return r;
}
