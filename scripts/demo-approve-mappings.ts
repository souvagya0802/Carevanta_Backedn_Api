/**
 * DEMO / DEVELOPMENT ONLY.
 *
 * Symptom → specialist links ("fever → General Medicine") are seeded as
 * PENDING_REVIEW, and patient search ignores them until a clinician approves
 * each one in Super Admin → Catalogue → Mappings. That is the production rule.
 *
 * For a demo database this script approves the pending starter links so that
 * typing "fever" shows doctors. It refuses to run in production.
 *
 *   npm run demo:approve-search
 */
import 'dotenv/config';
import { prisma } from '../src/lib/prisma.js';

export async function approvePendingMappingsForDemo() {
  if (process.env.APP_ENV === 'production') throw new Error('Refusing to auto-approve clinical mappings in production.');
  const res = await prisma.conditionSpecialityMapping.updateMany({
    where: { reviewStatus: 'PENDING_REVIEW' },
    data: { reviewStatus: 'APPROVED', reviewedAt: new Date(), reviewNote: 'Demo environment only: approved by demo:approve-search. A clinician must review this in production.' },
  });
  return res.count;
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/demo-approve-mappings.ts');
if (isMain) {
  approvePendingMappingsForDemo()
    .then((n) => console.log(`Approved ${n} pending symptom → specialist links for the demo.`))
    .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
