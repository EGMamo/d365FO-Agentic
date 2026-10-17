import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AgentOrchestrator } from './orchestrator.js';
import type { AppConfig } from '../config/index.js';
import type { LlmCompleteResponse, LlmMessage } from '../llm/types.js';
import type { TestCase } from '../testing/types.js';

const tc: TestCase = { id: 'TC-1', source: 'local', title: 'vendors', legalEntity: 'DEMF', steps: [{ index: 1, action: 'Open All vendors' }] };

interface Harness { calls: Array<{ tool: string; args: Record<string, unknown> }>; prompts: string[] }

async function run(turns: LlmCompleteResponse[], over: Partial<AppConfig> = {}): Promise<Harness & { outcome: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'orch-nav-'));
  const h: Harness = { calls: [], prompts: [] };
  const cfg = {
    LLM_PROVIDER: 'anthropic', AGENT_DRY_RUN: false, AGENT_VERBOSE: false, AGENT_MAX_STEPS: 20,
    REPORT_DIR: dir, KB_DIR: dir,
    D365_BASE_URL: 'https://fo.sandbox.operations.dynamics.com', D365_COMPANY: 'USMF', AGENT_ALLOW_DESTRUCTIVE: true, ...over,
  } as AppConfig;
  const llm = {
    name: 'fake',
    async complete(req: { messages: LlmMessage[] }) {
      if (h.prompts.length === 0) h.prompts.push(req.messages[0].content);
      return turns.shift()!;
    },
  };
  const mcp = {
    async listTools() { return []; },
    async callTool(_s: string, tool: string, args: Record<string, unknown>) { h.calls.push({ tool, args }); return { content: `${tool} ok`, isError: false }; },
  };
  const res = await new AgentOrchestrator({ cfg, llm, mcp, mcpServers: ['playwright'] } as never).runTestCase(tc);
  return { ...h, outcome: res.outcome };
}

const call = (name: string, args: Record<string, unknown>, id = name): LlmCompleteResponse => ({ text: '', stopReason: 'tool_use', toolCalls: [{ id, name, arguments: args }] });
const finish = call('finish_test', { outcome: 'passed' });

describe('d365_open_menu_item', () => {
  it('opens the page by deep link in the test legal entity, waits for it and snapshots', async () => {
    const h = await run([call('d365_open_menu_item', { page: 'Accounts payable > Vendors > All vendors' }), finish]);
    assert.deepEqual(h.calls.map((c) => c.tool), ['browser_navigate', 'browser_wait_for', 'browser_snapshot']);
    assert.equal(h.calls[0].args.url, 'https://fo.sandbox.operations.dynamics.com/?cmp=DEMF&mi=VendTableListPage');
  });

  it('accepts an unlisted menu item name but rejects anything else without navigating', async () => {
    const h = await run([call('d365_open_menu_item', { menuItem: 'WHSWaveTemplateTable' }), call('d365_open_menu_item', { menuItem: 'x&cmp=USMF' }, 'b'), finish]);
    assert.equal(h.calls.filter((c) => c.tool === 'browser_navigate').length, 1);
    assert.match(String(h.calls[0].args.url), /mi=WHSWaveTemplateTable$/);
  });
});
