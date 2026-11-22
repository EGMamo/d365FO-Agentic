import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { AppConfig } from '../config/index.js';
import { readReplayResults, replayEnvironment, replayFilters, replayTestResults, startReplay } from './replay.js';

const cfgAt = (dir: string): AppConfig => ({
  REPORT_DIR: dir,
  AGENT_REPLAY_DIR: path.join(dir, 'replay'),
  D365_BASE_URL: 'https://contoso.example/app',
  D365_STORAGE_STATE: path.join(dir, 'session.json'),
  D365_PASSWORD: 'never-in-child',
  AZDO_PAT: 'never-in-child',
  ANTHROPIC_API_KEY: 'never-in-child',
  PW_BROWSER: 'chromium',
} as AppConfig);

async function fakeCli(dir: string, source: string): Promise<void> {
  const packageDir = path.join(dir, 'replay', 'node_modules', '@playwright', 'test');
  await mkdir(packageDir, { recursive: true });
  await writeFile(path.join(packageDir, 'cli.js'), source);
}

describe('AI-free replay', () => {
  it('converts paths and globs to project-contained Playwright filters', () => {
    const testsDir = '/work/replay';
    const file = path.join(testsDir, 'tests', 'TC-1-one.spec.ts');
    const kind = (p: string) => p === file ? 'file' as const : undefined;
    const [filter] = replayFilters(['tests/TC-1-one.spec.ts'], { cwd: '/work', testsDir, kind });
    assert.ok(new RegExp(filter, 'i').test(file));
    assert.deepEqual(replayFilters(['TC-123'], { cwd: '/work', testsDir, kind }), ['TC-123']);
    assert.throws(() => replayFilters(['/etc/passwd'], { cwd: '/work', testsDir, kind: (p) => p === '/etc/passwd' ? 'file' : undefined }), /must stay inside/);
  });

  it('scrubs model, ADO and password secrets from the child environment', () => {
    const env = replayEnvironment(cfgAt('/work'), '/bundled/node_modules', {
      PATH: '/bin', ANTHROPIC_API_KEY: 'secret', AZDO_PAT: 'secret', D365_PASSWORD: 'secret', HTTPS_PROXY: 'http://proxy',
    });
    assert.equal(env.PATH, '/bin');
    assert.equal(env.HTTPS_PROXY, 'http://proxy');
    assert.equal(env.D365_URL, 'https://contoso.example/app');
    assert.equal(env.PW_BROWSER, 'chromium');
    for (const key of ['ANTHROPIC_API_KEY', 'AZDO_PAT', 'D365_PASSWORD']) assert.equal(env[key], undefined);
  });

  it('runs a mocked local Playwright CLI and reads only fresh row results', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'd365-replay-'));
    const cfg = cfgAt(dir);
    await fakeCli(dir, `const fs=require('node:fs');fs.mkdirSync('results',{recursive:true});
      fs.writeFileSync('results/results.json',JSON.stringify({suites:[{specs:[{title:'TC 1: One [row 2]',tests:[{annotations:[{type:'ado-test-case',description:'1'},{type:'iteration',description:'2'},{type:'iteration-count',description:'2'}],status:'expected',results:[{startTime:'2026-01-01T00:00:00.000Z',duration:25}]}]}]}]}));
      fs.writeFileSync('env.json',JSON.stringify({url:process.env.D365_URL,key:process.env.ANTHROPIC_API_KEY,pat:process.env.AZDO_PAT,password:process.env.D365_PASSWORD,browser:process.env.PW_BROWSER}));`);
    await mkdir(path.dirname(replayResultsPath(cfg)), { recursive: true });
    await writeFile(replayResultsPath(cfg), '{"stale":true}');
    const run = startReplay(cfg);
    assert.equal(await run.done, 0);
    const rows = readReplayResults(cfg, run.startedAt);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].caseId, rows[0].row, rows[0].count, rows[0].outcome], ['1', 2, 2, 'passed']);
    assert.deepEqual(replayTestResults(rows)[0].iteration, { row: 2, count: 2 });
    const env = JSON.parse(await readFile(path.join(cfg.AGENT_REPLAY_DIR!, 'env.json'), 'utf8')) as Record<string, unknown>;
    assert.deepEqual([env.key, env.pat, env.password], [undefined, undefined, undefined]);
    assert.equal(env.url, cfg.D365_BASE_URL);
  });

  it('executes a local spec with the real pinned Playwright runner and no browser/model/MCP', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'd365-replay-real-'));
    const cfg = cfgAt(dir);
    await mkdir(path.join(cfg.AGENT_REPLAY_DIR!, 'tests'), { recursive: true });
    await writeFile(path.join(cfg.AGENT_REPLAY_DIR!, 'tests', 'smoke.spec.ts'), `import { test } from '@playwright/test';
test('TC 99: local smoke', { annotation: [{ type: 'test-case-id', description: '99' }, { type: 'iteration', description: '1' }, { type: 'iteration-count', description: '1' }] }, () => {});
`);
    const run = startReplay(cfg);
    assert.equal(await run.done, 0);
    const rows = readReplayResults(cfg, run.startedAt);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].caseId, rows[0].outcome], ['99', 'passed']);
  });

  it('deletes stale results before a failed launch and supports cancellation', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'd365-replay-stale-'));
    const cfg = cfgAt(dir);
    await fakeCli(dir, `throw new Error('cannot start');`);
    await mkdir(path.dirname(replayResultsPath(cfg)), { recursive: true });
    await writeFile(replayResultsPath(cfg), '{"stale":true}');
    const failed = startReplay(cfg);
    assert.notEqual(await failed.done, 0);
    assert.equal(existsSync(replayResultsPath(cfg)), false);
    assert.deepEqual(readReplayResults(cfg, failed.startedAt), []);

    await fakeCli(dir, `setInterval(()=>{},1000);`);
    const ctl = new AbortController();
    const running = startReplay(cfg, { signal: ctl.signal });
    ctl.abort();
    assert.notEqual(await running.done, 0);
  });
});

function replayResultsPath(cfg: AppConfig): string {
  return path.join(cfg.AGENT_REPLAY_DIR!, 'results', 'results.json');
}
