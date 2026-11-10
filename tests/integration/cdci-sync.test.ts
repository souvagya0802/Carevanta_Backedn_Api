/**
 * CDCI medicine list sync: release check, download, validation gate, apply, discontinue, release marker,
 * admin notifications, kill switch, lease, and the admin trigger. No network: every request is served
 * from synthetic in-memory files by an injected fetch.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { acquireLease, releaseLease } from '../../src/lib/job-lease.js';
import { invalidateSetting } from '../../src/modules/settings/settings.service.js';
import { searchMedicines } from '../../src/modules/catalogue/medicines.service.js';
import { cdciSyncSettled } from '../../src/modules/catalogue/cdci-sync.routes.js';
import { CDCI_LAST_RUN_KEY, CDCI_RELEASE_KEY, CDCI_SYNC_ENABLED_KEY, CDCI_SYNC_JOB, CDCI_TEMPLATE_KEY, runCdciSyncWithLease, syncCdci, type CdciRelease, type FetchLike } from '../../src/jobs/cdci-sync.js';
import { resetDatabase } from '../helpers/db.js';
import { actor } from '../helpers/factory.js';

const V = '/api/v1';
const BRAND_HEADER = 'Identifier\tBrand Name\tProduct Identifier\tSupplier Identifier\tGeneric Identifier\tLicense Number\tLicense Status\tExcipient\tlast_updated_on';
const LICENCE = 'The Common Drug Codes for India (Flat Files Package) is produced by NRCeS at C-DAC, Pune under the terms of the Creative Commons Attribution 4.0 International Public License.';

/** Synthetic release: brand codes 9100001… named Synthol-<n>. */
function release(codes: number[], opts: { brandHeader?: string } = {}): Record<string, string> {
  const brands = codes.map((n) => `${9100000 + n}\tSynthol${n} (paracetamol) ${n * 10} mg oral tablet\t8001\t7001\t6001\t\tUNKNOWN\t\t20260831\t`);
  return {
    'BrandMaster.txt': [opts.brandHeader ?? BRAND_HEADER, ...brands].join('\r\n'),
    'GenericMaster.txt': 'Identifier\tGeneric Name\tSubstance Identifier\tRoute of Administration\tDose Form\r\n6001\tParacetamol oral tablet\t1\t26643006\t2',
    'ProductMaster.txt': 'Identifier\tProduct Name\r\n8001\tSynthol',
    'SupplierMaster.txt': 'Identifier\tSupplier Name\tCountry\r\n7001\tSynthetic Pharma Limited\t',
    'DrugFormMaster.txt': 'Identifier\tDose Form\t\r\n2\tOral tablet',
    'RouteOfAdministrationMaster.txt': 'Identifier\tRouteOfAdministration\r\n26643006\tOral route',
    'SubstanceMaster.txt': 'Identifier\tSubstance Name\tCAS Number\r\n1\tParacetamol\t103-90-2',
    'License.txt': LICENCE,
  };
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const code = (n: number) => String(9100000 + n);

function server(sha: string, files: Record<string, string>) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    if (url.startsWith('https://api.github.com/')) return Response.json([{ sha, commit: { committer: { date: '2026-08-31T10:00:00Z' } } }]);
    const file = url.split('/').pop()!;
    const body = files[file];
    return body === undefined ? new Response('Not Found', { status: 404 }) : new Response(body, { status: 200 });
  };
  return { fetchImpl, calls };
}

const marker = async () => (await prisma.platformSetting.findUnique({ where: { key: CDCI_RELEASE_KEY } }))?.value as unknown as CdciRelease | undefined;
const syncNotices = (channel: 'IN_APP' | 'EMAIL') => prisma.notification.findMany({ where: { templateKey: CDCI_TEMPLATE_KEY, channel }, orderBy: { createdAt: 'asc' } });
const snapshot = async () => (await prisma.medicine.findMany({ orderBy: { id: 'asc' }, select: { id: true, code: true, isActive: true, name: true, requiresPrescription: true } }));
const MIN = { minFirstRows: 5 };

let admin: Awaited<ReturnType<typeof actor>>;
let providerMedicineId: string;

beforeAll(async () => {
  await resetDatabase();
  await prisma.platformSetting.deleteMany({ where: { key: { startsWith: 'catalogue.cdci' } } });
  invalidateSetting();
  admin = await actor(['SUPER_ADMIN']);
  const m = await prisma.medicine.create({ data: { name: 'Pharmacy Added Syrup', source: 'PROVIDER', searchName: 'pharmacy added syrup' } });
  providerMedicineId = m.id;
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('CDCI medicine list sync', () => {
  it('first run applies the release, stores the marker and tells catalogue admins (in-app + email)', async () => {
    const { fetchImpl } = server('sha-1', release(range(1, 10)));
    const r = await syncCdci({ fetchImpl, ...MIN });
    expect(r, JSON.stringify(r)).toMatchObject({ status: 'applied', sha: 'sha-1', counts: { rows: 10, added: 10, discontinued: 0 } });
    expect(await prisma.medicine.count({ where: { source: 'CDCI', isActive: true } })).toBe(10);
    expect(await marker()).toMatchObject({ sha: 'sha-1', date: '2026-08-31T10:00:00Z', counts: { rows: 10, added: 10 } });
    const inApp = await syncNotices('IN_APP');
    expect(inApp.map((n) => n.userId)).toContain(admin.user.id);
    expect(inApp.at(-1)!.body).toBe('Medicine list updated: 10 added, 0 updated, 0 discontinued.');
    expect((await syncNotices('EMAIL')).some((n) => n.userId === admin.user.id)).toBe(true);
  });

  it('a second run with the same commit does nothing (only the release check is fetched)', async () => {
    const before = await snapshot();
    const { fetchImpl, calls } = server('sha-1', release(range(1, 10)));
    const r = await syncCdci({ fetchImpl, ...MIN });
    expect(r.status).toBe('unchanged');
    expect(calls).toHaveLength(1);
    expect(await snapshot()).toEqual(before);
  });

  it('a new release adds and discontinues, keeps admin edits and never touches pharmacy-added medicines', async () => {
    // An admin relaxed medicine 3 to over-the-counter.
    await prisma.medicine.updateMany({ where: { code: code(3) }, data: { requiresPrescription: false, schedule: 'OTC' } });
    const { fetchImpl } = server('sha-2', release([...range(1, 9), 11]));
    const r = await syncCdci({ fetchImpl, ...MIN });
    expect(r, JSON.stringify(r)).toMatchObject({ status: 'applied', sha: 'sha-2', counts: { rows: 10, added: 1, discontinued: 1 } });
    const gone = await prisma.medicine.findFirstOrThrow({ where: { code: code(10) } });
    expect(gone.isActive).toBe(false); // kept, never deleted
    expect(await prisma.medicine.findFirstOrThrow({ where: { code: code(11) } })).toMatchObject({ isActive: true, source: 'CDCI' });
    expect(await prisma.medicine.findFirstOrThrow({ where: { code: code(3) } })).toMatchObject({ requiresPrescription: false, schedule: 'OTC', isActive: true });
    expect(await prisma.medicine.findUniqueOrThrow({ where: { id: providerMedicineId } })).toMatchObject({ isActive: true, source: 'PROVIDER' });
    // Hidden from new stock search, still resolvable by id for existing stock and orders.
    expect((await searchMedicines('synthol10')).map((m) => m.id)).not.toContain(gone.id);
    expect((await searchMedicines('synthol1')).length).toBeGreaterThan(0);
    expect(await marker()).toMatchObject({ sha: 'sha-2' });
    expect((await syncNotices('IN_APP')).at(-1)!.body).toBe('Medicine list updated: 1 added, 0 updated, 1 discontinued.');
  });

  it('blocks a release with a changed header: nothing changes, admins are told why', async () => {
    const before = await snapshot();
    const { fetchImpl } = server('sha-3', release([...range(1, 9), 11], { brandHeader: BRAND_HEADER.replace('Brand Name', 'Brand') }));
    const r = await syncCdci({ fetchImpl, ...MIN });
    expect(r.status).toBe('blocked');
    expect(r.reason).toContain('BrandMaster.txt has an unexpected header');
    expect(await snapshot()).toEqual(before);
    expect(await marker()).toMatchObject({ sha: 'sha-2' });
    const last = (await syncNotices('IN_APP')).at(-1)!;
    expect(last.body).toMatch(/^Medicine list update blocked: BrandMaster\.txt has an unexpected header/u);
    expect(last.payload).toMatchObject({ level: 'important' });
  });

  it('blocks a 60% row drop and a missing file, leaving the catalogue as it was', async () => {
    const before = await snapshot();
    const drop = await syncCdci({ fetchImpl: server('sha-4', release(range(1, 4))).fetchImpl, ...MIN });
    expect(drop).toMatchObject({ status: 'blocked', reason: 'BrandMaster has 4 rows, under 80% of the previous 10' });
    const files = release([...range(1, 9), 11]);
    delete files['SubstanceMaster.txt'];
    const missing = await syncCdci({ fetchImpl: server('sha-5', files).fetchImpl, ...MIN });
    expect(missing).toMatchObject({ status: 'blocked', reason: 'SubstanceMaster.txt is missing from the release' });
    expect(await snapshot()).toEqual(before);
    expect(await marker()).toMatchObject({ sha: 'sha-2' });
  });

  it('the kill switch stops the sync before any download, and the admin trigger refuses', async () => {
    await prisma.platformSetting.upsert({ where: { key: CDCI_SYNC_ENABLED_KEY }, create: { key: CDCI_SYNC_ENABLED_KEY, value: false }, update: { value: false } });
    invalidateSetting();
    const { fetchImpl, calls } = server('sha-6', release(range(1, 12)));
    expect((await syncCdci({ fetchImpl, ...MIN })).status).toBe('disabled');
    expect(calls).toHaveLength(0);
    expect((await admin.post(`${V}/admin/catalogue/medicines/sync`, {})).status).toBe(409);
    await prisma.platformSetting.update({ where: { key: CDCI_SYNC_ENABLED_KEY }, data: { value: true } });
    invalidateSetting();
  });

  it('the lease prevents a second run while one is in progress', async () => {
    expect(await acquireLease(CDCI_SYNC_JOB, 60_000, 'other-worker')).toBe(true);
    try {
      const { fetchImpl, calls } = server('sha-7', release(range(1, 12)));
      expect(await runCdciSyncWithLease({ fetchImpl, ...MIN })).toBeNull();
      expect(calls).toHaveLength(0);
      expect((await admin.post(`${V}/admin/catalogue/medicines/sync`, {})).status).toBe(409);
      expect((await admin.get(`${V}/admin/catalogue/medicines/sync-status`)).body.data.running).toBe(true);
    } finally {
      await releaseLease(CDCI_SYNC_JOB, { ok: true, ms: 0 }, 'other-worker');
    }
  });

  it('admin trigger returns 202 at once, runs in the background, and sync-status reports the outcome', async () => {
    const { fetchImpl } = server('sha-2', release([...range(1, 9), 11]));
    vi.stubGlobal('fetch', fetchImpl);
    const res = await admin.post(`${V}/admin/catalogue/medicines/sync`, { force: true });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.data).toEqual({ status: 'started' });
    await cdciSyncSettled();
    vi.unstubAllGlobals();
    const status = await admin.get(`${V}/admin/catalogue/medicines/sync-status`);
    expect(status.status).toBe(200);
    expect(status.body.data).toMatchObject({ running: false, enabled: true, lastRelease: { sha: 'sha-2' }, lastRun: { status: 'applied', sha: 'sha-2', triggeredBy: admin.user.id } });
    expect(await prisma.auditEvent.count({ where: { action: 'catalogue.medicines_sync_started' } })).toBe(1);
    expect((await prisma.platformSetting.findUnique({ where: { key: CDCI_LAST_RUN_KEY } }))?.value).toMatchObject({ counts: { added: 0, discontinued: 0 } });
    // Without the permission: forbidden.
    const viewer = await actor(['SUPPORT_AGENT']).catch(() => null);
    if (viewer) expect((await viewer.post(`${V}/admin/catalogue/medicines/sync`, {})).status).toBe(403);
  });
});
