/**
 * Payment gateway configuration, set by the super-admin (Settings → Payments)
 * and stored in platform_settings. Razorpay and Stripe are both supported;
 * exactly one is "active" for patient payments at a time. Secrets are stored
 * AES-256-GCM encrypted and never returned by the API; the UI only learns
 * whether a secret is present and its last four characters.
 *
 * Nothing here moves money. The gateway adapters in gateway.ts read this
 * configuration when a payment order or refund is created.
 */
import { prisma, type Db } from '../../lib/prisma.js';
import { decryptField, encryptField } from '../../lib/crypto.js';
import { AppError, badRequest } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { setSetting } from '../platform/integrations.service.js';

export type GatewayName = 'RAZORPAY' | 'STRIPE';
export type GatewayMode = 'test' | 'live';

export interface GatewayConfig {
  enabled: boolean;
  mode: GatewayMode;
  /** Razorpay key id / Stripe publishable key — safe for browsers. */
  publicKey: string | null;
  /** Razorpay key secret / Stripe secret key — decrypted, in memory only. */
  secretKey: string | null;
  webhookSecret: string | null;
}
export interface PaymentConfig {
  activeGateway: GatewayName | 'NONE';
  razorpay: GatewayConfig;
  stripe: GatewayConfig;
}

export const PAYMENT_KEYS = [
  'payments.active_gateway',
  'payments.razorpay.enabled', 'payments.razorpay.mode', 'payments.razorpay.key_id', 'payments.razorpay.key_secret', 'payments.razorpay.webhook_secret',
  'payments.stripe.enabled', 'payments.stripe.mode', 'payments.stripe.publishable_key', 'payments.stripe.secret_key', 'payments.stripe.webhook_secret',
] as const;

let cache: { at: number; value: PaymentConfig } | null = null;
export function invalidatePaymentConfig() { cache = null; }

const decrypt = (v: unknown, what: string): string | null => {
  if (typeof v !== 'string' || !v) return null;
  try { return decryptField(v); } catch (err) { logger.error({ err, what }, 'payment secret could not be decrypted — was DATA_ENCRYPTION_KEY rotated?'); return null; }
};

export async function getPaymentConfig(db: Db = prisma): Promise<PaymentConfig> {
  if (cache && Date.now() - cache.at < 30_000) return cache.value;
  const rows = await db.platformSetting.findMany({ where: { key: { in: [...PAYMENT_KEYS] } } });
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const str = (k: string) => (typeof get(k) === 'string' && get(k) ? (get(k) as string) : null);
  const mode = (k: string): GatewayMode => (get(k) === 'live' ? 'live' : 'test');
  const value: PaymentConfig = {
    activeGateway: get('payments.active_gateway') === 'RAZORPAY' ? 'RAZORPAY' : get('payments.active_gateway') === 'STRIPE' ? 'STRIPE' : 'NONE',
    razorpay: { enabled: get('payments.razorpay.enabled') === true, mode: mode('payments.razorpay.mode'), publicKey: str('payments.razorpay.key_id'), secretKey: decrypt(get('payments.razorpay.key_secret'), 'razorpay.key_secret'), webhookSecret: decrypt(get('payments.razorpay.webhook_secret'), 'razorpay.webhook_secret') },
    stripe: { enabled: get('payments.stripe.enabled') === true, mode: mode('payments.stripe.mode'), publicKey: str('payments.stripe.publishable_key'), secretKey: decrypt(get('payments.stripe.secret_key'), 'stripe.secret_key'), webhookSecret: decrypt(get('payments.stripe.webhook_secret'), 'stripe.webhook_secret') },
  };
  cache = { at: Date.now(), value };
  return value;
}

/** Key formats published by each gateway; catching a live key saved under "test" (or vice versa) before it bites. */
export const KEY_RULES = {
  RAZORPAY: { publicKey: /^rzp_(test|live)_[A-Za-z0-9]{10,}$/, modeFromKey: (k: string) => (k.startsWith('rzp_live_') ? 'live' : 'test') as GatewayMode },
  STRIPE: { publicKey: /^pk_(test|live)_[A-Za-z0-9]{10,}$/, secretKey: /^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/, webhookSecret: /^whsec_[A-Za-z0-9]{10,}$/, modeFromKey: (k: string) => (/_live_/.test(k) ? 'live' : 'test') as GatewayMode },
} as const;

export interface GatewayInput { enabled: boolean; mode: GatewayMode; publicKey: string | null; secretKey?: string | null; webhookSecret?: string | null }

/** Validates and stores one gateway's settings. `undefined` secret = keep the stored one; '' or null = clear. */
export async function savePaymentGateway(db: Db, gateway: GatewayName, input: GatewayInput, updatedById: string) {
  const prefix = gateway === 'RAZORPAY' ? 'payments.razorpay' : 'payments.stripe';
  const current = await getPaymentConfig(db);
  const cfg = gateway === 'RAZORPAY' ? current.razorpay : current.stripe;
  if (input.publicKey) {
    if (!KEY_RULES[gateway].publicKey.test(input.publicKey)) throw badRequest(gateway === 'RAZORPAY' ? 'Razorpay key id looks wrong (expected rzp_test_… or rzp_live_…)' : 'Stripe publishable key looks wrong (expected pk_test_… or pk_live_…)', { field: 'publicKey' });
    if (KEY_RULES[gateway].modeFromKey(input.publicKey) !== input.mode) throw badRequest(`This is a ${KEY_RULES[gateway].modeFromKey(input.publicKey)} key but the mode is set to ${input.mode}`, { field: 'mode' });
  }
  if (gateway === 'STRIPE' && input.secretKey && !KEY_RULES.STRIPE.secretKey.test(input.secretKey)) throw badRequest('Stripe secret key looks wrong (expected sk_test_… or sk_live_…)', { field: 'secretKey' });
  if (gateway === 'STRIPE' && input.secretKey && KEY_RULES.STRIPE.modeFromKey(input.secretKey) !== input.mode) throw badRequest('The secret key does not match the selected mode', { field: 'secretKey' });
  if (gateway === 'STRIPE' && input.webhookSecret && !KEY_RULES.STRIPE.webhookSecret.test(input.webhookSecret)) throw badRequest('Stripe webhook signing secret looks wrong (expected whsec_…)', { field: 'webhookSecret' });
  const willHaveSecret = input.secretKey === undefined ? !!cfg.secretKey : !!input.secretKey;
  if (input.enabled && (!input.publicKey || !willHaveSecret)) throw badRequest('Enter both keys before enabling the gateway');

  const label = gateway === 'RAZORPAY' ? 'Razorpay' : 'Stripe';
  await setSetting(db, `${prefix}.enabled`, input.enabled, `${label} accepted for online payments`, false, updatedById);
  await setSetting(db, `${prefix}.mode`, input.mode, `${label} environment (test keys never move real money)`, false, updatedById);
  await setSetting(db, gateway === 'RAZORPAY' ? 'payments.razorpay.key_id' : 'payments.stripe.publishable_key', input.publicKey ?? '', `${label} public key (shown to browsers)`, false, updatedById);
  if (input.secretKey !== undefined) await setSetting(db, gateway === 'RAZORPAY' ? 'payments.razorpay.key_secret' : 'payments.stripe.secret_key', input.secretKey ? encryptField(input.secretKey) : '', `${label} secret key (encrypted)`, true, updatedById);
  if (input.webhookSecret !== undefined) await setSetting(db, `${prefix}.webhook_secret`, input.webhookSecret ? encryptField(input.webhookSecret) : '', `${label} webhook signing secret (encrypted)`, true, updatedById);
  // Disabling the active gateway turns online payments off rather than silently routing to the other one.
  if (!input.enabled && current.activeGateway === gateway) await setSetting(db, 'payments.active_gateway', 'NONE', 'Gateway patients pay through', false, updatedById);
  invalidatePaymentConfig();
}

export async function setActiveGateway(db: Db, gateway: GatewayName | 'NONE', updatedById: string) {
  const current = await getPaymentConfig(db);
  if (gateway !== 'NONE') {
    const cfg = gateway === 'RAZORPAY' ? current.razorpay : current.stripe;
    if (!cfg.enabled || !cfg.publicKey || !cfg.secretKey) throw badRequest(`${gateway === 'RAZORPAY' ? 'Razorpay' : 'Stripe'} is not enabled with both keys yet`);
    if (!cfg.webhookSecret) throw badRequest('Add the webhook signing secret first — without it payment confirmations cannot be verified');
  }
  await setSetting(db, 'payments.active_gateway', gateway, 'Gateway patients pay through', false, updatedById);
  invalidatePaymentConfig();
}

/** Calls the gateway with the stored keys and reports what it finds. Read-only API calls; nothing is charged. */
export async function testGateway(gateway: GatewayName): Promise<{ ok: true; account: string; mode: GatewayMode; detail: string }> {
  const cfg = (await getPaymentConfig())[gateway === 'RAZORPAY' ? 'razorpay' : 'stripe'];
  if (!cfg.publicKey || !cfg.secretKey) throw badRequest('Save both keys first');
  const fail = (msg: string): never => { throw new AppError(422, 'PRECONDITION_FAILED', `${gateway === 'RAZORPAY' ? 'Razorpay' : 'Stripe'} test failed: ${msg}`); };
  try {
    if (gateway === 'RAZORPAY') {
      const res = await fetch('https://api.razorpay.com/v1/orders?count=1', { headers: { Authorization: `Basic ${Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString('base64')}` }, signal: AbortSignal.timeout(10_000) });
      if (res.status === 401) return fail('the key id or secret is wrong');
      if (!res.ok) return fail(`HTTP ${res.status}`);
      const body = (await res.json()) as { count?: number };
      return { ok: true, account: cfg.publicKey, mode: cfg.mode, detail: `Authenticated. ${body.count ?? 0} recent order(s) visible.` };
    }
    const res = await fetch('https://api.stripe.com/v1/balance', { headers: { Authorization: `Bearer ${cfg.secretKey}` }, signal: AbortSignal.timeout(10_000) });
    if (res.status === 401) return fail('the secret key is wrong');
    if (!res.ok) return fail(`HTTP ${res.status}`);
    const body = (await res.json()) as { livemode?: boolean; available?: { amount: number; currency: string }[] };
    if ((body.livemode ? 'live' : 'test') !== cfg.mode) return fail(`the key is a ${body.livemode ? 'live' : 'test'} key but the mode is ${cfg.mode}`);
    const avail = body.available?.map((a) => `${(a.amount / 100).toFixed(2)} ${a.currency.toUpperCase()}`).join(', ') || '0';
    return { ok: true, account: cfg.publicKey, mode: cfg.mode, detail: `Authenticated (${body.livemode ? 'live' : 'test'} mode). Available balance: ${avail}.` };
  } catch (err) {
    if (err instanceof AppError) throw err;
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** What a browser needs to start a payment; never includes secrets. */
export async function publicPaymentConfig() {
  const c = await getPaymentConfig();
  const g = c.activeGateway === 'RAZORPAY' ? c.razorpay : c.activeGateway === 'STRIPE' ? c.stripe : null;
  return { activeGateway: c.activeGateway, mode: g?.mode ?? null, publicKey: g?.publicKey ?? null, enabled: { razorpay: c.razorpay.enabled, stripe: c.stripe.enabled } };
}
