/**
 * Smoke-test every read endpoint the provider portal uses, as each demo login.
 *
 *   npm run demo:smoke
 *
 * Runs after `npm run demo:seed`. A 200 means the page will load; a 403 is
 * expected where the role lacks the capability (the portal hides that page);
 * anything else is printed as a failure and the script exits non-zero.
 */
import request from 'supertest';
import { prisma } from '../src/lib/prisma.js';
import { createApp } from '../src/app.js';

const DOMAIN = 'demo.carevanta.local';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo-Carevanta-2026';
const LOGINS = ['hospital.owner', 'hospital.reception', 'dr.anjali.maity', 'lab.owner', 'pharmacy.owner', 'pharmacist', 'ambulance.owner', 'dispatcher'].map((l) => `${l}@${DOMAIN}`);
const app = createApp();
const V = '/api/v1';

const from = new Date().toISOString();
const to = new Date(Date.now() + 7 * 86_400_000).toISOString();
const PAGES: Record<string, string[]> = {
  common: ['', '/verification', '/analytics', '/analytics/daily', '/services', '/finance/summary', '/finance/transactions', '/finance/ledger', '/finance/settlements', '/documents'],
  DOCTOR: ['/appointments', '/appointments-today', '/doctors', '/schedules', `/slots?from=${from}&to=${to}`],
  HOSPITAL: ['/appointments', '/appointments-today', '/doctors', '/schedules', `/slots?from=${from}&to=${to}`, '/affiliations'],
  CLINIC: ['/appointments', '/appointments-today', '/doctors', '/schedules', `/slots?from=${from}&to=${to}`, '/affiliations'],
  DIAGNOSTIC_LAB: ['/diagnostic-orders', '/diagnostic-orders?status=REQUESTED'],
  IMAGING_CENTRE: ['/diagnostic-orders'],
  PHARMACY: ['/pharmacy-orders', '/prescriptions', '/prescriptions?status=PENDING', '/inventory', '/inventory?q=para'],
  AMBULANCE_OPERATOR: ['/vehicles', '/crew', '/dispatch/offers', '/dispatch/active'],
};
const GLOBAL = ['/portal/notifications', '/portal/config', '/public/portal-ui', '/portal/catalogue/services?category=DIAGNOSTIC_TEST', '/portal/catalogue/medicines?q=pa', '/portal/catalogue/departments', '/portal/catalogue/amenities', '/portal/catalogue/regions', '/portal/catalogue/providers?q=tamluk', '/portal/doctor/affiliations'];

let failures = 0;
for (const email of LOGINS) {
  const login = await request(app).post(`${V}/auth/login`).send({ identifier: email, password: PASSWORD });
  if (login.status !== 200) { console.log(`✗ ${email}: login ${login.status} ${JSON.stringify(login.body)}`); failures++; continue; }
  const auth = { Authorization: `Bearer ${login.body.data.accessToken}` };
  const get = (url: string) => request(app).get(V + url).set(auth);
  const me = await get('/portal/me');
  if (me.status !== 200) { console.log(`✗ ${email}: /portal/me ${me.status}`); failures++; continue; }
  const orgs = me.body.data.memberships as { providerId: string; type: string; memberRole: string; capabilities: string[] }[];
  console.log(`\n${email} → ${orgs.map((o) => `${o.type} as ${o.memberRole}`).join(', ')}`);
  const urls = [...GLOBAL.filter((u) => u !== '/portal/doctor/affiliations' || orgs.some((o) => o.type === 'DOCTOR'))];
  for (const o of orgs) for (const p of [...PAGES.common!, ...(PAGES[o.type] ?? [])]) urls.push(`/portal/providers/${o.providerId}${p}`);
  const results = await Promise.all(urls.map(async (u) => ({ u, res: await get(u) })));
  for (const { u, res } of results) {
    const short = u.replace(/\/portal\/providers\/[0-9a-f-]{36}/, '/…').replace(/\?from=.*$/, '?from…');
    const okish = res.status === 200 || res.status === 403;
    if (!okish) failures++;
    const note = res.status === 403 ? '(hidden for this role)' : res.status === 200 ? (Array.isArray(res.body.data) ? `${res.body.data.length} rows` : res.body.data?.items ? `${res.body.data.items.length} rows` : '') : JSON.stringify(res.body).slice(0, 160);
    console.log(`  ${okish ? '✓' : '✗'} ${res.status} ${short} ${note}`);
  }
}
await prisma.$disconnect();
console.log(failures ? `\n${failures} failure(s)` : '\nAll portal reads healthy.');
process.exitCode = failures ? 1 : 0;
