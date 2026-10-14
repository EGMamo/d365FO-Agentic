import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AgentOrchestrator } from './orchestrator.js';
import type { AppConfig } from '../config/index.js';
import type { LlmCompleteResponse } from '../llm/types.js';
import type { TestCase, TestResult } from '../testing/types.js';
import { ReplayStore } from '../replay/store.js';

const BASE = 'https://fo.sandbox.operations.dynamics.com';
const URL = `${BASE}/?cmp=USMF&mi=VendTableListPage`;
const tc: TestCase = {
  id: 'TC-R',
  source: 'local',
  title: 'vendor',
  steps: [
    { index: 1, action: 'Open all vendors' },
    { index: 2, action: 'Create vendor V1', expected: 'V1 is shown' },
  ],
};
const ran = (code: string) => `### Ran Playwright code\n\`\`\`js\n${code}\n\`\`\`\n### Page\n- Page URL: ${URL}\n- Page Title: All vendors -- Finance and Operations`;
const CODE: Record<string, string> = {
  browser_navigate: `await page.goto('${URL}');`,
  browser_click: "await page.getByTestId('SystemDefinedNewButton').click();",
  browser_verify_text_visible: "await expect(page.getByText('V1')).toBeVisible();",
};
const call = (name: string, args: Record<string, unknown> = {}): LlmCompleteResponse => ({ text: '', stopReason: 'tool_use', toolCalls: [{ id: name, name, arguments: args }] });
const aiRun = (): LlmCompleteResponse[] => [
  call('playwright__browser_navigate', { url: URL }),
  call('report_step', { index: 1, status: 'passed' }),
  call('playwright__browser_click', { element: 'New', target: 'e1' }),
  call('playwright__browser_verify_text_visible', { text: 'V1' }),
  call('report_step', { index: 2, status: 'passed', verified: true, observed: 'V1' }),
  call('finish_test', { outcome: 'passed' }),
];

interface Harness { result: TestResult; tools: string[]; llmTurns: number; runCode: string[] }

async function run(dir: string, turns: LlmCompleteResponse[], runCodeError?: string, over: Partial<AppConfig> = {}): Promise<Harness> {
  const h = { tools: [] as string[], llmTurns: 0, runCode: [] as string[] };
  const cfg = {
    LLM_PROVIDER: 'anthropic', AGENT_DRY_RUN: false, AGENT_VERBOSE: false, AGENT_MAX_STEPS: 20, AGENT_MAX_CONSECUTIVE_ERRORS: 0,
    AGENT_RELOOP_MAX_RETRIES: 0, AGENT_RELOOP_RETRY_ON: [], AGENT_RELOOP_COOLDOWN_MS: 0, REPORT_DIR: dir, KB_DIR: dir,
    D365_BASE_URL: BASE, D365_COMPANY: 'USMF', AGENT_ALLOW_DESTRUCTIVE: false, AGENT_FNO_AUTO_WAIT: false, AGENT_LEARN_PAGES: false, ...over,
  } as AppConfig;
  const llm = {
    name: 'fake',
    async complete() {
      h.llmTurns++;
      return turns.shift() ?? call('finish_test', { outcome: 'blocked' });
    },
  };
  const mcp = {
    async listTools() {
      return ['browser_navigate', 'browser_click', 'browser_verify_text_visible', 'browser_run_code_unsafe'].map((name) => ({ server: 'playwright', name, description: '', inputSchema: {} }));
    },
    async callTool(_s: string, tool: string, args: Record<string, unknown>) {
      h.tools.push(tool);
      if (tool === 'browser_run_code_unsafe') {
        h.runCode.push(String(args.code));
        if (runCodeError && String(args.code).includes('SystemDefinedNewButton')) return { content: [{ type: 'text', text: `### Error\n${runCodeError}` }], isError: true };
        return { content: [{ type: 'text', text: '### Result\n"ok"' }], isError: false };
      }
      return { content: [{ type: 'text', text: ran(CODE[tool] ?? '') }], isError: false };
    },
  };
  const kb = { retrieve: () => [], recipeFor: () => undefined, upsert() {}, async save() {}, recordOutcome: () => 0 };
  const result = await new AgentOrchestrator({ cfg, llm, mcp, kb, mcpServers: ['playwright'] } as never).runTestCase(tc);
  return { result, ...h };
}

describe('replaying a recorded passing run without the AI', () => {
  it('records a passing run, then replays it step by step with no model calls', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-replay-'));
    const first = await run(dir, aiRun());
    assert.equal(first.result.outcome, 'passed');
    assert.equal(first.result.replay, undefined);
    const saved = await new ReplayStore(dir).get(tc.id);
    assert.deepEqual(saved?.steps, [
      { index: 1, actions: [CODE.browser_navigate], assertions: [] },
      { index: 2, actions: [CODE.browser_click], assertions: [CODE.browser_verify_text_visible] },
    ]);

    const second = await run(dir, []);
    assert.equal(second.llmTurns, 0);
    assert.equal(second.result.outcome, 'passed');
    assert.deepEqual(second.result.replay, { outcome: 'passed' });
    assert.equal(second.runCode.length, 2);
    assert.ok(second.runCode[1].includes(CODE.browser_click) && second.runCode[1].includes(CODE.browser_verify_text_visible));
    assert.deepEqual(second.result.steps.map((s) => [s.index, s.status, s.verified]), [[1, 'passed', undefined], [2, 'passed', true]]);
    assert.equal((await new ReplayStore(dir).get(tc.id))?.successCount, 1);
  });

  it('hands the case to the AI when the replay fails, and tells it where', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-replay-'));
    await run(dir, aiRun());
    const turns = aiRun();
    const h = await run(dir, turns, "TimeoutError: locator.click: Timeout 15000ms exceeded. waiting for getByTestId('SystemDefinedNewButton')");
    assert.deepEqual(h.result.replay?.outcome, 'failed');
    assert.equal(h.result.replay?.step, 2);
    assert.match(h.result.replay?.error ?? '', /Timeout 15000ms/);
    assert.equal(h.result.outcome, 'passed', 'the AI run is the result');
    assert.equal(h.llmTurns, 6);
    assert.equal((await new ReplayStore(dir).get(tc.id))?.consecutiveFailures, 0, 'the AI pass recorded a fresh script');
  });

  it('does not replay when turned off or in a dry run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-replay-'));
    await run(dir, aiRun());
    for (const over of [{ AGENT_REPLAY: false }, { AGENT_DRY_RUN: true }] as Partial<AppConfig>[]) {
      const h = await run(dir, aiRun(), undefined, over);
      assert.equal(h.result.replay, undefined);
      assert.equal(h.runCode.length, 0);
    }
  });

  it('does not replay an address the guardrails refuse (another environment)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-replay-'));
    await run(dir, aiRun());
    const h = await run(dir, aiRun(), undefined, { D365_BASE_URL: 'https://other.sandbox.operations.dynamics.com' });
    assert.equal(h.runCode.length, 0);
    assert.equal(h.result.replay, undefined);
  });
});
