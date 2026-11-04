#!/usr/bin/env node
// Run intentionally when root dependencies or the bundled Playwright pin change.
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRuntimeManifest } from './runtime-manifest.mjs';

const runtime = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime');
mkdirSync(runtime, { recursive: true });
writeFileSync(join(runtime, 'package.json'), JSON.stringify(readRuntimeManifest(), null, 2) + '\n');
execSync('npm install --package-lock-only --ignore-scripts --no-fund', { cwd: runtime, stdio: 'inherit' });
execSync('npm audit --omit=dev --audit-level=high', { cwd: runtime, stdio: 'inherit' });
