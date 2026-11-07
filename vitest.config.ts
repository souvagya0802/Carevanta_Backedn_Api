import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./tests/global-setup.ts'],
    setupFiles: ['./tests/setup-env.ts'],
    include: ['tests/**/*.test.ts'],
    // Integration tests share one database; run files serially and reset
    // tables between files (tests/helpers/db.ts).
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      APP_ENV: 'test',
      LOG_LEVEL: 'silent',
      JWT_SECRET: 'test-only-jwt-secret-not-for-any-real-environment-0123456789',
      // 32 zero-bytes base64 — test only.
      DATA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      CORS_ORIGINS: 'http://localhost:3000',
      JOBS_ENABLED: 'false',
      LOGIN_MAX_FAILURES: '5',
      LOGIN_LOCKOUT_MINUTES: '15',
      RAZORPAY_WEBHOOK_SECRET: 'test-webhook-secret',
      STORAGE_LOCAL_DIR: './.tmp/test-storage',
    },
  },
});
