import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

// The CLI has import-time side effects (profile and .env loading). This smoke test proves the shipped
// `bin` entry still starts and exposes its commands; a broken top-level import would fail here first.
const cli = fileURLToPath(new URL('./index.js', import.meta.url));

describe('d365fo-agent CLI', () => {
  it('starts and lists its commands', () => {
    const res = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Usage: d365fo-agent/);
    for (const cmd of ['doctor', 'session-login', 'discover', 'run', 'report', 'upload', 'ui']) {
      assert.match(res.stdout, new RegExp(`\\b${cmd}\\b`), `help should list "${cmd}"`);
    }
  });

  it('reports its version', () => {
    const res = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout.trim(), /^\d+\.\d+\.\d+$/);
  });
});
