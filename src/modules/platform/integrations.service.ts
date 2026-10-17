import nodemailer, { type Transporter } from 'nodemailer';
import { prisma, type Db } from '../../lib/prisma.js';
import { decryptField, encryptField } from '../../lib/crypto.js';
import { badRequest } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

/**
 * Operator-configurable integrations stored in platform_settings:
 *   branding.*  — name, tagline, uploaded logo (storage key)
 *   smtp.*      — outbound email; the password is stored AES-256-GCM encrypted
 * Values are read through small caches that the write paths invalidate.
 */

// ─── Branding ──────────────────────────────────────────────────────────────
export interface Branding {
  name: string;
  tagline: string;
  logo: { storageKey: string; mimeType: string; sha256: string } | null;
}
const BRANDING_DEFAULT: Branding = { name: 'Carevanta', tagline: 'Trusted care, connected.', logo: null };
let brandingCache: { at: number; value: Branding } | null = null;

export async function getBranding(db: Db = prisma): Promise<Branding> {
  if (brandingCache && Date.now() - brandingCache.at < 30_000) return brandingCache.value;
  const rows = await db.platformSetting.findMany({ where: { key: { in: ['branding.name', 'branding.tagline', 'branding.logo'] } } });
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const value: Branding = {
    name: typeof get('branding.name') === 'string' ? (get('branding.name') as string) : BRANDING_DEFAULT.name,
    tagline: typeof get('branding.tagline') === 'string' ? (get('branding.tagline') as string) : BRANDING_DEFAULT.tagline,
    logo: (get('branding.logo') as Branding['logo']) ?? null,
  };
  brandingCache = { at: Date.now(), value };
  return value;
}

export async function setSetting(db: Db, key: string, value: unknown, description: string, isSensitive: boolean, updatedById: string) {
  await db.platformSetting.upsert({
    where: { key },
    create: { key, value: value as object, description, isSensitive, updatedById },
    update: { value: value as object, isSensitive, version: { increment: 1 }, updatedById },
  });
  brandingCache = null;
  smtpCache = null;
}

// ─── SMTP ──────────────────────────────────────────────────────────────────
export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean; // implicit TLS (465); otherwise STARTTLS is attempted
  username: string | null;
  password: string | null; // decrypted, in memory only
  fromAddress: string;
  fromName: string;
}
export const SMTP_KEYS = ['smtp.host', 'smtp.port', 'smtp.secure', 'smtp.username', 'smtp.password', 'smtp.fromAddress', 'smtp.fromName'] as const;
let smtpCache: { at: number; config: SmtpConfig | null; transport: Transporter | null } | null = null;

export async function getSmtpConfig(db: Db = prisma): Promise<SmtpConfig | null> {
  if (smtpCache && Date.now() - smtpCache.at < 30_000) return smtpCache.config;
  const rows = await db.platformSetting.findMany({ where: { key: { in: [...SMTP_KEYS] } } });
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const host = get('smtp.host');
  let config: SmtpConfig | null = null;
  if (typeof host === 'string' && host) {
    let password: string | null = null;
    const enc = get('smtp.password');
    if (typeof enc === 'string' && enc) {
      try {
        password = decryptField(enc);
      } catch (err) {
        logger.error({ err }, 'smtp password could not be decrypted — was DATA_ENCRYPTION_KEY rotated?');
      }
    }
    config = {
      host,
      port: Number(get('smtp.port') ?? 587),
      secure: get('smtp.secure') === true,
      username: typeof get('smtp.username') === 'string' && get('smtp.username') ? (get('smtp.username') as string) : null,
      password,
      fromAddress: typeof get('smtp.fromAddress') === 'string' ? (get('smtp.fromAddress') as string) : '',
      fromName: typeof get('smtp.fromName') === 'string' ? (get('smtp.fromName') as string) : 'Carevanta',
    };
  }
  smtpCache = { at: Date.now(), config, transport: null };
  return config;
}

function transportFor(config: SmtpConfig): Transporter {
  if (smtpCache?.transport && smtpCache.config === config) return smtpCache.transport;
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.username ? { user: config.username, pass: config.password ?? '' } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    tls: { minVersion: 'TLSv1.2' },
  });
  if (smtpCache) smtpCache.transport = transport;
  return transport;
}

export async function sendEmail(to: string, subject: string, text: string): Promise<{ messageId: string }> {
  const config = await getSmtpConfig();
  if (!config) throw badRequest('SMTP is not configured');
  if (!config.fromAddress) throw badRequest('SMTP from-address is not configured');
  const info = await transportFor(config).sendMail({ from: `"${config.fromName.replace(/"/g, '')}" <${config.fromAddress}>`, to, subject, text });
  return { messageId: String(info.messageId) };
}

export async function saveSmtpConfig(
  db: Db,
  input: { host: string; port: number; secure: boolean; username: string | null; password?: string | null; fromAddress: string; fromName: string },
  updatedById: string,
) {
  await setSetting(db, 'smtp.host', input.host, 'Outbound email server host', false, updatedById);
  await setSetting(db, 'smtp.port', input.port, 'Outbound email server port', false, updatedById);
  await setSetting(db, 'smtp.secure', input.secure, 'Use implicit TLS (port 465)', false, updatedById);
  await setSetting(db, 'smtp.username', input.username ?? '', 'SMTP username', false, updatedById);
  await setSetting(db, 'smtp.fromAddress', input.fromAddress, 'From address for platform email', false, updatedById);
  await setSetting(db, 'smtp.fromName', input.fromName, 'From name for platform email', false, updatedById);
  // undefined → keep the stored password; null/'' → clear; string → replace (encrypted).
  if (input.password !== undefined) {
    await setSetting(db, 'smtp.password', input.password ? encryptField(input.password) : '', 'SMTP password (encrypted)', true, updatedById);
  }
}

export async function verifySmtp(): Promise<void> {
  const config = await getSmtpConfig();
  if (!config) throw badRequest('SMTP is not configured');
  await transportFor(config).verify();
}
