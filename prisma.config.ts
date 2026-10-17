import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// The Prisma CLI (migrate, db execute, studio) uses DIRECT_URL — a non-pooled
// Neon connection — because schema migrations need session-level features that
// the PgBouncer-based pooler does not provide. The running application uses the
// pooled DATABASE_URL through the pg driver adapter (see src/lib/prisma.ts).
export default defineConfig({
  schema: 'prisma/schema',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DIRECT_URL'),
  },
});
