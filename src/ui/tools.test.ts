import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TestResult } from '../testing/types.js';
import { cliError, cliJson, MAX_WAIT_SECONDS, nextStep, runProgress, summarizeResults } from './tools.js';

describe('runProgress', () => {
  it('follows each case of a run from its log, with the time left', () => {
    const lines = ['$ d365fo-agent run --local cases', 'Running 3 test case(s).', '', '▶ Running [TC-1] Create vendor', '[agent] → browser_click {}', '  → passed (1 attempt) in 12.0s', '', '▶ Running [TC-2] Post invoice'];
    assert.deepEqual(runProgress(lines), {
      finished: 1,
      total: 3,
      current: 'TC-2 Post invoice',
      remainingSeconds: 24,
      cases: [{ id: 'TC-1', title: 'Create vendor', outcome: 'passed' }, { id: 'TC-2', title: 'Post invoice' }],
    });
    assert.deepEqual(runProgress([]), { finished: 0, cases: [] });
  });
});

describe('nextStep', () => {
  it('asks for another wait while a job runs, and says what to report once it has ended', () => {
    const running = nextStep({ kind: 'run', status: 'running' }, { finished: 1, total: 3, remainingSeconds: 300, cases: [] });
    assert.match(running, /1 of 3 case\(s\) finished, about 5 min left/);
    assert.match(running, new RegExp(`call get_run again with waitSeconds ${MAX_WAIT_SECONDS}`));
    assert.match(nextStep({ kind: 'run', status: 'failed' }, undefined, true), /results are included/);
    assert.match(nextStep({ kind: 'run', status: 'failed' }), /without results.*check_setup/);
    assert.match(nextStep({ kind: 'upload', status: 'passed' }), /Azure DevOps link/);
    assert.match(nextStep(null), /start_run/);
  });
});

describe('summarizeResults', () => {
  it('gives each case that did not pass its triage category and what to do, and counts them', () => {
    const r = (id: string, outcome: TestResult['outcome'], failureCategory?: TestResult['failureCategory']): TestResult =>
      ({ testCaseId: id, title: id, outcome, runState: 'completed', startedAt: '', finishedAt: '', durationMs: 1, steps: [], artifacts: [], ...(failureCategory ? { failureCategory } : {}) }) as TestResult;
    const out = summarizeResults([r('A', 'passed'), r('B', 'blocked', 'sign_in'), r('C', 'failed', 'assertion'), r('D', 'blocked', 'sign_in')]) as any;
    assert.deepEqual(out.triage.map((t: any) => [t.category, t.cases]), [['sign_in', 2], ['assertion', 1]]);
    assert.match(out.triage[0].hint, /sign-in/);
    assert.equal(out.cases[0].category, undefined);
    assert.equal(out.cases[2].category, 'assertion');
    assert.equal((summarizeResults([r('A', 'passed')]) as any).triage, undefined);
  });
});

describe('CLI output for tool replies', () => {
  it('reads the JSON line a command printed and the message of the error it threw', () => {
    assert.deepEqual(cliJson('Drafting…\n{"saved":[]}\n'), { saved: [] });
    assert.equal(cliJson('no json here'), undefined);
    assert.equal(cliJson('{broken'), undefined);
    assert.equal(cliError('Error: Azure DevOps 401 Unauthorized: nope\n    at request (client.js:1:1)'), 'Azure DevOps 401 Unauthorized: nope');
    assert.equal(cliError('config: AZDO_PROJECT is required'), 'AZDO_PROJECT is required');
    assert.equal(cliError(''), 'The command failed without a message.');
  });
});
