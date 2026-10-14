#!/usr/bin/env node
// Writes desktop/app: the built agent (../dist, ../web, ../examples) plus the Electron shell, with a package.json
// that adds the pinned Playwright MCP so the app never needs npx. Run `npm run build` in the project first.
import { execSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(desktop, '..');
const app = join(desktop, 'app');
if (!existsSync(join(root, 'dist', 'ui', 'server.js'))) {
  console.error('Build the project first: npm run build (in the project folder).');
  process.exit(1);
}
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const desktopPkg = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));

rmSync(app, { recursive: true, force: true });
for (const dir of ['dist', 'web', 'examples']) cpSync(join(root, dir), join(app, dir), { recursive: true, filter: (src) => !src.endsWith('.test.js') && !src.endsWith('.test.d.ts') });
cpSync(join(root, 'LICENSE'), join(app, 'LICENSE'));
cpSync(join(desktop, 'shell'), join(app, 'shell'), { recursive: true });
writeFileSync(
  join(app, 'package.json'),
  JSON.stringify(
    {
      name: 'd365fo-agent',
      productName: 'D365FO Agent',
      version: rootPkg.version,
      description: rootPkg.description,
      license: rootPkg.license,
      author: 'D365FO Agent contributors',
      type: 'module',
      main: 'shell/main.mjs',
      desktopName: 'd365fo-agent.desktop',
      dependencies: { ...rootPkg.dependencies, '@playwright/mcp': desktopPkg.bundle.playwrightMcp },
    },
    null,
    2,
  ),
);
execSync('npm install --omit=dev --no-audit --no-fund --loglevel=error', { cwd: app, stdio: 'inherit' });
console.log(`Staged ${app}`);
