import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { z, type ZodType } from 'zod';
import { registry, ErrorBody, PageMeta } from './openapi.js';
import { authenticate, requirePermissions, type AuthContext } from '../middleware/auth.js';
import { idempotency } from '../middleware/idempotency.js';
import { badRequest } from '../lib/errors.js';
import type { PermissionKey } from '../modules/access/permissions.js';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface HandlerContext<P, Q, B> {
  params: P;
  query: Q;
  body: B;
  auth: AuthContext;
  req: Request;
  res: Response;
}

export interface PageResult<T> {
  items: T[];
  page: { limit: number; nextCursor: string | null; hasMore: boolean };
}

interface BaseDef<P extends ZodType, Q extends ZodType, B extends ZodType> {
  method: Method;
  path: string;
  summary: string;
  description?: string;
  tags: string[];
  /** 'required' (default) or 'none' for public endpoints such as login. */
  auth?: 'required' | 'none';
  /** All listed permissions are required (platform RBAC). */
  permissions?: PermissionKey[];
  params?: P;
  query?: Q;
  body?: B;
  status?: 200 | 201 | 202 | 204;
  /** Requires an Idempotency-Key header and replays the stored response on retry. */
  idempotent?: boolean;
  middleware?: RequestHandler[];
}

interface ItemDef<P extends ZodType, Q extends ZodType, B extends ZodType, R extends ZodType> extends BaseDef<P, Q, B> {
  kind?: 'item';
  response?: R;
  handler: (ctx: HandlerContext<z.infer<P>, z.infer<Q>, z.infer<B>>) => Promise<z.input<R> | void>;
}

interface ListDef<P extends ZodType, Q extends ZodType, B extends ZodType, R extends ZodType> extends BaseDef<P, Q, B> {
  kind: 'list';
  response: R; // schema of one item
  handler: (ctx: HandlerContext<z.infer<P>, z.infer<Q>, z.infer<B>>) => Promise<PageResult<z.input<R>>>;
}

const _Empty = z.object({});

function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function parseOrThrow<T extends ZodType>(schema: T | undefined, value: unknown, where: string): z.infer<T> {
  if (!schema) return {} as z.infer<T>;
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw badRequest(`Invalid request ${where}`, {
      issues: result.error.issues.map((i) => ({ path: [where, ...i.path].join('.'), message: i.message, code: i.code })),
    });
  }
  return result.data;
}

/**
 * Declare an endpoint once: validation, auth, permission checks, idempotency,
 * the response envelope and its OpenAPI documentation all come from this
 * definition so the docs cannot drift from the implementation.
 */
export function defineRoute<
  P extends ZodType = typeof _Empty,
  Q extends ZodType = typeof _Empty,
  B extends ZodType = typeof _Empty,
  R extends ZodType = ZodType,
>(router: Router, basePath: string, def: ItemDef<P, Q, B, R> | ListDef<P, Q, B, R>): void {
  const auth = def.auth ?? 'required';
  const status = def.status ?? (def.method === 'post' ? 201 : 200);
  const fullPath = `${basePath}${def.path}`;
  const isList = def.kind === 'list';

  // ── OpenAPI registration ─────────────────────────────────────────────────
  const responses: Record<string, any> = {};
  if (status === 204) {
    responses['204'] = { description: 'No content' };
  } else {
    const dataSchema = def.response
      ? isList
        ? z.object({ data: z.array(def.response), page: PageMeta })
        : z.object({ data: def.response })
      : z.object({ data: z.unknown() });
    responses[String(status)] = { description: 'Success', content: { 'application/json': { schema: dataSchema } } };
  }
  const errorResponse = (description: string) => ({
    description,
    content: { 'application/json': { schema: ErrorBody } },
  });
  responses['400'] = errorResponse('Validation failed');
  if (auth === 'required') {
    responses['401'] = errorResponse('Authentication required');
    responses['403'] = errorResponse('Insufficient permission');
  }
  if (def.params) responses['404'] = errorResponse('Not found');
  if (def.method !== 'get') responses['409'] = errorResponse('Conflict / invalid state transition');

  const descriptionParts = [def.description ?? ''];
  if (def.permissions?.length) descriptionParts.push(`**Required permissions:** ${def.permissions.join(', ')}`);
  if (def.idempotent) descriptionParts.push('**Idempotency-Key header required.**');

  registry.registerPath({
    method: def.method,
    path: toOpenApiPath(fullPath),
    summary: def.summary,
    description: descriptionParts.filter(Boolean).join('\n\n'),
    tags: def.tags,
    security: auth === 'required' ? [{ bearerAuth: [] }] : [],
    request: {
      ...(def.params ? { params: def.params as any } : {}),
      ...(def.query ? { query: def.query as any } : {}),
      ...(def.body ? { body: { content: { 'application/json': { schema: def.body } } } } : {}),
      ...(def.idempotent
        ? { headers: z.object({ 'idempotency-key': z.string().min(8).max(80) }) as any }
        : {}),
    },
    responses,
  });

  // ── Express wiring ───────────────────────────────────────────────────────
  const chain: RequestHandler[] = [];
  if (auth === 'required') chain.push(authenticate);
  if (def.permissions?.length) chain.push(requirePermissions(def.permissions));
  if (def.middleware) chain.push(...def.middleware);
  if (def.idempotent) chain.push(idempotency(`${def.method.toUpperCase()} ${fullPath}`));

  chain.push(async (req: Request, res: Response, _next: NextFunction) => {
    const params = parseOrThrow(def.params, req.params, 'params');
    const query = parseOrThrow(def.query, req.query, 'query');
    const body = parseOrThrow(def.body, req.body, 'body');
    const ctx = { params, query, body, auth: res.locals.auth as AuthContext, req, res };

    if (isList) {
      const result = await (def as ListDef<P, Q, B, R>).handler(ctx);
      res.status(status).json({ data: result.items, page: result.page });
      return;
    }
    const data = await (def as ItemDef<P, Q, B, R>).handler(ctx);
    if (res.headersSent) return;
    if (status === 204) {
      res.status(204).end();
      return;
    }
    res.status(status).json({ data: data ?? null });
  });

  router[def.method](fullPath, ...chain);
}

/** Common params schema for `/:id` routes. */
export const IdParams = z.object({ id: z.uuid() });
