import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../http/route.js';
import { listCities, listCountries, listStates, lookupPincode } from './geo.service.js';

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
    handler: async ({ params, res }) => { res.setHeader('Cache-Control', 'public, max-age=3600'); return lookupPincode(params.pin); },
  });

  return r;
}
