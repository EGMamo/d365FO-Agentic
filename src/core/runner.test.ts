import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCases, selectCases, unknownCaseIds } from './runner.js';
import type { TestCase, TestResult } from '../testing/types.js';

const tc = (id: string, over: Partial<TestCase> = {}): TestCase => ({ id, source: 'local', title: id, steps: [], ...over });
const cases = [
  tc('1', { priority: 3, tags: ['Smoke'], module: 'Accounts payable' }),
  tc('2', { priority: 1, tags: ['regression'], module: 'General ledger' }),
  tc('3', { tags: ['smoke'], area: 'Procurement and sourcing' }),
  tc('4', { priority: 1, module: 'Accounts payable' }),
];

describe('selectCases', () => {
  it('keeps the discovered order by default', () => {
    assert.deepEqual(selectCases(cases, {}).map((c) => c.id), ['1', '2', '3', '4']);
  });

  it('orders by priority on request, keeping the original order for ties and unprioritised cases last', () => {
    assert.deepEqual(selectCases(cases, { sortByPriority: true }).map((c) => c.id), ['2', '4', '1', '3']);
    assert.deepEqual(selectCases(cases, { sortByPriority: true, caseId: '3,1' }).map((c) => c.id), ['3', '1']);
  });

  it('filters by tag, module or area, and priority', () => {
    assert.deepEqual(selectCases(cases, { tags: ['SMOKE'] }).map((c) => c.id), ['1', '3']);
    assert.deepEqual(selectCases(cases, { modules: ['payable,procurement'] }).map((c) => c.id), ['1', '3', '4']);
    assert.deepEqual(selectCases(cases, { maxPriority: 1 }).map((c) => c.id), ['2', '3', '4']);
    assert.deepEqual(selectCases(cases, { tags: ['smoke'], modules: ['payable'] }).map((c) => c.id), ['1']);
  });

  it('runs listed ids in the order given', () => {
    assert.deepEqual(selectCases(cases, { caseId: '3, 1,9' }).map((c) => c.id), ['3', '1']);
  });

  it('runs an id listed twice once, and reports ids that match nothing', () => {
    assert.deepEqual(selectCases(cases, { caseId: '1,1,3' }).map((c) => c.id), ['1', '3']);
    assert.deepEqual(unknownCaseIds(cases, '3, 9,9,TC-X'), ['9', 'TC-X']);
    assert.deepEqual(unknownCaseIds(cases, undefined), []);
  });
});

describe('runCases', () => {
  const result = (t: TestCase, outcome: TestResult['outcome']): TestResult => ({
    testCaseId: t.id, title: t.title, outcome, runState: outcome === 'passed' ? 'completed' : 'failed', startedAt: '', finishedAt: '', durationMs: 0, steps: [], artifacts: [],
    ...(outcome === 'failed' ? { failureCategory: 'assertion' as const, errorMessage: 'x' } : {}),
  });

  it('stops between cases when interrupted and keeps the finished results', async () => {
    const ctl = new AbortController();
    const lines: string[] = [];
    const orchestrator = { async runTestCase(t: TestCase) { ctl.abort(); return result(t, 'failed'); } };
    const out = await runCases(orchestrator, cases, (l) => lines.push(l), ctl.signal);
    assert.equal(out.results.length, 1);
    assert.equal(out.aborted, 'Run interrupted');
    assert.ok(lines.some((l) => l.includes('3 case(s) were not run')));
    assert.ok(lines.some((l) => l.includes('category: assertion')));
    assert.ok(lines.some((l) => l.includes('Why cases did not pass: assertion 1')));
  });

  it('stops at a case that was interrupted and leaves it out of the triage summary', async () => {
    const ctl = new AbortController();
    const lines: string[] = [];
    const seen: Array<AbortSignal | undefined> = [];
    const orchestrator = {
      async runTestCase(t: TestCase, signal?: AbortSignal) {
        seen.push(signal);
        if (t.id === '1') return result(t, 'passed');
        ctl.abort();
        return { ...result(t, 'blocked'), failureCategory: 'infrastructure' as const, interrupted: true };
      },
    };
    const out = await runCases(orchestrator, cases, (l) => lines.push(l), ctl.signal);
    assert.deepEqual(out.results.map((r) => [r.testCaseId, r.interrupted]), [['1', undefined], ['2', true]]);
    assert.equal(out.aborted, 'Run interrupted');
    assert.equal(seen[0], ctl.signal);
    assert.ok(lines.some((l) => l.includes('2 further case(s) were not run')));
    assert.ok(!lines.some((l) => l.includes('Why cases did not pass')));
  });

  it('runs everything when not interrupted', async () => {
    const out = await runCases({ async runTestCase(t: TestCase) { return result(t, 'passed'); } }, cases, () => {});
    assert.equal(out.results.length, 4);
    assert.equal(out.aborted, undefined);
  });
});
