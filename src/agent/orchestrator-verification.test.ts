import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AgentOrchestrator, unverifiedSteps } from './orchestrator.js';
import type { AppConfig } from '../config/index.js';
import type { LlmCompleteResponse } from '../llm/types.js';
import type { TestCase } from '../testing/types.js';
import { writeReports } from '../reporting/reporters.js';
import { readFile } from 'node:fs/promises';

const tc: TestCase = {
  id: 'T1', source: 'local', title: 'verify', steps: [{ index: 1, action: 'Open' }, { index: 2, action: 'Save', expected: 'Saved' }],
};
const call = (name: string, args: Record<string, unknown>, id = name): LlmCompleteResponse => ({ text: '', stopReason: 'tool_use', toolCalls: [{ id, name, arguments: args }] });
const finish = (outcome = 'passed') => call('finish_test', { outcome }, 'fin');

async function run(turns: LlmCompleteResponse[], over: Partial<AppConfig> = {}, callTool?: (s: string, t: string, a: Record<string, unknown>, ms?: number) => Promise<{ content: unknown; isError: boolean }>, testCase = tc) {
  const dir = await mkdtemp(join(tmpdir(), 'orch-'));
  const cfg = {
    LLM_PROVIDER: 'anthropic', AGENT_DRY_RUN: false, AGENT_VERBOSE: false, AGENT_MAX_STEPS: 30, REPORT_DIR: dir, D365_BASE_URL: 'https://x.sandbox.operations.dynamics.com',
    D365_COMPANY: 'USMF', AGENT_TOOL_TIMEOUT_MS: 60000, AGENT_NAV_TIMEOUT_MS: 90000, ...over,
  } as AppConfig;
  const toolResults: string[] = [];
  const llm = {
    name: 'fake',
    async complete(req: { messages: Array<{ role: string; content: string }> }) {
      const last = req.messages.at(-1);
      if (last?.role === 'tool') toolResults.push(last.content);
      return turns.shift() ?? finish('blocked');
    },
  };
  const mcp = { async listTools() { return []; }, callTool: callTool ?? (async () => ({ content: 'page', isError: false })) };
  const result = await new AgentOrchestrator({ cfg, llm, mcp, mcpServers: ['playwright', 'learn'] } as never).runTestCase(testCase);
  return { result, toolResults, dir };
}

describe('assertion discipline', () => {
  it('requires `verified` when a passed step has an expected result, and records nothing until it is given', async () => {
    const { result, toolResults } = await run([
      call('report_step', { index: 1, status: 'passed', observed: 'opened' }),
      call('report_step', { index: 2, status: 'passed', observed: 'saved' }, 'r2'),
      call('report_step', { index: 2, status: 'passed', observed: 'header shows Saved', verified: true }, 'r3'),
      finish(),
    ]);
    assert.match(toolResults[1], /has an expected result[\s\S]*Nothing was recorded/);
    assert.equal(result.outcome, 'passed');
    assert.equal(result.steps.find((s) => s.index === 2)?.verified, true);
  });

  it('does not count a pass whose expected result was marked unverified', async () => {
    const { result } = await run([
      call('report_step', { index: 1, status: 'passed' }),
      call('report_step', { index: 2, status: 'passed', observed: 'could not read the banner', verified: false }, 'r2'),
      finish(),
    ]);
    assert.equal(result.outcome, 'blocked');
    assert.match(result.errorMessage ?? '', /step 2 has an expected result that was not verified/);
  });

  it('does not count a pass when the step with an expected result was never reported', async () => {
    const { result } = await run([call('report_step', { index: 1, status: 'passed' }), finish()]);
    assert.equal(result.outcome, 'blocked');
  });

  it('leaves dry runs alone, since nothing can be verified there', async () => {
    const { result } = await run([finish()], { AGENT_DRY_RUN: true });
    assert.equal(result.outcome, 'passed');
  });

  it('unverifiedSteps ignores steps without an expected result and failed steps', () => {
    assert.deepEqual(unverifiedSteps(tc, [{ index: 2, status: 'failed', durationMs: 0 }]), []);
    assert.deepEqual(unverifiedSteps(tc, []), [2]);
  });
});

describe('time budgets', () => {
  const nav = (id = 'n') => call('playwright__browser_navigate', { url: 'https://x.sandbox.operations.dynamics.com' }, id);

  it('passes the navigation budget to navigation and the tool budget to other calls', async () => {
    const seen: Array<[string, number | undefined]> = [];
    await run([nav(), call('playwright__browser_snapshot', {}, 's'), finish('blocked')], { AGENT_TOOL_TIMEOUT_MS: 1000, AGENT_NAV_TIMEOUT_MS: 5000 }, async (_s, t, _a, ms) => { seen.push([t, ms]); return { content: 'page', isError: false }; });
    assert.deepEqual(seen, [['browser_navigate', 5000], ['browser_snapshot', 1000]]);
  });

  it('never cuts an explicit wait short', async () => {
    const seen: Array<number | undefined> = [];
    await run([call('playwright__browser_wait_for', { time: 30 }), finish('blocked')], { AGENT_TOOL_TIMEOUT_MS: 1000 }, async (_s, _t, _a, ms) => { seen.push(ms); return { content: 'ok', isError: false }; });
    assert.equal(seen[0], 35000);
  });

  it('reports a timeout to the model and records it on the result, without swallowing it', async () => {
    const { result, toolResults } = await run([nav(), finish('blocked')], {}, async () => { throw Object.assign(new Error('Request timed out'), { code: -32001 }); });
    assert.match(toolResults[0], /timed out after 90s[\s\S]*fresh browser_snapshot/);
    assert.equal(result.timeouts?.length, 1);
    assert.match(result.timeouts?.[0] ?? '', /browser_navigate exceeded 90s/);
  });

  it('does not treat other tool errors as timeouts', async () => {
    const { result } = await run([nav(), finish('blocked')], {}, async () => { throw new Error('boom'); });
    assert.equal(result.timeouts, undefined);
  });
});

describe('per-run data bag', () => {
  it('stores, recalls and reports recorded values, redacting secrets and capping the count', async () => {
    const turns = [
      call('record_value', { key: 'vendor', value: 'TESTV-1' }, 'a'),
      call('record_value', { key: 'note', value: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz' }, 'b'),
      call('recall_values', {}, 'c'),
      call('report_step', { index: 1, status: 'passed' }, 'd'),
      call('report_step', { index: 2, status: 'passed', verified: true, observed: 'saved' }, 'e'),
      finish(),
    ];
    const { result, toolResults, dir } = await run(turns);
    assert.deepEqual(JSON.parse(toolResults[2]), { vendor: 'TESTV-1', note: '***' });
    assert.deepEqual(result.data, { vendor: 'TESTV-1', note: '***' });
    await writeReports(dir, [result]);
    const html = await readFile(join(dir, 'report.html'), 'utf8');
    assert.match(html, /vendor = TESTV-1/);
  });

  it('rejects empty entries and more than 20 keys', async () => {
    const turns = [call('record_value', { key: '', value: 'x' }, 'z'), ...Array.from({ length: 21 }, (_, i) => call('record_value', { key: `k${i}`, value: 'v' }, `k${i}`)), finish('blocked')];
    const { result, toolResults } = await run(turns);
    assert.match(toolResults[0], /required/);
    assert.equal(Object.keys(result.data ?? {}).length, 20);
    assert.match(toolResults.at(-1) ?? '', /At most 20 values/);
  });
});
