import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_MODEL } from '../profiles/ai.js';
import { parseConfig } from './index.js';

describe('configuration parsing', () => {
  it('preserves defaults and disabled production/destructive actions when settings are absent', () => {
    const cfg = parseConfig({});
    assert.equal(cfg.LLM_MODEL, DEFAULT_MODEL);
    assert.equal(cfg.LLM_MAX_TOKENS, 4096);
    assert.equal(cfg.LLM_PROMPT_CACHE, true);
    assert.equal(cfg.PW_HEADLESS, true);
    assert.equal(cfg.AGENT_DRY_RUN, false);
    assert.equal(cfg.AGENT_ALLOW_PRODUCTION, false);
    assert.equal(cfg.AGENT_ALLOW_DESTRUCTIVE, false);
    assert.equal(cfg.AGENT_STOP_ON_AUTH_FAILURE, true);
    assert.deepEqual(cfg.AGENT_ALLOWED_HOSTS, []);
    assert.deepEqual(cfg.AGENT_ALLOWED_TOOLS_EXTRA, []);
    assert.equal(cfg.AZDO_AUTH, undefined);
    assert.equal(cfg.D365_STORAGE_STATE, undefined);
  });

  it('normalises saved strings, optional blanks, flags and lists', () => {
    const cfg = parseConfig({
      LLM_MODEL: '  ', LLM_MAX_TOKENS: '8192', LLM_PROMPT_CACHE: 'false', PW_HEADLESS: 'false',
      AGENT_DRY_RUN: 'true', AGENT_MAX_REPEATED_CALLS: '0', D365_ENVIRONMENT_TYPE: ' Sandbox ',
      ANTHROPIC_BASE_URL: '  ', ANTHROPIC_AUTH_TOKEN: ' token ', AZDO_TENANT_ID: ' tenant ',
      AZDO_AUTH: '', D365_STORAGE_STATE: ' session.json ',
      AGENT_ALLOWED_HOSTS: ' ONE.EXAMPLE, ,two.example ', AGENT_ALLOWED_TOOLS_EXTRA: ' tool_a, tool_b ',
    });
    assert.equal(cfg.LLM_MODEL, DEFAULT_MODEL);
    assert.equal(cfg.LLM_MAX_TOKENS, 8192);
    assert.equal(cfg.LLM_PROMPT_CACHE, false);
    assert.equal(cfg.PW_HEADLESS, false);
    assert.equal(cfg.AGENT_DRY_RUN, true);
    assert.equal(cfg.AGENT_MAX_REPEATED_CALLS, 0);
    assert.equal(cfg.D365_ENVIRONMENT_TYPE, 'sandbox');
    assert.equal(cfg.ANTHROPIC_BASE_URL, undefined);
    assert.equal(cfg.ANTHROPIC_AUTH_TOKEN, 'token');
    assert.equal(cfg.AZDO_TENANT_ID, 'tenant');
    assert.equal(cfg.AZDO_AUTH, undefined);
    assert.equal(cfg.D365_STORAGE_STATE, 'session.json');
    assert.deepEqual(cfg.AGENT_ALLOWED_HOSTS, ['one.example', 'two.example']);
    assert.deepEqual(cfg.AGENT_ALLOWED_TOOLS_EXTRA, ['tool_a', 'tool_b']);
  });

  it('reports invalid setting names and rejects invalid limits and environment types', () => {
    assert.throws(() => parseConfig({ LLM_MAX_TOKENS: '0', D365_ENVIRONMENT_TYPE: 'unknown' }),
      /Invalid environment configuration:[\s\S]*LLM_MAX_TOKENS[\s\S]*D365_ENVIRONMENT_TYPE/);
  });
});
