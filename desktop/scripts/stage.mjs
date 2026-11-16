#!/usr/bin/env node
// Writes desktop/app: the built agent (../dist, ../web, ../examples) plus the Electron shell, with a package.json
// that adds the pinned Playwright MCP so the app never needs npx. Run `npm run build` in the project first.
import { execSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { readRuntimeManifest } from './runtime-manifest.mjs';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(desktop, '..');
const app = join(desktop, 'app');
if (!existsSync(join(root, 'dist', 'ui', 'server.js'))) {
  console.error('Build the project first: npm run build (in the project folder).');
  process.exit(1);
}
const runtime = join(desktop, 'runtime');
const manifest = JSON.parse(readFileSync(join(runtime, 'package.json'), 'utf8'));
if (!isDeepStrictEqual(manifest, readRuntimeManifest())) {
  throw new Error('The desktop runtime manifest is stale. Run npm run lock:runtime in desktop and commit its manifest and lockfile.');
}
const lock = JSON.parse(readFileSync(join(runtime, 'package-lock.json'), 'utf8'));
if (!isDeepStrictEqual(lock.packages?.['']?.dependencies, manifest.dependencies)) {
  throw new Error('The desktop runtime lock does not match its manifest. Run npm run lock:runtime in desktop.');
}

rmSync(app, { recursive: true, force: true });
for (const dir of ['dist', 'web', 'examples']) cpSync(join(root, dir), join(app, dir), { recursive: true, filter: (src) => !src.endsWith('.test.js') && !src.endsWith('.test.d.ts') });
cpSync(join(root, 'LICENSE'), join(app, 'LICENSE'));
cpSync(join(desktop, 'shell'), join(app, 'shell'), { recursive: true });
cpSync(join(runtime, 'package.json'), join(app, 'package.json'));
cpSync(join(runtime, 'package-lock.json'), join(app, 'package-lock.json'));
// No Python/Open WebUI runtime is staged; conversations are migrated from the legacy database instead.
execSync('npm ci --omit=dev --ignore-scripts --no-fund --loglevel=error', { cwd: app, stdio: 'inherit' });
execSync('npm audit --omit=dev --audit-level=high', { cwd: app, stdio: 'inherit' });
// A machine-readable inventory accompanies the exact dependency lock in every installer.
execSync('npm sbom --omit=dev --sbom-format=cyclonedx > sbom.cdx.json', { cwd: app, stdio: 'inherit' });
console.log(`Staged ${app}`);
