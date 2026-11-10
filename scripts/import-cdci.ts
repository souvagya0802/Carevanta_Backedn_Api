import { resolve } from 'node:path';
import { importCdci, CDCI_ATTRIBUTION, CDCI_DEFAULT_SCHEDULE } from '../src/modules/catalogue/cdci-import.js';
import { closeMongoClient } from '../src/lib/mongo-client.js';
import { prisma } from '../src/lib/prisma.js';

/**
 * `npm run medicines:import -- [folder]` loads or refreshes medicines from a CDCI flat-file release
 * (default folder data/cdci; see data/cdci/README.md). Safe to re-run.
 */
const dir = resolve(process.argv[2] ?? 'data/cdci');
console.log(`Importing CDCI medicines from ${dir}`);
try {
  const r = await importCdci(dir, { log: (m) => console.log(m) });
  console.log(`Done in ${(r.ms / 1000).toFixed(1)} s: read ${r.read}, inserted ${r.inserted}, updated ${r.updated}, unchanged ${r.unchanged}, skipped ${r.skipped}.`);
  console.log(`New rows default to requiresPrescription=true and schedule ${CDCI_DEFAULT_SCHEDULE} (CDCI has no schedule data).`);
  console.log(`Attribution: ${CDCI_ATTRIBUTION}`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await closeMongoClient();
  await prisma.$disconnect();
}
