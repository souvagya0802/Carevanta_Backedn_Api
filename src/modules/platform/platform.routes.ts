import { Router } from 'express';
import { z } from 'zod';
import { defineRoute, IdParams } from '../../http/route.js';
import { prisma } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, isPgError, notFound } from '../../lib/errors.js';
import { buildPage, cursorOrderBy, cursorWhere, PaginationQuery } from '../../lib/pagination.js';
import { DateTimeString, Reason, iso } from '../../http/dto.js';
import { makeReference, REF } from '../../lib/reference.js';
import { invalidateSetting } from '../settings/settings.service.js';
import { describeSetting, validateSettingValue } from '../settings/settings.meta.js';
import { NOTIFICATION_CATALOGUE, channelDrivers, deliverQueuedNotifications, htmlToText, isHtml, maskRecipient, notificationKeyInfo, placeholders, render, smsSegments } from '../notifications/notifications.service.js';
import { sendEmail } from './integrations.service.js';
import { env } from '../../config/env.js';
import type { Prisma } from '../../../generated/prisma/client.js';

const Passthrough = z.object({ id: z.uuid() }).passthrough();

export function platformRouter(): Router {
  const r = Router();

  // ── Settings ───────────────────────────────────────────────────────────
  type SettingRow = { key: string; value: unknown; description: string | null; isSensitive: boolean; version: number; updatedById: string | null; updatedAt: Date };
  const settingDto = (s: SettingRow, updatedBy: { id: string; fullName: string } | null) => {
    const meta = describeSetting(s.key);
    return {
      key: s.key,
      value: s.isSensitive ? '[SENSITIVE]' : s.value,
      description: s.description,
      isSensitive: s.isSensitive,
      version: s.version,
      updatedById: s.updatedById,
      updatedBy,
      updatedAt: s.updatedAt.toISOString(),
      meta: {
        label: meta.label ?? s.key.split('.').slice(1).join(' ').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
        group: meta.group,
        groupLabel: meta.groupLabel,
        groupDescription: meta.groupDescription,
        type: meta.type ?? (typeof s.value === 'boolean' ? 'boolean' : typeof s.value === 'number' ? 'number' : typeof s.value === 'string' ? 'string' : 'json'),
        unit: meta.unit ?? null,
        min: meta.min ?? null,
        max: meta.max ?? null,
        step: meta.step ?? null,
        pattern: meta.pattern ?? null,
        patternHint: meta.patternHint ?? null,
        options: meta.options ?? null,
        risk: meta.risk ?? 'medium',
        help: meta.help ?? null,
        default: meta.known ? meta.default : null,
        isDefault: meta.known && JSON.stringify(meta.default) === JSON.stringify(s.value),
      },
    };
  };
  /** Resolve updater names in one query so the UI can show who changed what. */
  async function updaterNames(ids: (string | null)[]) {
    const unique = Array.from(new Set(ids.filter((x): x is string => !!x)));
    if (!unique.length) return new Map<string, { id: string; fullName: string }>();
    const users = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, fullName: true } });
    return new Map(users.map((u) => [u.id, u]));
  }

  defineRoute(r, '/admin/settings', {
    method: 'get',
    path: '',
    summary: 'Platform settings',
    tags: ['Admin · Settings'],
    permissions: ['settings.read'],
    description: 'Each setting carries presentation metadata (label, group, type, unit, bounds, risk, default) so clients never hardcode it.',
    response: z.array(z.object({ key: z.string(), value: z.unknown(), description: z.string().nullable(), isSensitive: z.boolean(), version: z.number().int(), meta: z.object({ label: z.string(), group: z.string(), type: z.string(), risk: z.string() }).passthrough() }).passthrough()),
    handler: async () => {
      const rows = await prisma.platformSetting.findMany({ orderBy: { key: 'asc' } });
      const names = await updaterNames(rows.map((x) => x.updatedById));
      return rows.map((x) => settingDto(x, x.updatedById ? (names.get(x.updatedById) ?? null) : null));
    },
  });

  defineRoute(r, '/admin/settings', {
    method: 'put',
    path: '/:key',
    summary: 'Change a setting (optimistic concurrency, audited)',
    tags: ['Admin · Settings'],
    status: 200,
    permissions: ['settings.manage'],
    params: z.object({ key: z.string().regex(/^[a-z0-9_.]{3,96}$/) }),
    body: z.object({ value: z.union([z.string().max(2000), z.number(), z.boolean(), z.record(z.string(), z.unknown())]), expectedVersion: z.number().int().min(1), reason: Reason }),
    response: z.object({ key: z.string(), value: z.unknown(), version: z.number().int() }).passthrough(),
    handler: async ({ params, body, auth }) => {
      const updated = await prisma.$transaction(async (tx) => {
        if (/^(smtp|branding|payments|push|patient)./.test(params.key)) throw badRequest('Use the dedicated configuration screen (Branding, Email, Payments, Push or Patient App) for this setting');
        const s = await tx.platformSetting.findUnique({ where: { key: params.key } });
        if (!s) throw notFound('Setting');
        if (typeof s.value !== typeof body.value) throw badRequest(`This setting expects a ${typeof s.value}`);
        const problem = validateSettingValue(params.key, s.value, body.value);
        if (problem) throw badRequest(problem, { field: 'value' });
        if (JSON.stringify(s.value) === JSON.stringify(body.value)) throw badRequest('The value is unchanged', { field: 'value' });
        const res = await tx.platformSetting.updateMany({ where: { key: params.key, version: body.expectedVersion }, data: { value: body.value as object, version: { increment: 1 }, updatedById: auth.userId } });
        if (res.count !== 1) throw conflict('The setting changed concurrently; reload and retry');
        await audit(tx, { action: 'settings.changed', entityType: 'platform_setting', entityId: params.key, metadata: { from: s.isSensitive ? '[SENSITIVE]' : s.value, to: s.isSensitive ? '[SENSITIVE]' : body.value, reason: body.reason } });
        return tx.platformSetting.findUniqueOrThrow({ where: { key: params.key } });
      });
      invalidateSetting(params.key);
      const names = await updaterNames([updated.updatedById]);
      return settingDto(updated, updated.updatedById ? (names.get(updated.updatedById) ?? null) : null);
    },
  });

  // ── Audit log ──────────────────────────────────────────────────────────
  defineRoute(r, '/admin/audit-events', {
    kind: 'list',
    method: 'get',
    path: '',
    summary: 'Search the audit log',
    tags: ['Admin · Audit'],
    permissions: ['audit.read'],
    query: PaginationQuery.extend({
      action: z.string().max(96).optional(),
      entityType: z.string().max(48).optional(),
      entityId: z.string().max(64).optional(),
      actorUserId: z.uuid().optional(),
      outcome: z.enum(['SUCCESS', 'DENIED', 'FAILURE']).optional(),
      from: DateTimeString.optional(),
      to: DateTimeString.optional(),
    }),
    response: Passthrough,
    handler: async ({ query }) => {
      const where: Prisma.AuditEventWhereInput = {
        ...(query.action ? { action: query.action.endsWith('*') ? { startsWith: query.action.slice(0, -1) } : query.action } : {}),
        ...(query.entityType ? { entityType: query.entityType } : {}),
        ...(query.entityId ? { entityId: query.entityId } : {}),
        ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
        ...(query.outcome ? { outcome: query.outcome } : {}),
        ...(query.from || query.to ? { occurredAt: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lt: new Date(query.to) } : {}) } } : {}),
        ...cursorWhere(query.cursor, 'occurredAt'),
      };
      const rows = await prisma.auditEvent.findMany({ where, orderBy: cursorOrderBy('occurredAt'), take: query.limit + 1 });
      const { items, page } = buildPage(rows, query.limit, (e) => e.occurredAt);
      return { items: items.map((e) => ({ ...e, occurredAt: e.occurredAt.toISOString() })), page };
    },
  });

  defineRoute(r, '/admin/audit-events', {
    kind: 'list',
    method: 'get',
    path: '/sensitive-access',
    summary: 'Who opened which medical report / credential document',
    tags: ['Admin · Audit'],
    permissions: ['audit.read'],
    query: PaginationQuery.extend({ resourceType: z.string().max(48).optional(), resourceId: z.uuid().optional(), actorUserId: z.uuid().optional() }),
    response: Passthrough,
    handler: async ({ query }) => {
      const rows = await prisma.sensitiveAccessLog.findMany({
        where: {
          ...(query.resourceType ? { resourceType: query.resourceType } : {}),
          ...(query.resourceId ? { resourceId: query.resourceId } : {}),
          ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
          ...cursorWhere(query.cursor, 'accessedAt'),
        },
        orderBy: cursorOrderBy('accessedAt'),
        take: query.limit + 1,
      });
      const { items, page } = buildPage(rows, query.limit, (e) => e.accessedAt);
      return { items: items.map((e) => ({ ...e, accessedAt: e.accessedAt.toISOString() })), page };
    },
  });

  // ── Notifications ──────────────────────────────────────────────────────
  defineRoute(r, '/admin/notifications', {
    kind: 'list',
    method: 'get',
    path: '',
    summary: 'Notification outbox (recipients masked, payloads never shown)',
    tags: ['Admin · Notifications'],
    permissions: ['notifications.read'],
    query: PaginationQuery.extend({
      status: z.enum(['QUEUED', 'SENT', 'FAILED', 'CANCELLED']).optional(),
      channel: z.enum(['EMAIL', 'SMS', 'PUSH', 'IN_APP']).optional(),
      templateKey: z.string().max(96).optional(),
      userId: z.uuid().optional(),
      from: DateTimeString.optional(),
      to: DateTimeString.optional(),
    }),
    response: Passthrough,
    handler: async ({ query }) => {
      const rows = await prisma.notification.findMany({
        where: {
          ...(query.status ? { status: query.status } : {}),
          ...(query.channel ? { channel: query.channel } : {}),
          ...(query.templateKey ? { templateKey: query.templateKey } : {}),
          ...(query.userId ? { userId: query.userId } : {}),
          ...(query.from || query.to ? { createdAt: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lt: new Date(query.to) } : {}) } } : {}),
          ...cursorWhere(query.cursor),
        },
        orderBy: cursorOrderBy(),
        take: query.limit + 1,
      });
      const { items, page } = buildPage(rows, query.limit, (n) => n.createdAt);
      return {
        page,
        items: items.map((n) => ({ id: n.id, userId: n.userId, channel: n.channel, templateKey: n.templateKey, recipient: maskRecipient(n.recipient), status: n.status, attempts: n.attempts, lastError: n.lastError, sentAt: iso(n.sentAt), createdAt: n.createdAt.toISOString() })),
      };
    },
  });

  defineRoute(r, '/admin/notifications', {
    method: 'get',
    path: '/stats',
    summary: 'Outbox health: counts by status, last-24h volume, oldest queued item, channel drivers',
    tags: ['Admin · Notifications'],
    permissions: ['notifications.read'],
    response: z.object({
      byStatus: z.record(z.string(), z.number().int()),
      last24h: z.record(z.string(), z.number().int()),
      byChannel24h: z.record(z.string(), z.number().int()),
      oldestQueuedAt: z.string().nullable(),
      drivers: z.record(z.string(), z.enum(['smtp', 'log', 'webpush', 'inapp'])),
      processing: z.enum(['inline', 'background']),
    }),
    handler: async () => {
      const since = new Date(Date.now() - 24 * 3_600_000);
      const [byStatus, last24h, byChannel24h, oldest, drivers] = await Promise.all([
        prisma.notification.groupBy({ by: ['status'], _count: { _all: true } }),
        prisma.notification.groupBy({ by: ['status'], _count: { _all: true }, where: { createdAt: { gte: since } } }),
        prisma.notification.groupBy({ by: ['channel'], _count: { _all: true }, where: { createdAt: { gte: since } } }),
        prisma.notification.findFirst({ where: { status: 'QUEUED' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
        channelDrivers(),
      ]);
      return {
        byStatus: Object.fromEntries(byStatus.map((x) => [x.status, x._count._all])),
        last24h: Object.fromEntries(last24h.map((x) => [x.status, x._count._all])),
        byChannel24h: Object.fromEntries(byChannel24h.map((x) => [x.channel, x._count._all])),
        oldestQueuedAt: iso(oldest?.createdAt ?? null),
        drivers,
        processing: env.JOBS_ENABLED ? ('background' as const) : ('inline' as const),
      };
    },
  });

  defineRoute(r, '/admin/notifications', {
    method: 'post',
    path: '/:id/retry',
    summary: 'Re-queue a failed notification',
    tags: ['Admin · Notifications'],
    status: 200,
    permissions: ['notifications.manage'],
    params: IdParams,
    response: Passthrough,
    handler: async ({ params }) => {
      const res = await prisma.notification.updateMany({ where: { id: params.id, status: 'FAILED' }, data: { status: 'QUEUED', attempts: 0, lastError: null } });
      if (res.count === 0) throw conflict('Only FAILED notifications can be retried');
      await audit(prisma, { action: 'notification.retried', entityType: 'notification', entityId: params.id });
      return { id: params.id, status: 'QUEUED' };
    },
  });

  defineRoute(r, '/admin/notifications', {
    method: 'post',
    path: '/:id/cancel',
    summary: 'Cancel a queued notification so it is never delivered',
    tags: ['Admin · Notifications'],
    status: 200,
    permissions: ['notifications.manage'],
    params: IdParams,
    body: z.object({ reason: Reason }),
    response: Passthrough,
    handler: async ({ params, body }) => {
      // Dropping the payload also discards any one-time code it carried.
      const res = await prisma.notification.updateMany({ where: { id: params.id, status: 'QUEUED' }, data: { status: 'CANCELLED', payload: {}, lastError: `Cancelled: ${body.reason}`.slice(0, 1000) } });
      if (res.count === 0) throw conflict('Only QUEUED notifications can be cancelled');
      await audit(prisma, { action: 'notification.cancelled', entityType: 'notification', entityId: params.id, metadata: { reason: body.reason } });
      return { id: params.id, status: 'CANCELLED' };
    },
  });

  defineRoute(r, '/admin/notifications', {
    method: 'post',
    path: '/retry-failed',
    summary: 'Re-queue every failed notification (optionally one template key)',
    tags: ['Admin · Notifications'],
    status: 200,
    permissions: ['notifications.manage'],
    body: z.object({ templateKey: z.string().max(96).optional() }).default({}),
    response: z.object({ requeued: z.number().int() }),
    handler: async ({ body }) => {
      const res = await prisma.notification.updateMany({ where: { status: 'FAILED', ...(body.templateKey ? { templateKey: body.templateKey } : {}) }, data: { status: 'QUEUED', attempts: 0, lastError: null } });
      if (res.count > 0) await audit(prisma, { action: 'notification.retried_all', entityType: 'notification', entityId: null, metadata: { count: res.count, templateKey: body.templateKey ?? null } });
      return { requeued: res.count };
    },
  });

  defineRoute(r, '/admin/notifications', {
    method: 'post',
    path: '/deliver-now',
    summary: 'Drain the queue immediately (otherwise the worker runs every minute)',
    tags: ['Admin · Notifications'],
    status: 200,
    permissions: ['notifications.manage'],
    response: z.object({ sent: z.number().int(), remaining: z.number().int() }),
    handler: async () => {
      const sent = await deliverQueuedNotifications(100);
      const remaining = await prisma.notification.count({ where: { status: 'QUEUED' } });
      await audit(prisma, { action: 'notification.delivered_now', entityType: 'notification', entityId: null, metadata: { sent, remaining } });
      return { sent, remaining };
    },
  });

  const TemplateDto = z.object({ id: z.uuid(), key: z.string(), channel: z.string(), locale: z.string(), version: z.number().int(), subject: z.string().nullable(), body: z.string(), isActive: z.boolean() });
  const Channel = z.enum(['EMAIL', 'SMS', 'PUSH', 'IN_APP']);
  const Locale = z.enum(['en', 'bn', 'hi']);

  /** Problems a template would have at delivery time. Returned by preview and enforced on publish. */
  function lintTemplate(input: { key: string; channel: string; subject?: string | null; body: string }) {
    const info = notificationKeyInfo(input.key);
    const used = placeholders(`${input.subject ?? ''} ${input.body}`);
    const known = info ? Object.keys(info.variables) : null;
    const unknown = known ? used.filter((p) => !known.includes(p)) : [];
    const unused = known ? known.filter((k) => !used.includes(k)) : [];
    const errors: string[] = [];
    const warnings: string[] = [];
    if (input.channel === 'EMAIL' && !input.subject?.trim()) errors.push('Email templates need a subject');
    if (unknown.length) errors.push(`Unknown placeholder${unknown.length > 1 ? 's' : ''} for ${input.key}: ${unknown.map((u) => `{{${u}}}`).join(', ')} (they would render empty)`);
    if (!info) warnings.push(`No code path sends "${input.key}" yet — this template will not be used until one does`);
    else if (!info.channels.includes(input.channel as never)) warnings.push(`${input.key} is only sent by ${info.channels.join(' and ')}; a ${input.channel} template will not be used`);
    if (unused.length) warnings.push(`Not using ${unused.map((u) => `{{${u}}}`).join(', ')} — make sure the message still makes sense without it`);
    const sample = info?.sample ?? Object.fromEntries(used.map((u) => [u, `<${u}>`]));
    const body = render(input.body, sample);
    const html = isHtml(input.body);
    if (html && input.channel !== 'EMAIL') errors.push(`${input.channel} messages are plain text; remove the HTML tags`);
    const rendered = { subject: input.subject ? render(input.subject, sample) : null, body, isHtml: html, text: html ? htmlToText(body) : body };
    const sms = input.channel === 'SMS' ? smsSegments(rendered.body) : null;
    if (sms && sms.segments > 3) warnings.push(`Long SMS: ${sms.segments} parts (${sms.encoding}); carriers may truncate or reject it`);
    return { errors, warnings, placeholders: used, rendered, sms };
  }

  defineRoute(r, '/admin/notification-templates', {
    method: 'get',
    path: '/catalogue',
    summary: 'Template keys the platform sends, their variables, and which (key, channel, locale) lack an active template',
    tags: ['Admin · Notifications'],
    permissions: ['notifications.read'],
    response: z.object({
      keys: z.array(z.object({ key: z.string(), description: z.string(), variables: z.record(z.string(), z.string()), channels: z.array(z.string()), sample: z.record(z.string(), z.string()) })),
      channels: z.array(z.string()),
      locales: z.array(z.string()),
      missing: z.array(z.object({ key: z.string(), channel: z.string(), locale: z.string() })),
    }),
    handler: async () => {
      const active = await prisma.notificationTemplate.findMany({ where: { isActive: true }, select: { key: true, channel: true, locale: true } });
      const has = new Set(active.map((t) => `${t.key}|${t.channel}|${t.locale}`));
      // English is the fallback locale and the only one deliveries resolve today, so it is the one that must exist.
      const missing = NOTIFICATION_CATALOGUE.flatMap((k) => k.channels.filter((c) => !has.has(`${k.key}|${c}|en`)).map((c) => ({ key: k.key, channel: c, locale: 'en' })));
      return { keys: NOTIFICATION_CATALOGUE.map((k) => ({ ...k, channels: [...k.channels] })), channels: Channel.options, locales: Locale.options, missing };
    },
  });

  defineRoute(r, '/admin/notification-templates', {
    method: 'post',
    path: '/preview',
    summary: 'Render a draft with sample variables and report problems (nothing is saved)',
    tags: ['Admin · Notifications'],
    status: 200,
    permissions: ['notifications.read'],
    body: z.object({ key: z.string().max(96), channel: Channel, subject: z.string().max(200).optional(), body: z.string().max(8000) }),
    response: z.object({ errors: z.array(z.string()), warnings: z.array(z.string()), placeholders: z.array(z.string()), rendered: z.object({ subject: z.string().nullable(), body: z.string(), isHtml: z.boolean(), text: z.string() }), sms: z.object({ encoding: z.string(), length: z.number().int(), segments: z.number().int() }).nullable() }),
    handler: async ({ body }) => lintTemplate(body),
  });

  defineRoute(r, '/admin/notification-templates', {
    method: 'post',
    path: '/test-send',
    summary: 'Email the active template for a key to an address, rendered with sample variables (audited)',
    tags: ['Admin · Notifications'],
    status: 200,
    permissions: ['notifications.manage'],
    body: z.object({ key: z.string().max(96), locale: Locale.default('en'), to: z.email() }),
    response: z.object({ messageId: z.string(), subject: z.string() }),
    handler: async ({ body, auth }) => {
      const t = await prisma.notificationTemplate.findFirst({ where: { key: body.key, channel: 'EMAIL', locale: body.locale, isActive: true } });
      if (!t) throw notFound('Active EMAIL template');
      const sample = notificationKeyInfo(body.key)?.sample ?? {};
      const subject = `[TEST] ${render(t.subject ?? 'Carevanta', sample)}`;
      const rendered = render(t.body, sample);
      const note = 'Test message sent from the Carevanta admin panel with sample values. No real code or booking is attached.';
      const html = isHtml(rendered);
      const { messageId } = await sendEmail(body.to, subject, `${html ? htmlToText(rendered) : rendered}\n\n— ${note}`, html ? `${rendered}<p style="font:12px/1.5 Arial,sans-serif;color:#6b7280;margin-top:16px">— ${note}</p>` : undefined);
      await audit(prisma, { action: 'notification_template.test_sent', entityType: 'notification_template', entityId: t.id, actorUserId: auth.userId, metadata: { key: t.key, to: maskRecipient(body.to) } });
      return { messageId, subject };
    },
  });
  defineRoute(r, '/admin/notification-templates', {
    method: 'get',
    path: '',
    summary: 'Notification templates (all versions)',
    tags: ['Admin · Notifications'],
    permissions: ['notifications.read'],
    response: z.array(TemplateDto),
    handler: async () =>
      (await prisma.notificationTemplate.findMany({ orderBy: [{ key: 'asc' }, { channel: 'asc' }, { version: 'desc' }] })).map((t) => ({
        id: t.id, key: t.key, channel: t.channel, locale: t.locale, version: t.version, subject: t.subject, body: t.body, isActive: t.isActive,
      })),
  });

  defineRoute(r, '/admin/notification-templates', {
    method: 'post',
    path: '',
    summary: 'Publish a new template version (previous version is deactivated)',
    tags: ['Admin · Notifications'],
    permissions: ['notifications.manage'],
    body: z.object({
      key: z.string().regex(/^[a-z0-9_.]{3,96}$/, 'Lower-case letters, digits, dots and underscores only'),
      channel: Channel,
      locale: Locale.default('en'),
      subject: z.string().trim().max(200).optional(),
      body: z.string().trim().min(1).max(8000),
    }),
    response: TemplateDto,
    handler: async ({ body, auth }) => {
      const lint = lintTemplate(body);
      if (lint.errors.length) throw badRequest(lint.errors[0]!, { errors: lint.errors, warnings: lint.warnings });
      return prisma.$transaction(async (tx) => {
        const latest = await tx.notificationTemplate.findFirst({ where: { key: body.key, channel: body.channel, locale: body.locale }, orderBy: { version: 'desc' } });
        await tx.notificationTemplate.updateMany({ where: { key: body.key, channel: body.channel, locale: body.locale, isActive: true }, data: { isActive: false } });
        const t = await tx.notificationTemplate.create({ data: { ...body, subject: body.subject ?? null, version: (latest?.version ?? 0) + 1, updatedById: auth.userId } });
        await audit(tx, { action: 'notification_template.published', entityType: 'notification_template', entityId: t.id, metadata: { key: t.key, channel: t.channel, version: t.version } });
        return { id: t.id, key: t.key, channel: t.channel, locale: t.locale, version: t.version, subject: t.subject, body: t.body, isActive: t.isActive };
      });
    },
  });

  const templateDto = (t: { id: string; key: string; channel: string; locale: string; version: number; subject: string | null; body: string; isActive: boolean }) => ({ id: t.id, key: t.key, channel: t.channel, locale: t.locale, version: t.version, subject: t.subject, body: t.body, isActive: t.isActive });

  defineRoute(r, '/admin/notification-templates', {
    method: 'post',
    path: '/:id/activate',
    summary: 'Make this version the active one for its key, channel and language (any other active version is deactivated)',
    tags: ['Admin · Notifications'],
    status: 200,
    permissions: ['notifications.manage'],
    params: IdParams,
    response: TemplateDto,
    handler: async ({ params, auth }) =>
      prisma.$transaction(async (tx) => {
        const t = await tx.notificationTemplate.findUnique({ where: { id: params.id } });
        if (!t) throw notFound('Notification template');
        if (t.isActive) return templateDto(t);
        await tx.notificationTemplate.updateMany({ where: { key: t.key, channel: t.channel, locale: t.locale, isActive: true }, data: { isActive: false } });
        const u = await tx.notificationTemplate.update({ where: { id: t.id }, data: { isActive: true, updatedById: auth.userId } });
        await audit(tx, { action: 'notification_template.activated', entityType: 'notification_template', entityId: t.id, metadata: { key: t.key, channel: t.channel, locale: t.locale, version: t.version } });
        return templateDto(u);
      }),
  });

  defineRoute(r, '/admin/notification-templates', {
    method: 'post',
    path: '/:id/deactivate',
    summary: 'Switch this version off; deliveries of its key and channel are skipped (not retried) until a version is active again',
    tags: ['Admin · Notifications'],
    status: 200,
    permissions: ['notifications.manage'],
    params: IdParams,
    body: z.object({ reason: Reason.optional() }).default({}),
    response: TemplateDto,
    handler: async ({ params, body, auth }) => {
      const t = await prisma.notificationTemplate.findUnique({ where: { id: params.id } });
      if (!t) throw notFound('Notification template');
      if (!t.isActive) throw conflict('This version is already inactive');
      const u = await prisma.notificationTemplate.update({ where: { id: t.id }, data: { isActive: false, updatedById: auth.userId } });
      await audit(prisma, { action: 'notification_template.deactivated', entityType: 'notification_template', entityId: t.id, actorUserId: auth.userId, metadata: { key: t.key, channel: t.channel, locale: t.locale, version: t.version, reason: body.reason ?? null } });
      return templateDto(u);
    },
  });

  // ── Regions ────────────────────────────────────────────────────────────
  const RegionDto = z.object({ id: z.uuid(), code: z.string(), name: z.string(), district: z.string(), state: z.string(), status: z.string(), launchedAt: z.string().nullable(), providerCount: z.number().int() });
  const regionDto = (x: any) => ({ id: x.id, code: x.code, name: x.name, district: x.district, state: x.state, status: x.status, launchedAt: iso(x.launchedAt), providerCount: x._count?.locations ?? 0 });

  defineRoute(r, '/admin/regions', {
    method: 'get',
    path: '',
    summary: 'Service regions',
    tags: ['Admin · Regions'],
    permissions: ['providers.read'],
    response: z.array(RegionDto),
    handler: async () => (await prisma.serviceRegion.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { locations: true } } } })).map(regionDto),
  });

  defineRoute(r, '/admin/regions', {
    method: 'post',
    path: '',
    summary: 'Add a region',
    tags: ['Admin · Regions'],
    permissions: ['regions.manage'],
    body: z.object({ code: z.string().regex(/^[A-Z0-9-]{3,64}$/), name: z.string().trim().min(2).max(120), district: z.string().trim().min(2).max(80), state: z.string().trim().min(2).max(80) }),
    response: RegionDto,
    handler: async ({ body }) => {
      try {
        const x = await prisma.serviceRegion.create({ data: body, include: { _count: { select: { locations: true } } } });
        await audit(prisma, { action: 'region.created', entityType: 'service_region', entityId: x.id, metadata: { code: x.code } });
        return regionDto(x);
      } catch (err) {
        if (isPgError(err, '23505')) throw conflict('A region with this code already exists');
        throw err;
      }
    },
  });

  defineRoute(r, '/admin/regions', {
    method: 'post',
    path: '/:id/status',
    summary: 'Change region rollout status',
    tags: ['Admin · Regions'],
    status: 200,
    permissions: ['regions.manage'],
    params: IdParams,
    body: z.object({ status: z.enum(['PLANNED', 'PILOT', 'LIVE', 'PAUSED']) }),
    response: RegionDto,
    handler: async ({ params, body }) => {
      const x = await prisma.serviceRegion.findUnique({ where: { id: params.id } });
      if (!x) throw notFound('Region');
      const u = await prisma.serviceRegion.update({ where: { id: x.id }, data: { status: body.status, ...(body.status === 'LIVE' && !x.launchedAt ? { launchedAt: new Date() } : {}) }, include: { _count: { select: { locations: true } } } });
      await audit(prisma, { action: 'region.status_changed', entityType: 'service_region', entityId: x.id, metadata: { from: x.status, to: body.status } });
      return regionDto(u);
    },
  });

  // ── Compliance: consents, legal holds, incidents ───────────────────────
  defineRoute(r, '/admin/compliance', {
    method: 'get',
    path: '/consents',
    summary: 'Consent records for a patient profile (metadata only)',
    tags: ['Admin · Compliance'],
    permissions: ['compliance.manage'],
    query: z.object({ patientProfileId: z.uuid() }),
    response: z.array(Passthrough),
    handler: async ({ query }) =>
      (await prisma.consentRecord.findMany({ where: { patientProfileId: query.patientProfileId }, orderBy: { grantedAt: 'desc' } })).map((c) => ({
        id: c.id, scope: c.scope, purpose: c.purpose, policyVersion: c.policyVersion, granteeProviderId: c.granteeProviderId, grantedAt: c.grantedAt.toISOString(), expiresAt: iso(c.expiresAt), withdrawnAt: iso(c.withdrawnAt),
      })),
  });

  defineRoute(r, '/admin/compliance', {
    kind: 'list',
    method: 'get',
    path: '/legal-holds',
    summary: 'Legal holds',
    tags: ['Admin · Compliance'],
    permissions: ['compliance.manage'],
    query: PaginationQuery.extend({ activeOnly: z.coerce.boolean().default(true) }),
    response: Passthrough,
    handler: async ({ query }) => {
      const rows = await prisma.legalHold.findMany({ where: { ...(query.activeOnly ? { releasedAt: null } : {}), ...cursorWhere(query.cursor, 'placedAt') }, orderBy: cursorOrderBy('placedAt'), take: query.limit + 1 });
      const { items, page } = buildPage(rows, query.limit, (h) => h.placedAt);
      return { items: items.map((h) => ({ ...h, placedAt: h.placedAt.toISOString(), releasedAt: iso(h.releasedAt) })), page };
    },
  });

  defineRoute(r, '/admin/compliance', {
    method: 'post',
    path: '/legal-holds',
    summary: 'Place a legal hold (blocks anonymisation / deletion)',
    tags: ['Admin · Compliance'],
    permissions: ['compliance.manage'],
    body: z.object({ entityType: z.enum(['user', 'provider', 'transaction', 'appointment']), entityId: z.uuid(), reason: Reason }),
    response: Passthrough,
    handler: async ({ body, auth }) => {
      const h = await prisma.legalHold.create({ data: { ...body, placedById: auth.userId } });
      await audit(prisma, { action: 'legal_hold.placed', entityType: body.entityType, entityId: body.entityId, metadata: { holdId: h.id } });
      return { id: h.id, placedAt: h.placedAt.toISOString() };
    },
  });

  defineRoute(r, '/admin/compliance', {
    method: 'post',
    path: '/legal-holds/:id/release',
    summary: 'Release a legal hold',
    tags: ['Admin · Compliance'],
    status: 200,
    permissions: ['compliance.manage'],
    params: IdParams,
    body: z.object({ reason: Reason }),
    response: Passthrough,
    handler: async ({ params, body, auth }) => {
      const res = await prisma.legalHold.updateMany({ where: { id: params.id, releasedAt: null }, data: { releasedAt: new Date(), releasedById: auth.userId } });
      if (res.count === 0) throw conflict('Hold not found or already released');
      await audit(prisma, { action: 'legal_hold.released', entityType: 'legal_hold', entityId: params.id, metadata: { reason: body.reason } });
      return { id: params.id, released: true };
    },
  });

  const IncidentDto = Passthrough;
  defineRoute(r, '/admin/compliance', {
    kind: 'list',
    method: 'get',
    path: '/incidents',
    summary: 'Security / privacy incidents',
    tags: ['Admin · Compliance'],
    permissions: ['compliance.manage'],
    query: PaginationQuery.extend({ status: z.enum(['OPEN', 'CONTAINED', 'RESOLVED', 'CLOSED']).optional() }),
    response: IncidentDto,
    handler: async ({ query }) => {
      const rows = await prisma.securityIncident.findMany({ where: { ...(query.status ? { status: query.status } : {}), ...cursorWhere(query.cursor) }, orderBy: cursorOrderBy(), take: query.limit + 1 });
      const { items, page } = buildPage(rows, query.limit, (i) => i.createdAt);
      return { items: items.map((i) => ({ ...i, detectedAt: i.detectedAt.toISOString(), containedAt: iso(i.containedAt), resolvedAt: iso(i.resolvedAt), regulatorNotifiedAt: iso(i.regulatorNotifiedAt), createdAt: i.createdAt.toISOString(), updatedAt: i.updatedAt.toISOString() })), page };
    },
  });

  defineRoute(r, '/admin/compliance', {
    method: 'post',
    path: '/incidents',
    summary: 'Record an incident',
    tags: ['Admin · Compliance'],
    permissions: ['compliance.manage'],
    body: z.object({ severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']), title: z.string().trim().min(3).max(200), summary: z.string().trim().min(10).max(5000), detectedAt: DateTimeString, personalDataAffected: z.boolean().default(false) }),
    response: IncidentDto,
    handler: async ({ body, auth }) => {
      const i = await prisma.securityIncident.create({ data: { ...body, reference: makeReference(REF.incident), detectedAt: new Date(body.detectedAt), createdById: auth.userId } });
      await audit(prisma, { action: 'incident.recorded', entityType: 'security_incident', entityId: i.id, metadata: { severity: i.severity, personalDataAffected: i.personalDataAffected } });
      return { id: i.id, reference: i.reference, status: i.status };
    },
  });

  defineRoute(r, '/admin/compliance', {
    method: 'patch',
    path: '/incidents/:id',
    summary: 'Update incident status / regulator notification',
    tags: ['Admin · Compliance'],
    permissions: ['compliance.manage'],
    params: IdParams,
    body: z.object({ status: z.enum(['CONTAINED', 'RESOLVED', 'CLOSED']).optional(), regulatorNotifiedAt: DateTimeString.optional(), note: z.string().max(2000).optional() }).strict(),
    response: IncidentDto,
    handler: async ({ params, body }) => {
      const i = await prisma.securityIncident.findUnique({ where: { id: params.id } });
      if (!i) throw notFound('Incident');
      const now = new Date();
      const u = await prisma.securityIncident.update({
        where: { id: i.id },
        data: {
          ...(body.status ? { status: body.status } : {}),
          ...(body.status === 'CONTAINED' ? { containedAt: now } : {}),
          ...(body.status === 'RESOLVED' || body.status === 'CLOSED' ? { resolvedAt: i.resolvedAt ?? now } : {}),
          ...(body.regulatorNotifiedAt ? { regulatorNotifiedAt: new Date(body.regulatorNotifiedAt) } : {}),
        },
      });
      await audit(prisma, { action: 'incident.updated', entityType: 'security_incident', entityId: i.id, metadata: { status: body.status, note: body.note } });
      return { id: u.id, status: u.status };
    },
  });

  return r;
}
