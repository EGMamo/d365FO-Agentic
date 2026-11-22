import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AppConfig } from '../config/index.js';
import { buildDefaultManager, capsArgs } from './registry.js';

const specs = (cfg: Partial<AppConfig>) =>
  (buildDefaultManager({ PW_HEADLESS: true, PW_BROWSER: 'chromium', LEARN_MCP_URL: 'https://learn', REPORT_DIR: 'r', ...cfg } as AppConfig) as unknown as {
    specs: Map<string, { transport: string; url?: string }>;
  }).specs;

describe('buildDefaultManager', () => {
  it('registers only the browser and Microsoft Learn', () => {
    assert.deepEqual([...specs({}).keys()], ['playwright', 'learn']);
  });

  it('registers the Dynamics 365 ERP MCP server at <F&O address>/mcp when there is an F&O address, unless it is off', () => {
    const fno = { D365_BASE_URL: 'https://x.sandbox.operations.dynamics.com/?cmp=USMF', D365_USERNAME: 'u', D365_PASSWORD: 'p' };
    const on = specs({ ...fno, AGENT_D365_MCP: true });
    assert.deepEqual([...on.keys()], ['playwright', 'learn', 'd365']);
    assert.equal(on.get('d365')?.url, 'https://x.sandbox.operations.dynamics.com/mcp');
    assert.equal(specs({ ...fno, AGENT_D365_MCP: true, D365_MCP_URL: 'https://mcp.example/mcp' }).get('d365')?.url, 'https://mcp.example/mcp');
    assert.deepEqual([...specs({ ...fno, AGENT_D365_MCP: false }).keys()], ['playwright', 'learn']);
  });

  it('turns on the testing tools, merged with devtools when tracing', () => {
    assert.deepEqual(capsArgs([]), ['--caps', 'testing']);
    assert.deepEqual(capsArgs(['--caps', 'devtools', '--output-dir', 'x']), ['--caps', 'testing,devtools', '--output-dir', 'x']);
  });
});
