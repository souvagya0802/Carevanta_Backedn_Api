import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, fromDatabaseError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { getRequestContext } from '../lib/request-context.js';

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', 'Route not found'));
};

/**
 * Converts every error into the standard envelope. Unknown errors become a
 * generic 500 — stack traces, SQL and Prisma messages are logged, never sent.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = getRequestContext()?.requestId;
  let appErr: AppError | undefined = err instanceof AppError ? err : undefined;

  if (!appErr && err?.type === 'entity.too.large') appErr = new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body too large');
  if (!appErr && err?.type === 'entity.parse.failed') appErr = new AppError(400, 'VALIDATION_FAILED', 'Malformed JSON body');
  if (!appErr && err?.type === 'charset.unsupported') appErr = new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported charset');
  appErr ??= fromDatabaseError(err);

  if (!appErr) {
    logger.error({ err, method: req.method, path: req.originalUrl }, 'unhandled error');
    appErr = new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  } else if (appErr.status >= 500) {
    logger.error({ err, code: appErr.code }, 'server error');
  } else {
    logger.debug({ code: appErr.code, status: appErr.status }, 'client error');
  }

  if (res.headersSent) return;
  if (appErr.status === 429) res.setHeader('Retry-After', '60');
  res.status(appErr.status).json({
    error: {
      code: appErr.code,
      message: appErr.message,
      ...(appErr.details !== undefined ? { details: appErr.details } : {}),
      ...(requestId ? { requestId } : {}),
    },
  });
};
