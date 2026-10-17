import { randomBytes } from 'node:crypto';
import { env, isProduction } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { hmacSha256Hex, safeEqual } from '../../lib/crypto.js';
import { logger } from '../../lib/logger.js';

/**
 * Payment-gateway port. Production uses Razorpay's REST API; development and
 * tests use a *simulated* gateway that never moves money and is labelled as
 * such in every response. Payment success is NEVER inferred from a client
 * callback — only from a signature-verified webhook processed server-side.
 */
export interface GatewayOrder {
  gatewayOrderId: string;
  amountMinor: bigint;
  currency: string;
  simulated: boolean;
  keyId: string | null;
}

export interface GatewayRefund {
  gatewayRefundId: string;
  status: 'pending' | 'processed';
}

export interface PaymentGateway {
  createOrder(input: { amountMinor: bigint; currency: string; receipt: string }): Promise<GatewayOrder>;
  createRefund(input: { gatewayPaymentId: string; amountMinor: bigint; receipt: string }): Promise<GatewayRefund>;
}

class RazorpayGateway implements PaymentGateway {
  constructor(private keyId: string, private keySecret: string) {}

  private async call<T>(path: string, body: object): Promise<T> {
    const res = await fetch(`https://api.razorpay.com/v1${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
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
    const order = await this.call<{ id: string; amount: number; currency: string }>('/orders', {
      amount: Number(input.amountMinor),
      currency: input.currency,
      receipt: input.receipt,
      payment_capture: 1,
    });
    return { gatewayOrderId: order.id, amountMinor: BigInt(order.amount), currency: order.currency, simulated: false, keyId: this.keyId };
  }

  async createRefund(input: { gatewayPaymentId: string; amountMinor: bigint; receipt: string }): Promise<GatewayRefund> {
    const refund = await this.call<{ id: string; status: string }>(`/payments/${encodeURIComponent(input.gatewayPaymentId)}/refund`, {
      amount: Number(input.amountMinor),
      receipt: input.receipt,
      speed: 'normal',
    });
    return { gatewayRefundId: refund.id, status: refund.status === 'processed' ? 'processed' : 'pending' };
  }
}

class SimulatedGateway implements PaymentGateway {
  async createOrder(input: { amountMinor: bigint; currency: string; receipt: string }): Promise<GatewayOrder> {
    return { gatewayOrderId: `order_SIM${randomBytes(7).toString('hex')}`, amountMinor: input.amountMinor, currency: input.currency, simulated: true, keyId: null };
  }
  async createRefund(): Promise<GatewayRefund> {
    return { gatewayRefundId: `rfnd_SIM${randomBytes(7).toString('hex')}`, status: 'pending' };
  }
}

let override: PaymentGateway | undefined;
export function setGatewayForTests(g: PaymentGateway | undefined) {
  override = g;
}

export function getGateway(): PaymentGateway {
  if (override) return override;
  if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) return new RazorpayGateway(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET);
  if (isProduction) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Online payments are not configured');
  return new SimulatedGateway();
}

/** Razorpay signs the raw webhook body with HMAC-SHA256 using the webhook secret. */
export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
  const secret = env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  return safeEqual(hmacSha256Hex(secret, rawBody), signature);
}
