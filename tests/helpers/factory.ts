import request from 'supertest';
import type { Express } from 'express';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../src/lib/prisma.js';
import { hashPassword } from '../../src/modules/auth/passwords.js';
import { createApp } from '../../src/app.js';

export const TEST_PASSWORD = 'Correct-Horse-Battery-9';
let app: Express | undefined;
let cachedHash: string | undefined;

export function getApp(): Express {
  app ??= createApp();
  return app;
}

export function api() {
  return request(getApp());
}

export async function createUser(opts: {
  roles?: string[];
  status?: 'ACTIVE' | 'PENDING_VERIFICATION' | 'SUSPENDED' | 'DEACTIVATED';
  email?: string;
  phone?: string;
  fullName?: string;
} = {}) {
  cachedHash ??= await hashPassword(TEST_PASSWORD);
  const email = opts.email ?? `user-${randomUUID().slice(0, 8)}@test.carevanta.local`;
  const user = await prisma.user.create({
    data: {
      email,
      phone: opts.phone ?? null,
      fullName: opts.fullName ?? 'Test User',
      passwordHash: cachedHash,
      status: opts.status ?? 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  for (const key of opts.roles ?? []) {
    const role = await prisma.role.findUniqueOrThrow({ where: { key } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  }
  return user;
}

export async function login(email: string, password = TEST_PASSWORD) {
  const res = await api().post('/api/v1/auth/login').send({ identifier: email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data as { accessToken: string; refreshToken: string; sessionId: string };
}

/** Create a user with roles and return an authorised supertest wrapper. */
export async function actor(roles: string[] = ['SUPER_ADMIN'], opts: Parameters<typeof createUser>[0] = {}) {
  const user = await createUser({ ...opts, roles });
  const tokens = await login(user.email!);
  const auth = { Authorization: `Bearer ${tokens.accessToken}` };
  return {
    user,
    tokens,
    get: (url: string) => api().get(url).set(auth),
    post: (url: string, body?: object, headers: Record<string, string> = {}) =>
      api().post(url).set(auth).set(headers).send(body ?? {}),
    patch: (url: string, body?: object) => api().patch(url).set(auth).send(body ?? {}),
    put: (url: string, body?: object) => api().put(url).set(auth).send(body ?? {}),
    delete: (url: string) => api().delete(url).set(auth),
    upload: (url: string, file: Buffer, contentType: string) => api().post(url).set(auth).set('Content-Type', contentType).send(file),
  };
}

export type Actor = Awaited<ReturnType<typeof actor>>;

export function idem(): Record<string, string> {
  return { 'Idempotency-Key': `test-${randomUUID()}` };
}
