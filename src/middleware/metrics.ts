import type { RequestHandler } from 'express';

/**
 * In-process request metrics in Prometheus text exposition format, without a
 * metrics library: a counter per (method, route template, status class), a
 * latency histogram per route template, and an in-flight gauge. Labels are
 * bounded by the number of declared routes (unmatched paths share one label),
 * so the series count cannot be inflated by a client. Per instance; a scraper
 * adds the instance label. Reset on restart, like any process-local metric.
 */
const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

interface Histogram { buckets: number[]; sum: number; count: number }

const requestsTotal = new Map<string, number>();
const latency = new Map<string, Histogram>();
let inFlight = 0;
const startedAt = Date.now();

function key(...parts: string[]): string {
  return parts.join('\u0000');
}

/**
 * The route template that matched (`/api/v1/admin/users/:id`), never the raw URL: ids and query strings would
 * explode the label set. Express restores `req.baseUrl` before `finish` fires, so the mount prefix is recovered
 * from the request path: the template matched the trailing segments, everything before them is the mount.
 */
export function routeLabel(req: { route?: { path?: unknown }; originalUrl?: string }): string {
  const template = typeof req.route?.path === 'string' ? req.route.path : undefined;
  if (!template) return 'unmatched';
  const path = (req.originalUrl ?? '').split('?')[0] ?? '';
  const templateSegments = template.split('/').filter(Boolean).length;
  const pathSegments = path.split('/').filter(Boolean);
  const prefix = pathSegments.slice(0, Math.max(0, pathSegments.length - templateSegments));
  return `${prefix.length ? '/' + prefix.join('/') : ''}${template}`;
}

export function recordRequest(method: string, route: string, status: number, ms: number): void {
  const statusClass = `${Math.floor(status / 100)}xx`;
  const k = key(method, route, statusClass);
  requestsTotal.set(k, (requestsTotal.get(k) ?? 0) + 1);
  const hk = key(method, route);
  let h = latency.get(hk);
  if (!h) {
    h = { buckets: new Array<number>(LATENCY_BUCKETS_MS.length).fill(0), sum: 0, count: 0 };
    latency.set(hk, h);
  }
  for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) if (ms <= LATENCY_BUCKETS_MS[i]!) h.buckets[i] = (h.buckets[i] ?? 0) + 1;
  h.sum += ms;
  h.count += 1;
}

export const metricsMiddleware: RequestHandler = (req, res, next) => {
  const started = process.hrtime.bigint();
  inFlight += 1;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    inFlight -= 1;
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    recordRequest(req.method, routeLabel(req), res.statusCode, ms);
  };
  res.on('finish', finish);
  res.on('close', finish);
  next();
};

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/** Prometheus text format (version 0.0.4). */
export function renderMetrics(): string {
  const lines: string[] = [];
  lines.push('# HELP carevanta_http_requests_total HTTP requests by method, route template and status class.');
  lines.push('# TYPE carevanta_http_requests_total counter');
  for (const [k, v] of requestsTotal) {
    const [method, route, status] = k.split('\u0000');
    lines.push(`carevanta_http_requests_total{method="${method}",route="${esc(route ?? '')}",status="${status}"} ${v}`);
  }
  lines.push('# HELP carevanta_http_request_duration_ms HTTP request latency in milliseconds by method and route template.');
  lines.push('# TYPE carevanta_http_request_duration_ms histogram');
  for (const [k, h] of latency) {
    const [method, route] = k.split('\u0000');
    const labels = `method="${method}",route="${esc(route ?? '')}"`;
    LATENCY_BUCKETS_MS.forEach((le, i) => lines.push(`carevanta_http_request_duration_ms_bucket{${labels},le="${le}"} ${h.buckets[i]}`));
    lines.push(`carevanta_http_request_duration_ms_bucket{${labels},le="+Inf"} ${h.count}`);
    lines.push(`carevanta_http_request_duration_ms_sum{${labels}} ${h.sum.toFixed(3)}`);
    lines.push(`carevanta_http_request_duration_ms_count{${labels}} ${h.count}`);
  }
  lines.push('# HELP carevanta_http_requests_in_flight Requests currently being handled.');
  lines.push('# TYPE carevanta_http_requests_in_flight gauge');
  lines.push(`carevanta_http_requests_in_flight ${inFlight}`);
  lines.push('# HELP carevanta_process_uptime_seconds Seconds since the process started.');
  lines.push('# TYPE carevanta_process_uptime_seconds gauge');
  lines.push(`carevanta_process_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`);
  const mem = process.memoryUsage();
  lines.push('# HELP carevanta_process_resident_memory_bytes Resident set size.');
  lines.push('# TYPE carevanta_process_resident_memory_bytes gauge');
  lines.push(`carevanta_process_resident_memory_bytes ${mem.rss}`);
  return lines.join('\n') + '\n';
}

/** Test hook. */
export function resetMetrics(): void {
  requestsTotal.clear();
  latency.clear();
  inFlight = 0;
}
