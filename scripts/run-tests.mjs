#!/usr/bin/env node
// Runs the compiled tests with the built-in runner. Lists the files itself so it works on every Node >= 20 and on
// Windows, where `node --test "dist/**/*.test.js"` relies on glob support that older Node versions lack.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

function find(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...find(p));
    else if (e.isFile() && e.name.endsWith('.test.js')) out.push(p);
  }
  return out;
}

const filter = process.argv.slice(2);
const files = find('dist').filter((f) => !filter.length || filter.some((s) => f.includes(s))).sort();
if (!files.length) {
  console.error('No compiled tests found under dist/. Run `npm run build` first.');
  process.exit(1);
}
const res = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(res.status ?? 1);
