import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Guardrails } from './guardrails.js';

const cfg = { D365_BASE_URL: 'https://x.sandbox.operations.dynamics.com', D365_COMPANY: 'USMF' };
const servers = ['playwright', 'learn'];

describe('tool allowlist', () => {
  const g = new Guardrails(cfg, servers);

  it('allows the normal UI-driving and docs tools', () => {
    for (const t of ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_fill_form', 'browser_take_screenshot', 'browser_verify_text_visible']) {
      assert.equal(g.isToolAllowed('playwright', t), true, t);
    }
    for (const t of ['microsoft_docs_search', 'microsoft_docs_fetch', 'microsoft_code_sample_search']) assert.equal(g.isToolAllowed('learn', t), true, t);
  });

  it('offers only the read-only data tools of the Dynamics 365 ERP MCP server', () => {
    for (const t of ['data_find_entity_type', 'data_get_entity_metadata', 'data_find_entities', 'data_find_entities_sql']) assert.equal(g.isToolAllowed('d365', t), true, t);
    for (const t of ['data_create_entities', 'data_update_entities', 'data_delete_entities', 'form_click_control', 'api_invoke_action']) assert.equal(g.isToolAllowed('d365', t), false, t);
  });

  it('denies tools that expose cookies, storage, scripts, files or network internals', () => {
    for (const t of [
      'browser_storage_state', 'browser_set_storage_state', 'browser_cookie_list', 'browser_cookie_get', 'browser_localstorage_get',
      'browser_sessionstorage_list', 'browser_evaluate', 'browser_run_code_unsafe', 'browser_file_upload', 'browser_drop',
      'browser_network_request', 'browser_route', 'browser_pdf_save', 'browser_start_tracing', 'browser_install',
    ]) assert.equal(g.isToolAllowed('playwright', t), false, t);
    assert.equal(g.isToolAllowed('azure-devops', 'anything'), false);
    assert.equal(g.isToolAllowed('learn', 'browser_snapshot'), false, 'allowlists are per server');
  });

  it('opts in extra tools by exact name or prefix', () => {
    const extra = new Guardrails({ ...cfg, AGENT_ALLOWED_TOOLS_EXTRA: ['playwright__browser_file_upload', 'playwright__browser_cookie_*'] }, servers);
    assert.equal(extra.isToolAllowed('playwright', 'browser_file_upload'), true);
    assert.equal(extra.isToolAllowed('playwright', 'browser_cookie_list'), true);
    assert.equal(extra.isToolAllowed('playwright', 'browser_evaluate'), false);
    assert.equal(extra.isToolAllowed('learn', 'browser_file_upload'), false);
  });

  it('splits discovered tools into visible and hidden', () => {
    const tools = ['browser_snapshot', 'browser_storage_state', 'browser_click'].map((name) => ({ server: 'playwright', name }));
    const { allowed, blocked } = g.splitTools(tools);
    assert.deepEqual(allowed.map((t) => t.name), ['browser_snapshot', 'browser_click']);
    assert.deepEqual(blocked.map((t) => t.name), ['browser_storage_state']);
  });
});

describe('checkCall', () => {
  const g = new Guardrails(cfg, servers);

  it('refuses servers that are not enabled for the run', () => {
    assert.match(new Guardrails(cfg, ['playwright']).checkCall('learn', 'microsoft_docs_search', {}) ?? '', /not enabled/);
    assert.match(g.checkCall('azure-devops', 'x', {}) ?? '', /not enabled/);
  });

  it('refuses non-allowlisted tools', () => {
    assert.match(g.checkCall('playwright', 'browser_storage_state', {}) ?? '', /allowlist/);
  });

  it('checks every url argument sent to the browser, not just browser_navigate', () => {
    assert.equal(g.checkCall('playwright', 'browser_navigate', { url: 'https://x.sandbox.operations.dynamics.com/' }), undefined);
    assert.match(g.checkCall('playwright', 'browser_navigate', { url: 'https://evil.example' }) ?? '', /not allowed/);
    assert.match(g.checkCall('playwright', 'browser_tabs', { action: 'new', url: 'https://evil.example' }) ?? '', /not allowed/);
    assert.equal(g.checkCall('playwright', 'browser_tabs', { action: 'list' }), undefined);
  });

  it('applies the per-test legal entity to company links', () => {
    const url = 'https://x.sandbox.operations.dynamics.com/?cmp=DEMF';
    assert.match(g.checkCall('playwright', 'browser_navigate', { url }) ?? '', /DEMF/);
    assert.equal(g.checkCall('playwright', 'browser_navigate', { url }, 'DEMF'), undefined);
  });

  it('does not treat a url argument to a docs tool as browser navigation', () => {
    assert.equal(g.checkCall('learn', 'microsoft_docs_fetch', { url: 'https://learn.microsoft.com/en-us/dynamics365/' }), undefined);
  });
});
