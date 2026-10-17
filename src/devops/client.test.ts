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
