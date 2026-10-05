import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AgentOrchestrator } from './orchestrator.js';
import type { AppConfig } from '../config/index.js';
import type { LlmCompleteResponse } from '../llm/types.js';
import type { TestCase } from '../testing/types.js';

const tc: TestCase = { id: 'T1', source: 'local', title: 'login', steps: [{ index: 1, action: 'Open' }] };

function build(dir: string, over: Partial<AppConfig>, next: () => LlmCompleteResponse, called: string[]) {
  const cfg = {
    LLM_PROVIDER: 'anthropic', AGENT_DRY_RUN: true, AGENT_VERBOSE: false, AGENT_MAX_STEPS: 20,
    AGENT_RELOOP_MAX_RETRIES: 0, AGENT_RELOOP_RETRY_ON: [], AGENT_RELOOP_COOLDOWN_MS: 0, REPORT_DIR: dir,
    D365_BASE_URL: 'https://x', D365_COMPANY: 'USMF', ...over,
  } as AppConfig;
  const llm = { name: 'fake', async complete() { return next(); } };
  const mcp = {
    async listTools() { return []; },
    async callTool(_s: string, tool: string) { called.push(tool); return { content: 'page', isError: false }; },
  };
  const kb = { retrieve: () => [], recipeFor: () => undefined, upsert() {}, async save() {} };
  return new AgentOrchestrator({ cfg, llm, mcp, kb, mcpServers: ['playwright', 'learn'] } as never);
}

const nav = (id: string): LlmCompleteResponse => ({
  text: '', stopReason: 'tool_use',
  toolCalls: [{ id, name: 'playwright__browser_navigate', arguments: { url: 'https://x' } }],
});

describe('dry-run classification', () => {
  it('skips state-changing browser tools but still runs read-only ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-'));
    const called: string[] = [];
    const tools = ['browser_snapshot', 'browser_take_screenshot', 'browser_wait_for', 'browser_click', 'browser_type', 'browser_fill_form', 'browser_press_key', 'browser_select_option'];
    const turns: LlmCompleteResponse[] = [
      ...tools.map((t, i): LlmCompleteResponse => ({ text: '', stopReason: 'tool_use', toolCalls: [{ id: String(i), name: `playwright__${t}`, arguments: { i } }] })),
      { text: '', stopReason: 'tool_use', toolCalls: [{ id: 'f', name: 'finish_test', arguments: { outcome: 'passed' } }] },
    ];
    await build(dir, {}, () => turns.shift()!, called).runTestCase(tc);
    assert.deepEqual(called, ['browser_snapshot', 'browser_take_screenshot', 'browser_wait_for']);
  });

  it('executes browser_navigate in a dry run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-'));
    const called: string[] = [];
    const turns = [nav('1'), { text: '', stopReason: 'tool_use', toolCalls: [{ id: '2', name: 'finish_test', arguments: { outcome: 'passed' } }] } as LlmCompleteResponse];
    const res = await build(dir, {}, () => turns.shift()!, called).runTestCase(tc);
    assert.deepEqual(called, ['browser_navigate']);
    assert.equal(res.outcome, 'passed');
  });
});

describe('repeated tool call guard', () => {
  it('stops with a clear message after too many identical consecutive calls', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-'));
    const called: string[] = [];
    let n = 0;
    const res = await build(dir, { AGENT_MAX_REPEATED_CALLS: 3 }, () => nav(String(n++)), called).runTestCase(tc);
    assert.equal(res.outcome, 'blocked');
    assert.equal(called.length, 3);
    assert.match(res.errorMessage ?? '', /browser_navigate.*4 times in a row/);
  });

  it('does not trigger when calls differ, and 0 disables it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-'));
    const called: string[] = [];
    let n = 0;
    const mk = (): LlmCompleteResponse => n++ < 6
      ? { text: '', stopReason: 'tool_use', toolCalls: [{ id: String(n), name: 'playwright__browser_navigate', arguments: { url: `https://x/${n % 2}` } }] }
      : { text: '', stopReason: 'tool_use', toolCalls: [{ id: 'f', name: 'finish_test', arguments: { outcome: 'passed' } }] };
    assert.equal((await build(dir, {}, mk, called).runTestCase(tc)).outcome, 'passed');

    n = 0; called.length = 0;
    await build(dir, { AGENT_MAX_REPEATED_CALLS: 0, AGENT_MAX_STEPS: 5 }, () => nav(String(n++)), called).runTestCase(tc);
    assert.equal(called.length, 5);
  });
});
