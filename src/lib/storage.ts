import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { AppError } from './errors.js';

/**
 * Private document storage. Keys are generated server-side only (never from
 * client input), so path traversal is impossible by construction; `resolve`
 * still double-checks containment. The local driver is for development and
 * single-node pilots — production should use encrypted object storage (e.g.
 * S3-compatible with SSE-KMS) behind the same interface.
 */
const ROOT = path.resolve(env.STORAGE_LOCAL_DIR);

export const ALLOWED_DOCUMENT_TYPES: Record<string, { ext: string; magic: (b: Buffer) => boolean }> = {
  'application/pdf': { ext: 'pdf', magic: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  'image/jpeg': { ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': {
    ext: 'png',
    magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  'image/webp': {
    ext: 'webp',
    magic: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
};
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

function resolveKey(key: string): string {
  if (!/^[a-z0-9/_.-]+$/.test(key) || key.includes('..')) throw new AppError(400, 'VALIDATION_FAILED', 'Invalid storage key');
  const full = path.resolve(ROOT, key);
  if (!full.startsWith(ROOT + path.sep)) throw new AppError(400, 'VALIDATION_FAILED', 'Invalid storage key');
  return full;
}

export function validateUpload(buffer: Buffer, mimeType: string) {
  const spec = ALLOWED_DOCUMENT_TYPES[mimeType];
  if (!spec) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Only PDF, JPEG and PNG files are accepted');
  if (buffer.length === 0) throw new AppError(400, 'VALIDATION_FAILED', 'Empty file');
  if (buffer.length > env.MAX_UPLOAD_BYTES) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'File too large');
  // Never trust the declared content type: check the file signature.
  if (!spec.magic(buffer)) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'File content does not match its declared type');
  return spec;
}

export async function putObject(prefix: string, buffer: Buffer, mimeType: string) {
  const spec = validateUpload(buffer, mimeType);
  const now = new Date();
  const key = `${prefix}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${spec.ext}`;
  const full = resolveKey(key);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, buffer, { flag: 'wx', mode: 0o600 });
  return { key, sha256: createHash('sha256').update(buffer).digest('hex'), sizeBytes: buffer.length };
}

export async function getObject(key: string): Promise<Buffer> {
  try {
    return await readFile(resolveKey(key));
  } catch {
    throw new AppError(404, 'NOT_FOUND', 'File not found');
  }
}
