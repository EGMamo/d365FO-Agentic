import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { LlmHttpError, LlmUnavailableError, toUnavailable } from './errors.js';
import { OpenAiCompatibleProvider } from './openai-compatible.js';
import { AgentOrchestrator } from '../agent/orchestrator.js';
import { runCases } from '../core/runner.js';
import { fetchWithResilience, parseRetryAfterMs, retryDelayMs } from '../utils/http.js';
import type { AppConfig } from '../config/index.js';
import type { LlmCompleteResponse } from './types.js';
import type { TestCase, TestResult } from '../testing/types.js';

const tc = (id: string): TestCase => ({ id, source: 'local', title: `case ${id}`, steps: [{ index: 1, action: 'Open' }] });

describe('toUnavailable', () => {
  it('treats rate limits, auth failures, outages and network errors as "provider unavailable"', () => {
    for (const status of [401, 403, 429, 500, 502, 503]) {
      const e = toUnavailable(new LlmHttpError('boom', status));
      assert.ok(e instanceof LlmUnavailableError, String(status));
      assert.equal(e.status, status);
    }
    assert.match(toUnavailable(new LlmHttpError('limit', 429))!.message, /HTTP 429.*limit.*switch LLM_PROVIDER/);
    assert.match(toUnavailable(new LlmHttpError('limit', 429, 5_868_000))!.message, /asks for ~98 min\)/);
    assert.match(toUnavailable(new LlmHttpError('limit', 429, 45_000))!.message, /asks for ~45 s\)/);
    assert.match(toUnavailable(new LlmHttpError('limit', 429, 9 * 3_600_000))!.message, /asks for ~9 h\)/);
    assert.ok(toUnavailable(new TypeError('fetch failed')));
    assert.ok(toUnavailable(Object.assign(new Error('x'), { name: 'AbortError' })));
    assert.ok(toUnavailable(Object.assign(new Error('nope'), { status: 429 })), 'SDK errors carry a status too');
  });

  it('leaves per-request problems alone so they stay a test-level result', () => {
    assert.equal(toUnavailable(new LlmHttpError('context too long', 400)), undefined);
    assert.equal(toUnavailable(new LlmHttpError('not found', 404)), undefined);
    assert.equal(toUnavailable(new Error('something else')), undefined);
    assert.equal(toUnavailable(undefined), undefined);
  });
});

describe('openai-compatible provider errors', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('throws an LlmHttpError carrying the status', async () => {
    globalThis.fetch = async () => new Response('Sorry, you have exceeded your rate limit', { status: 429, headers: { 'retry-after': '5868' } });
    const llm = new OpenAiCompatibleProvider({ name: 'p', baseUrl: 'https://x/y', apiKey: 'k', model: 'm', maxTokens: 1, temperature: 0, maxRetries: 0 });
    await assert.rejects(llm.complete({ messages: [{ role: 'user', content: 'hi' }] }), (e: unknown) => {
      assert.ok(e instanceof LlmHttpError);
      assert.equal(e.status, 429);
      assert.equal(e.retryAfterMs, 5_868_000);
      assert.match(e.message, /p error 429: Sorry, you have exceeded/);
      return true;
    });
  });
});

describe('retryDelayMs', () => {
  const res = (retryAfter?: string) => ({ headers: new Headers(retryAfter ? { 'retry-after': retryAfter } : {}) });

  it('uses plain backoff without Retry-After', () => {
    const d = retryDelayMs(res(), 500, 1)!;
    assert.ok(d >= 500 && d < 750, String(d));
  });

  it('waits at least as long as a reasonable Retry-After asks (seconds or date)', () => {
    assert.ok(retryDelayMs(res('7'), 500, 1)! >= 7000);
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    assert.ok(retryDelayMs(res(new Date(now + 12_000).toUTCString()), 500, 1, now)! >= 12_000);
  });

  it('gives up (undefined) when the server asks for longer than 30s', () => {
    assert.equal(retryDelayMs(res('31'), 500, 1), undefined);
    assert.equal(retryDelayMs(res('5868'), 500, 1), undefined);
    assert.ok(retryDelayMs(res('30'), 500, 1)! >= 30_000);
  });

  it('ignores a Retry-After that is garbage or in the past', () => {
    assert.ok(retryDelayMs(res('soon'), 500, 1)! < 750);
    assert.ok(retryDelayMs(res('0'), 500, 1)! < 750);
    const now = Date.UTC(2026, 0, 1);
    assert.equal(parseRetryAfterMs(new Date(now - 60_000).toUTCString(), now), undefined);
  });
});

describe('fetchWithResilience', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const opts = { timeoutMs: 1000, maxRetries: 3, retryBaseMs: 1 };

  it('does not retry a 429 whose Retry-After is far too long, and leaves the body readable', async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return new Response('limit reached', { status: 429, headers: { 'retry-after': '5868' } }); };
    const res = await fetchWithResilience('https://x', {}, opts);
    assert.equal(calls, 1);
    assert.equal(res.status, 429);
    assert.equal(await res.text(), 'limit reached');
  });

  it('still retries transient failures without Retry-After', async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return calls < 3 ? new Response('busy', { status: 503 }) : new Response('ok'); };
    const res = await fetchWithResilience('https://x', {}, opts);
    assert.equal(calls, 3);
    assert.equal(await res.text(), 'ok');
  });
});

function orchestrator(complete: () => Promise<LlmCompleteResponse>, over: Partial<AppConfig> = {}) {
  const dir = mkdtemp(join(tmpdir(), 'orch-'));
  const calls = { llm: 0 };
  const build = async () => {
    const cfg = {
      LLM_PROVIDER: 'anthropic', AGENT_DRY_RUN: false, AGENT_VERBOSE: false, AGENT_MAX_STEPS: 10,
      AGENT_RELOOP_MAX_RETRIES: 2, AGENT_RELOOP_RETRY_ON: ['failed', 'blocked'], AGENT_RELOOP_COOLDOWN_MS: 0,
      D365_BASE_URL: 'https://x.sandbox.operations.dynamics.com', D365_COMPANY: 'USMF', REPORT_DIR: await dir, ...over,
    } as AppConfig;
    const llm = { name: 'fake', async complete() { calls.llm += 1; return complete(); } };
    const mcp = { async listTools() { return []; }, async callTool() { return { content: 'page', isError: false }; } };
    const kb = { retrieve: () => [], recipeFor: () => undefined, upsert() {}, async save() {} };
    return new AgentOrchestrator({ cfg, llm, mcp, kb, mcpServers: ['playwright', 'learn'] } as never);
  };
  return { calls, run: async (t: TestCase) => (await build()).runTestCase(t) };
}

describe('orchestrator and LLM outages', () => {
  it('propagates a rate limit instead of recording a verdict, and does not retry the case', async () => {
    const o = orchestrator(async () => { throw new LlmHttpError('github-copilot error 429: rate limit', 429); });
    await assert.rejects(o.run(tc('A')), (e: unknown) => e instanceof LlmUnavailableError && /HTTP 429/.test(e.message));
    assert.equal(o.calls.llm, 1, 'no reloop retry against a rate-limited provider');
  });

  it('still records a per-request LLM error (bad request) as a blocked case', async () => {
    const o = orchestrator(async () => { throw new LlmHttpError('provider error 400: context too long', 400); }, { AGENT_RELOOP_MAX_RETRIES: 0 });
    const res = await o.run(tc('B'));
    assert.equal(res.outcome, 'blocked');
    assert.match(res.errorMessage ?? '', /Transient orchestration failure.*400/);
  });

  it('explains a failing verdict that came without a reason, from the step that failed', async () => {
    const turns: LlmCompleteResponse[] = [
      { text: '', stopReason: 'tool_use', toolCalls: [{ id: '1', name: 'report_step', arguments: { index: 1, status: 'blocked', observed: 'Sign-in page asked for MFA' } }] },
      { text: '', stopReason: 'tool_use', toolCalls: [{ id: '2', name: 'finish_test', arguments: { outcome: 'blocked' } }] },
    ];
    const res = await orchestrator(async () => turns.shift()!, { AGENT_RELOOP_MAX_RETRIES: 0 }).run(tc('C'));
    assert.equal(res.outcome, 'blocked');
    assert.equal(res.errorMessage, 'Step 1 blocked: Sign-in page asked for MFA');
  });

  it('never invents a reason for a passing test', async () => {
    const res = await orchestrator(async () => ({ text: '', stopReason: 'tool_use', toolCalls: [{ id: '1', name: 'finish_test', arguments: { outcome: 'passed' } }] })).run(tc('D'));
    assert.equal(res.errorMessage, undefined);
  });
});

describe('runCases', () => {
  const result = (id: string, outcome: TestResult['outcome'], errorMessage?: string): TestResult => ({
    testCaseId: id, title: `case ${id}`, outcome, runState: 'completed', startedAt: '', finishedAt: '', durationMs: 1500, steps: [], artifacts: [], errorMessage,
  });

  it('runs every case and prints why a case did not pass', async () => {
    const out: string[] = [];
    const outcomes = { A: result('A', 'passed'), B: result('B', 'failed', 'Step 2 failed:\n vendor   not found') };
    const { results, aborted } = await runCases({ runTestCase: async (t) => outcomes[t.id as 'A' | 'B'] }, [tc('A'), tc('B')], (l) => out.push(l));
    assert.equal(aborted, undefined);
    assert.deepEqual(results.map((r) => r.testCaseId), ['A', 'B']);
    assert.ok(out.includes('    reason: Step 2 failed: vendor not found'));
    assert.ok(!out.some((l) => l.includes('reason') && l.includes('case A')));
  });

  it('stops at the first LLM outage, keeps earlier results, and does not run the rest', async () => {
    const ran: string[] = [];
    const out: string[] = [];
    const runner = {
      async runTestCase(t: TestCase) {
        ran.push(t.id);
        if (t.id === 'B') throw new LlmUnavailableError('LLM provider unavailable (HTTP 429): slow down', 429);
        return result(t.id, 'passed');
      },
    };
    const { results, aborted } = await runCases(runner, [tc('A'), tc('B'), tc('C'), tc('D')], (l) => out.push(l));
    assert.deepEqual(ran, ['A', 'B']);
    assert.match(aborted ?? '', /HTTP 429/);
    assert.deepEqual(results.map((r) => [r.testCaseId, r.outcome]), [['A', 'passed'], ['B', 'blocked']]);
    assert.match(results[1].errorMessage ?? '', /Run aborted, not a test result.*HTTP 429/);
    assert.ok(out.some((l) => l.includes('2 further case(s) were not run')));
  });

  it('lets unexpected errors propagate', async () => {
    await assert.rejects(runCases({ runTestCase: async () => { throw new Error('bug'); } }, [tc('A')], () => {}), /bug/);
  });
});
