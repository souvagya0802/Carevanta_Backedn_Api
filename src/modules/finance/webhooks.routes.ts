import { Router, type Request, type Response } from 'express';
import { isProduction } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { auditDetached } from '../../lib/audit.js';
import { verifyWebhookSignature } from './gateway.js';
import { processWebhook } from './payments.service.js';

/**
 * Payment webhooks. Mounted with express.raw so the exact bytes the gateway
 * signed are verified. Responds 2xx for valid (including duplicate) events so
 * the gateway stops retrying; invalid signatures get 401 and are audited.
 */
export function webhookRouter(): Router {
  const r = Router();

  const handle = (gateway: 'RAZORPAY' | 'TEST_GATEWAY') => async (req: Request, res: Response) => {
    const raw = req.body;
    if (!Buffer.isBuffer(raw) || raw.length === 0) throw new AppError(400, 'VALIDATION_FAILED', 'Expected a raw JSON body');
    const signature = req.header('x-razorpay-signature');
    if (!verifyWebhookSignature(raw, signature)) {
      await auditDetached({ action: 'webhook.signature_invalid', entityType: 'webhook', entityId: gateway, actorType: 'WEBHOOK', outcome: 'DENIED' });
      throw new AppError(401, 'WEBHOOK_SIGNATURE_INVALID', 'Invalid webhook signature');
    }
    const eventId = req.header('x-razorpay-event-id');
    if (!eventId || eventId.length > 100) throw new AppError(400, 'VALIDATION_FAILED', 'Missing event id');
    const result = await processWebhook(gateway, eventId, raw);
    res.status(200).json({ data: { received: true, duplicate: result.duplicate, status: result.status } });
  };

  r.post('/razorpay', handle('RAZORPAY'));
  // Simulated gateway for development and automated tests only.
  if (!isProduction) r.post('/test-gateway', handle('TEST_GATEWAY'));
  return r;
}
