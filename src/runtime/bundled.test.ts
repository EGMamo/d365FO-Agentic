import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { bundledBin, packageCommand } from './bundled.js';

describe('bundled package commands', () => {
  it('finds a package bin in a node_modules folder above the code', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bundled-'));
    await mkdir(join(root, 'node_modules', '@scope', 'tool'), { recursive: true });
    await writeFile(join(root, 'node_modules', '@scope', 'tool', 'package.json'), JSON.stringify({ bin: { tool: 'cli.js' } }));
    const deep = join(root, 'dist', 'mcp');
    await mkdir(deep, { recursive: true });
    assert.equal(bundledBin('@scope/tool', 'tool', deep), join(root, 'node_modules', '@scope', 'tool', 'cli.js'));
    assert.equal(bundledBin('@scope/missing', 'x', deep), undefined);
  });

  it('runs a bundled package with this Node, and falls back to npx', () => {
    assert.deepEqual(packageCommand('p', 'p@latest', 'p', ['--a'], () => '/app/node_modules/p/cli.js'), { command: process.execPath, args: ['/app/node_modules/p/cli.js', '--a'] });
    assert.deepEqual(packageCommand('p', 'p@latest', 'p', ['--a'], () => undefined), { command: 'npx', args: ['-y', 'p@latest', '--a'] });
  });
});
