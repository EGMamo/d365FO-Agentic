import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AppConfig } from '../config/index.js';
import { buildDefaultManager } from './registry.js';

const specs = (cfg: Partial<AppConfig>) =>
  (buildDefaultManager({ PW_HEADLESS: true, PW_BROWSER: 'chromium', LEARN_MCP_URL: 'https://learn', REPORT_DIR: 'r', ...cfg } as AppConfig) as unknown as {
    specs: Map<string, { transport: string; url?: string }>;
  }).specs;

describe('buildDefaultManager', () => {
  it('registers the Release Planner MCP server only when its URL is set', () => {
    assert.ok(!specs({}).has('release-planner'));
    const s = specs({ RELEASE_PLANNER_MCP_URL: 'http://localhost:3000/mcp' });
    assert.deepEqual(s.get('release-planner'), { name: 'release-planner', transport: 'http', url: 'http://localhost:3000/mcp' });
    assert.ok(s.has('playwright') && s.has('learn'));
  });
});
