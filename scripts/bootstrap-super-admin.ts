/**
 * One-time super-admin bootstrap. Run by an operator with database access:
 *
 *   BOOTSTRAP_ADMIN_EMAIL=owner@example.com BOOTSTRAP_ADMIN_NAME="Owner" npm run admin:bootstrap
 *
 * - Refuses to run if any active SUPER_ADMIN already exists (further admins
 *   are created through the authenticated API by an existing super-admin).
 * - Never sets or prints a password. It prints a one-time set-password token
 *   (valid 72 h) to use with POST /api/v1/auth/password/reset.
 * - There is no HTTP endpoint for this.
 */
import { prisma } from '../src/lib/prisma.js';
import { syncAccessControl } from '../src/modules/access/seed-access.js';
import { randomToken, sha256Hex } from '../src/lib/crypto.js';
import { audit } from '../src/lib/audit.js';

const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
const fullName = process.env.BOOTSTRAP_ADMIN_NAME?.trim() || 'Platform owner';
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error('Set BOOTSTRAP_ADMIN_EMAIL to a valid email address.');
  process.exit(2);
}

try {
  await syncAccessControl(prisma);
  const existing = await prisma.userRole.count({ where: { revokedAt: null, role: { key: 'SUPER_ADMIN' }, user: { status: { in: ['ACTIVE', 'PENDING_VERIFICATION'] } } } });
  if (existing > 0) {
    console.error(`Refusing: ${existing} active super-admin account(s) already exist. Use the admin API to add more.`);
    process.exit(1);
  }
  const token = randomToken(32);
  const userId = await prisma.$transaction(async (tx) => {
    const role = await tx.role.findUniqueOrThrow({ where: { key: 'SUPER_ADMIN' } });
    const user =
      (await tx.user.findUnique({ where: { email } })) ??
      (await tx.user.create({ data: { email, fullName, status: 'ACTIVE', mustChangePassword: true, emailVerifiedAt: new Date() } }));
    await tx.userRole.create({ data: { userId: user.id, roleId: role.id, reason: 'Initial bootstrap' } });
    await tx.verificationToken.create({ data: { userId: user.id, purpose: 'PASSWORD_RESET', tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + 72 * 3_600_000) } });
    await audit(tx, { action: 'bootstrap.super_admin_created', entityType: 'user', entityId: user.id, actorType: 'SYSTEM', metadata: { email } });
    return user.id;
  });
  console.log(`Super-admin created: ${email} (${userId})`);
  console.log('Set the password within 72 hours with:');
  console.log(`  POST /api/v1/auth/password/reset  { "token": "${token}", "newPassword": "<choose a strong passphrase>" }`);
  console.log('This token is shown once and is not stored in plain text.');
} finally {
  await prisma.$disconnect();
}
