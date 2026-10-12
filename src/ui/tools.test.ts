import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runProgress } from './tools.js';

describe('runProgress', () => {
  it('follows each case of a run from its log', () => {
    const lines = ['$ d365fo-agent run --local cases', '', '▶ Running [TC-1] Create vendor', '[agent] → browser_click {}', '  → passed (1 attempt) in 12.0s', '', '▶ Running [TC-2] Post invoice'];
    assert.deepEqual(runProgress(lines), {
      finished: 1,
      current: 'TC-2 Post invoice',
      cases: [{ id: 'TC-1', title: 'Create vendor', outcome: 'passed' }, { id: 'TC-2', title: 'Post invoice' }],
    });
    assert.deepEqual(runProgress([]), { finished: 0, cases: [] });
  });
});
