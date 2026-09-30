import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadLocalTestCases } from './loader.js';

describe('example test cases', () => {
  it('all load, have unique ids and numbered steps, and agent-verification cases are marked sandbox-only', async () => {
    const cases = await loadLocalTestCases(join(process.cwd(), 'examples', 'testcases'));
    assert.ok(cases.length >= 5);
    assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
    for (const c of cases) {
      assert.ok(c.steps.length > 0, c.id);
      assert.deepEqual(c.steps.map((s) => s.index), c.steps.map((_, i) => i + 1), c.id);
    }
    for (const c of cases.filter((x) => x.tags?.includes('agent-verification'))) {
      assert.ok(c.tags?.includes('sandbox-only'), `${c.id} must be tagged sandbox-only`);
      assert.match(c.preconditions ?? '', /SANDBOX ONLY/);
    }
  });
});
