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
import { getPaymentConfig, publicPaymentConfig, savePaymentGateway, setActiveGateway, testGateway } from '../finance/payment-config.service.js';
import { generateVapidKeys, pushStatus, sendPushToUser, setPushSubject } from '../notifications/push.service.js';
import { env } from '../../config/env.js';

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

  // ── Payment gateways (Razorpay, Stripe) ───────────────────────────────────
  const GatewayDto = z.object({ enabled: z.boolean(), mode: z.enum(['test', 'live']), publicKey: z.string().nullable(), hasSecretKey: z.boolean(), secretKeyHint: z.string().nullable(), hasWebhookSecret: z.boolean() });
  const PaymentsDto = z.object({ activeGateway: z.enum(['NONE', 'RAZORPAY', 'STRIPE']), razorpay: GatewayDto, stripe: GatewayDto, webhookUrls: z.object({ razorpay: z.string(), stripe: z.string() }) });
  const hint = (s: string | null) => (s ? `••••${s.slice(-4)}` : null);
  const paymentsDto = async () => {
    const c = await getPaymentConfig();
    const g = (x: typeof c.razorpay) => ({ enabled: x.enabled, mode: x.mode, publicKey: x.publicKey, hasSecretKey: !!x.secretKey, secretKeyHint: hint(x.secretKey), hasWebhookSecret: !!x.webhookSecret });
    return { activeGateway: c.activeGateway, razorpay: g(c.razorpay), stripe: g(c.stripe), webhookUrls: { razorpay: `${env.PUBLIC_API_URL ?? ''}/api/v1/webhooks/razorpay`, stripe: `${env.PUBLIC_API_URL ?? ''}/api/v1/webhooks/stripe` } };
  };

  defineRoute(r, '/admin/integrations', {
    method: 'get',
    path: '/payments',
    summary: 'Payment gateway configuration (secrets never returned)',
    tags: ['Admin · Settings'],
    permissions: ['settings.read'],
    response: PaymentsDto,
    handler: () => paymentsDto(),
  });

  // Registered before `/payments/:gateway` so "active" is never read as a gateway name.
  defineRoute(r, '/admin/integrations', {
    method: 'put',
    path: '/payments/active',
    summary: 'Choose which gateway patients pay through (or none)',
    tags: ['Admin · Settings'],
    status: 200,
    permissions: ['settings.manage'],
    middleware: [sensitiveLimiter],
    body: z.object({ gateway: z.enum(['NONE', 'RAZORPAY', 'STRIPE']), reason: z.string().trim().min(5).max(500) }),
    response: PaymentsDto,
    handler: async ({ body, auth }) => {
      await prisma.$transaction(async (tx) => {
        await setActiveGateway(tx, body.gateway, auth.userId);
        await audit(tx, { action: 'payments.active_gateway_changed', entityType: 'platform_setting', entityId: 'payments.active_gateway', metadata: { gateway: body.gateway, reason: body.reason } });
      });
      return paymentsDto();
    },
  });

  defineRoute(r, '/admin/integrations', {
    method: 'put',
    path: '/payments/:gateway',
    summary: 'Save keys for Razorpay or Stripe',
    description: 'Omit `secretKey` / `webhookSecret` to keep the stored value; send an empty string to clear it. Keys are checked against the gateway’s published formats and the selected mode.',
    tags: ['Admin · Settings'],
    status: 200,
    permissions: ['settings.manage'],
    middleware: [sensitiveLimiter],
    params: z.object({ gateway: z.enum(['razorpay', 'stripe']) }),
    body: z.object({ enabled: z.boolean(), mode: z.enum(['test', 'live']), publicKey: z.string().trim().max(200).nullable(), secretKey: z.string().trim().max(200).nullable().optional(), webhookSecret: z.string().trim().max(200).nullable().optional() }),
    response: PaymentsDto,
    handler: async ({ params, body, auth }) => {
      const gateway = params.gateway === 'razorpay' ? 'RAZORPAY' : 'STRIPE';
      await prisma.$transaction(async (tx) => {
        await savePaymentGateway(tx, gateway, body, auth.userId);
        await audit(tx, { action: 'payments.gateway_configured', entityType: 'platform_setting', entityId: `payments.${params.gateway}`, metadata: { enabled: body.enabled, mode: body.mode, publicKey: body.publicKey, secretChanged: body.secretKey !== undefined, webhookSecretChanged: body.webhookSecret !== undefined } });
      });
      return paymentsDto();
    },
  });

  defineRoute(r, '/admin/integrations', {
    method: 'post',
    path: '/payments/:gateway/test',
    summary: 'Call the gateway with the saved keys (read-only; nothing is charged)',
    tags: ['Admin · Settings'],
    status: 200,
    permissions: ['settings.manage'],
    middleware: [sensitiveLimiter],
    params: z.object({ gateway: z.enum(['razorpay', 'stripe']) }),
    response: z.object({ ok: z.boolean(), account: z.string(), mode: z.string(), detail: z.string() }),
    handler: async ({ params, auth }) => {
      const result = await testGateway(params.gateway === 'razorpay' ? 'RAZORPAY' : 'STRIPE');
      await audit(prisma, { action: 'payments.gateway_tested', entityType: 'platform_setting', entityId: `payments.${params.gateway}`, actorUserId: auth.userId, metadata: { mode: result.mode } });
      return result;
    },
  });

  defineRoute(r, '/public', {
    method: 'get',
    path: '/payments',
    summary: 'Which gateway is live and its public key (for the patient app checkout)',
    tags: ['Public'],
    auth: 'none',
    response: z.object({ activeGateway: z.string(), mode: z.string().nullable(), publicKey: z.string().nullable(), enabled: z.object({ razorpay: z.boolean(), stripe: z.boolean() }) }),
    handler: () => publicPaymentConfig(),
  });

  // ── Web Push (VAPID) ───────────────────────────────────────────────────────
  const PushDto = z.object({ configured: z.boolean(), publicKey: z.string().nullable(), subject: z.string().nullable(), subscriptions: z.number().int(), subscribedUsers: z.number().int() });

  defineRoute(r, '/admin/integrations', {
    method: 'get',
    path: '/push',
    summary: 'Web Push status: whether VAPID keys exist and how many devices are subscribed',
    tags: ['Admin · Settings'],
    permissions: ['settings.read'],
    response: PushDto,
    handler: () => pushStatus(),
  });

  defineRoute(r, '/admin/integrations', {
    method: 'post',
    path: '/push/generate',
    summary: 'Generate a new VAPID key pair (every device must subscribe again)',
    tags: ['Admin · Settings'],
    status: 200,
    permissions: ['settings.manage'],
    middleware: [sensitiveLimiter],
    body: z.object({ subject: z.string().trim().min(6).max(200), confirm: z.literal(true) }),
    response: PushDto,
    handler: async ({ body, auth }) => {
      await prisma.$transaction(async (tx) => {
        await generateVapidKeys(tx, body.subject, auth.userId);
        await audit(tx, { action: 'push.vapid_generated', entityType: 'platform_setting', entityId: 'push.vapid', metadata: { subject: body.subject } });
      });
      return pushStatus();
    },
  });

  defineRoute(r, '/admin/integrations', {
    method: 'put',
    path: '/push',
    summary: 'Change the VAPID contact subject',
    tags: ['Admin · Settings'],
    status: 200,
    permissions: ['settings.manage'],
    body: z.object({ subject: z.string().trim().min(6).max(200) }),
    response: PushDto,
    handler: async ({ body, auth }) => {
      await prisma.$transaction(async (tx) => {
        await setPushSubject(tx, body.subject, auth.userId);
        await audit(tx, { action: 'push.subject_changed', entityType: 'platform_setting', entityId: 'push.vapid.subject', metadata: { subject: body.subject } });
      });
      return pushStatus();
    },
  });

  defineRoute(r, '/admin/integrations', {
    method: 'post',
    path: '/push/test',
    summary: 'Send a test push to every device you have subscribed',
    tags: ['Admin · Settings'],
    status: 200,
    permissions: ['settings.manage'],
    middleware: [sensitiveLimiter],
    response: z.object({ ok: z.boolean(), devices: z.number().int() }),
    handler: async ({ auth }) => {
      try {
        const devices = await sendPushToUser(auth.userId, { title: 'Carevanta push test', body: 'Push notifications are working on this device.', link: '/' });
        return { ok: true, devices };
      } catch (err) {
        throw new AppError(422, 'PRECONDITION_FAILED', `Push test failed: ${err instanceof Error ? err.message : String(err)}`);
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

