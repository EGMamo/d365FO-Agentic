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

  it('turns on the testing tools, merged with devtools when tracing', () => {
    assert.deepEqual(capsArgs([]), ['--caps', 'testing']);
    assert.deepEqual(capsArgs(['--caps', 'devtools', '--output-dir', 'x']), ['--caps', 'testing,devtools', '--output-dir', 'x']);
  });
});
