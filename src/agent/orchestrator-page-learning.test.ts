import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AgentOrchestrator } from './orchestrator.js';
import type { AppConfig } from '../config/index.js';
import type { LlmCompleteResponse, LlmMessage } from '../llm/types.js';
import type { TestCase } from '../testing/types.js';

const BASE = 'https://fo.sandbox.operations.dynamics.com';
const tc: TestCase = { id: 'TC-1', source: 'local', title: 'vendors', steps: [{ index: 1, action: 'Create a vendor' }] };
const page = (code: string, mi = 'VendTableListPage', title = 'All vendors -- Finance and Operations') =>
  `### Ran Playwright code\n\`\`\`js\n${code}\n\`\`\`\n### Page\n- Page URL: ${BASE}/?cmp=USMF&mi=${mi}\n- Page Title: ${title}`;

type Reply = { content: string; isError?: boolean };
interface Harness { calls: Array<{ tool: string; args: Record<string, unknown> }>; toolResults: string[]; outcome: string; dir: string }

async function run(turns: LlmCompleteResponse[], replies: (tool: string, args: Record<string, unknown>) => Reply | undefined, dir?: string, over: Partial<AppConfig> = {}): Promise<Harness> {
  dir ??= await mkdtemp(join(tmpdir(), 'orch-learn-'));
  const h: Harness = { calls: [], toolResults: [], outcome: '', dir };
  const cfg = {
    LLM_PROVIDER: 'anthropic', AGENT_DRY_RUN: false, AGENT_VERBOSE: false, AGENT_MAX_STEPS: 20, AGENT_MAX_CONSECUTIVE_ERRORS: 0,
    REPORT_DIR: dir, KB_DIR: dir,
    D365_BASE_URL: BASE, D365_COMPANY: 'USMF', AGENT_ALLOW_DESTRUCTIVE: false, ...over,
  } as AppConfig;
  const llm = {
    name: 'fake',
    async complete(req: { messages: LlmMessage[] }) {
      const last = req.messages.at(-1);
      if (last?.role === 'tool') h.toolResults.push(last.content);
      return turns.shift()!;
    },
  };
  const mcp = {
    async listTools() { return []; },
    async callTool(_s: string, tool: string, args: Record<string, unknown>) {
      h.calls.push({ tool, args });
      const r = replies(tool, args) ?? { content: `${tool} ok` };
      return { content: [{ type: 'text', text: r.content }], isError: Boolean(r.isError) };
    },
  };
  const res = await new AgentOrchestrator({ cfg, llm, mcp, mcpServers: ['playwright'] } as never).runTestCase(tc);
  h.outcome = res.outcome;
  return h;
}

const call = (name: string, args: Record<string, unknown>, id = name): LlmCompleteResponse => ({ text: '', stopReason: 'tool_use', toolCalls: [{ id, name, arguments: args }] });
const finish = call('finish_test', { outcome: 'failed' });

describe('learning F&O forms during a run', () => {
  it('learns the stable locator of a control and offers it on the next visit to the form', async () => {
    const first = await run(
      [call('d365_open_menu_item', { page: 'All vendors' }), call('playwright__browser_click', { element: 'New button', target: 'e12' }), finish],
      (tool) => (tool === 'browser_click' ? { content: page("await page.getByTestId('SystemDefinedNewButton').click();") } : tool === 'browser_snapshot' ? { content: page('') } : undefined),
    );
    const saved = JSON.parse(await readFile(join(first.dir, 'pages.json'), 'utf8'));
    assert.deepEqual(saved.pages[0].controls.map((c: { name: string; target: string }) => [c.name, c.target]), [['New button', "getByTestId('SystemDefinedNewButton')"]]);
    assert.deepEqual(first.calls.map((c) => c.tool), ['browser_navigate', 'browser_wait_for', 'browser_snapshot', 'browser_click', 'browser_wait_for'], 'the click is followed by a wait for the F&O busy overlay');

    const second = await run([call('d365_open_menu_item', { page: 'All vendors' }), finish], (tool) => (tool === 'browser_snapshot' ? { content: page('') } : undefined), first.dir);
    assert.match(second.toolResults[0], /Learned about All vendors \(VendTableListPage\)/);
    assert.match(second.toolResults[0], /"New button" \(click\): target getByTestId\('SystemDefinedNewButton'\)/);
  });

  it('makes a form reached any other way openable by caption', async () => {
    const first = await run(
      [call('playwright__browser_navigate', { url: `${BASE}/?cmp=USMF&mi=WHSWaveTemplateTable` }), finish],
      (tool) => (tool === 'browser_navigate' ? { content: page(`await page.goto('x');`, 'WHSWaveTemplateTable', 'Wave templates -- Finance and Operations') } : undefined),
    );
    const second = await run([call('d365_open_menu_item', { page: 'Wave templates' }), finish], () => undefined, first.dir);
    assert.equal(second.calls[0].args.url, `${BASE}/?cmp=USMF&mi=WHSWaveTemplateTable`);
  });

  it('waits for F&O and retries once when a locator target is not there yet, then forgets a target that keeps failing', async () => {
    let clicks = 0;
    const h = await run(
      [call('d365_open_menu_item', { page: 'All vendors' }), call('playwright__browser_click', { element: 'Edit', target: "getByTestId('SystemDefinedEditButton')" }), finish],
      (tool) => {
        if (tool === 'browser_snapshot') return { content: page('') };
        if (tool === 'browser_click') return ++clicks === 1 ? { content: `Error: "getByTestId('SystemDefinedEditButton')" does not match any elements.`, isError: true } : { content: page("await page.getByTestId('SystemDefinedEditButton').click();") };
        return undefined;
      },
    );
    assert.equal(clicks, 2);
    assert.deepEqual(h.calls.slice(3).map((c) => c.tool), ['browser_click', 'browser_wait_for', 'browser_click', 'browser_wait_for']);
    assert.doesNotMatch(h.toolResults[1], /does not match/);
  });

  it('saves notes for the current form with d365_page_note', async () => {
    const h = await run(
      [call('d365_page_note', { note: 'too early' }), call('d365_open_menu_item', { page: 'All vendors' }), call('d365_page_note', { note: 'Vendor group is on the General FastTab' }), finish],
      (tool) => (tool === 'browser_snapshot' ? { content: page('') } : undefined),
    );
    assert.match(h.toolResults[0], /No F&O form is open yet/);
    const saved = JSON.parse(await readFile(join(h.dir, 'pages.json'), 'utf8'));
    assert.deepEqual(saved.pages[0].notes, ['Vendor group is on the General FastTab']);
  });

  it('refuses a destructive click given as a control-name locator', async () => {
    const h = await run([call('playwright__browser_click', { target: "getByTestId('SystemDefinedDeleteButton')" }), finish], () => undefined);
    assert.equal(h.calls.length, 0);
    assert.match(h.toolResults[0], /Blocked by policy.*destructive/);
  });

  it('learns nothing when page learning is off', async () => {
    const h = await run(
      [call('playwright__browser_click', { element: 'New', target: 'e1' }), finish],
      () => ({ content: page("await page.getByTestId('SystemDefinedNewButton').click();") }),
      undefined,
      { AGENT_LEARN_PAGES: false, AGENT_FNO_AUTO_WAIT: false },
    );
    assert.deepEqual(h.calls.map((c) => c.tool), ['browser_click']);
    await assert.rejects(readFile(join(h.dir, 'pages.json'), 'utf8'));
  });
});
