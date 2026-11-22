import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { AppConfig } from '../config/index.js';
import { AzureDevOpsClient } from './client.js';

describe('Azure DevOps test plans and suites', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const cfg = { AZDO_ORG_URL: 'https://dev.azure.com/contoso/', AZDO_PROJECT: 'Fin Ops', AZDO_PAT: 'pat', AZDO_AUTH: 'pat', AZDO_HTTP_TIMEOUT_MS: 5000, AZDO_HTTP_MAX_RETRIES: 0, AZDO_HTTP_RETRY_BASE_MS: 1 } as AppConfig;
  const reply = (value: unknown[], continuation?: string): Response =>
    new Response(JSON.stringify({ value }), { status: 200, headers: { 'content-type': 'application/json', ...(continuation ? { 'x-ms-continuationtoken': continuation } : {}) } });

  it('lists every page of plans, newest first, with the root suite of each', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      return url.includes('continuationToken=') ? reply([{ id: 12, name: 'Sprint 12', state: 'Active', rootSuite: { id: 13 } }]) : reply([{ id: 3, name: 'Regression', areaPath: 'Fin Ops\\AP', rootSuite: { id: 4 } }], 'next page');
    }) as typeof fetch;
    const plans = await new AzureDevOpsClient(cfg).listPlans();
    assert.deepEqual(plans, [
      { id: '12', name: 'Sprint 12', state: 'Active', rootSuiteId: '13' },
      { id: '3', name: 'Regression', areaPath: 'Fin Ops\\AP', rootSuiteId: '4' },
    ]);
    assert.equal(urls[0], 'https://dev.azure.com/contoso/Fin%20Ops/_apis/testplan/plans?includePlanDetails=true&api-version=7.1');
    assert.match(urls[1], /&continuationToken=next%20page$/);
  });

  it('fills @parameters from the case table and its shared parameter sets', async () => {
    const urls: string[] = [];
    const steps = '<steps id="0" last="2"><step id="2" type="ActionStep">'
      + '<parameterizedString isformatted="true">&lt;P&gt;Pick @Vendor in @LegalEntity, approver @Approver&lt;/P&gt;</parameterizedString>'
      + '<parameterizedString isformatted="true">&lt;P&gt;@Vendor is active&lt;/P&gt;</parameterizedString><description/></step></steps>';
    const table = (cols: Record<string, string>) => `<NewDataSet><xs:schema id="NewDataSet"></xs:schema><Table1>${Object.entries(cols).map(([k, v]) => `<${k}>${v}</${k}>`).join('')}</Table1></NewDataSet>`;
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      if (url.toLowerCase().includes('/suites/')) return reply([{ testCase: { id: '38' } }]);
      if (url.includes('$expand=relations')) {
        return reply([{
          id: 38, fields: { 'System.Title': 'Req', 'Microsoft.VSTS.TCM.Steps': steps, 'Microsoft.VSTS.TCM.LocalDataSource': table({ Vendor: 'US-101' }) },
          relations: [
            { rel: 'Microsoft.VSTS.TestCase.SharedParameterReferencedBy-Forward', url: 'https://dev.azure.com/contoso/_apis/wit/workItems/77' },
            { rel: 'Microsoft.VSTS.Common.TestedBy-Reverse', url: 'https://dev.azure.com/contoso/_apis/wit/workItems/99' },
          ],
        }]);
      }
      return reply([{ id: 77, fields: { 'Microsoft.VSTS.TCM.LocalDataSource': table({ LegalEntity: 'USMF', Vendor: 'ignored' }) } }]);
    }) as typeof fetch;
    const [tc] = await new AzureDevOpsClient(cfg).listTestCases('1', '2');
    assert.deepEqual(tc.steps, [{ index: 1, action: 'Pick US-101 in USMF, approver @Approver', expected: 'US-101 is active' }]);
    assert.deepEqual(tc.parameters, { row: 1, rows: 1, filled: ['Vendor', 'LegalEntity'], unresolved: ['Approver'] });
    assert.ok(urls.some((u) => /ids=77&fields=System\.Id,Microsoft\.VSTS\.TCM\.Parameters,Microsoft\.VSTS\.TCM\.LocalDataSource/.test(u)), 'only the shared set link is followed');
    assert.ok(!urls.some((u) => /ids=99/.test(u)));
  });

  it('leaves a case without parameters alone and keeps going when a shared set cannot be read', async () => {
    const steps = '<steps><step id="2"><parameterizedString isformatted="false">Use @Vendor</parameterizedString><parameterizedString isformatted="false"></parameterizedString></step></steps>';
    globalThis.fetch = (async (url: string) => {
      if (url.toLowerCase().includes('/suites/')) return reply([{ testCase: { id: '1' } }, { testCase: { id: '2' } }]);
      if (url.includes('$expand=relations')) {
        return reply([
          { id: 1, fields: { 'Microsoft.VSTS.TCM.Steps': '<steps><step id="2"><parameterizedString isformatted="false">Open</parameterizedString><parameterizedString isformatted="false"></parameterizedString></step></steps>' } },
          { id: 2, fields: { 'Microsoft.VSTS.TCM.Steps': steps }, relations: [{ rel: 'x.SharedParameterReferencedBy', url: 'https://x/_apis/wit/workItems/5' }] },
        ]);
      }
      return new Response('nope', { status: 500 });
    }) as typeof fetch;
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (m: string) => { warnings.push(String(m)); };
    try {
      const [a, b] = await new AzureDevOpsClient(cfg).listTestCases('1', '2');
      assert.equal(a.parameters, undefined);
      assert.deepEqual(b.parameters, { row: 1, rows: 0, filled: [], unresolved: ['Vendor'] });
    } finally {
      console.warn = warn;
    }
    assert.match(warnings.join('\n'), /could not read the shared parameter sets/);
  });

  describe('saving parameter values to a test case', () => {
    const PARAMS = 'Microsoft.VSTS.TCM.Parameters';
    const SOURCE = 'Microsoft.VSTS.TCM.LocalDataSource';
    const table = (cols: Record<string, string>) => `<NewDataSet><xs:schema id="NewDataSet"></xs:schema><Table1>${Object.entries(cols).map(([k, v]) => `<${k}>${v}</${k}>`).join('')}</Table1></NewDataSet>`;
    const workItem = (fields: Record<string, string>, rev = 7) => new Response(JSON.stringify({ id: 38, rev, fields }), { status: 200, headers: { 'content-type': 'application/json' } });
    type Patch = Array<{ op: string; path: string; value?: unknown }>;

    /** A work item store: GET returns the stored fields, PATCH applies the operations (or ignores them, to play a server that keeps something else). */
    function store(initial: Record<string, string>, apply = true) {
      const fields = { ...initial };
      const patches: Array<{ type: string | null; ops: Patch }> = [];
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          const ops = JSON.parse(String(init.body)) as Patch;
          patches.push({ type: new Headers(init.headers).get('content-type'), ops });
          if (apply) for (const o of ops) if (o.path.startsWith('/fields/')) { if (o.op === 'remove') delete fields[o.path.slice(8)]; else fields[o.path.slice(8)] = String(o.value); }
          return workItem(fields);
        }
        return workItem(fields);
      }) as typeof fetch;
      return { fields, patches };
    }

    it('fills only parameters without a value, with a revision check, and reads the case back', async () => {
      const s = store({ [PARAMS]: '<parameters><param name="Vendor" bind="default" /></parameters>', [SOURCE]: table({ Vendor: 'US-101' }) });
      const result = await new AzureDevOpsClient(cfg).saveParameterValues('38', { Vendor: 'IGNORED', Warehouse: '11' });
      assert.deepEqual(result, { saved: ['Warehouse'], skipped: ['Vendor'] });
      assert.equal(s.patches.length, 1);
      assert.equal(s.patches[0].type, 'application/json-patch+json');
      assert.deepEqual(s.patches[0].ops[0], { op: 'test', path: '/rev', value: 7 });
      assert.match(String(s.patches[0].ops.find((o) => o.path.endsWith('LocalDataSource'))?.value), /<Vendor>US-101<\/Vendor><Warehouse>11<\/Warehouse>/);
      assert.match(s.fields[PARAMS], /name="Vendor"[\s\S]*name="Warehouse"/);
    });

    it('writes nothing when every value is already there', async () => {
      const s = store({ [SOURCE]: table({ Vendor: 'US-101' }) });
      assert.deepEqual(await new AzureDevOpsClient(cfg).saveParameterValues('38', { Vendor: 'US-102' }), { saved: [], skipped: ['Vendor'] });
      assert.equal(s.patches.length, 0);
    });

    it('puts the case back as it was when the stored data is not what was written', async () => {
      const original = { [PARAMS]: '<parameters><param name="Vendor" bind="default" /></parameters>', [SOURCE]: table({ Vendor: 'US-101' }) };
      const s = store(original, false);
      await assert.rejects(new AzureDevOpsClient(cfg).saveParameterValues('38', { Warehouse: '11' }), /stored the parameter values differently[\s\S]*put back as it was/);
      assert.equal(s.patches.length, 2, 'the write, then the restore');
      assert.deepEqual(s.patches[1].ops.map((o) => [o.op, o.path.replace('/fields/', ''), o.value]), [['add', PARAMS, original[PARAMS]], ['add', SOURCE, original[SOURCE]]]);
    });

    it('refuses an id or a name that is not what it should be', async () => {
      store({});
      await assert.rejects(new AzureDevOpsClient(cfg).saveParameterValues('38; drop', { A: '1' }), /not a test case id/);
      await assert.rejects(new AzureDevOpsClient(cfg).saveParameterValues('38', { 'A B': '1' }), /not a parameter name/);
    });
  });

  it('lists the suites of a plan with their parents', async () => {
    let seen = '';
    globalThis.fetch = (async (url: string) => {
      seen = url;
      return reply([{ id: 4, name: 'Regression', suiteType: 'staticTestSuite' }, { id: 5, name: 'Vendors', suiteType: 'requirementTestSuite', parentSuite: { id: 4 } }]);
    }) as typeof fetch;
    assert.deepEqual(await new AzureDevOpsClient(cfg).listSuites('3'), [
      { id: '4', name: 'Regression', type: 'staticTestSuite' },
      { id: '5', name: 'Vendors', type: 'requirementTestSuite', parentId: '4' },
    ]);
    assert.equal(seen, 'https://dev.azure.com/contoso/Fin%20Ops/_apis/testplan/Plans/3/suites?api-version=7.1');
  });
});
