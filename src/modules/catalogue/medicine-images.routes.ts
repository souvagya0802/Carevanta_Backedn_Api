import express, { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../http/route.js';
import { prisma } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { getObject, IMAGE_TYPES, putObject } from '../../lib/storage.js';
import { rateLimit } from 'express-rate-limit';
import { env } from '../../config/env.js';
import { assertProviderAccess } from '../providers/provider-access.js';
import { medicineImageCredit, medicineImageUrl } from './medicine-image-url.js';
import { allowedLicence, cachedCandidate, downloadPhoto, DownloadError, searchOpenImages } from './medicine-photo-search.js';

/**
 * Medicine photos. Admins (catalogue.manage) may set, replace or remove any photo. A pharmacy may add a photo
 * when the medicine has none, or replace one it added itself; it can never overwrite Carevanta's or another
 * pharmacy's photo. Pharmacy photos are live at once (founder rule: no approval step). Old files stay in
 * storage; only the reference changes, and the public URL is versioned by the image hash.
 */
export const MAX_MEDICINE_PHOTO_BYTES = 2 * 1024 * 1024;
const TYPES: string[] = [...IMAGE_TYPES];

/** A pharmacy uploading photos from its counter: generous, bounded against scripted spam. */
const photoLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => !env.RATE_LIMIT_ENABLED || (env.APP_ENV === 'test' && process.env.RATE_LIMIT_IN_TESTS !== 'true'),
  handler: (_req, _res, next) => next(new AppError(429, 'RATE_LIMITED', 'Too many photo uploads, please slow down')),
});

/** Online photo search: 10 a minute per admin, so the shared upstream quota (200/day anonymous) is not burned by clicks. */
const searchLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (_req, res) => String((res.locals.auth as { userId?: string } | undefined)?.userId ?? 'anon'),
  skip: () => !env.RATE_LIMIT_ENABLED || (env.APP_ENV === 'test' && process.env.RATE_LIMIT_IN_TESTS !== 'true'),
  handler: (_req, _res, next) => next(new AppError(429, 'RATE_LIMITED', 'Too many photo searches, wait a minute')),
});

/** Raw body parser that lets the handler answer 415 for other types and a clear 413 for big photos. */
const rawPhoto = [
  (req: Request, _res: Response, next: (err?: unknown) => void) => {
    const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (!TYPES.includes(type)) return next(new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Upload a JPEG, PNG or WebP photo'));
    next();
  },
  express.raw({ type: TYPES, limit: MAX_MEDICINE_PHOTO_BYTES }),
  // The parser drains an oversized body before failing, so the client always gets this answer.
  (err: unknown, _req: Request, _res: Response, next: (err?: unknown) => void) => {
    next((err as { type?: string } | null)?.type === 'entity.too.large' ? new AppError(413, 'PAYLOAD_TOO_LARGE', 'The photo must be 2 MB or smaller') : err);
  },
] as unknown as RequestHandler[];

const PhotoDto = z.object({ id: z.uuid(), imageUrl: z.string().nullable(), imageSource: z.string().nullable(), imageUpdatedAt: z.string().nullable(), imageCredit: z.string().nullable(), imageLicence: z.string().nullable(), imageSourceUrl: z.string().nullable(), imageIsRepresentative: z.boolean() });
const photoDto = (m: { id: string; imageSha256: string | null; imageSource: string | null; imageUpdatedAt: Date | null; imageCredit?: string | null; imageLicence?: string | null; imageSourceUrl?: string | null; imageIsRepresentative?: boolean | null }) => ({ id: m.id, imageUrl: medicineImageUrl(m), imageSource: m.imageSource, imageUpdatedAt: m.imageUpdatedAt?.toISOString() ?? null, ...medicineImageCredit(m) });
/** Any upload (admin or pharmacy) replaces a web photo, so its credit goes too. */
const NO_CREDIT = { imageCredit: null, imageLicence: null, imageSourceUrl: null, imageIsRepresentative: false };

async function storePhoto(req: Request) {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw badRequest('Send the photo as the raw request body with Content-Type image/jpeg, image/png or image/webp');
  if (req.body.length > MAX_MEDICINE_PHOTO_BYTES) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'The photo must be 2 MB or smaller');
  const mimeType = String(req.headers['content-type']).split(';')[0]!.trim().toLowerCase();
  const stored = await putObject('medicine-photos', req.body, mimeType); // checks the file signature, 415 on mismatch
  return { ...stored, mimeType };
}

/**
 * Who may change the photo from a pharmacy's point of view:
 * none (anyone may add), mine (this pharmacy added it), carevanta (admin photo), other (another pharmacy's).
 */
export function photoOwner(m: { imageSha256?: string | null; imageSource?: string | null; imageUpdatedByProviderId?: string | null }, providerId: string): 'none' | 'mine' | 'carevanta' | 'other' {
  // A web photo is at best a licensed stand-in: a pharmacy's real pack photo may replace it.
  if (!m.imageSha256 || m.imageSource === 'WEB') return 'none';
  if (m.imageSource === 'PROVIDER') return m.imageUpdatedByProviderId === providerId ? 'mine' : 'other';
  return 'carevanta';
}

export function medicineImagesRouter(): Router {
  const r = Router();

  r.get('/public/catalogue/medicines/:id/image', async (req: Request, res: Response) => {
    const id = z.uuid().safeParse(req.params.id);
    if (!id.success) throw notFound('Photo');
    const m = await prisma.medicine.findUnique({ where: { id: id.data }, select: { imageKey: true, imageMimeType: true, imageSha256: true } });
    if (!m?.imageKey || !m.imageSha256 || !m.imageMimeType) throw notFound('Photo');
    const etag = `"${m.imageSha256}"`;
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('ETag', etag);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    const buf = await getObject(m.imageKey);
    res.setHeader('Content-Type', m.imageMimeType);
    res.send(buf);
  });

  const admin = '/admin/catalogue/medicines';
  const tags = ['Admin · Catalogue'];

  defineRoute(r, admin, {
    method: 'put',
    path: '/:id/image',
    summary: 'Set or replace a medicine photo (JPEG, PNG or WebP, ≤ 2 MB, raw body)',
    tags,
    status: 200,
    permissions: ['catalogue.manage'],
    params: z.object({ id: z.uuid() }),
    middleware: rawPhoto,
    response: PhotoDto,
    handler: async ({ params, req, auth }) => {
      const before = await prisma.medicine.findUnique({ where: { id: params.id }, select: { imageSha256: true, imageSource: true } });
      if (!before) throw notFound('Medicine');
      const stored = await storePhoto(req);
      return prisma.$transaction(async (tx) => {
        const m = await tx.medicine.update({ where: { id: params.id }, data: { imageKey: stored.key, imageMimeType: stored.mimeType, imageSha256: stored.sha256, imageSource: 'ADMIN', imageUpdatedAt: new Date(), imageUpdatedById: auth.userId, imageUpdatedByProviderId: null, ...NO_CREDIT } });
        await audit(tx, { action: 'catalogue.medicine_photo_set', entityType: 'medicine', entityId: params.id, metadata: { mimeType: stored.mimeType, sizeBytes: stored.sizeBytes, replaced: !!before.imageSha256, previousSource: before.imageSource ?? null } });
        return photoDto(m);
      });
    },
  });

  defineRoute(r, admin, {
    method: 'delete',
    path: '/:id/image',
    summary: 'Remove a medicine photo',
    tags,
    status: 200,
    permissions: ['catalogue.manage'],
    params: z.object({ id: z.uuid() }),
    response: PhotoDto,
    handler: async ({ params }) => {
      const before = await prisma.medicine.findUnique({ where: { id: params.id }, select: { imageSha256: true, imageSource: true, imageUpdatedByProviderId: true } });
      if (!before) throw notFound('Medicine');
      if (!before.imageSha256) throw conflict('This medicine has no photo');
      return prisma.$transaction(async (tx) => {
        const m = await tx.medicine.update({ where: { id: params.id }, data: { imageKey: null, imageMimeType: null, imageSha256: null, imageSource: null, imageUpdatedAt: null, imageUpdatedById: null, imageUpdatedByProviderId: null, ...NO_CREDIT } });
        await audit(tx, { action: 'catalogue.medicine_photo_removed', entityType: 'medicine', entityId: params.id, metadata: { previousSource: before.imageSource ?? null, previousProviderId: before.imageUpdatedByProviderId ?? null } });
        return photoDto(m);
      });
    },
  });

  const Candidate = z.object({
    provider: z.enum(['openverse', 'commons']), id: z.string(), title: z.string(), thumbUrl: z.string(), fullUrl: z.string(), width: z.number().nullable(), height: z.number().nullable(), mime: z.string(),
    licence: z.string(), licenceUrl: z.string().nullable(), creator: z.string().nullable(), sourcePageUrl: z.string(), attribution: z.string(), matchedOn: z.enum(['brand', 'composition']),
  });

  defineRoute(r, admin, {
    method: 'get',
    path: '/:id/image/search',
    summary: 'Search openly licensed photos for a medicine (Openverse + Wikimedia Commons)',
    description: 'Brand (+ strength) first, then the salt with the dosage form when fewer than 3 photos are found. Only CC0, public domain, CC BY and CC BY-SA. Nothing is attached: an admin picks. 503 when the upstream daily limit is reached and nothing was found.',
    tags,
    status: 200,
    permissions: ['catalogue.manage'],
    params: z.object({ id: z.uuid() }),
    middleware: [searchLimiter],
    response: z.object({ candidates: z.array(Candidate), queries: z.array(z.string()), exhausted: z.boolean() }),
    handler: async ({ params }) => {
      const m = await prisma.medicine.findUnique({ where: { id: params.id }, select: { name: true, strength: true, composition: true, genericName: true, dosageForm: true } });
      if (!m) throw notFound('Medicine');
      const res = await searchOpenImages({ brand: m.name, strength: m.strength, composition: m.composition, genericName: m.genericName, dosageForm: m.dosageForm });
      if (res.exhausted && res.candidates.length === 0) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Image search limit reached, try again in an hour');
      return { candidates: res.candidates, queries: res.queries, exhausted: res.exhausted };
    },
  });

  defineRoute(r, admin, {
    method: 'post',
    path: '/:id/image/from-web',
    summary: 'Attach an openly licensed photo found by the image search',
    description: 'Only a photo our own search returned in the last hour can be attached (download host allowlist: upload.wikimedia.org, *.staticflickr.com, or the host Openverse named). Stores the credit, licence and source page. A salt match must be marked representative.',
    tags,
    status: 200,
    permissions: ['catalogue.manage'],
    params: z.object({ id: z.uuid() }),
    body: z.object({ fullUrl: z.url(), sourcePageUrl: z.url(), licence: z.string().min(2).max(40), creator: z.string().max(300).nullable().optional(), attribution: z.string().max(1000).nullable().optional(), representative: z.boolean() }),
    response: PhotoDto,
    handler: async ({ params, body, auth }) => {
      if (!allowedLicence(body.licence)) throw badRequest('That licence does not allow commercial use. Choose a CC0, public domain, CC BY or CC BY-SA photo.');
      const c = cachedCandidate(body.fullUrl);
      if (!c) throw badRequest('Search again and choose a photo from the results (results are kept for one hour).');
      if (c.matchedOn === 'composition' && !body.representative) throw badRequest('A photo found by salt must be marked as a representative image.');
      const before = await prisma.medicine.findUnique({ where: { id: params.id }, select: { imageSha256: true, imageSource: true } });
      if (!before) throw notFound('Medicine');
      let photo: { buffer: Buffer; mimeType: string };
      try {
        photo = await downloadPhoto(c.fullUrl, c.provider === 'openverse' ? [new URL(c.fullUrl).hostname.toLowerCase()] : []);
      } catch (e) {
        if (e instanceof DownloadError) throw new AppError(e.status, e.status === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : e.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_FAILED', e.message);
        throw new AppError(502, 'SERVICE_UNAVAILABLE', 'The photo could not be downloaded, try another one');
      }
      const stored = await putObject('medicine-photos', photo.buffer, photo.mimeType); // magic-byte check, 415 on mismatch
      const credit = (c.creator ? `${c.creator}` : 'Unknown creator').slice(0, 300);
      const via = c.provider === 'commons' ? 'Wikimedia Commons' : 'Openverse';
      return prisma.$transaction(async (tx) => {
        const m = await tx.medicine.update({
          where: { id: params.id },
          data: { imageKey: stored.key, imageMimeType: photo.mimeType, imageSha256: stored.sha256, imageSource: 'WEB', imageUpdatedAt: new Date(), imageUpdatedById: auth.userId, imageUpdatedByProviderId: null, imageCredit: `${credit} via ${via}`, imageLicence: c.licence, imageSourceUrl: c.sourcePageUrl, imageIsRepresentative: body.representative },
        });
        await audit(tx, { action: 'catalogue.medicine_photo_from_web', entityType: 'medicine', entityId: params.id, metadata: { provider: c.provider, candidateId: c.id, licence: c.licence, sourcePageUrl: c.sourcePageUrl, matchedOn: c.matchedOn, representative: body.representative, sizeBytes: stored.sizeBytes, replaced: !!before.imageSha256, previousSource: before.imageSource ?? null } });
        return photoDto(m);
      });
    },
  });

  defineRoute(r, '/portal/providers/:providerId/medicines', {
    method: 'put',
    path: '/:id/image',
    summary: 'A pharmacy adds a medicine photo (JPEG, PNG or WebP, ≤ 2 MB, raw body)',
    description: 'Allowed when the medicine has no photo or the current photo came from this pharmacy. Live at once (no approval). 409 when Carevanta or another pharmacy set the photo.',
    tags: ['Provider Portal'],
    status: 200,
    params: z.object({ providerId: z.uuid(), id: z.uuid() }),
    middleware: [photoLimiter, ...rawPhoto],
    response: PhotoDto,
    handler: async ({ params, req, auth }) => {
      await assertProviderAccess(auth, params.providerId, { platformPermission: 'pharmacy.manage', capability: 'manage_inventory' });
      const provider = await prisma.provider.findUnique({ where: { id: params.providerId }, select: { type: true } });
      if (provider?.type !== 'PHARMACY') throw badRequest('Only pharmacies add medicine photos');
      const before = await prisma.medicine.findUnique({ where: { id: params.id }, select: { imageSha256: true, imageSource: true, imageUpdatedByProviderId: true } });
      if (!before) throw notFound('Medicine');
      const owner = photoOwner(before, params.providerId);
      if (owner === 'carevanta') throw conflict('This medicine already has a photo set by Carevanta.');
      if (owner === 'other') throw conflict('This medicine already has a photo added by another pharmacy.');
      const stored = await storePhoto(req);
      return prisma.$transaction(async (tx) => {
        // Re-check inside the transaction so two pharmacies racing for an empty photo cannot both win.
        const updated = await tx.medicine.updateMany({
          where: owner === 'none' ? { id: params.id, OR: [{ imageSha256: null }, { imageSha256: { isSet: false } }, { imageSource: 'WEB' }] } : { id: params.id, imageSource: 'PROVIDER', imageUpdatedByProviderId: params.providerId },
          data: { imageKey: stored.key, imageMimeType: stored.mimeType, imageSha256: stored.sha256, imageSource: 'PROVIDER', imageUpdatedAt: new Date(), imageUpdatedById: auth.userId, imageUpdatedByProviderId: params.providerId, ...NO_CREDIT },
        });
        if (updated.count !== 1) throw conflict('Someone else added a photo for this medicine just now. Reload and check.');
        await audit(tx, { action: 'catalogue.medicine_photo_added_by_provider', entityType: 'medicine', entityId: params.id, metadata: { providerId: params.providerId, mimeType: stored.mimeType, sizeBytes: stored.sizeBytes, replaced: owner === 'mine' } });
        return photoDto(await tx.medicine.findUniqueOrThrow({ where: { id: params.id } }));
      });
    },
  });

  return r;
}
