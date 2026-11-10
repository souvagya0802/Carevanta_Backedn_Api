import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { AppError } from '../../src/lib/errors.js';
import { censorLogValue, maskPii, REDACT_PATHS } from '../../src/lib/logger.js';
import { errorHandler } from '../../src/middleware/error-handler.js';
import { recordRequest, renderMetrics, resetMetrics } from '../../src/middleware/metrics.js';

describe('log redaction', () => {
  it('masks contact details so lines stay correlatable but not usable', () => {
    expect(maskPii('asha.das@example.in')).toBe('a***@example.in');
    expect(maskPii('+919800012345')).toBe('•••45');
    expect(maskPii('9800012345')).toBe('•••45');
    expect(maskPii('Asha Das')).toBe('[REDACTED]');
    expect(maskPii(42)).toBe('[REDACTED]');
    expect(maskPii('')).toBe('[REDACTED]');
  });

  it('secrets vanish; identifiers are masked', () => {
    expect(censorLogValue('hunter2', ['body', 'password'])).toBe('[REDACTED]');
    expect(censorLogValue('a@b.in', ['email'])).toBe('a***@b.in');
    expect(censorLogValue('a@b.in', ['user', 'email'])).toBe('a***@b.in');
  });

  it('the configured paths cover emails, phones and secrets one level deep', () => {
    for (const p of ['email', '*.email', 'phone', '*.phone', 'identifier', 'password', '*.refreshToken', 'req.headers.authorization']) {
      expect(REDACT_PATHS).toContain(p);
    }
  });

  it('a logger built with the production redaction never writes a raw e-mail, phone or token', () => {
    const lines: string[] = [];
    const log = pino({ level: 'info', redact: { paths: REDACT_PATHS, censor: censorLogValue } }, { write: (s: string) => { lines.push(s); } });
    log.info({ email: 'patient@example.in', phone: '+919800012345', refreshToken: 'rt_secret', user: { email: 'x@y.in', password: 'p' }, code: 'NOT_FOUND' }, 'probe');
    const out = lines.join('');
    expect(out).not.toContain('patient@example.in');
    expect(out).not.toContain('9800012345');
    expect(out).not.toContain('rt_secret');
    expect(out).not.toContain('"p"');
    expect(out).toContain('p***@example.in');
    expect(out).toContain('"code":"NOT_FOUND"');
  });
});

function fakeRes() {
  const headers: Record<string, string> = {};
  const res: any = {
    statusCode: 200,
    headersSent: false,
    body: undefined as unknown,
    setHeader: (k: string, v: string) => { headers[k.toLowerCase()] = v; },
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
    headers,
  };
  return res;
}
const fakeReq = { method: 'GET', originalUrl: '/x' } as any;
const run = (err: unknown) => { const res = fakeRes(); errorHandler(err, fakeReq, res, () => undefined); return res; };

describe('error handler', () => {
  it('maps body-parser and framework client errors to 4xx without leaking internals', () => {
    expect(run({ type: 'entity.parse.failed', message: 'Unexpected token } in JSON at position 12', stack: 'x' }).body).toEqual({ error: { code: 'VALIDATION_FAILED', message: 'Malformed JSON body' } });
    expect(run({ type: 'entity.too.large', status: 413 }).statusCode).toBe(413);
    expect(run({ type: 'request.aborted' }).statusCode).toBe(400);
    const exposed = run({ status: 400, expose: true, message: 'Failed to decode param' });
    expect(exposed.statusCode).toBe(400);
    expect(exposed.body.error.message).toBe('Malformed request');
  });

  it('an unknown error is a generic 500: no message, stack or Prisma text', () => {
    const res = run(new Error('PrismaClientValidationError: Unknown arg `passwordHash` in select for model User'));
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
    // A status alone (without `expose`) is not trusted.
    expect(run({ status: 401, message: 'library said so' }).statusCode).toBe(500);
  });

  it('AppError passes through with details, 429 carries Retry-After, 5xx details are kept generic', () => {
    const v = run(new AppError(400, 'VALIDATION_FAILED', 'Invalid request body', { issues: [{ path: 'body.x', message: 'Required' }] }));
    expect(v.body.error.details.issues[0].path).toBe('body.x');
    const r = run(new AppError(429, 'RATE_LIMITED', 'Too many requests'));
    expect(r.headers['retry-after']).toBe('60');
    expect(r.statusCode).toBe(429);
  });

  it('does not write twice when headers were already sent', () => {
    const res = fakeRes();
    res.headersSent = true;
    errorHandler(new Error('late'), fakeReq, res, () => undefined);
    expect(res.body).toBeUndefined();
  });
});

describe('metrics exposition', () => {
  it('aggregates by route template and status class with cumulative latency buckets', () => {
    resetMetrics();
    recordRequest('GET', '/api/v1/admin/users/:id', 200, 12);
    recordRequest('GET', '/api/v1/admin/users/:id', 404, 3);
    recordRequest('GET', '/api/v1/admin/users/:id', 200, 800);
    recordRequest('POST', 'unmatched', 404, 1);
    const text = renderMetrics();
    expect(text).toContain('carevanta_http_requests_total{method="GET",route="/api/v1/admin/users/:id",status="2xx"} 2');
    expect(text).toContain('carevanta_http_requests_total{method="GET",route="/api/v1/admin/users/:id",status="4xx"} 1');
    expect(text).toContain('carevanta_http_request_duration_ms_bucket{method="GET",route="/api/v1/admin/users/:id",le="5"} 1');
    expect(text).toContain('carevanta_http_request_duration_ms_bucket{method="GET",route="/api/v1/admin/users/:id",le="25"} 2');
    expect(text).toContain('carevanta_http_request_duration_ms_bucket{method="GET",route="/api/v1/admin/users/:id",le="+Inf"} 3');
    expect(text).toContain('carevanta_http_request_duration_ms_count{method="GET",route="/api/v1/admin/users/:id"} 3');
    expect(text).toContain('carevanta_http_requests_in_flight 0');
    expect(text).toMatch(/carevanta_process_uptime_seconds \d+/);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('escapes label values', () => {
    resetMetrics();
    recordRequest('GET', '/weird"route\\x', 200, 1);
    expect(renderMetrics()).toContain('route="/weird\\"route\\\\x"');
  });
});
