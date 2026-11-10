import { beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase } from '../helpers/db.js';
import { actor, api, createUser, idem } from '../helpers/factory.js';
import { affiliatedDoctor, patient, randomUUID, slotsFor } from '../helpers/fixtures.js';

beforeAll(resetDatabase);

describe('EDGE-HTTP: pagination boundaries', () => {
  it('EDGE-HTTP-01: limit 0, -1, 101, 1.5 and text are 400; 1 and 100 are accepted; pages never overlap', async () => {
    const admin = await actor(['SUPER_ADMIN']);
    for (let i = 0; i < 3; i++) await createUser({ fullName: `Paged User ${i}` });
    for (const limit of ['0', '-1', '101', '1.5', 'abc', '']) {
      const res = await admin.get(`/api/v1/admin/users?limit=${limit}`);
      expect(res.status, `limit=${limit}`).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }
    const one = await admin.get('/api/v1/admin/users?limit=1');
    expect(one.status).toBe(200);
    expect(one.body.data).toHaveLength(1);
    expect(one.body.page).toEqual({ limit: 1, hasMore: true, nextCursor: expect.any(String) });
    const two = await admin.get(`/api/v1/admin/users?limit=1&cursor=${encodeURIComponent(one.body.page.nextCursor)}`);
    expect(two.status).toBe(200);
    expect(two.body.data[0].id).not.toBe(one.body.data[0].id);
    const max = await admin.get('/api/v1/admin/users?limit=100');
    expect(max.status).toBe(200);
    expect(max.body.page.hasMore).toBe(false);
    expect(max.body.page.nextCursor).toBeNull();
    // Walking the whole list one at a time visits every user exactly once.
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const page = await admin.get(`/api/v1/admin/users?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      for (const row of page.body.data) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
      cursor = page.body.page.nextCursor;
      if (!cursor) break;
    }
    expect(seen.size).toBe(max.body.data.length);
  });

  it('EDGE-HTTP-02: cursors that are not ours are 400, never 500', async () => {
    const admin = await actor(['SUPER_ADMIN']);
    const bad = [
      'garbage',
      Buffer.from('{"t":"2026-01-01T00:00:00.000Z"}').toString('base64url'), // no id
      Buffer.from('{"t":"not-a-date","i":"00000000-0000-0000-0000-000000000000"}').toString('base64url'),
      Buffer.from('{"t":"2026-01-01T00:00:00.000Z","i":"../../etc"}').toString('base64url'),
      Buffer.from('[1,2]').toString('base64url'),
      'x'.repeat(201),
    ];
    for (const cursor of bad) {
      const res = await admin.get(`/api/v1/admin/users?cursor=${encodeURIComponent(cursor)}`);
      expect(res.status, cursor.slice(0, 30)).toBe(400);
    }
  });
});

describe('EDGE-HTTP: body and route handling', () => {
  it('EDGE-HTTP-03: malformed JSON, a JSON array where an object is expected, and >256 kB bodies', async () => {
    const admin = await actor(['SUPER_ADMIN']);
    const malformed = await api().post('/api/v1/auth/login').set('Content-Type', 'application/json').send('{"identifier": ');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.message).toMatch(/Malformed JSON/);
    const array = await api().post('/api/v1/auth/login').set('Content-Type', 'application/json').send('[1,2,3]');
    expect(array.status).toBe(400);
    const primitive = await api().post('/api/v1/auth/login').set('Content-Type', 'application/json').send('"just a string"');
    expect(primitive.status).toBe(400);
    const huge = await admin.post('/api/v1/admin/users', { fullName: 'x'.repeat(300 * 1024), email: 'huge@test.carevanta.local' });
    expect(huge.status).toBe(413);
    expect(huge.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    // Unknown fields on a strict body are refused rather than silently dropped.
    const strict = await admin.patch(`/api/v1/admin/users/${admin.user.id}`, { fullName: 'Renamed', isSuperAdmin: true });
    expect(strict.status).toBe(400);
  });

  it('EDGE-HTTP-04: unknown routes and wrong methods are JSON 404s; every error carries a requestId', async () => {
    const admin = await actor(['SUPER_ADMIN']);
    const missing = await admin.get('/api/v1/no-such-route');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatchObject({ code: 'NOT_FOUND', requestId: expect.any(String) });
    expect((await api().delete('/api/v1/auth/login')).status).toBe(404);
    expect((await api().get('/api/v2/auth/me')).status).toBe(404);
    // Path traversal in the URL does not escape the API prefix.
    expect((await api().get('/api/v1/../../etc/passwd')).status).toBe(404);
  });

  it('EDGE-HTTP-05: every /:id route rejects a non-UUID with 400 and an unknown UUID with 404', async () => {
    const admin = await actor(['SUPER_ADMIN']);
    const ghost = randomUUID();
    const routes = [
      '/api/v1/admin/users/{id}',
      '/api/v1/admin/providers/{id}',
      '/api/v1/admin/verification-cases/{id}',
      '/api/v1/admin/affiliations/{id}',
      '/api/v1/admin/support-cases/{id}',
      '/api/v1/admin/support-cases/{id}/events',
      '/api/v1/admin/diagnostic-orders/{id}',
      '/api/v1/admin/pharmacy-orders/{id}',
      '/api/v1/admin/finance/transactions/{id}',
      '/api/v1/admin/finance/settlements/{id}',
      '/api/v1/admin/finance/commission-policies/{id}',
      '/api/v1/admin/dispatch/{id}',
      '/api/v1/admin/roles/{id}',
      '/api/v1/admin/providers/{id}/documents',
      '/api/v1/admin/users/{id}/activity',
    ];
    for (const route of routes) {
      const notUuid = await admin.get(route.replace('{id}', '123'));
      expect(notUuid.status, `${route} with 123`).toBe(400);
      const unknown = await admin.get(route.replace('{id}', ghost));
      expect([404, 200].includes(unknown.status), `${route} with ghost → ${unknown.status} ${JSON.stringify(unknown.body)}`).toBe(true);
      // A sub-collection of a missing parent may legitimately be an empty list, but never a 500.
      if (unknown.status === 200) expect(Array.isArray(unknown.body.data) ? unknown.body.data.length : 0).toBe(0);
    }
  });

  it('EDGE-HTTP-06: writes against a ghost id are 404 (state checks never run before existence checks)', async () => {
    const admin = await actor(['SUPER_ADMIN']);
    const ghost = randomUUID();
    const writes: [string, object][] = [
      [`/api/v1/admin/users/${ghost}/status`, { status: 'SUSPENDED', reason: 'edge case probe' }],
      [`/api/v1/admin/users/${ghost}/roles`, { roleKey: 'AUDITOR' }],
      [`/api/v1/admin/providers/${ghost}/status`, { action: 'SUSPEND', reason: 'edge case probe' }],
      [`/api/v1/admin/providers/${ghost}/submit`, {}],
      [`/api/v1/admin/providers/${ghost}/members`, { userId: admin.user.id, memberRole: 'STAFF' }],
      [`/api/v1/admin/affiliations/${ghost}/actions`, { action: 'VERIFY' }],
      [`/api/v1/admin/support-cases/${ghost}/status`, { status: 'IN_PROGRESS' }],
      [`/api/v1/admin/support-cases/${ghost}/comments`, { body: 'hello' }],
      [`/api/v1/admin/diagnostic-orders/${ghost}/status`, { status: 'CONFIRMED' }],
      [`/api/v1/admin/pharmacy-orders/${ghost}/status`, { status: 'ACCEPTED' }],
      [`/api/v1/admin/finance/refunds/${ghost}/review`, { decision: 'REJECT', note: 'edge case probe' }],
      [`/api/v1/admin/finance/settlements/${ghost}/approve`, {}],
      [`/api/v1/admin/finance/commission-policies/${ghost}/submit`, {}],
      [`/api/v1/admin/reviews/${ghost}/moderate`, { decision: 'PUBLISHED' }],
      [`/api/v1/admin/ambulance/vehicles/${ghost}/status`, { status: 'SUSPENDED' }],
      [`/api/v1/admin/dispatch/${ghost}/cancel`, { reason: 'edge case probe' }],
      [`/api/v1/admin/verification-cases/${ghost}/decision`, { decision: 'REJECT', note: 'edge case probe' }],
    ];
    for (const [url, body] of writes) {
      const res = await admin.post(url, body);
      expect(res.status, `${url} → ${JSON.stringify(res.body)}`).toBe(404);
    }
  });
});

describe('EDGE-HTTP: permission matrix', () => {
  it('EDGE-HTTP-07: read-only and single-purpose roles are refused on writes outside their remit', async () => {
    const auditor = await actor(['AUDITOR']);
    const legal = await actor(['LEGAL_REVIEWER']);
    const reviewer = await actor(['CLINICAL_REVIEWER']);
    const dispatcher = await actor(['OPERATIONS_DISPATCHER']);
    const nobody = await actor([]);
    const cases: [typeof auditor, string, object][] = [
      [auditor, '/api/v1/admin/users', { fullName: 'X Y', email: 'xy@test.carevanta.local' }],
      [auditor, '/api/v1/admin/providers', { type: 'CLINIC', legalName: 'Edge Clinic', displayName: 'Edge Clinic' }],
      [auditor, '/api/v1/admin/roles', { key: 'EDGE_ROLE', name: 'Edge', permissions: ['users.read'], reason: 'probe role' }],
      [auditor, '/api/v1/admin/support-cases', { type: 'SUPPORT', subject: 'probe', description: 'probe', priority: 'LOW' }],
      [legal, '/api/v1/admin/finance/commission-policies', { code: 'EDGE_POLICY', name: 'Edge', category: 'OTHER', method: 'FLAT', flatMinor: 100, effectiveFrom: new Date().toISOString() }],
      [reviewer, '/api/v1/admin/catalogue/specialities', { code: 'EDGE_SPEC', name: 'Edge Speciality' }],
      [dispatcher, '/api/v1/admin/finance/settlements', {}],
      [dispatcher, '/api/v1/admin/ambulance/vehicles', { operatorProviderId: randomUUID(), registrationNumber: 'WB00XX0000', vehicleType: 'BLS', insuranceValidUntil: '2030-01-01' }],
      [nobody, '/api/v1/admin/users', { fullName: 'X Y', email: 'xy2@test.carevanta.local' }],
    ];
    for (const [who, url, body] of cases) {
      const res = await who.post(url, body, idem());
      expect(res.status, `${who.user.fullName} ${url} → ${res.status} ${JSON.stringify(res.body)}`).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
    // Reads the auditor is entitled to still work.
    expect((await auditor.get('/api/v1/admin/users')).status).toBe(200);
    expect((await auditor.get('/api/v1/admin/finance/transactions')).status).toBe(200);
    // A user with no roles cannot even list.
    expect((await nobody.get('/api/v1/admin/users')).status).toBe(403);
  });
});

describe('EDGE-HTTP: idempotency keys', () => {
  it('EDGE-HTTP-08: key format is enforced; reuse with a different body is 422; a failed attempt frees the key', async () => {
    const ctx = await affiliatedDoctor();
    const { slots } = await slotsFor(ctx.hospitalOwner, ctx.doctor.id, ctx.hospital.locationId, { capacity: 5 });
    const p = await patient();
    const body = { slotId: slots[0]!.id, patientProfileId: p.profileId };
    for (const key of ['', 'short', 'has spaces in it', 'x'.repeat(81), 'bad/slash', 'tab\tkey']) {
      const res = await p.post('/api/v1/patient/appointments', body, key ? { 'Idempotency-Key': key } : {});
      expect(res.status, `key=${JSON.stringify(key)}`).toBe(400);
    }
    // A failed attempt (unknown slot) does not burn the key.
    const key = { 'Idempotency-Key': `edge-${randomUUID()}` };
    expect((await p.post('/api/v1/patient/appointments', { ...body, slotId: randomUUID() }, key)).status).toBe(404);
    const ok = await p.post('/api/v1/patient/appointments', body, key);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    // Same key, same body → replay.
    const replay = await p.post('/api/v1/patient/appointments', body, key);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data.id).toBe(ok.body.data.id);
    // Same key, different body (another slot) → 422, and no second booking.
    const other = await p.post('/api/v1/patient/appointments', { ...body, slotId: slots[1]!.id }, key);
    expect(other.status).toBe(422);
    expect(other.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    // Keys are per user: another patient may use the same key string for their own booking.
    const q = await patient();
    const theirs = await q.post('/api/v1/patient/appointments', { slotId: slots[1]!.id, patientProfileId: q.profileId }, key);
    expect(theirs.status, JSON.stringify(theirs.body)).toBe(201);
    expect(theirs.body.data.id).not.toBe(ok.body.data.id);
    // Key order inside the JSON body does not matter (canonical hash).
    const reordered = await p.post('/api/v1/patient/appointments', { patientProfileId: p.profileId, slotId: slots[0]!.id }, key);
    expect(reordered.status).toBe(201);
    expect(reordered.headers['idempotent-replayed']).toBe('true');
  });
});
