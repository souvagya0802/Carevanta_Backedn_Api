import 'dotenv/config';
import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z
  .object({
    APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    // MongoDB (Atlas replica set in staging/production; mongodb-memory-server in tests).
    // Must be a replica-set or mongos URI: the API relies on multi-document transactions.
    MONGODB_URI: z.url({ protocol: /^mongodb(\+srv)?$/ }),
    MONGODB_DB: z.string().min(1).max(64).default('carevanta'),
    // Upper bound for a single query; Prisma applies it as maxTimeMS through the transaction options.
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),

    // Access tokens: HS256 JWT signed with JWT_SECRET (>= 32 bytes of entropy).
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    JWT_ISSUER: z.string().default('carevanta-api'),
    JWT_AUDIENCE: z.string().default('carevanta'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),

    // 32-byte key, base64-encoded, for AES-256-GCM field encryption.
    DATA_ENCRYPTION_KEY: z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length === 32, 'DATA_ENCRYPTION_KEY must be 32 bytes base64'),

    CORS_ORIGINS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),

    LOGIN_MAX_FAILURES: z.coerce.number().int().min(3).max(20).default(5),
    LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),

    RAZORPAY_KEY_ID: z.string().optional(),
    RAZORPAY_KEY_SECRET: z.string().optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
    /** Public base URL of this API (for webhook URLs shown to admins), e.g. https://api.carevanta.in */
    PUBLIC_API_URL: z.string().url().optional(),

    // Place search / reverse geocoding proxy (GET /public/geo/search, /reverse). Free services only:
    // nominatim (OpenStreetMap, no key, 1 request/s, needs a contact e-mail in the User-Agent) or
    // locationiq (free tier 5,000/day, Nominatim-compatible, needs GEOCODER_API_KEY). Keys live in .env only.
    GEOCODER_PROVIDER: z.enum(['nominatim', 'locationiq']).default('nominatim'),
    // Blank lines in .env (as in .env.example) count as "not set".
    GEOCODER_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(8).optional()),
    GEOCODER_CONTACT_EMAIL: z.preprocess((v) => (v === '' ? undefined : v), z.string().email().optional()),

    STORAGE_DRIVER: z.enum(['local']).default('local'),
    STORAGE_LOCAL_DIR: z.string().default('./storage'),
    MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).max(20 * 1024 * 1024).default(10 * 1024 * 1024),

    JOBS_ENABLED: booleanString.default(true),
    // Only for load testing from a single IP; never disable in production.
    RATE_LIMIT_ENABLED: booleanString.default(true),
    OPENAPI_ENABLED: booleanString.default(true),
  })
  .superRefine((env, ctx) => {
    if (env.APP_ENV === 'production') {
      if (env.CORS_ORIGINS.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message: 'required in production' });
      }
      if (!env.RATE_LIMIT_ENABLED) {
        ctx.addIssue({ code: 'custom', path: ['RATE_LIMIT_ENABLED'], message: 'must be true in production' });
      }
      if (!env.RAZORPAY_WEBHOOK_SECRET) {
        ctx.addIssue({ code: 'custom', path: ['RAZORPAY_WEBHOOK_SECRET'], message: 'required in production' });
      }
    }
  });

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Print variable names and messages only — never values.
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env: Env = loadEnv();
export const isProduction = env.APP_ENV === 'production';
export const isTest = env.APP_ENV === 'test';
