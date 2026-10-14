import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Finds the command-line script of a package installed next to this code, by walking up the node_modules folders.
 * The desktop app ships @playwright/mcp this way so it needs no npx; a source checkout does not have it and keeps
 * using npx. Returns undefined when the package is not installed.
 */
export function bundledBin(pkg: string, bin: string, from = dirname(fileURLToPath(import.meta.url))): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const manifest = join(dir, 'node_modules', pkg, 'package.json');
    if (existsSync(manifest)) {
      try {
        const meta = JSON.parse(readFileSync(manifest, 'utf8')) as { bin?: string | Record<string, string> };
        const rel = typeof meta.bin === 'string' ? meta.bin : meta.bin?.[bin];
        return rel ? join(dirname(manifest), rel) : undefined;
      } catch {
        return undefined;
      }
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/** How to start a package's command: with this Node (or the desktop app running as Node) when bundled, else through npx. */
export function packageCommand(pkg: string, spec: string, bin: string, args: string[], find: typeof bundledBin = bundledBin): { command: string; args: string[] } {
  const script = find(pkg, bin);
  return script ? { command: process.execPath, args: [script, ...args] } : { command: 'npx', args: ['-y', spec, ...args] };
}
