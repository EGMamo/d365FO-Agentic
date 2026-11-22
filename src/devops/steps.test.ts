import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { flattenSteps, parseStepsXml } from './steps.js';
import { AgentOrchestrator } from '../agent/orchestrator.js';
import type { AppConfig } from '../config/index.js';
import type { TestCase } from '../testing/types.js';

const step = (id: number, text: string, expected = ''): string => `<step id="${id}" type="ActionStep"><parameterizedString isformatted="true">${text}</parameterizedString><parameterizedString isformatted="true">${expected}</parameterizedString></step>`;

describe('nested Azure DevOps shared steps', () => {
  it('expands nested references, retains action paths/metadata, and keeps following steps in the containing case', async () => {
    const xml = `<steps id="0" last="12">${step(10, '&lt;P&gt;First @Vendor&lt;/P&gt;')}<compref id="11" ref="500">${step(12, '&lt;P&gt;After&lt;/P&gt;')}</compref></steps>`;
    const shared = new Map<number, string>([
      [500, `<steps>${step(15, '&lt;P&gt;Shared&lt;/P&gt;')}<compref id="16" ref="600"></compref></steps>`],
      [600, `<steps>${step(17, '&lt;P&gt;Nested&lt;/P&gt;', '&lt;P&gt;Done&lt;/P&gt;')}</steps>`],
    ]);
    const result = await flattenSteps(parseStepsXml(xml), async (id) => parseStepsXml(shared.get(id)));
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.steps.map((s) => [s.action, s.actionPath, s.sharedStepId]), [
      ['First @Vendor', '0000000a', undefined],
      ['Shared', '0000000b0000000f', 500],
      ['Nested', '0000000b0000001000000011', 600],
      ['After', '0000000c', undefined],
    ]);
    assert.equal(result.steps[2].expected, 'Done');
  });

  it('makes unreadable dependencies and recursion explicit, without dropping following steps', async () => {
    const xml = `<steps><compref id="3" ref="500">${step(4, 'After')}</compref></steps>`;
    const missing = await flattenSteps(parseStepsXml(xml), async () => undefined);
    assert.equal(missing.problems.length, 1);
    assert.match(missing.problems[0], /Shared steps 500 could not be loaded/);
    assert.deepEqual(missing.steps.map((s) => s.action), [missing.steps[0].action, 'After']);
    assert.equal(missing.steps[1].actionPath, '00000004');

    const shared = new Map<number, string>([
      [500, '<steps><compref id="5" ref="600"></compref></steps>'],
      [600, '<steps><compref id="6" ref="500"></compref></steps>'],
    ]);
    const cyclic = await flattenSteps(parseStepsXml(xml), async (id) => parseStepsXml(shared.get(id)));
    assert.match(cyclic.problems.join(' '), /recursion cycle/);
    assert.equal(cyclic.steps.at(-1)?.action, 'After');
  });

  it('keeps formatted HTML decoding and typed placeholders intact', async () => {
    const result = await flattenSteps(parseStepsXml(`<steps>${step(2, '&lt;P&gt;Use &amp;lt;vendor group&amp;gt;&amp;nbsp;now&lt;/P&gt;')}</steps>`), async () => undefined);
    assert.equal(result.steps[0].action, 'Use <vendor group> now');
  });

  it('blocks an incomplete case before model or browser execution', async () => {
    const tc: TestCase = { id: '1', source: 'devops', title: 'Broken', problems: ['Shared steps 500 could not be loaded.'], steps: [{ index: 1, action: 'Do not run' }] };
    let models = 0;
    let tools = 0;
    const agent = new AgentOrchestrator({
      cfg: { REPORT_DIR: '/unused', AGENT_PREFLIGHT: 'off' } as AppConfig,
      llm: { name: 'fake', async complete() { models++; throw new Error('must not run'); } },
      mcp: { async listTools() { tools++; return []; }, async callTool() { tools++; return { content: '', isError: false }; } },
      mcpServers: ['playwright'],
    } as never);
    const result = await agent.runTestCase(tc);
    assert.equal(result.outcome, 'blocked');
    assert.match(result.errorMessage ?? '', /dependencies are incomplete/);
    assert.equal(result.steps[0].status, 'blocked');
    assert.deepEqual([models, tools], [0, 0]);
  });
});
