import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyFailure, FAILURE_CATEGORY_HINTS, hintsMayBeAtFault, summarizeFailures } from './triage.js';
import { AttemptGuard } from '../agent/run-guard.js';
import { INTERRUPTED_MESSAGE } from '../agent/orchestrator.js';
import type { TestResult } from './types.js';

const base: TestResult = { testCaseId: '1', title: 't', outcome: 'failed', runState: 'failed', startedAt: '', finishedAt: '', durationMs: 0, steps: [], artifacts: [] };
const r = (over: Partial<TestResult>): TestResult => ({ ...base, ...over });

describe('classifyFailure', () => {
  it('ignores passed and skipped cases', () => {
    assert.equal(classifyFailure(r({ outcome: 'passed' })), undefined);
    assert.equal(classifyFailure(r({ outcome: 'skipped' })), undefined);
  });

  it('recognises the run messages', () => {
    const cases: Array<[Partial<TestResult>, string]> = [
      [{ outcome: 'blocked', errorMessage: 'Run aborted, not a test result: rate limited' }, 'infrastructure'],
      [{ outcome: 'blocked', errorMessage: 'Transient orchestration failure: socket hang up' }, 'infrastructure'],
      [{ outcome: 'blocked', errorMessage: 'Agent stopped: sign-in asked for multi-factor authentication' }, 'sign_in'],
      [{ outcome: 'blocked', errorMessage: 'Agent stopped: 3 tool calls were refused by the guardrails' }, 'guardrail'],
      [{ outcome: 'blocked', errorMessage: 'Agent stopped: pages could not be found or opened' }, 'not_found'],
      [{ outcome: 'blocked', errorMessage: 'Agent stopped: token budget exceeded (AGENT_MAX_TOKENS_PER_TEST)' }, 'budget'],
      [{ outcome: 'blocked', errorMessage: 'Agent stopped: the test used all 40 model turns (AGENT_MAX_STEPS) before it finished' }, 'budget'],
      [{ outcome: 'blocked', errorMessage: 'Agent stopped: time limit reached (AGENT_TEST_TIMEOUT_MS)' }, 'timeout'],
      [{ outcome: 'blocked', errorMessage: 'Not counted as passed: step 2 was not verified' }, 'unverified'],
      [{ outcome: 'blocked', errorMessage: 'Agent stopped: the same call was repeated with identical arguments' }, 'agent'],
      [{ outcome: 'failed', errorMessage: 'Total was 10' }, 'assertion'],
      [{ outcome: 'blocked', policyBlocks: ['delete'] }, 'guardrail'],
      [{ outcome: 'blocked', timeouts: ['browser_click'] }, 'timeout'],
      [{ outcome: 'blocked' }, 'blocked'],
    ];
    for (const [over, want] of cases) assert.equal(classifyFailure(r(over)), want, JSON.stringify(over));
  });

  it('uses the step cause the agent reported', () => {
    assert.equal(classifyFailure(r({ outcome: 'blocked', steps: [{ index: 1, durationMs: 0, status: 'blocked', cause: 'no_access' }] })), 'not_found');
    assert.equal(classifyFailure(r({ outcome: 'blocked', steps: [{ index: 1, durationMs: 0, status: 'blocked', cause: 'sign_in' }] })), 'sign_in');
    assert.equal(classifyFailure(r({ outcome: 'blocked', steps: [{ index: 1, durationMs: 0, status: 'blocked', cause: 'missing_data' }] })), 'blocked');
  });

  it('classifies the messages the run guard really produces', () => {
    let clock = 0;
    const guard = () => new AttemptGuard({ AGENT_TEST_TIMEOUT_MS: 1000, AGENT_MAX_TOKENS_PER_TEST: 10, AGENT_MAX_CONSECUTIVE_ERRORS: 2, AGENT_MAX_UNREACHABLE_TARGETS: 1 } as never, () => clock);
    const blocked = (errorMessage: string | undefined) => classifyFailure(r({ outcome: 'blocked', errorMessage }));

    const slow = guard();
    clock = 5000;
    assert.equal(blocked(slow.checkBudgets()?.message), 'timeout');
    const greedy = guard();
    greedy.recordUsage({ inputTokens: 20 });
    assert.equal(blocked(greedy.checkBudgets()?.message), 'budget');
    const stuck = guard();
    stuck.recordToolResult(true);
    assert.equal(blocked(stuck.recordToolResult(true)?.message), 'agent');
    assert.equal(blocked(guard().recordUnreachable('https://fo.example/?mi=Nope', '404')?.message), 'not_found');
    assert.equal(blocked(guard().authStop({ kind: 'mfa', evidence: 'Approve sign in request' })?.message), 'sign_in');
    assert.equal(blocked(guard().authStop({ kind: 'credentials', evidence: 'Your account or password is incorrect' })?.message), 'sign_in');
    assert.equal(blocked(INTERRUPTED_MESSAGE), 'infrastructure');
  });

  it('judges a failed case by its step causes, not by words the model wrote', () => {
    for (const errorMessage of ['The request timed out message bar was shown instead of the total', 'Expected the MFA setup page title', 'Sign-in button label was wrong']) {
      assert.equal(classifyFailure(r({ outcome: 'failed', errorMessage })), 'assertion', errorMessage);
    }
    assert.equal(classifyFailure(r({ outcome: 'failed', steps: [{ index: 1, durationMs: 0, status: 'failed', cause: 'not_found' }] })), 'not_found');
  });

  it('blames the hints only for failures they could have caused', () => {
    const step = (cause: 'not_found' | 'no_access') => ({ status: 'blocked' as const, cause });
    assert.equal(hintsMayBeAtFault('not_found', [step('not_found')]), true);
    assert.equal(hintsMayBeAtFault('not_found', []), true);
    assert.equal(hintsMayBeAtFault('not_found', [step('no_access')]), false);
    assert.equal(hintsMayBeAtFault('not_found', [step('no_access'), step('not_found')]), true);
    assert.equal(hintsMayBeAtFault('timeout', []), true);
    for (const c of ['assertion', 'sign_in', 'budget', 'guardrail', 'infrastructure', 'blocked', undefined] as const) assert.equal(hintsMayBeAtFault(c, []), false, String(c));
  });

  it('summarises counts most common first, each with a hint', () => {
    const s = summarizeFailures([r({}), r({}), r({ outcome: 'blocked' }), r({ outcome: 'passed' })]);
    assert.deepEqual(s, [['assertion', 2], ['blocked', 1]]);
    for (const [c] of s) assert.ok(FAILURE_CATEGORY_HINTS[c].length > 10);
  });
});
