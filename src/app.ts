import express, { Router, type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { runWithRequestContext } from './lib/request-context.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { globalLimiter } from './middleware/rate-limit.js';
import { generateOpenApiDocument } from './http/openapi.js';
import { apiRouter } from './routes.js';
import { webhookRouter } from './modules/finance/webhooks.routes.js';

let shuttingDown = false;
export function markShuttingDown() {
  shuttingDown = true;
}

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);
  // BigInt never reaches JSON by accident: money is mapped explicitly, but this
  // guards against a missed field throwing at serialisation time.
  app.set('json replacer', (_key: string, value: unknown) =>
    typeof value === 'bigint' ? (value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString()) : value,
  );

  // Request id + async context (available to logger and audit writer).
  app.use((req, res, next) => {
    const incoming = req.header('x-request-id');
    const requestId = incoming && /^[A-Za-z0-9\-_.]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', requestId);
    runWithRequestContext(
      { requestId, ipAddress: req.ip, userAgent: req.get('user-agent') ?? undefined },
      () => next(),
    );
  });

  app.use(
    pinoHttp({
      logger,
      genReqId: (_req, res) => String(res.getHeader('X-Request-Id')),
      autoLogging: { ignore: (req) => req.url === '/health/live' || req.url === '/health/ready' },
      serializers: {
        req: (req) => ({ method: req.method, url: req.url?.split('?')[0] }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: { 'script-src': ["'self'", "'unsafe-inline'"], 'img-src': ["'self'", 'data:'] }, // swagger-ui
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(
    cors({
      origin: (origin, cb) => {
        // Non-browser clients (mobile apps, server-to-server) send no Origin.
        if (!origin) return cb(null, true);
        cb(null, env.CORS_ORIGINS.includes(origin));
      },
      credentials: false,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id', 'Idempotent-Replayed', 'RateLimit', 'RateLimit-Policy'],
      maxAge: 600,
    }),
  );

  // Health checks expose no internals.
  app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/health/ready', async (_req, res) => {
    if (shuttingDown) {
      res.status(503).json({ status: 'shutting_down' });
      return;
    }
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  // Webhooks need the raw body for signature verification — mount before JSON parser.
  app.use('/api/v1/webhooks', express.raw({ type: 'application/json', limit: '256kb' }), webhookRouter());

  app.use(express.json({ limit: '256kb', strict: true }));
  app.use(globalLimiter);

  const v1 = Router();
  v1.use(apiRouter());
  app.use('/api/v1', v1);

  if (env.OPENAPI_ENABLED) {
    const doc = generateOpenApiDocument();
    app.get('/api/v1/openapi.json', (_req, res) => {
      res.json(doc);
    });
    app.use('/docs', swaggerUi.serve, swaggerUi.setup(doc, { customSiteTitle: 'Carevanta API' }));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
