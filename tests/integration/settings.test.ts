import { beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase } from '../helpers/db.js';
import { actor } from '../helpers/factory.js';

beforeAll(resetDatabase);

describe('platform settings — metadata, bounds and safety rails', () => {
  it('describes every setting with label, group, type, risk and default so the UI never hardcodes them', async () => {
    const sa = await actor(['SUPER_ADMIN']);
    const res = await sa.get('/api/v1/admin/settings');
    expect(res.status).toBe(200);
    const byKey = new Map(res.body.data.map((s: { key: string }) => [s.key, s]));
    const radius = byKey.get('search.default_radius_km') as { meta: Record<string, unknown>; updatedBy: unknown; value: unknown };
    expect(radius.meta).toMatchObject({ label: 'Default search radius', group: 'search', groupLabel: 'Discovery', type: 'integer', unit: 'km', min: 1, max: 200, risk: 'low', default: 15 });
    expect(typeof radius.meta.isDefault).toBe('boolean');
    expect(radius.meta.isDefault).toBe(radius.value === 15);
    const dispatch = byKey.get('emergency.live_dispatch_enabled') as { meta: Record<string, unknown> };
    expect(dispatch.meta).toMatchObject({ type: 'boolean', risk: 'high' });
    expect(typeof dispatch.meta.help).toBe('string');
    expect(radius.updatedBy === null || typeof (radius.updatedBy as { fullName: string }).fullName === 'string').toBe(true);
  });

  it('rejects out-of-range, wrong-shape, unchanged and malformed values with field-level errors', async () => {
    const sa = await actor(['SUPER_ADMIN']);
    const get = async (key: string) => (await sa.get('/api/v1/admin/settings')).body.data.find((x: { key: string }) => x.key === key);
    const radius = await get('search.default_radius_km');
    const put = (key: string, value: unknown, version: number, reason = 'Edge-case test with a valid reason') => sa.put(`/api/v1/admin/settings/${key}`, { value, expectedVersion: version, reason });

    const tooBig = await put('search.default_radius_km', 500, radius.version);
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.error.message).toMatch(/at most 200 km/);
    expect(tooBig.body.error.details).toMatchObject({ field: 'value' });
    expect((await put('search.default_radius_km', 0, radius.version)).status).toBe(400);
    expect((await put('search.default_radius_km', 12.5, radius.version)).body.error.message).toMatch(/whole number/);
    expect((await put('search.default_radius_km', radius.value, radius.version)).body.error.message).toMatch(/unchanged/);
    expect((await put('search.default_radius_km', 20, radius.version, 'abc')).status).toBe(400); // reason too short

    const num = await get('emergency.public_number');
    expect((await put('emergency.public_number', '911-help', num.version)).body.error.message).toMatch(/2–6 digits/);
    expect((await put('emergency.public_number', '   ', num.version)).status).toBe(400);
    const hold = await get('finance.settlement_hold_days');
    expect((await put('finance.settlement_hold_days', -1, hold.version)).status).toBe(400);
    expect((await put('finance.settlement_hold_days', 91, hold.version)).status).toBe(400);
    expect((await put('finance.settlement_hold_days', 'seven', hold.version)).status).toBe(400);
    expect((await put('booking.require_provider_confirmation', 'true', hold.version)).status).toBe(400);
    expect((await sa.put('/api/v1/admin/settings/smtp.host', { value: 'x', expectedVersion: 1, reason: 'bypass attempt' })).status).toBe(400);
    expect((await sa.put('/api/v1/admin/settings/does.not.exist', { value: 1, expectedVersion: 1, reason: 'unknown key' })).status).toBe(404);
  });

  it('accepts a valid change, records who changed it, bumps the version and flags that the value left its default', async () => {
    const sa = await actor(['SUPER_ADMIN']);
    const before = (await sa.get('/api/v1/admin/settings')).body.data.find((x: { key: string }) => x.key === 'booking.patient_cancellation_cutoff_minutes');
    const target = before.value === 180 ? 240 : 180;
    const res = await sa.put('/api/v1/admin/settings/booking.patient_cancellation_cutoff_minutes', { value: target, expectedVersion: before.version, reason: 'Pilot providers asked for a longer window' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ value: target, version: before.version + 1, updatedBy: { id: sa.user.id } });
    expect(res.body.data.meta.isDefault).toBe(false);
    const stale = await sa.put('/api/v1/admin/settings/booking.patient_cancellation_cutoff_minutes', { value: 300, expectedVersion: before.version, reason: 'stale write attempt' });
    expect(stale.status).toBe(409);
    const back = await sa.put('/api/v1/admin/settings/booking.patient_cancellation_cutoff_minutes', { value: 120, expectedVersion: before.version + 1, reason: 'Reset to the platform default' });
    expect(back.status).toBe(200);
    expect(back.body.data.meta.isDefault).toBe(true);
  });
});
