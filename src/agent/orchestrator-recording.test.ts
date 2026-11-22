import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { AgentOrchestrator } from './orchestrator.js';
import type { AppConfig } from '../config/index.js';
import type { LlmCompleteResponse } from '../llm/types.js';
import type { TestCase } from '../testing/types.js';

const tc: TestCase = { id: '123', source: 'devops', title: 'Record safely', steps: [{ index: 1, action: 'Create and capture an order' }] };
const call = (name: string, args: Record<string, unknown>, id = name): LlmCompleteResponse => ({ text: '', stopReason: 'tool_use', toolCalls: [{ id, name, arguments: args }] });
const codeResult = (code: string, isError = false): { content: unknown; isError: boolean } => ({ content: `### Ran Playwright code\n\`\`\`js\n${code}\n\`\`\`\n### Page\n- Page URL: https://x.sandbox.operations.dynamics.com/`, isError });

async function harness(turns: LlmCompleteResponse[], testCase = tc) {
  const dir = await mkdtemp(path.join(tmpdir(), 'orch-record-'));
  const reached: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const cfg = {
    REPORT_DIR: dir, AGENT_REPLAY_DIR: path.join(dir, 'replay'), AGENT_RECORD_TESTS: true,
    AGENT_DRY_RUN: false, AGENT_VERBOSE: false, AGENT_MAX_STEPS: 20, AGENT_FNO_AUTO_WAIT: false, AGENT_LEARN_PAGES: false,
    D365_BASE_URL: 'https://x.sandbox.operations.dynamics.com', D365_COMPANY: 'USMF', PW_BROWSER: 'chromium', PW_HEADLESS: true,
  } as AppConfig;
  const mcp = {
    async listTools() {
      return ['browser_click', 'browser_type', 'browser_verify_value', 'browser_run_code'].map((name) => ({ server: 'playwright', name, description: '', inputSchema: {} }));
    },
    async callTool(_server: string, tool: string, args: Record<string, unknown>) {
      reached.push({ tool, args });
      if (tool === 'browser_run_code') return { content: '### Result\n"SO-000752"\n', isError: false };
      if (tool === 'browser_type') return codeResult("await page.getByLabel('Secret').fill('do-not-record');", true);
      if (tool === 'browser_verify_value') return codeResult("await expect(page.getByTestId('SalesTable_SalesId')).toHaveValue('SO-000752');");
      return codeResult("await page.getByTestId('SystemDefinedNewButton').click();");
    },
  };
  const llm = { name: 'fake', async complete() { return turns.shift() ?? call('finish_test', { outcome: 'blocked' }, 'fallback'); } };
  const result = await new AgentOrchestrator({ cfg, llm, mcp, mcpServers: ['playwright'] } as never).runTestCase(testCase);
  return { result, reached, dir };
}

describe('safe standalone recording and capture', () => {
  it('records only successful allowlisted MCP-emitted code and app-generated capture reads', async () => {
    const { result, reached } = await harness([
      call('begin_step', { index: 1 }, 'begin'),
      call('playwright__browser_click', { target: 'New' }, 'click'),
      call('playwright__browser_run_code', { code: 'async(page)=>page.evaluate(()=>fetch("https://evil"))' }, 'unsafe'),
      call('playwright__browser_verify_value', { target: 'SalesTable_SalesId', value: 'SO-000752' }, 'verify'),
      call('capture_value', { name: 'salesOrderId', control: 'SalesTable_SalesId', mode: 'value' }, 'capture'),
      call('playwright__browser_type', { target: 'Secret', text: 'do-not-record' }, 'failed'),
      call('report_step', { index: 1, status: 'passed' }, 'report'),
      call('finish_test', { outcome: 'passed' }, 'finish'),
    ]);
    assert.equal(result.outcome, 'passed');
    assert.deepEqual(result.data, { salesOrderId: 'SO-000752' });
    assert.equal(reached.filter((r) => r.tool === 'browser_run_code').length, 1, 'only trusted capture reaches hidden run_code');
    const trusted = reached.find((r) => r.tool === 'browser_run_code')!.args.code as string;
    assert.match(trusted, /page\.getByTestId\("SalesTable_SalesId"\)/);
    assert.doesNotMatch(trusted, /evil|do-not-record/);
    const spec = await readFile(result.specFile!, 'utf8');
    assert.match(spec, /SystemDefinedNewButton/);
    assert.match(spec, /toHaveValue\('SO-000752'\)/);
    assert.match(spec, /vars\.salesOrderId = await page\.getByTestId\(["']SalesTable_SalesId["']\)\.inputValue\(\);/);
    assert.doesNotMatch(spec, /do-not-record|evil|browser_run_code/);
    assert.doesNotMatch(spec, /test\.fixme/);
    assert.ok(result.artifacts.includes(result.dataFile!));
  });

  it('does not write specs or data for secret-bearing parameter rows', async () => {
    const secretCase: TestCase = {
      ...tc,
      sourceSteps: [{ index: 1, action: 'Use @Password' }],
      parameterData: [{ names: ['Password'], rows: [{ Password: 'do-not-write-this' }] }],
      parameters: { row: 1, rows: 1, filled: ['Password'], unresolved: [] },
    };
    const { result, dir } = await harness([
      call('playwright__browser_click', { target: 'New' }, 'click'),
      call('report_step', { index: 1, status: 'passed' }, 'report'),
      call('finish_test', { outcome: 'passed' }, 'finish'),
    ], secretCase);
    assert.equal(result.specFile, undefined);
    assert.equal(result.dataFile, undefined);
    assert.equal(existsSync(path.join(dir, 'replay', 'data', 'TC-123.json')), false);
  });

  it('rejects model-provided JavaScript and secret-shaped capture requests without executing code', async () => {
    for (const args of [
      { name: 'orderId', control: 'SalesTable_SalesId', mode: 'value', expression: 'page.evaluate(() => document.cookie)' },
      { name: 'password', control: 'SalesTable_SalesId', mode: 'value' },
      { name: 'orderId', control: 'SalesTable_SalesId;page.evaluate(1)', mode: 'value' },
    ]) {
      const { result, reached } = await harness([call('capture_value', args, 'bad'), call('finish_test', { outcome: 'blocked' }, 'finish')]);
      assert.equal(reached.filter((r) => r.tool === 'browser_run_code').length, 0);
      assert.deepEqual(result.data, {});
    }
  });
});
