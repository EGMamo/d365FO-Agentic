import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TestResult } from '../testing/types.js';
import { describeSuggestions, parameterSuggestions } from './suggestions.js';

const result = (over: Partial<TestResult>): TestResult => ({
  testCaseId: '38', title: 'Requisition', outcome: 'passed', runState: 'completed', startedAt: '', finishedAt: '', durationMs: 0, steps: [], artifacts: [],
  suggestedParameters: [{ name: 'VendorAccount', value: 'US-101', source: 'odata', how: 'active, USMF' }], ...over,
});

describe('parameter suggestions', () => {
  it('keeps passed Azure DevOps cases that chose values', () => {
    const list = parameterSuggestions([
      result({}),
      result({ testCaseId: '39', outcome: 'failed' }),
      result({ testCaseId: '40', outcome: 'blocked' }),
      result({ testCaseId: 'local-case', title: 'Local' }),
      result({ testCaseId: '41', interrupted: true }),
      result({ testCaseId: '42', suggestedParameters: [] }),
      result({ testCaseId: '43', suggestedParameters: undefined }),
    ]);
    assert.deepEqual(list.map((s) => s.caseId), ['38']);
  });

  it('can be limited to some cases', () => {
    const all = [result({}), result({ testCaseId: '44' })];
    assert.deepEqual(parameterSuggestions(all, ['44']).map((s) => s.caseId), ['44']);
    assert.deepEqual(parameterSuggestions(all, []).map((s) => s.caseId), ['38', '44']);
  });

  it('says where each value came from', () => {
    const lines = describeSuggestions(parameterSuggestions([result({ suggestedParameters: [{ name: 'A', value: '1', source: 'odata', how: 'active' }, { name: 'B', value: '2', source: 'agent' }] })]));
    assert.deepEqual(lines, ['Case 38 (Requisition):', '  @A = 1  (read from F&O; active)', '  @B = 2  (chosen by the agent)']);
  });
});
