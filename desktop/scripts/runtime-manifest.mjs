import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function runtimeManifest(rootPkg, desktopPkg) {
  return {
    name: 'd365fo-agent',
    productName: 'D365FO Agent',
    version: rootPkg.version,
    description: rootPkg.description,
    license: rootPkg.license,
    author: 'D365FO Agent contributors',
    private: true,
    type: 'module',
    main: 'shell/main.mjs',
    desktopName: 'd365fo-agent.desktop',
    dependencies: { ...rootPkg.dependencies, '@playwright/mcp': desktopPkg.bundle.playwrightMcp },
  };
}

export function readRuntimeManifest() {
  const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
  return runtimeManifest(
    JSON.parse(readFileSync(join(desktop, '..', 'package.json'), 'utf8')),
    JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8')),
  );
}
