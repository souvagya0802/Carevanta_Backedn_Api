/**
 * Platform-layer hardening: security headers, CORS allow-list, body limits and
 * parse errors, the error envelope, request ids, cache headers, health
 * semantics, rate-limit headers and the metrics endpoint. Nothing here touches
 * business rules; every expectation is about how the edge of the API behaves
 * for a hostile or careless client.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { markIndexesReady } from '../../src/app.js';
import { resetDatabase } from '../helpers/db.js';
import { actor, api } from '../helpers/factory.js';

// Read by createApp() on first use (lazy in the test factory); this file runs in its own fork.
const METRICS_TOKEN = 'test-only-metrics-token-0123456789';
env.METRICS_ENABLED = true;
env.METRICS_TOKEN = METRICS_TOKEN;

beforeAll(resetDatabase);
const V = '/api/v1';
const ALLOWED_ORIGIN = env.CORS_ORIGINS[0]!;

describe('security headers', () => {
  it('sends Helmet headers and hides the server software', async () => {
    const res = await api().get('/health/live');
    expect(res.status).toBe(200);
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['referrer-policy']).toBeDefined();
  });

  it('API responses are not cacheable unless a handler says so', async () => {
    const sa = await actor(['SUPER_ADMIN']);
    const me = await sa.get(`${V}/auth/me`);
    expect(me.status).toBe(200);
    expect(me.headers['cache-control']).toBe('no-store');
    const missing = await api().get(`${V}/does-not-exist`);
    expect(missing.headers['cache-control']).toBe('no-store');
    // Public reference geography opts into caching explicitly.
    const countries = await api().get(`${V}/public/geo/countries`);
    expect(countries.status).toBe(200);
    expect(countries.headers['cache-control']).toMatch(/max-age=/);
    expect(countries.headers['cache-control']).not.toContain('no-store');
  });
});

describe('CORS allow-list', () => {
  it('reflects an allowed origin and answers preflight', async () => {
    const res = await api().get('/health/live').set('Origin', ALLOWED_ORIGIN);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    const pre = await api().options(`${V}/auth/login`).set('Origin', ALLOWED_ORIGIN).set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'content-type,idempotency-key');
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-methods']).toContain('POST');
    expect(pre.headers['access-control-allow-headers']).toMatch(/Idempotency-Key/i);
    expect(pre.headers['access-control-expose-headers']).toMatch(/X-Request-Id/i);
  });

  it('gives an unknown origin no CORS headers at all', async () => {
    const res = await api().get('/health/live').set('Origin', 'https://evil.example');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('still serves non-browser clients that send no Origin', async () => {
    const res = await api().get('/health/live');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('request ids', () => {
  it('generates one and echoes it in error bodies', async () => {
    const res = await api().get(`${V}/nope`);
    expect(res.status).toBe(404);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('propagates a well-formed caller id and replaces a malformed one', async () => {
    const ok = await api().get('/health/live').set('X-Request-Id', 'edge-abc123-XYZ.7');
    expect(ok.headers['x-request-id']).toBe('edge-abc123-XYZ.7');
    const bad = await api().get('/health/live').set('X-Request-Id', 'x;y z<script>');
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('bodies and parse errors', () => {
  it('malformed JSON → 400 in the standard envelope, no stack', async () => {
    const res = await api().post(`${V}/auth/login`).set('Content-Type', 'application/json').send('{"identifier": ');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { code: 'VALIDATION_FAILED', message: 'Malformed JSON body', requestId: expect.any(String) } });
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.js|SyntaxError|node_modules/);
  });

  it('a JSON primitive at the top level is rejected (strict parser)', async () => {
    const res = await api().post(`${V}/auth/login`).set('Content-Type', 'application/json').send('"just a string"');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('bodies over 256 KB → 413', async () => {
    const res = await api().post(`${V}/auth/login`).set('Content-Type', 'application/json').send(JSON.stringify({ identifier: 'a'.repeat(300 * 1024), password: 'x' }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('a non-JSON content type is ignored, so validation reports the missing fields', async () => {
    const res = await api().post(`${V}/auth/login`).set('Content-Type', 'text/plain').send('identifier=x&password=y');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.issues.some((i: { path: string }) => i.path.startsWith('body.'))).toBe(true);
  });

  it('malformed percent-encoding in the path → 4xx, never a 500', async () => {
    const res = await api().get(`${V}/admin/users/%E0%A4%A`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body.error.code).toBeDefined();
  });
});

describe('error envelope', () => {
  it('unknown routes share the envelope', async () => {
    for (const path of [`${V}/definitely/missing`, '/nothing-here', `${V}/admin/users/not-a-uuid`]) {
      const res = await api().get(path);
      expect([400, 401, 404]).toContain(res.status);
      expect(res.body.error).toMatchObject({ code: expect.any(String), message: expect.any(String), requestId: expect.any(String) });
      expect(res.body.error.stack).toBeUndefined();
    }
  });

  it('unauthenticated and invalid-token calls are 401 without detail about why', async () => {
    const none = await api().get(`${V}/auth/me`);
    expect(none.status).toBe(401);
    expect(none.body.error.code).toBe('UNAUTHENTICATED');
    const junk = await api().get(`${V}/auth/me`).set('Authorization', 'Bearer not.a.jwt');
    expect(junk.status).toBe(401);
    expect(JSON.stringify(junk.body)).not.toMatch(/jose|JWS|signature/i);
  });

  it('validation failures list the offending fields but never echo the submitted values', async () => {
    const res = await api().post(`${V}/auth/login`).send({ identifier: 'not-an-identifier-SECRET', password: 'hunter2-SECRET' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('SECRET');
  });
});

describe('health', () => {
  it('live is always 200 and ready reports starting until indexes are synced', async () => {
    expect((await api().get('/health/live')).body).toEqual({ status: 'ok' });
    const before = await api().get('/health/ready');
    expect(before.status).toBe(503);
    expect(before.body).toEqual({ status: 'starting' });
    markIndexesReady();
    const after = await api().get('/health/ready');
    expect(after.status).toBe(200);
    expect(after.body).toEqual({ status: 'ready' });
  });
});

describe('rate limiting', () => {
  it('login is limited per IP with standard headers and Retry-After', async () => {
    process.env.RATE_LIMIT_IN_TESTS = 'true';
    try {
      let limited: Awaited<ReturnType<ReturnType<typeof api>['post']>> | undefined;
      for (let i = 0; i < 25; i++) {
        const res = await api().post(`${V}/auth/login`).send({ identifier: `nobody-${i}@test.carevanta.local`, password: 'Wrong-Password-1' });
        if (res.status === 429) { limited = res; break; }
        expect(res.status, JSON.stringify(res.body)).toBe(401);
      }
      expect(limited, 'expected the auth limiter (20/min) to trip').toBeDefined();
      expect(limited!.body.error.code).toBe('RATE_LIMITED');
      expect(limited!.headers['retry-after']).toBe('60');
      expect(limited!.headers['ratelimit']).toBeDefined();
      expect(limited!.headers['x-ratelimit-limit']).toBeUndefined();
    } finally {
      delete process.env.RATE_LIMIT_IN_TESTS;
    }
  });
});

describe('metrics', () => {
  it('requires the scrape token and renders Prometheus text with route templates, not raw URLs', async () => {
    await api().get(`${V}/admin/users/00000000-0000-4000-8000-000000000000`); // 401, but counted under the template
    const anon = await api().get('/metrics');
    expect(anon.status).toBe(401);
    const res = await api().get('/metrics').set('Authorization', `Bearer ${METRICS_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('# TYPE carevanta_http_requests_total counter');
    expect(res.text).toMatch(/carevanta_http_requests_total\{method="GET",route="\/api\/v1\/admin\/users\/:id",status="4xx"\} \d+/);
    expect(res.text).not.toContain('00000000-0000-4000-8000-000000000000');
    expect(res.text).toContain('carevanta_http_request_duration_ms_bucket');
  });
});
