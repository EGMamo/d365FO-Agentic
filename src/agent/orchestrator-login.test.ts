import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AgentOrchestrator } from './orchestrator.js';
import { baseSystemPrompt } from './prompts.js';
import { validateForRun, type AppConfig } from '../config/index.js';
import { CREDENTIAL_TOOL_NAME } from '../d365fo/login.js';
import type { LlmCompleteRequest, LlmCompleteResponse } from '../llm/types.js';
import type { TestCase } from '../testing/types.js';

const SECRET_USER = 'tester@contoso.example';
const SECRET_PASS = 'S3cr3t-Pa55!';

function cfg(over: Partial<AppConfig> = {}, dir = '.'): AppConfig {
  return {
    D365_BASE_URL: 'https://x.operations.dynamics.com',
    D365_USERNAME: SECRET_USER,
    D365_PASSWORD: SECRET_PASS,
    D365_COMPANY: 'USMF',
    LLM_PROVIDER: 'anthropic',
    ANTHROPIC_API_KEY: 'k',
    AGENT_DRY_RUN: false,
    AGENT_VERBOSE: false,
    AGENT_MAX_STEPS: 5,
    AGENT_RELOOP_MAX_RETRIES: 0,
    AGENT_RELOOP_RETRY_ON: [],
    AGENT_RELOOP_COOLDOWN_MS: 0,
    REPORT_DIR: dir,
    ...over,
  } as AppConfig;
}

const tc: TestCase = { id: 'T1', source: 'local', title: 'login', steps: [{ index: 1, action: 'Sign in' }] };

describe('D365 login credentials', () => {
  it('keeps the credentials out of the system prompt', () => {
    const prompt = baseSystemPrompt(cfg());
    assert.ok(!prompt.includes(SECRET_PASS) && !prompt.includes(SECRET_USER));
    assert.ok(prompt.includes(CREDENTIAL_TOOL_NAME));
  });

  it('types the configured credentials via browser_type and scrubs them from results', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-'));
    const typed: Array<Record<string, unknown>> = [];
    let toolsSeen: string[] = [];
    const turns: LlmCompleteResponse[] = [
      { text: '', stopReason: 'tool_use', toolCalls: [{ id: '1', name: CREDENTIAL_TOOL_NAME, arguments: { field: 'username', ref: 'e1', submit: true } }] },
      { text: '', stopReason: 'tool_use', toolCalls: [{ id: '2', name: CREDENTIAL_TOOL_NAME, arguments: { field: 'password', ref: 'e2', submit: true } }] },
      { text: '', stopReason: 'tool_use', toolCalls: [{ id: '3', name: 'finish_test', arguments: { outcome: 'passed' } }] },
    ];
    const sent: string[] = [];
    const llm = {
      name: 'fake',
      async complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse> {
        toolsSeen = (req.tools ?? []).map((t: { name: string })  => t.name);
        for (const m of req.messages) if (m.role === 'tool') sent.push(m.content);
        return turns.shift()!;
      },
    };
    const mcp = {
      async listTools() { return []; },
      async callTool(server: string, tool: string, args: Record<string, unknown>) {
        assert.equal(server, 'playwright');
        assert.equal(tool, 'browser_type');
        typed.push(args);
        return { content: `typed ${String(args.text)}`, isError: false };
      },
    };
    const kb = { retrieve: () => [], upsert() {}, async save() {} };
    const orch = new AgentOrchestrator({ cfg: cfg({}, dir), llm, mcp, kb, mcpServers: [] } as never);
    const res = await orch.runTestCase(tc);

    assert.equal(res.outcome, 'passed');
    assert.ok(toolsSeen.includes(CREDENTIAL_TOOL_NAME));
    assert.deepEqual(typed.map((t) => [t.ref, t.text, t.submit]), [
      ['e1', SECRET_USER, true],
      ['e2', SECRET_PASS, true],
    ]);
    assert.ok(sent.length >= 2);
    for (const s of sent) assert.ok(!s.includes(SECRET_PASS) && !s.includes(SECRET_USER), s);
  });

  it('reports a clear error when credentials are missing', () => {
    const issues = validateForRun(cfg({ D365_USERNAME: undefined, D365_PASSWORD: undefined }));
    assert.ok(issues.some((i) => i.includes('D365_USERNAME') && i.includes('D365_PASSWORD')));
    assert.ok(!validateForRun(cfg()).some((i) => i.includes('D365_USERNAME')));
  });
});
