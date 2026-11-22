import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { AzureDevOpsClient, worstOutcome } from './client.js';
import type { AppConfig } from '../config/index.js';
import type { TestResult } from '../testing/types.js';

const cfg = { AZDO_ORG_URL: 'https://dev.azure.com/contoso', AZDO_PROJECT: 'ERP', AZDO_PAT: 'pat', AZDO_AUTH: 'pat', AZDO_HTTP_TIMEOUT_MS: 5000, AZDO_HTTP_MAX_RETRIES: 0, AZDO_HTTP_RETRY_BASE_MS: 1 } as AppConfig;
const row = (n: number, outcome: TestResult['outcome']): TestResult => ({
  testCaseId: '38', title: 'Create order', iteration: { row: n, count: 2 }, outcome,
  runState: outcome === 'passed' ? 'completed' : 'failed', startedAt: `2026-01-01T00:00:0${n}.000Z`, finishedAt: `2026-01-01T00:00:0${n + 1}.000Z`, durationMs: 1000,
  steps: [{ index: 1, status: outcome === 'passed' ? 'passed' : 'failed', actionPath: '0000000b0000000f', observed: `row ${n}`, durationMs: 1000 }], artifacts: [],
  ...(outcome === 'failed' ? { errorMessage: 'wrong status' } : {}),
});

async function publish(rejectDetails = false): Promise<Array<{ method: string; url: string; body: any }>> {
  const calls: Array<{ method: string; url: string; body: any }> = [];
  let detailPatches = 0;
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (method === 'POST' && /\/_apis\/test\/runs\?/.test(url)) return json({ id: 55, url: 'run' });
    if (method === 'POST' && /\/Runs\/55\/results\?/.test(url)) return json({ value: [{ id: 900 }] });
    if (method === 'PATCH' && /\/Runs\/55\/results\?/.test(url)) {
      if (rejectDetails && detailPatches++ === 0) return json({ message: 'iterationDetails unsupported' }, 400);
      return json({ value: [] });
    }
    if (method === 'PATCH' && /\/_apis\/test\/runs\/55\?/.test(url)) return json({ id: 55 });
    throw new Error(`Unexpected request ${method} ${url}`);
  }) as typeof fetch;
  const uploaded = await new AzureDevOpsClient(cfg).publishResults('7', [row(1, 'passed'), row(2, 'failed')]);
  assert.equal(uploaded.runId, 55);
  return calls;
}

describe('Azure DevOps iteration publishing', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('creates one case result with a failed worst-outcome rollup and per-row actionResults', async () => {
    const calls = await publish();
    const create = calls.find((c) => c.method === 'POST' && /Runs\/55\/results/.test(c.url))!;
    assert.equal(create.body.length, 1, 'rows must not create duplicate case results');
    assert.equal(create.body[0].outcome, 'Failed');
    assert.equal(create.body[0].testCase.id, '38');
    const patch = calls.find((c) => c.method === 'PATCH' && /Runs\/55\/results/.test(c.url))!;
    assert.equal(patch.body[0].iterationDetails.length, 2);
    assert.deepEqual(patch.body[0].iterationDetails.map((i: any) => [i.id, i.outcome]), [[1, 'Passed'], [2, 'Failed']]);
    assert.equal(patch.body[0].iterationDetails[0].actionResults[0].actionPath, '0000000b0000000f');
    assert.equal(patch.body[0].iterationDetails[1].actionResults[0].iterationId, 2);
  });

  it('falls back to case-level outcomes when the API rejects iteration details', async () => {
    const calls = await publish(true);
    const patches = calls.filter((c) => c.method === 'PATCH' && /Runs\/55\/results/.test(c.url));
    assert.equal(patches.length, 2);
    assert.equal(patches[0].body[0].iterationDetails.length, 2);
    assert.equal(patches[1].body[0].iterationDetails, undefined);
    assert.equal(patches[1].body[0].outcome, 'Failed');
  });

  it('uses a deterministic worst outcome', () => {
    assert.equal(worstOutcome([row(1, 'passed'), row(2, 'blocked')]), 'blocked');
    assert.equal(worstOutcome([row(1, 'skipped'), row(2, 'passed')]), 'passed');
    assert.equal(worstOutcome([row(1, 'skipped'), row(2, 'skipped')]), 'skipped');
  });
});
