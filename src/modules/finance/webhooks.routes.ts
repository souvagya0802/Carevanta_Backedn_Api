import { Router, type Request, type Response } from 'express';
import { isProduction } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { auditDetached } from '../../lib/audit.js';
import { verifyRazorpaySignature, verifyStripeSignature, type LiveGateway } from './gateway.js';
import { processWebhook } from './payments.service.js';

/**
 * Payment webhooks. Mounted with express.raw so the exact bytes the gateway
 * signed are verified. Responds 2xx for valid (including duplicate) events so
 * the gateway stops retrying; invalid signatures get 401 and are audited.
 *
 *   POST /webhooks/razorpay      x-razorpay-signature, x-razorpay-event-id
 *   POST /webhooks/stripe        Stripe-Signature; the event id is in the body
 *   POST /webhooks/test-gateway  simulator (never in production)
 */
export function webhookRouter(): Router {
  const r = Router();

  const rawBody = (req: Request): Buffer => {
    const raw = req.body;
    if (!Buffer.isBuffer(raw) || raw.length === 0) throw new AppError(400, 'VALIDATION_FAILED', 'Expected a raw JSON body');
    return raw;
  };
  const rejected = async (gateway: LiveGateway) => {
    await auditDetached({ action: 'webhook.signature_invalid', entityType: 'webhook', entityId: gateway, actorType: 'WEBHOOK', outcome: 'DENIED' });
    throw new AppError(401, 'WEBHOOK_SIGNATURE_INVALID', 'Invalid webhook signature');
  };

  const razorpayStyle = (gateway: 'RAZORPAY' | 'TEST_GATEWAY') => async (req: Request, res: Response) => {
    const raw = rawBody(req);
    if (!(await verifyRazorpaySignature(raw, req.header('x-razorpay-signature')))) await rejected(gateway);
    const eventId = req.header('x-razorpay-event-id');
    if (!eventId || eventId.length > 100) throw new AppError(400, 'VALIDATION_FAILED', 'Missing event id');
    const result = await processWebhook(gateway, eventId, raw);
    res.status(200).json({ data: { received: true, duplicate: result.duplicate, status: result.status } });
  };

  r.post('/razorpay', razorpayStyle('RAZORPAY'));
  r.post('/stripe', async (req: Request, res: Response) => {
    const raw = rawBody(req);
    if (!(await verifyStripeSignature(raw, req.header('stripe-signature')))) await rejected('STRIPE');
    let eventId: unknown;
    try { eventId = (JSON.parse(raw.toString('utf8')) as { id?: unknown }).id; } catch { throw new AppError(400, 'VALIDATION_FAILED', 'Malformed webhook body'); }
    if (typeof eventId !== 'string' || !eventId || eventId.length > 100) throw new AppError(400, 'VALIDATION_FAILED', 'Missing event id');
    const result = await processWebhook('STRIPE', eventId, raw);
    res.status(200).json({ data: { received: true, duplicate: result.duplicate, status: result.status } });
  });
  // Simulated gateway for development and automated tests only.
  if (!isProduction) r.post('/test-gateway', razorpayStyle('TEST_GATEWAY'));
  return r;
}
