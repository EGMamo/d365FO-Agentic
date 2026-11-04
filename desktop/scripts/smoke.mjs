#!/usr/bin/env node
// Exercise a fresh packaged application on each native build host, without touching personal app data.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const candidates = process.platform === 'darwin'
  ? [join(root, 'desktop', 'release', 'mac-arm64', 'D365FO Agent.app', 'Contents', 'MacOS', 'D365FO Agent')]
  : process.platform === 'win32'
    ? [join(root, 'desktop', 'release', 'win-unpacked', 'D365FO Agent.exe')]
    : [];
const exe = candidates.find(existsSync);
if (!exe) throw new Error(`No packaged application found for ${process.platform}/${process.arch}. Build the native installer first.`);
const result = spawnSync(process.execPath, [join(root, 'desktop', 'e2e', 'run.mjs')], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    E2E_APP: exe,
    E2E_OUT: process.env.E2E_OUT || join(root, 'desktop', 'release', 'smoke'),
    E2E_OPENWEBUI: process.env.E2E_OPENWEBUI || 'false',
  },
});
process.exit(result.status ?? 1);
