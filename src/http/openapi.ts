import { OpenAPIRegistry, OpenApiGeneratorV31, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description: 'Short-lived access token from POST /api/v1/auth/login',
});

export const ErrorBody = registry.register(
  'Error',
  z.object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
      requestId: z.string().optional(),
    }),
  }),
);

export const PageMeta = z.object({
  limit: z.number().int(),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

export function generateOpenApiDocument() {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Carevanta API',
      version: '1.0.0',
      description:
        'Carevanta healthcare marketplace API. All monetary values are integer minor units (paise) with an ISO-4217 currency code. ' +
        'List endpoints use cursor pagination. Retryable POSTs marked "Idempotency-Key required" must send a unique key per logical operation.',
    },
    servers: [{ url: '/api/v1' }],
  });
}
