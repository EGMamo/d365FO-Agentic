import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCases } from './runner.js';
import { iterationCount, testCaseForIteration } from './iterations.js';
import type { TestCase, TestResult } from '../testing/types.js';

function parameterized(id: string): TestCase {
  return {
    id, source: 'devops', title: `Case ${id}`,
    steps: [{ index: 1, action: 'Use one' }],
    sourceSteps: [{ index: 1, action: 'Use @Value and @Order', actionPath: '00000002' }],
    parameterData: [{ names: ['Value'], rows: [{ Value: 'one' }, { Value: 'two' }] }],
  };
}

const result = (tc: TestCase, outcome: TestResult['outcome'], data: Record<string, string> = {}): TestResult => ({
  testCaseId: tc.id, title: tc.title, outcome, runState: outcome === 'passed' ? 'completed' : 'failed',
  startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z', durationMs: 1000,
  steps: [{ index: 1, status: outcome === 'passed' ? 'passed' : 'failed', durationMs: 1, actionPath: '00000002' }], artifacts: [], data,
});

describe('multi-row iterations', () => {
  it('retains every local/shared row and substitutes each independently, with first row as the default', async () => {
    const tc = parameterized('10');
    assert.equal(iterationCount(tc), 2);
    assert.equal(testCaseForIteration(tc, 1).steps[0].action, 'Use two and @Order');
    assert.deepEqual(testCaseForIteration(tc, 1).parameters, { row: 2, rows: 2, filled: ['Value'], unresolved: ['Order'], carried: [] });

    const seen: string[] = [];
    const one = await runCases({ async runTestCase(t) { seen.push(t.steps[0].action); return result(t, 'passed'); } }, [tc], () => {});
    assert.deepEqual(seen, ['Use one and @Order']);
    assert.equal(one.results[0].iteration?.row, 1);

    seen.length = 0;
    const all = await runCases({ async runTestCase(t) { seen.push(t.steps[0].action); return result(t, 'passed'); } }, [tc], () => {}, undefined, { allIterations: true });
    assert.deepEqual(seen, ['Use one and @Order', 'Use two and @Order']);
    assert.deepEqual(all.results.map((r) => [r.testCaseId, r.iteration]), [['10', { row: 1, count: 2 }], ['10', { row: 2, count: 2 }]]);
  });

  it('does not carry values between rows or remember values from a failed row', async () => {
    const creator = parameterized('20');
    const consumer = parameterized('21');
    const seen: Array<[string, string]> = [];
    const out = await runCases({
      async runTestCase(tc) {
        seen.push([tc.id, tc.steps[0].action]);
        if (tc.id === '20') return result(tc, tc.parameters?.row === 2 ? 'failed' : 'passed', { Order: `SO-${tc.parameters?.row}` });
        return result(tc, 'passed');
      },
    }, [creator, consumer], () => {}, undefined, { allIterations: true });
    assert.deepEqual(seen, [
      ['20', 'Use one and @Order'], ['20', 'Use two and @Order'],
      ['21', 'Use one and SO-1'], ['21', 'Use two and SO-1'],
    ]);
    assert.equal(out.results.length, 4);
    assert.equal(out.results[1].outcome, 'failed');
    assert.ok(!seen.some(([, action]) => action.includes('SO-2')), 'failed row 2 must not supply a carry value');
  });
});
