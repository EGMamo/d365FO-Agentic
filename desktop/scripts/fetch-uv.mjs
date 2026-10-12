#!/usr/bin/env node
// Downloads the pinned uv binary for each platform/arch electron-builder will package on this machine, into
// resources/uv/<os>-<arch>/ (electron-builder's ${os} names: mac, win, linux). uv installs Python and Open WebUI
// on the user's first start. Pass targets to override, e.g. `node scripts/fetch-uv.mjs mac-arm64 mac-x64`.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8')).bundle.uv;
const TRIPLES = {
  'mac-arm64': 'aarch64-apple-darwin',
  'mac-x64': 'x86_64-apple-darwin',
  'win-x64': 'x86_64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
};
const defaults = { darwin: ['mac-arm64', 'mac-x64'], win32: ['win-x64'], linux: [`linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`] };
const targets = process.argv.slice(2).length ? process.argv.slice(2) : defaults[process.platform];

for (const target of targets) {
  const triple = TRIPLES[target];
  if (!triple) throw new Error(`Unknown target ${target}`);
  const out = join(desktop, 'resources', 'uv', target);
  const exe = join(out, target.startsWith('win') ? 'uv.exe' : 'uv');
  if (existsSync(exe) && existsSync(join(out, 'VERSION')) && readFileSync(join(out, 'VERSION'), 'utf8') === version) continue;
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const zip = target.startsWith('win');
  const name = `uv-${triple}.${zip ? 'zip' : 'tar.gz'}`;
  const url = `https://github.com/astral-sh/uv/releases/download/${version}/${name}`;
  console.log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const archive = join(out, name);
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  // tar ships with Windows 10+ and reads zip files too.
  execFileSync('tar', zip ? ['-xf', archive, '-C', out] : ['-xzf', archive, '-C', out, '--strip-components=1']);
  rmSync(archive);
  rmSync(join(out, 'uvx'), { force: true });
  rmSync(join(out, 'uvx.exe'), { force: true });
  rmSync(join(out, 'uvw.exe'), { force: true });
  if (!zip) chmodSync(exe, 0o755);
  writeFileSync(join(out, 'VERSION'), version);
}
