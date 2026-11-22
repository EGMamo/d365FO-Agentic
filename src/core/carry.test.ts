import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TestCase, TestResult } from '../testing/types.js';
import { applyCarriedValues, carryKey, rememberValues, type CarriedValues } from './carry.js';
import { runCases } from './runner.js';

const result = (id: string, outcome: TestResult['outcome'], data: Record<string, string>, over: Partial<TestResult> = {}): TestResult => ({
  testCaseId: id, title: `Case ${id}`, outcome, runState: 'completed', startedAt: '', finishedAt: '', durationMs: 0, steps: [], artifacts: [], data, ...over,
});

const later = (unresolved: string[], extra: Partial<TestCase> = {}): TestCase => ({
  id: '39', source: 'devops', title: 'Approved demand becomes an order',
  steps: [
    { index: 1, action: 'Open requisition @PurchaseRequisitionNumber for vendor @VendorAccount', expected: '@PurchaseRequisitionNumber is approved' },
    { index: 2, action: 'Approver @Approver signs' },
  ],
  parameters: { row: 1, rows: 1, filled: ['Currency'], unresolved },
  ...extra,
});

describe('values carried over from earlier cases of a run', () => {
  it('treats case, spaces, underscores and a leading @ as the same name', () => {
    assert.equal(carryKey('@Purchase_Requisition Number'), carryKey('purchaserequisitionnumber'));
    assert.notEqual(carryKey('VendorAccount'), carryKey('VendorAccountName'));
  });

  it('remembers values only from a case that passed, and not from an interrupted one', () => {
    const c: CarriedValues = new Map();
    rememberValues(c, result('1', 'failed', { PurchaseRequisitionNumber: 'PR-1' }));
    rememberValues(c, result('2', 'blocked', { PurchaseRequisitionNumber: 'PR-2' }));
    rememberValues(c, result('3', 'passed', { PurchaseRequisitionNumber: 'PR-3' }, { interrupted: true }));
    assert.equal(c.size, 0);
    rememberValues(c, result('4', 'passed', { '@VendorAccount': 'US-101', 'purchase requisition number': 'PR-4', empty: '' }));
    assert.deepEqual([...c.values()].map((v) => [v.name, v.value, v.from]), [['VendorAccount', 'US-101', '4'], ['purchase requisition number', 'PR-4', '4']]);
    rememberValues(c, result('5', 'passed', { PurchaseRequisitionNumber: 'PR-5' }));
    assert.equal(c.get(carryKey('PurchaseRequisitionNumber'))?.value, 'PR-5', 'the latest passing case wins');
  });

  it('fills only the parameters the case still has no value for, in the steps and their expected results', () => {
    const c: CarriedValues = new Map();
    rememberValues(c, result('38', 'passed', { PurchaseRequisitionNumber: 'PR-7', Currency: 'EUR', Unrelated: 'x' }));
    const { tc, used } = applyCarriedValues(later(['PurchaseRequisitionNumber', 'VendorAccount', 'Approver']), c);
    assert.deepEqual(used, [{ name: 'PurchaseRequisitionNumber', from: '38' }]);
    assert.equal(tc.steps[0].action, 'Open requisition PR-7 for vendor @VendorAccount');
    assert.equal(tc.steps[0].expected, 'PR-7 is approved');
    assert.deepEqual(tc.parameters, {
      row: 1, rows: 1, filled: ['Currency', 'PurchaseRequisitionNumber'], unresolved: ['VendorAccount', 'Approver'],
      carried: [{ name: 'PurchaseRequisitionNumber', from: '38' }],
    });
  });

  it('never replaces a value the test case has: Currency is filled, so an earlier Currency is not used', () => {
    const c: CarriedValues = new Map();
    rememberValues(c, result('38', 'passed', { Currency: 'EUR' }));
    const tcase = later(['VendorAccount']);
    const out = applyCarriedValues({ ...tcase, steps: [{ index: 1, action: 'Pay in USD with @VendorAccount' }] }, c);
    assert.deepEqual(out.used, []);
    assert.equal(out.tc.steps[0].action, 'Pay in USD with @VendorAccount', 'the case keeps its own text; an earlier Currency does not replace it');
    assert.deepEqual(out.tc.parameters?.filled, ['Currency']);
  });

  it('returns the very same case when nothing applies', () => {
    const tcase = later(['VendorAccount']);
    assert.equal(applyCarriedValues(tcase, new Map()).tc, tcase);
    const noParams: TestCase = { id: 'x', source: 'local', title: 't', steps: [{ index: 1, action: 'Open' }] };
    assert.equal(applyCarriedValues(noParams, new Map([['a', { name: 'a', value: '1', from: '1' }]])).tc, noParams);
  });
});

describe('a run of several cases', () => {
  const orchestrator = (outcomes: Record<string, { outcome: TestResult['outcome']; data?: Record<string, string> }>) => {
    const seen: TestCase[] = [];
    return {
      seen,
      runTestCase: async (tc: TestCase): Promise<TestResult> => {
        seen.push(tc);
        const o = outcomes[tc.id] ?? { outcome: 'passed' as const };
        return result(tc.id, o.outcome, o.data ?? {});
      },
    };
  };
  const first: TestCase = { id: '38', source: 'devops', title: 'Create requisition', steps: [{ index: 1, action: 'Create it' }] };

  it('hands a passed case\'s values to the next case by parameter name, and says so', async () => {
    const o = orchestrator({ '38': { outcome: 'passed', data: { PurchaseRequisitionNumber: 'PR-7' } } });
    const lines: string[] = [];
    await runCases(o, [first, later(['PurchaseRequisitionNumber', 'VendorAccount'])], (l) => lines.push(l));
    assert.equal(o.seen[1].steps[0].action, 'Open requisition PR-7 for vendor @VendorAccount');
    assert.deepEqual(o.seen[1].parameters?.unresolved, ['VendorAccount']);
    assert.ok(lines.some((l) => l === '  ↳ values from earlier cases of this run: @PurchaseRequisitionNumber (case 38)'));
  });

  it('hands nothing on from a case that did not pass, so the later case keeps its parameter unset', async () => {
    const o = orchestrator({ '38': { outcome: 'failed', data: { PurchaseRequisitionNumber: 'PR-7' } } });
    await runCases(o, [first, later(['PurchaseRequisitionNumber'])], () => undefined);
    assert.match(o.seen[1].steps[0].action, /@PurchaseRequisitionNumber/);
    assert.deepEqual(o.seen[1].parameters?.carried, undefined);
  });

  it('hands nothing on to a case run alone, or to a case that comes before the one that creates the value', async () => {
    const alone = orchestrator({});
    await runCases(alone, [later(['PurchaseRequisitionNumber'])], () => undefined);
    assert.match(alone.seen[0].steps[0].action, /@PurchaseRequisitionNumber/);
    const wrongOrder = orchestrator({ '38': { outcome: 'passed', data: { PurchaseRequisitionNumber: 'PR-7' } } });
    await runCases(wrongOrder, [later(['PurchaseRequisitionNumber']), first], () => undefined);
    assert.match(wrongOrder.seen[0].steps[0].action, /@PurchaseRequisitionNumber/);
  });

  it('keeps nothing between two runs', async () => {
    const o = orchestrator({ '38': { outcome: 'passed', data: { PurchaseRequisitionNumber: 'PR-7' } } });
    await runCases(o, [first], () => undefined);
    await runCases(o, [later(['PurchaseRequisitionNumber'])], () => undefined);
    assert.match(o.seen[1].steps[0].action, /@PurchaseRequisitionNumber/);
  });
});
