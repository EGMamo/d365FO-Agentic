import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AgentOrchestrator, turnBudget } from './orchestrator.js';
import type { AppConfig } from '../config/index.js';
import type { LlmCompleteResponse } from '../llm/types.js';
import type { TestCase } from '../testing/types.js';

const tc: TestCase = { id: 'T1', source: 'local', title: 'login', steps: [{ index: 1, action: 'Open' }] };

function build(dir: string, over: Partial<AppConfig>, next: () => LlmCompleteResponse, called: string[]) {
  const cfg = {
    LLM_PROVIDER: 'anthropic', AGENT_DRY_RUN: true, AGENT_VERBOSE: false, AGENT_MAX_STEPS: 20,
    REPORT_DIR: dir,
    D365_BASE_URL: 'https://x', D365_COMPANY: 'USMF', ...over,
  } as AppConfig;
  const llm = { name: 'fake', async complete() { return next(); } };
  const mcp = {
    async listTools() { return []; },
    async callTool(_s: string, tool: string) { called.push(tool); return { content: 'page', isError: false }; },
  };
  return new AgentOrchestrator({ cfg, llm, mcp, mcpServers: ['playwright', 'learn'] } as never);
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

describe('turn budget', () => {
  it('scales with the number of steps but never goes below AGENT_MAX_STEPS', () => {
    assert.equal(turnBudget(40, 5), 40);
    assert.equal(turnBudget(40, 20), 80);
  });

  it('says the test ran out of model turns instead of "ended without a reason"', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-'));
    const called: string[] = [];
    let n = 0;
    const res = await build(dir, { AGENT_MAX_REPEATED_CALLS: 0, AGENT_MAX_STEPS: 3 }, () => nav(String(n++)), called).runTestCase(tc);
    assert.equal(res.outcome, 'blocked');
    assert.equal(called.length, 4);
    assert.match(res.errorMessage ?? '', /used all 4 model turns \(AGENT_MAX_STEPS\).*step 1 was not reported/);
    assert.equal(res.failureCategory, 'budget');
  });
});

describe('F&O loading screen', () => {
  it('waits past the splash after a navigation and hands the model the loaded page', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-'));
    const called: string[] = [];
    const seen: string[] = [];
    const turns: LlmCompleteResponse[] = [nav('1'), { text: '', stopReason: 'tool_use', toolCalls: [{ id: 'f', name: 'finish_test', arguments: { outcome: 'blocked' } }] }];
    const cfg = {
      LLM_PROVIDER: 'anthropic', AGENT_DRY_RUN: false, AGENT_VERBOSE: false, AGENT_MAX_STEPS: 20,
      REPORT_DIR: dir,
      D365_BASE_URL: 'https://x', D365_COMPANY: 'USMF',
    } as unknown as AppConfig;
    const llm = {
      name: 'fake',
      async complete(req: { messages: Array<{ role: string; content: string }> }) {
        const last = req.messages.at(-1);
        if (last?.role === 'tool') seen.push(last.content);
        return turns.shift()!;
      },
    };
    let snapshots = 0;
    const splash = '### Page\n- Page URL: https://x/?cmp=USMF&mi=VendTableListPage\n### Snapshot\n```yaml\n- generic: Finance and Operations\n```';
    const loaded = '### Page\n- Page URL: https://x/?cmp=USMF&mi=VendTableListPage\n- Page Title: All suppliers -- Finance and Operations\n### Snapshot\n```yaml\n- button "New"\n```';
    const mcp = {
      async listTools() { return []; },
      async callTool(_s: string, tool: string) {
        called.push(tool);
        if (tool === 'browser_navigate') return { content: splash, isError: false };
        if (tool === 'browser_snapshot') return { content: ++snapshots > 1 ? loaded : splash, isError: false };
        return { content: 'ok', isError: false };
      },
    };

    await new AgentOrchestrator({ cfg, llm, mcp, mcpServers: ['playwright'] } as never).runTestCase(tc);
    assert.deepEqual(called.slice(0, 5), ['browser_navigate', 'browser_snapshot', 'browser_snapshot', 'browser_wait_for', 'browser_snapshot']);
    assert.match(seen[0], /finished loading:[\s\S]*All suppliers/);
  });
});
