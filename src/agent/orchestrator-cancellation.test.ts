import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AgentOrchestrator } from './orchestrator.js';
import type { AppConfig } from '../config/index.js';
import type { LlmCompleteRequest, LlmCompleteResponse } from '../llm/types.js';

const tc = { id: 'stop', source: 'local' as const, title: 'Stop', steps: [{ index: 1, action: 'Save' }] };
const batch: LlmCompleteResponse = { text: '', stopReason: 'tool_use', toolCalls: [
  { id: 'a', name: 'playwright__browser_click', arguments: { target: 'Save' } },
  { id: 'b', name: 'playwright__browser_type', arguments: { target: 'Name', text: 'after stop' } },
] };
async function harness(complete: (req: LlmCompleteRequest) => Promise<LlmCompleteResponse>, tool: (signal?: AbortSignal) => Promise<void> = async () => {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cancel-'));
  const cfg = { LLM_PROVIDER: 'anthropic', AGENT_DRY_RUN: false, AGENT_VERBOSE: false, AGENT_MAX_STEPS: 5,
    REPORT_DIR: dir, AGENT_FNO_AUTO_WAIT: false, AGENT_LEARN_PAGES: false, PW_TRACE: 'off' } as AppConfig;
  const reached: string[] = [];
  let listed = 0;
  const mcp = {
    async listTools() { listed++; return []; },
    async callTool(_server: string, name: string, _args: unknown, _timeout: unknown, signal?: AbortSignal) {
      reached.push(name); await tool(signal); return { content: '', isError: false };
    },
  };
  const agent = new AgentOrchestrator({ cfg, llm: { name: 'fake', complete }, mcp, mcpServers: ['playwright'] } as never);
  return { reached, listed: () => listed, run: (signal: AbortSignal) => agent.runTestCase(tc, signal) };
}

describe('run cancellation boundaries', () => {
  it('makes no model or MCP requests when already cancelled', async () => {
    const controller = new AbortController(); controller.abort();
    let models = 0;
    const h = await harness(async () => { models++; return batch; });
    assert.equal((await h.run(controller.signal)).interrupted, true);
    assert.equal(models, 0); assert.equal(h.listed(), 0); assert.deepEqual(h.reached, []);
  });

  it('forwards the provider signal and refuses a tool batch returned after cancellation', async () => {
    const controller = new AbortController();
    const h = await harness(async (req) => { assert.equal(req.signal, controller.signal); controller.abort(); return batch; });
    const result = await h.run(controller.signal);
    assert.equal(result.interrupted, true); assert.equal(result.outcome, 'blocked'); assert.deepEqual(h.reached, []);
  });

  it('forwards the MCP signal and never executes the rest of a batch after an in-flight tool is cancelled', async () => {
    const controller = new AbortController();
    const h = await harness(async () => batch, async (signal) => { assert.equal(signal, controller.signal); controller.abort(); });
    assert.equal((await h.run(controller.signal)).interrupted, true);
    assert.deepEqual(h.reached, ['browser_click']);
  });

  it('returns promptly even when a third-party provider ignores its cancellation signal', { timeout: 1000 }, async () => {
    const controller = new AbortController();
    const h = await harness(async () => { queueMicrotask(() => controller.abort()); return new Promise(() => {}); });
    assert.equal((await h.run(controller.signal)).interrupted, true);
    assert.deepEqual(h.reached, []);
  });

  it('cancels tool discovery before any model request', { timeout: 1000 }, async () => {
    const controller = new AbortController();
    const dir = await mkdtemp(join(tmpdir(), 'cancel-discovery-'));
    let models = 0;
    const agent = new AgentOrchestrator({
      cfg: { REPORT_DIR: dir } as AppConfig,
      llm: { name: 'fake', async complete() { models++; return batch; } },
      mcp: { async listTools(_server: string, signal: AbortSignal) { assert.equal(signal, controller.signal); queueMicrotask(() => controller.abort()); return new Promise(() => {}); } },
      mcpServers: ['playwright'],
    } as never);
    assert.equal((await agent.runTestCase(tc, controller.signal)).interrupted, true);
    assert.equal(models, 0);
  });
});
