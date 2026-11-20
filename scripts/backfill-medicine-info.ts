import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { backfillMedicineInfo, CDCI_ATTRIBUTION } from '../src/modules/catalogue/cdci-import.js';
import { closeMongoClient } from '../src/lib/mongo-client.js';
import { prisma } from '../src/lib/prisma.js';

/**
 * `npm run medicines:backfill-info -- [folder]` sets the substitute key (compositionKey) on every medicine and
 * fills patient information (uses, how it works, side effects, contraindications, interactions, class) for
 * existing CDCI medicines from the CDCI GenericMaster.txt and SubstanceMaster.txt in the folder (default
 * data/cdci). Files: https://raw.githubusercontent.com/ohcnetwork/cdci/main/data/source/<File>.txt.
 * Idempotent and safe to re-run; information an admin edited (infoSource ADMIN) is never overwritten.
 * Without the folder only the keys are computed.
 */
const dir = resolve(process.argv[2] ?? 'data/cdci');
const hasFiles = existsSync(join(dir, 'GenericMaster.txt'));
console.log(hasFiles ? `Backfilling medicine keys and information from ${dir}` : `GenericMaster.txt not found in ${dir}; computing substitute keys only`);
try {
  const r = await backfillMedicineInfo(hasFiles ? dir : null, { log: (m) => console.log(m) });
  console.log(`Done in ${(r.ms / 1000).toFixed(1)} s: scanned ${r.scanned}, keys written ${r.keysUpdated}, information written ${r.infoUpdated}, admin-edited left alone ${r.infoSkippedAdmin}.`);
  if (hasFiles) console.log(`Attribution: ${CDCI_ATTRIBUTION}`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await closeMongoClient();
  await prisma.$disconnect();
}
