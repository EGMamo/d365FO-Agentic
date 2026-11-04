import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AgentOrchestrator } from './orchestrator.js';
import { baseSystemPrompt } from './prompts.js';
import type { AppConfig } from '../config/index.js';
import { CREDENTIAL_TOOL_NAME, browserTypeArgs } from '../d365fo/login.js';
import type { LlmCompleteRequest, LlmCompleteResponse } from '../llm/types.js';
import type { TestCase } from '../testing/types.js';

const SECRET_USER = 'tester@contoso.example';
const SECRET_PASS = 'S3cr3t-Pa55!';
const tc: TestCase = { id: 'T1', source: 'local', title: 'login', steps: [{ index: 1, action: 'Sign in' }] };
const call = (name: string, args: Record<string, unknown>): LlmCompleteResponse => ({ text: '', stopReason: 'tool_use', toolCalls: [{ id: name, name, arguments: args }] });
const config = (dir = '.'): AppConfig => ({
  D365_BASE_URL: 'https://x.sandbox.operations.dynamics.com', D365_USERNAME: SECRET_USER, D365_PASSWORD: SECRET_PASS,
  D365_COMPANY: 'USMF', LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k', AGENT_DRY_RUN: false,
  AGENT_VERBOSE: false, AGENT_MAX_STEPS: 5, AGENT_LEARN_PAGES: false, AGENT_FNO_AUTO_WAIT: false, REPORT_DIR: dir,
}) as AppConfig;
const trustedTool = { server: 'playwright', name: 'browser_run_code', description: '', inputSchema: { properties: { code: {} } } };

describe('D365 login credentials', () => {
  it('keeps credentials out of the prompt and exposes only the limited credential request to the model', () => {
    const prompt = baseSystemPrompt(config());
    assert.ok(!prompt.includes(SECRET_PASS) && !prompt.includes(SECRET_USER));
    assert.ok(prompt.includes(CREDENTIAL_TOOL_NAME));
  });

  it('uses trusted atomic entry, ignores model locators and never returns raw credentials or code to the model', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-'));
    const typed: Array<Record<string, unknown>> = [];
    const sent: string[] = [];
    let toolsSeen: string[] = [];
    const turns = [
      call(CREDENTIAL_TOOL_NAME, { field: 'username', ref: 'attacker-ref', element: 'Password', submit: true }),
      call(CREDENTIAL_TOOL_NAME, { field: 'password', target: 'getByRole("textbox", {name:"Search"})' }),
      call('report_step', { index: 1, status: 'passed' }), call('finish_test', { outcome: 'passed' }),
    ];
    const llm = { name: 'fake', async complete(req: LlmCompleteRequest) {
      toolsSeen = (req.tools ?? []).map((t) => t.name);
      sent.push(...req.messages.filter((m) => m.role === 'tool').map((m) => m.content));
      return turns.shift()!;
    } };
    const mcp = { async listTools() { return [trustedTool]; }, async callTool(server: string, tool: string, args: Record<string, unknown>) {
      assert.equal(server, 'playwright'); assert.equal(tool, 'browser_run_code'); typed.push(args);
      return { content: 'untrusted tool echo ' + SECRET_PASS, isError: false };
    } };
    const res = await new AgentOrchestrator({ cfg: config(dir), llm, mcp, mcpServers: ['playwright'] } as never).runTestCase(tc);
    assert.equal(res.outcome, 'passed');
    assert.ok(toolsSeen.includes(CREDENTIAL_TOOL_NAME));
    assert.ok(!toolsSeen.includes('playwright__browser_run_code'));
    assert.equal(typed.length, 2);
    assert.ok(String(typed[0].code).includes(SECRET_USER));
    assert.ok(String(typed[1].code).includes(SECRET_PASS));
    assert.ok(!JSON.stringify(typed).includes('attacker-ref'));
    assert.ok(!JSON.stringify(typed).includes('getByRole'));
    assert.ok(!sent.join('\n').includes(SECRET_PASS) && !sent.join('\n').includes(SECRET_USER));
    assert.ok(!sent.join('\n').includes('page.evaluate'));
  });

  it('fails closed when the trusted operation is unavailable, and never falls back to browser_type', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-'));
    const turns = [call(CREDENTIAL_TOOL_NAME, { field: 'password', ref: 'e1' }), call('finish_test', { outcome: 'blocked' })];
    const sent: string[] = [];
    let reached = false;
    const llm = { name: 'fake', async complete(req: LlmCompleteRequest) { sent.push(...req.messages.filter((m) => m.role === 'tool').map((m) => m.content)); return turns.shift()!; } };
    const mcp = { async listTools() { return []; }, async callTool() { reached = true; return { content: '', isError: false }; } };
    await new AgentOrchestrator({ cfg: config(dir), llm, mcp, mcpServers: ['playwright'] } as never).runTestCase(tc);
    assert.equal(reached, false);
    assert.match(sent.join('\n'), /Credential entry refused.*trusted authentication checks/);
  });

  it('redacts errors from the trusted operation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-'));
    const turns = [call(CREDENTIAL_TOOL_NAME, { field: 'password' }), call('finish_test', { outcome: 'blocked' })];
    const sent: string[] = [];
    const llm = { name: 'fake', async complete(req: LlmCompleteRequest) { sent.push(...req.messages.filter((m) => m.role === 'tool').map((m) => m.content)); return turns.shift()!; } };
    const mcp = { async listTools() { return [trustedTool]; }, async callTool() { return { content: `Credential entry refused: ${SECRET_PASS}`, isError: true }; } };
    await new AgentOrchestrator({ cfg: config(dir), llm, mcp, mcpServers: ['playwright'] } as never).runTestCase(tc);
    assert.match(sent.join('\n'), /typing it failed/);
    assert.ok(!sent.join('\n').includes(SECRET_PASS));
  });

  it('retains browser_type argument compatibility for non-credential callers', () => {
    assert.deepEqual(browserTypeArgs({ properties: { ref: {}, text: {}, submit: {} } }, { ref: 'e1', text: 'test' }), { ref: 'e1', text: 'test', submit: false });
  });
});
