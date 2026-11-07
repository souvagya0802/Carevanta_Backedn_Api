import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Prisma 6 with the MongoDB connector. The connection string is read from
// MONGODB_URI in the schema's datasource block (see prisma/schema/base.prisma).
// There are no SQL migrations and `prisma db push` is not used: `npm run db:sync`
// (and the API at start-up) creates every index from the generated manifest plus
// the partial indexes in src/lib/mongo-indexes.ts.
export default defineConfig({
  schema: 'prisma/schema',
  migrations: {
    seed: 'tsx prisma/seed.ts',
  },
});
