import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../http/route.js';
import { prisma } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { getObject, IMAGE_TYPES, putObject } from '../../lib/storage.js';
import { sensitiveLimiter } from '../../middleware/rate-limit.js';
import { getBranding, getSmtpConfig, saveSmtpConfig, sendEmail, setSetting, verifySmtp } from './integrations.service.js';
import { abdmSession, connectorStatus, getRegistryConnectors, saveRegistryConnectors } from '../providers/registries.service.js';

const MAX_LOGO_BYTES = 2 * 1024 * 1024;

const BrandingDto = z.object({ name: z.string(), tagline: z.string(), logoUrl: z.string().nullable(), logoMimeType: z.string().nullable() });

async function brandingDto() {
  const b = await getBranding();
  return {
    name: b.name,
    tagline: b.tagline,
    // Versioned by content hash so clients can cache aggressively and still refresh on change.
    logoUrl: b.logo ? `/api/v1/public/branding/logo?v=${b.logo.sha256.slice(0, 12)}` : null,
    logoMimeType: b.logo?.mimeType ?? null,
  };
}

export function integrationsRouter(): Router {
  const r = Router();

  // ── Public branding ────────────────────────────────────────────────────
  defineRoute(r, '/public', {
    method: 'get',
    path: '/branding',
    summary: 'Platform name, tagline and logo URL (public)',
    tags: ['Public'],
    auth: 'none',
    response: BrandingDto,
    handler: () => brandingDto(),
  });

  r.get('/public/branding/logo', async (_req: Request, res: Response) => {
    const b = await getBranding();
    if (!b.logo) throw notFound('Logo');
    const buf = await getObject(b.logo.storageKey);
    res.setHeader('Content-Type', b.logo.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    res.setHeader('ETag', `"${b.logo.sha256}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(buf);
  });

  // ── Admin branding ─────────────────────────────────────────────────────
  defineRoute(r, '/admin/branding', {
    method: 'put',
    path: '',
    summary: 'Set platform name and tagline',
    tags: ['Admin · Settings'],
    status: 200,
    permissions: ['settings.manage'],
    body: z.object({ name: z.string().trim().min(2).max(60), tagline: z.string().trim().max(120) }),
    response: BrandingDto,
    handler: async ({ body, auth }) => {
      await prisma.$transaction(async (tx) => {
        await setSetting(tx, 'branding.name', body.name, 'Platform display name', false, auth.userId);
        await setSetting(tx, 'branding.tagline', body.tagline, 'Platform tagline', false, auth.userId);
        await audit(tx, { action: 'branding.updated', entityType: 'platform_setting', entityId: 'branding', metadata: body });
      });
      return brandingDto();
    },
  });

  defineRoute(r, '/admin/branding', {
    method: 'put',
    path: '/logo',
    summary: 'Upload the platform logo (PNG, JPEG or WebP, ≤ 2 MB, raw body)',
    description: 'The image is served as-is; clients fit it into their logo box with object-fit: contain, so any aspect ratio works.',
    tags: ['Admin · Settings'],
    status: 200,
    permissions: ['settings.manage'],
    middleware: [express.raw({ type: [...IMAGE_TYPES], limit: MAX_LOGO_BYTES })],
    response: BrandingDto,
    handler: async ({ req, auth }) => {
      if (!Buffer.isBuffer(req.body)) throw badRequest('Send the image as the raw request body with Content-Type image/png, image/jpeg or image/webp');
      if (req.body.length > MAX_LOGO_BYTES) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Logo must be 2 MB or smaller');
      const mimeType = String(req.headers['content-type']).split(';')[0]!.trim();
      const stored = await putObject('branding', req.body, mimeType);
      await prisma.$transaction(async (tx) => {
        await setSetting(tx, 'branding.logo', { storageKey: stored.key, mimeType, sha256: stored.sha256 }, 'Platform logo', false, auth.userId);
        await audit(tx, { action: 'branding.logo_uploaded', entityType: 'platform_setting', entityId: 'branding.logo', metadata: { mimeType, sizeBytes: stored.sizeBytes } });
      });
      return brandingDto();
    },
  });

  defineRoute(r, '/admin/branding', {
    method: 'delete',
    path: '/logo',
    summary: 'Remove the uploaded logo (clients fall back to their default)',
    tags: ['Admin · Settings'],
    status: 200,
    permissions: ['settings.manage'],
    response: BrandingDto,
    handler: async ({ auth }) => {
      await prisma.$transaction(async (tx) => {
        await setSetting(tx, 'branding.logo', null, 'Platform logo', false, auth.userId);
        await audit(tx, { action: 'branding.logo_removed', entityType: 'platform_setting', entityId: 'branding.logo' });
      });
      return brandingDto();
    },
  });

  // ── SMTP ───────────────────────────────────────────────────────────────
  const SmtpDto = z.object({
    configured: z.boolean(),
    host: z.string().nullable(),
    port: z.number().int().nullable(),
    secure: z.boolean(),
    username: z.string().nullable(),
    hasPassword: z.boolean(),
    fromAddress: z.string().nullable(),
    fromName: z.string().nullable(),
  });
  const smtpDto = async () => {
    const c = await getSmtpConfig();
    return { configured: !!c, host: c?.host ?? null, port: c?.port ?? null, secure: c?.secure ?? false, username: c?.username ?? null, hasPassword: !!c?.password, fromAddress: c?.fromAddress ?? null, fromName: c?.fromName ?? null };
  };

  defineRoute(r, '/admin/integrations', {
    method: 'get',
    path: '/smtp',
    summary: 'Current SMTP configuration (password never returned)',
    tags: ['Admin · Settings'],
    permissions: ['settings.read'],
    response: SmtpDto,
    handler: () => smtpDto(),
  });

  defineRoute(r, '/admin/integrations', {
    method: 'put',
    path: '/smtp',
    summary: 'Save SMTP configuration',
    description: 'Omit `password` to keep the stored one; send an empty string to clear it. The password is stored encrypted.',
    tags: ['Admin · Settings'],
    status: 200,
    permissions: ['settings.manage'],
    middleware: [sensitiveLimiter],
    body: z.object({
      host: z.string().trim().min(1).max(253),
      port: z.number().int().min(1).max(65535),
      secure: z.boolean(),
      username: z.string().trim().max(254).nullable(),
      password: z.string().max(512).nullable().optional(),
      fromAddress: z.email().max(254),
      fromName: z.string().trim().min(1).max(100),
    }),
    response: SmtpDto,
    handler: async ({ body, auth }) => {
      await prisma.$transaction(async (tx) => {
        await saveSmtpConfig(tx, body, auth.userId);
        await audit(tx, { action: 'smtp.configured', entityType: 'platform_setting', entityId: 'smtp', metadata: { host: body.host, port: body.port, secure: body.secure, username: body.username, fromAddress: body.fromAddress, passwordChanged: body.password !== undefined } });
      });
      return smtpDto();
    },
  });

  defineRoute(r, '/admin/integrations', {
    method: 'post',
    path: '/smtp/test',
    summary: 'Verify the SMTP connection and send a test email',
    tags: ['Admin · Settings'],
    status: 200,
    permissions: ['settings.manage'],
    middleware: [sensitiveLimiter],
    body: z.object({ to: z.email() }),
    response: z.object({ ok: z.boolean(), messageId: z.string() }),
    handler: async ({ body, auth }) => {
      try {
        await verifySmtp();
        const { messageId } = await sendEmail(body.to, 'Carevanta SMTP test', 'This is a test message from the Carevanta platform. If you received it, outbound email is configured correctly.');
        await audit(prisma, { action: 'smtp.test_sent', entityType: 'platform_setting', entityId: 'smtp', actorUserId: auth.userId, metadata: { to: body.to } });
        return { ok: true, messageId };
      } catch (err) {
        if (err instanceof AppError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new AppError(422, 'PRECONDITION_FAILED', `SMTP test failed: ${message.slice(0, 300)}`);
      }
    },
  });

  // ── Registry connectors (ABDM HPR/HFR, GSTIN, Vahan) ──────────────────────
  const RegistryConnectorsDto = z.object({
    abdm: z.object({ environment: z.enum(['sandbox', 'production']), clientId: z.string().nullable(), hasSecret: z.boolean(), hprLookupUrl: z.string().nullable(), hfrLookupUrl: z.string().nullable() }),
    gstin: z.object({ baseUrl: z.string().nullable(), hasApiKey: z.boolean() }),
    vahan: z.object({ baseUrl: z.string().nullable(), hasApiKey: z.boolean() }),
    status: z.record(z.string(), z.enum(['configured', 'not_configured'])),
  });
  const connectorsDto = async () => ({ ...(await getRegistryConnectors()), status: await connectorStatus() });

  defineRoute(r, '/admin/integrations', {
    method: 'get',
    path: '/registries',
    summary: 'Registry connector configuration (secrets never returned)',
    tags: ['Admin · Settings'],
    permissions: ['settings.read'],
    response: RegistryConnectorsDto,
    handler: () => connectorsDto(),
  });

  const httpsUrl = z.string().url().max(300).refine((u) => u.startsWith('https://'), 'Must be an https URL');
  defineRoute(r, '/admin/integrations', {
    method: 'put',
    path: '/registries',
    summary: 'Save registry connector configuration (blank secret keeps the stored one; null clears it)',
    tags: ['Admin · Settings'],
    status: 200,
    permissions: ['settings.manage'],
    body: z.object({
      abdm: z.object({ environment: z.enum(['sandbox', 'production']).optional(), clientId: z.string().max(200).nullable().optional(), clientSecret: z.string().max(500).nullable().optional(), hprLookupUrl: httpsUrl.nullable().optional(), hfrLookupUrl: httpsUrl.nullable().optional() }).optional(),
      gstin: z.object({ baseUrl: httpsUrl.nullable().optional(), apiKey: z.string().max(500).nullable().optional() }).optional(),
      vahan: z.object({ baseUrl: httpsUrl.nullable().optional(), apiKey: z.string().max(500).nullable().optional() }).optional(),
    }),
    response: RegistryConnectorsDto,
    handler: async ({ body, auth }) => {
      // '' means "keep the existing secret"; null means clear.
      const keep = (v: string | null | undefined) => (v === '' ? undefined : v);
      await prisma.$transaction(async (tx) => {
        await saveRegistryConnectors(tx, {
          abdm: body.abdm ? { ...body.abdm, clientSecret: keep(body.abdm.clientSecret) } : undefined,
          gstin: body.gstin ? { ...body.gstin, apiKey: keep(body.gstin.apiKey) } : undefined,
          vahan: body.vahan ? { ...body.vahan, apiKey: keep(body.vahan.apiKey) } : undefined,
        }, auth.userId);
        await audit(tx, { action: 'registries.configured', entityType: 'platform_setting', entityId: 'registries', actorUserId: auth.userId, metadata: { sections: Object.keys(body) } });
      });
      return connectorsDto();
    },
  });

  defineRoute(r, '/admin/integrations', {
    method: 'post',
    path: '/registries/abdm/test',
    summary: 'Obtain an ABDM gateway session with the stored credentials',
    tags: ['Admin · Settings'],
    status: 200,
    permissions: ['settings.manage'],
    middleware: [sensitiveLimiter],
    response: z.object({ ok: z.boolean(), environment: z.string(), expiresIn: z.number().nullable() }),
    handler: async ({ auth }) => {
      const s = await abdmSession();
      await audit(prisma, { action: 'registries.abdm_tested', entityType: 'platform_setting', entityId: 'registries', actorUserId: auth.userId, metadata: { environment: s.environment } });
      return { ok: true, environment: s.environment, expiresIn: s.expiresIn };
    },
  });

  return r;
}

