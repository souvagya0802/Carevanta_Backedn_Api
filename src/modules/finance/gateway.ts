import { randomBytes } from 'node:crypto';
import { env, isProduction } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { hmacSha256Hex, safeEqual } from '../../lib/crypto.js';
import { logger } from '../../lib/logger.js';
import { getPaymentConfig, type GatewayName } from './payment-config.service.js';

/**
 * Payment-gateway port. The super-admin picks the active gateway and supplies
 * its keys (Settings → Payments): Razorpay or Stripe. Development and tests
 * use a *simulated* gateway that never moves money and is labelled as such in
 * every response. Payment success is NEVER inferred from a client callback —
 * only from a signature-verified webhook processed server-side.
 */
export type LiveGateway = GatewayName | 'TEST_GATEWAY';

export interface GatewayOrder {
  gateway: LiveGateway;
  gatewayOrderId: string;
  amountMinor: bigint;
  currency: string;
  simulated: boolean;
  /** Razorpay key id or Stripe publishable key for the browser SDK. */
  keyId: string | null;
  /** Stripe only: the PaymentIntent client secret the browser confirms with. */
  clientSecret?: string | null;
}

export interface GatewayRefund {
  gatewayRefundId: string;
  status: 'pending' | 'processed';
}

export interface PaymentGateway {
  readonly name: LiveGateway;
  createOrder(input: { amountMinor: bigint; currency: string; receipt: string }): Promise<GatewayOrder>;
  createRefund(input: { gatewayPaymentId: string; amountMinor: bigint; receipt: string }): Promise<GatewayRefund>;
}

class RazorpayGateway implements PaymentGateway {
  readonly name = 'RAZORPAY' as const;
  constructor(private keyId: string, private keySecret: string) {}

  private async call<T>(path: string, body: object): Promise<T> {
    const res = await fetch(`https://api.razorpay.com/v1${path}`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logger.error({ status: res.status, path }, 'razorpay request failed');
      throw new AppError(502, 'SERVICE_UNAVAILABLE', 'Payment gateway request failed');
    }
    return (await res.json()) as T;
  }

  async createOrder(input: { amountMinor: bigint; currency: string; receipt: string }): Promise<GatewayOrder> {
    const order = await this.call<{ id: string; amount: number; currency: string }>('/orders', { amount: Number(input.amountMinor), currency: input.currency, receipt: input.receipt, payment_capture: 1 });
    return { gateway: 'RAZORPAY', gatewayOrderId: order.id, amountMinor: BigInt(order.amount), currency: order.currency, simulated: false, keyId: this.keyId };
  }

  async createRefund(input: { gatewayPaymentId: string; amountMinor: bigint; receipt: string }): Promise<GatewayRefund> {
    const refund = await this.call<{ id: string; status: string }>(`/payments/${encodeURIComponent(input.gatewayPaymentId)}/refund`, { amount: Number(input.amountMinor), receipt: input.receipt, speed: 'normal' });
    return { gatewayRefundId: refund.id, status: refund.status === 'processed' ? 'processed' : 'pending' };
  }
}

/** Stripe PaymentIntents. The intent id doubles as our "order id"; the browser confirms it with the client secret. */
class StripeGateway implements PaymentGateway {
  readonly name = 'STRIPE' as const;
  constructor(private publishableKey: string, private secretKey: string) {}

  private async call<T>(path: string, form: Record<string, string>, idempotencyKey?: string): Promise<T> {
    const res = await fetch(`https://api.stripe.com/v1${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logger.error({ status: res.status, path }, 'stripe request failed');
      throw new AppError(502, 'SERVICE_UNAVAILABLE', 'Payment gateway request failed');
    }
    return (await res.json()) as T;
  }

  async createOrder(input: { amountMinor: bigint; currency: string; receipt: string }): Promise<GatewayOrder> {
    const pi = await this.call<{ id: string; amount: number; currency: string; client_secret: string }>('/payment_intents', {
      amount: String(input.amountMinor),
      currency: input.currency.toLowerCase(),
      'automatic_payment_methods[enabled]': 'true',
      description: input.receipt,
      'metadata[receipt]': input.receipt,
    }, `pi:${input.receipt}`);
    return { gateway: 'STRIPE', gatewayOrderId: pi.id, amountMinor: BigInt(pi.amount), currency: pi.currency.toUpperCase(), simulated: false, keyId: this.publishableKey, clientSecret: pi.client_secret };
  }

  async createRefund(input: { gatewayPaymentId: string; amountMinor: bigint; receipt: string }): Promise<GatewayRefund> {
    const refund = await this.call<{ id: string; status: string }>('/refunds', { payment_intent: input.gatewayPaymentId, amount: String(input.amountMinor), 'metadata[receipt]': input.receipt }, `rf:${input.receipt}`);
    return { gatewayRefundId: refund.id, status: refund.status === 'succeeded' ? 'processed' : 'pending' };
  }
}

class SimulatedGateway implements PaymentGateway {
  readonly name = 'TEST_GATEWAY' as const;
  async createOrder(input: { amountMinor: bigint; currency: string; receipt: string }): Promise<GatewayOrder> {
    return { gateway: 'TEST_GATEWAY', gatewayOrderId: `order_SIM${randomBytes(7).toString('hex')}`, amountMinor: input.amountMinor, currency: input.currency, simulated: true, keyId: null };
  }
  async createRefund(): Promise<GatewayRefund> {
    return { gatewayRefundId: `rfnd_SIM${randomBytes(7).toString('hex')}`, status: 'pending' };
  }
}

let override: PaymentGateway | undefined;
export function setGatewayForTests(g: PaymentGateway | undefined) {
  override = g;
}

/**
 * The gateway patients pay through right now. Order of precedence: test
 * override → super-admin configuration → RAZORPAY_* environment variables
 * (kept for early deployments) → simulated gateway outside production.
 */
export async function getGateway(): Promise<PaymentGateway> {
  if (override) return override;
  const c = await getPaymentConfig();
  if (c.activeGateway === 'RAZORPAY' && c.razorpay.publicKey && c.razorpay.secretKey) return new RazorpayGateway(c.razorpay.publicKey, c.razorpay.secretKey);
  if (c.activeGateway === 'STRIPE' && c.stripe.publicKey && c.stripe.secretKey) return new StripeGateway(c.stripe.publicKey, c.stripe.secretKey);
  if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) return new RazorpayGateway(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET);
  if (isProduction) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Online payments are not configured');
  return new SimulatedGateway();
}

async function razorpayWebhookSecret(): Promise<string | null> {
  const c = await getPaymentConfig();
  return c.razorpay.webhookSecret ?? env.RAZORPAY_WEBHOOK_SECRET ?? null;
}

/** Razorpay (and the simulator) sign the raw webhook body with HMAC-SHA256 using the webhook secret. */
export async function verifyRazorpaySignature(rawBody: Buffer, signature: string | undefined): Promise<boolean> {
  const secret = await razorpayWebhookSecret();
  if (!secret || !signature) return false;
  return safeEqual(hmacSha256Hex(secret, rawBody), signature);
}

/**
 * Stripe signs `${timestamp}.${rawBody}` and sends `Stripe-Signature: t=…,v1=…`.
 * Events older than five minutes are rejected to stop replays.
 */
export async function verifyStripeSignature(rawBody: Buffer, header: string | undefined, now = Date.now()): Promise<boolean> {
  const secret = (await getPaymentConfig()).stripe.webhookSecret;
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(now / 1000 - t) > 300) return false;
  const expected = hmacSha256Hex(secret, Buffer.concat([Buffer.from(`${t}.`), rawBody]));
  return safeEqual(expected, v1);
}

/** Kept for existing callers; Razorpay-style verification. */
export const verifyWebhookSignature = verifyRazorpaySignature;
