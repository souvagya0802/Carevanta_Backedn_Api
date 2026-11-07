import { describe, expect, it } from 'vitest';
import { withExplicitNulls } from '../../src/lib/prisma-null-defaults.js';
import { MODELS } from '../../src/lib/mongo-model-manifest.js';

describe('explicit nulls for omitted optional fields (MongoDB)', () => {
  it('fills omitted optional scalars on create, leaves provided values and defaults alone', () => {
    const out = withExplicitNulls('User', 'create', { data: { email: 'a@b.c', fullName: 'A', passwordHash: 'x' } }) as { data: Record<string, unknown> };
    expect(out.data.email).toBe('a@b.c');
    expect(out.data.phone).toBeNull();
    expect(out.data.lockedUntil).toBeNull();
    expect('status' in out.data).toBe(false); // has a default → Prisma fills it
    expect('createdAt' in out.data).toBe(false);
  });

  it('skips foreign keys when the payload uses relation objects (checked input)', () => {
    const fk = MODELS.ServiceTransaction!.foreignKeys;
    expect(fk.length).toBeGreaterThan(0);
    const out = withExplicitNulls('ServiceTransaction', 'create', { data: { provider: { connect: { id: 'p' } }, grossMinor: 1n } }) as { data: Record<string, unknown> };
    for (const f of fk) expect(f in out.data, f).toBe(false);
    // Unchecked input (plain providerId) does get the other FK nulls so source links behave like SQL NULLs.
    const unchecked = withExplicitNulls('ServiceTransaction', 'create', { data: { providerId: 'p', grossMinor: 1n } }) as { data: Record<string, unknown> };
    expect(unchecked.data.appointmentId).toBeNull();
    expect(unchecked.data.pharmacyOrderId).toBeNull();
  });

  it('completes nested creates inside create, update and upsert payloads', () => {
    const out = withExplicitNulls('Provider', 'create', { data: { displayName: 'X', type: 'HOSPITAL', slug: 'x', locations: { create: [{ name: 'Main', addressLine1: 'Road', city: 'Tamluk', district: 'PM', state: 'WB', pincode: '721636' }] } } }) as { data: { locations: { create: Record<string, unknown>[] } } };
    expect(out.data.locations.create[0]).toMatchObject({ latitude: null, longitude: null });
    const upd = withExplicitNulls('Provider', 'update', { where: { id: 'p' }, data: { locations: { create: { name: 'Branch', addressLine1: 'Road', city: 'Moyna', district: 'PM', state: 'WB', pincode: '721636' } } } }) as { data: { displayName?: unknown; locations: { create: Record<string, unknown> } } };
    expect(upd.data.locations.create.latitude).toBeNull();
    expect('displayName' in upd.data).toBe(false); // updates never invent nulls at the top level
    const ups = withExplicitNulls('User', 'upsert', { where: { id: 'u' }, create: { email: 'a@b.c', fullName: 'A' }, update: { fullName: 'B' } }) as { create: Record<string, unknown>; update: Record<string, unknown> };
    expect(ups.create.phone).toBeNull();
    expect('phone' in ups.update).toBe(false);
  });

  it('never touches Json fields or reads', () => {
    const out = withExplicitNulls('AuditEvent', 'create', { data: { action: 'x', entityType: 'y', entityId: 'z' } }) as { data: Record<string, unknown> };
    expect('metadata' in out.data).toBe(false);
    const args = { where: { phone: null } };
    expect(withExplicitNulls('User', 'findMany', args)).toBe(args);
  });
});
