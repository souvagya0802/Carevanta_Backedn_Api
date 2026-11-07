import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { spawn } from 'node:child_process';

/**
 * Starts a throwaway single-node MongoDB replica set (transactions enabled, same
 * major line as Atlas), creates every index in an empty database and seeds
 * reference data once — so every test run also verifies that the indexes apply
 * cleanly from nothing. Tests never touch MONGODB_URI from .env.
 *
 * The mongod binary is downloaded once into ~/.cache/mongodb-binaries.
 *
 * Child processes are spawned asynchronously on purpose: a blocking execSync here
 * stalls this process's event loop, and with it the in-memory server's supervision,
 * which makes the Prisma engine in the child time out on connect.
 */
const DB_NAME = 'carevanta_test';
let replSet: MongoMemoryReplSet | undefined;

function run(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs} ms\n${out.slice(-2000)}`)); }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}\n${out.slice(-4000)}`));
    });
  });
}

export async function setup() {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger', dbName: DB_NAME } });
  const uri = replSet.getUri(DB_NAME);
  process.env.MONGODB_URI = uri;
  process.env.MONGODB_DB = DB_NAME;

  const env = {
    ...process.env,
    APP_ENV: 'test',
    MONGODB_URI: uri,
    MONGODB_DB: DB_NAME,
    JWT_SECRET: 'test-only-jwt-secret-not-for-any-real-environment-0123456789',
    DATA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  };
  // Every index (schema manifest + partial indexes), then reference data (run twice inside: proves the seed is idempotent).
  await run('npx', ['tsx', 'tests/helpers/seed-once.ts'], env, 240_000);
}

export async function teardown() {
  await replSet?.stop({ doCleanup: true, force: true });
}
