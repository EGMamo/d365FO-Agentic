import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { composeUp, dockerComposeAvailable, waitForHttp, writeComposeEnv, type Run } from './studio.js';

describe('studio', () => {
  it('writes the compose env file with the tool address and key, owner-only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'studio-'));
    const file = await writeComposeEnv(dir, { toolPort: 4366, toolKey: 'k'.repeat(48), webuiPort: 3001 });
    const text = await readFile(file, 'utf8');
    assert.match(text, /^OPENWEBUI_PORT=3001$/m);
    assert.match(text, /^D365FO_TOOL_URL=http:\/\/host\.docker\.internal:4366\/tools$/m);
    assert.match(text, new RegExp(`^D365FO_TOOL_KEY=${'k'.repeat(48)}$`, 'm'));
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  });

  it('runs docker compose with the env file and reports whether Docker is there', async () => {
    const calls: string[][] = [];
    const ok: Run = async (cmd, args) => (calls.push([cmd, ...args]), 0);
    assert.equal(await dockerComposeAvailable(ok), true);
    assert.equal(await dockerComposeAvailable(async () => null), false);
    assert.equal(await composeUp('/x/openwebui', ok), true);
    assert.deepEqual(calls[1], ['docker', 'compose', '-f', join('/x/openwebui', 'docker-compose.yml'), '--env-file', join('/x/openwebui', '.env'), 'up', '-d']);
  });

  it('waits until the address answers, and gives up after the timeout', async () => {
    let n = 0;
    const flaky = (async () => {
      if (++n < 3) throw new Error('ECONNREFUSED');
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    assert.equal(await waitForHttp('http://x/health', 1000, flaky, 1), true);
    assert.equal(await waitForHttp('http://x/health', 30, (async () => new Response('', { status: 503 })) as typeof fetch, 5), false);
  });
});
