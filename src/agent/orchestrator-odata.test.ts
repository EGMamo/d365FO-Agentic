import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AgentOrchestrator } from './orchestrator.js';
import type { AppConfig } from '../config/index.js';
import type { LlmCompleteRequest, LlmCompleteResponse } from '../llm/types.js';
import type { ODataQuery } from '../d365fo/odata.js';
import { ODataSignInError } from '../d365fo/odata-auth.js';
import type { TestCase } from '../testing/types.js';

const call = (name: string, args: Record<string, unknown>, id = name): LlmCompleteResponse => ({ text: '', stopReason: 'tool_use', toolCalls: [{ id, name, arguments: args }] });
const finish = (): LlmCompleteResponse => call('finish_test', { outcome: 'blocked' }, 'fin');
const tc: TestCase = { id: 'O', source: 'local', title: 'odata', legalEntity: 'USMF', steps: [{ index: 1, action: 'Check vendor US-101 is active' }] };

async function run(turns: LlmCompleteResponse[], over: Partial<AppConfig>, odata?: { query(q: ODataQuery): Promise<unknown> }, extra: { testCase?: TestCase; classify?: Array<{ id: number; kind: string }> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'orch-odata-'));
  const cfg = {
    LLM_PROVIDER: 'anthropic', AGENT_DRY_RUN: false, AGENT_VERBOSE: false, AGENT_MAX_STEPS: 10, REPORT_DIR: dir, D365_BASE_URL: 'https://x.sandbox.operations.dynamics.com',
    D365_COMPANY: 'USMF', AGENT_FNO_AUTO_WAIT: false, AGENT_LEARN_PAGES: false, AGENT_PREFLIGHT: 'off', AGENT_DISCARD_UNSAVED: false, ...over,
  } as AppConfig;
  const toolResults: string[] = [];
  const offered: string[][] = [];
  const systems: string[] = [];
  const prompts: string[] = [];
  const llm = {
    name: 'fake',
    async complete(req: LlmCompleteRequest) {
      if (req.tools?.some((t) => t.name === 'classify_placeholders')) {
        return call('classify_placeholders', { placeholders: extra.classify ?? [] });
      }
      offered.push((req.tools ?? []).map((t) => t.name));
      if (!systems.length) { systems.push(req.system ?? ''); prompts.push(req.messages[0].content); }
      const last = req.messages.at(-1);
      if (last?.role === 'tool') toolResults.push(last.content);
      return turns.shift() ?? finish();
    },
  };
  const mcp = { async listTools() { return []; }, async callTool() { return { content: '', isError: false }; } };
  const result = await new AgentOrchestrator({ cfg, llm, mcp, mcpServers: ['playwright'], odata } as never).runTestCase(extra.testCase ?? tc);
  return { result, toolResults, offered, systems, prompts };
}

describe('d365_odata_query', () => {
  it('is offered only when OData is on and there is an F&O address', async () => {
    assert.ok((await run([], { AGENT_ODATA: true })).offered[0].includes('d365_odata_query'));
    assert.ok(!(await run([], { AGENT_ODATA: false })).offered[0].includes('d365_odata_query'));
    assert.ok(!(await run([], { AGENT_ODATA: true, D365_BASE_URL: undefined })).offered[0].includes('d365_odata_query'));
  });

  it('runs the query and returns the rows to the model', async () => {
    const seen: ODataQuery[] = [];
    const odata = { async query(q: ODataQuery) { seen.push(q); return { entity: q.entity, count: 1, rows: [{ VendorAccountNumber: 'US-101' }] }; } };
    const { toolResults } = await run(
      [call('d365_odata_query', { entity: 'VendorsV2', select: 'VendorAccountNumber', filter: "VendorAccountNumber eq 'US-101'", top: '3', company: 'USMF' }), finish()],
      { AGENT_ODATA: true }, odata,
    );
    assert.deepEqual(seen, [{ entity: 'VendorsV2', select: 'VendorAccountNumber', filter: "VendorAccountNumber eq 'US-101'", orderby: undefined, top: 3, company: 'USMF' }]);
    assert.deepEqual(JSON.parse(toolResults[0]), { entity: 'VendorsV2', count: 1, rows: [{ VendorAccountNumber: 'US-101' }] });
  });

  it('refuses another company than the test legal entity, and counts it as a policy block', async () => {
    let called = false;
    const odata = { async query() { called = true; return {}; } };
    const { result, toolResults } = await run([call('d365_odata_query', { entity: 'VendorsV2', company: 'DEMF' }), finish()], { AGENT_ODATA: true }, odata);
    assert.equal(called, false);
    assert.match(toolResults[0], /Blocked by policy: company DEMF is not this test's legal entity \(USMF\)/);
    assert.equal(result.policyBlocks?.length, 1);
  });

  it('tells the model to carry on in the browser when data access is not available, without counting a failing tool call', async () => {
    const odata = { async query() { throw new ODataSignInError('Not signed in for data access yet.'); } };
    const turns = [...Array.from({ length: 6 }, (_, i) => call('d365_odata_query', { entity: 'VendorsV2', top: i + 1 }, `q${i}`)), finish()];
    const { toolResults, result } = await run(turns, { AGENT_ODATA: true, AGENT_MAX_CONSECUTIVE_ERRORS: 5 }, odata);
    assert.match(toolResults[0], /Not signed in for data access yet\. If data access is not available, check the page in the browser instead/);
    assert.equal(toolResults.length, 6, 'six refusals in a row did not stop the run');
    assert.doesNotMatch(result.errorMessage ?? '', /consecutive|failing/i);
  });

  it('counts an unexpected failure as a failing tool call and scrubs secrets from the answer', async () => {
    const odata = { async query() { throw new Error('boom sk-ant-api03-abcdefghijklmnopqrstuvwxyz'); } };
    const { toolResults } = await run([call('d365_odata_query', { entity: 'VendorsV2' }), finish()], { AGENT_ODATA: true }, odata);
    assert.match(toolResults[0], /boom \*\*\*/);
  });
});

describe('filling unset data from F&O', () => {
  const fill = { AGENT_ODATA: true, AGENT_FILL_FROM_ERP: true, AGENT_IGNORE_USER_ROLE: true, AGENT_PREFLIGHT: 'block' as const };
  const withParams: TestCase = {
    id: '38', source: 'devops', title: 'Requisition', legalEntity: 'USMF',
    steps: [{ index: 1, action: 'Select vendor @VendorAccount in @LegalEntity' }, { index: 2, action: 'Save' }],
    parameters: { row: 1, rows: 0, filled: [], unresolved: ['VendorAccount', 'LegalEntity'] },
  };
  const passed = [call('report_step', { index: 1, status: 'passed' }, 's1'), call('report_step', { index: 2, status: 'passed' }, 's2'), call('finish_test', { outcome: 'passed' }, 'fin')];
  const odata = { async query() { return { entity: 'VendorsV2', count: 1, rows: [{ VendorAccountNumber: 'US-101' }] }; } };

  it('offers record_parameter and the find-data instructions only when filling is on', async () => {
    const on = await run([], fill, odata, { testCase: withParams, classify: [{ id: 0, kind: 'lookup' }, { id: 1, kind: 'config' }] });
    assert.ok(on.offered[0].includes('record_parameter'));
    assert.match(on.systems[0], /13\. Order for any value a step needs[\s\S]*When the prompt lists "Values to find in F&O"/);
    assert.match(on.systems[0], /14\. Some cases name a user role/);
    const off = await run([], { ...fill, AGENT_FILL_FROM_ERP: false, AGENT_IGNORE_USER_ROLE: false }, odata, { testCase: withParams, classify: [{ id: 0, kind: 'missing' }] });
    assert.ok(!off.offered[0]?.includes('record_parameter'));
    assert.doesNotMatch(off.systems[0] ?? '', /Values to find in F&O"/);
  });

  it('lists the lookups to find in the prompt and lets the case run instead of blocking it', async () => {
    const { prompts, result } = await run([...passed], fill, odata, { testCase: withParams, classify: [{ id: 0, kind: 'lookup' }, { id: 1, kind: 'config' }] });
    assert.match(prompts[0], /Values to find in F&O[^\n]*@VendorAccount \(step 1\)/);
    assert.doesNotMatch(prompts[0], /@LegalEntity \(step 1\)/);
    assert.notEqual(result.errorMessage?.startsWith('Missing test data'), true);
  });

  it('blocks as before when a value is missing data, even with filling on', async () => {
    const { result, prompts } = await run([], fill, odata, { testCase: withParams, classify: [{ id: 0, kind: 'missing' }, { id: 1, kind: 'config' }] });
    assert.equal(prompts.length, 0);
    assert.match(result.errorMessage ?? '', /^Missing test data[\s\S]*@VendorAccount/);
  });

  it('records the chosen value, tells apart a value read from F&O, and suggests it only for a passed case', async () => {
    const turns = [
      call('d365_odata_query', { entity: 'VendorsV2', select: 'VendorAccountNumber', company: 'USMF' }, 'q'),
      call('record_parameter', { name: '@VendorAccount', value: 'US-101', how: 'active, USMF' }, 'r1'),
      call('record_parameter', { name: 'LegalEntity', value: 'USMF' }, 'r2'),
      ...passed,
    ];
    const { result, toolResults } = await run(turns, fill, odata, { testCase: withParams, classify: [{ id: 0, kind: 'lookup' }, { id: 1, kind: 'lookup' }] });
    assert.deepEqual(JSON.parse(toolResults[1]), { ok: true, recorded: '@VendorAccount', source: 'odata' });
    assert.deepEqual(JSON.parse(toolResults[2]), { ok: true, recorded: '@LegalEntity', source: 'agent' }, 'USMF was not in what F&O returned');
    assert.deepEqual(result.suggestedParameters, [
      { name: 'VendorAccount', value: 'US-101', source: 'odata', how: 'active, USMF' },
      { name: 'LegalEntity', value: 'USMF', source: 'agent' },
    ]);
    assert.equal(result.data?.['@VendorAccount'], 'US-101');
  });

  it('suggests nothing from a case that did not pass', async () => {
    const turns = [call('record_parameter', { name: 'VendorAccount', value: 'US-101' }, 'r'), call('report_step', { index: 1, status: 'blocked', cause: 'other' }, 's'), call('finish_test', { outcome: 'blocked' }, 'f')];
    const { result } = await run(turns, fill, odata, { testCase: withParams, classify: [{ id: 0, kind: 'lookup' }, { id: 1, kind: 'lookup' }] });
    assert.equal(result.suggestedParameters, undefined);
  });

  it('refuses a name that is not an unfilled parameter, without counting a failing call', async () => {
    const turns = [call('record_parameter', { name: 'Approver', value: 'jo' }, 'r'), call('record_parameter', { name: '', value: 'x' }, 'e'), finish()];
    const { toolResults, result } = await run(turns, fill, odata, { testCase: withParams, classify: [{ id: 0, kind: 'lookup' }, { id: 1, kind: 'lookup' }] });
    assert.match(toolResults[0], /'Approver' is not an unfilled parameter of this case \(those are: @VendorAccount, @LegalEntity\)[\s\S]*Nothing was recorded/);
    assert.match(toolResults[1], /Both `name` and `value` are required/);
    assert.equal(result.suggestedParameters, undefined);
  });

  it('has the agent sort the unset parameters itself when preflight is off, so filling from F&O still works', async () => {
    const off = { ...fill, AGENT_PREFLIGHT: 'off' as const };
    const { prompts, offered } = await run([], off, odata, { testCase: withParams });
    assert.match(prompts[0], /Parameters with no value in the test case: @VendorAccount, @LegalEntity\. Decide for each one yourself/);
    assert.match(prompts[0], /this run's company is USMF; use it/);
    assert.match(prompts[0], /@Requester\) or a role: the signed-in user/);
    assert.match(prompts[0], /find one in F&O with `d365_odata_query` and save it with `record_parameter`/);
    assert.ok(offered[0].includes('record_parameter') && offered[0].includes('d365_odata_query'));
  });

  it('puts values from an earlier step of the case before any lookup, in the rules and in the parameter list', async () => {
    const { systems, prompts } = await run([], { ...fill, AGENT_PREFLIGHT: 'off' }, odata, { testCase: withParams });
    assert.match(systems[0], /13\. Order for any value a step needs: first the value written in the step[\s\S]*then a value an earlier step of this case created[\s\S]*never a lookup\); only then a record found in F&O/);
    assert.match(systems[0], /under the parameter's name without the @/);
    assert.match(prompts[0], /a value an earlier step of this case creates or shows[\s\S]*never look one up/);
  });

  it('does not add that list when preflight sorted the values, when filling is off, or when no parameter is unset', async () => {
    const sorted = await run([], fill, odata, { testCase: withParams, classify: [{ id: 0, kind: 'lookup' }, { id: 1, kind: 'config' }] });
    assert.doesNotMatch(sorted.prompts[0], /Parameters with no value in the test case/);
    const noFill = await run([], { ...fill, AGENT_PREFLIGHT: 'off', AGENT_FILL_FROM_ERP: false }, odata, { testCase: withParams });
    assert.doesNotMatch(noFill.prompts[0], /Parameters with no value in the test case/);
    const none = await run([], { ...fill, AGENT_PREFLIGHT: 'off' }, odata, { testCase: { ...withParams, parameters: { row: 1, rows: 1, filled: ['VendorAccount'], unresolved: [] } } });
    assert.doesNotMatch(none.prompts[0], /Parameters with no value in the test case/);
  });

  it('does not take a page the menu tool does not know for a page F&O lacks', async () => {
    const { toolResults } = await run([call('d365_open_menu_item', { page: 'Some page nobody mapped' }, 'm'), finish()], { ...fill, AGENT_PREFLIGHT: 'off' }, odata, { testCase: withParams });
    assert.match(toolResults[0], /is not in the list of pages this tool knows\. That does not mean F&O lacks it[\s\S]*navigation search box[\s\S]*only if F&O's own search cannot find it/);
  });

  it('runs a role step as the signed-in user instead of blocking, but only when the setting is on', async () => {
    const roleCase: TestCase = { id: 'R', source: 'devops', title: 'Role', steps: [{ index: 1, action: 'Pre-requisites: 1. User Role = [TBC] 2. Open the page' }] };
    const classify = [{ id: 0, kind: 'missing' }];
    const on = await run([], fill, odata, { testCase: roleCase, classify });
    assert.equal(on.prompts.length, 1, 'the case ran');
    assert.match(on.systems[0], /do those steps as the user who is signed in/);
    const off = await run([], { ...fill, AGENT_IGNORE_USER_ROLE: false }, odata, { testCase: roleCase, classify });
    assert.equal(off.prompts.length, 0, 'with the setting off the role is missing data and the case is blocked');
    assert.match(off.result.errorMessage ?? '', /^Missing test data/);
  });
});
