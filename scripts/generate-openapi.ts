/** Writes docs/openapi.json from the route registry (`npm run openapi:generate`). */
import { mkdir, writeFile } from 'node:fs/promises';
import { createApp } from '../src/app.js';
import { generateOpenApiDocument } from '../src/http/openapi.js';
import { prisma } from '../src/lib/prisma.js';

createApp(); // registers every route with the OpenAPI registry
const doc = generateOpenApiDocument();
await mkdir('docs', { recursive: true });
await writeFile('docs/openapi.json', JSON.stringify(doc, null, 2));
const paths = Object.keys(doc.paths ?? {});
const ops = paths.reduce((n, p) => n + Object.keys((doc.paths as any)[p]).length, 0);
console.log(`docs/openapi.json written: ${paths.length} paths, ${ops} operations`);
await prisma.$disconnect();
