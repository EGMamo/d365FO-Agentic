import type { StepResult, TestResult } from './types.js';

/**
 * Why a test did not pass, in terms a person can act on. Derived from the step causes the agent reported and
 * the stop messages of the run guard, so a run summary can say "3 environment problems, 1 real defect"
 * instead of a flat list of failures.
 */
export type FailureCategory =
  /** The application did not behave as the test case expects: the likely real defect. */
  | 'assertion'
  /** Sign-in needed MFA or was refused. */
  | 'sign_in'
  /** A page, menu item or record named in the test case does not exist here, or the user lacks access. */
  | 'not_found'
  /** Tool calls were refused by the guardrails. */
  | 'guardrail'
  /** The test or a tool call ran out of time. */
  | 'timeout'
  /** The token or model-turn budget was spent. */
  | 'budget'
  /** A step with an expected result was reported passed without checking it. */
  | 'unverified'
  /** The model stopped making progress (loops, repeated errors, no verdict). */
  | 'agent'
  /** The model provider or tooling was unavailable. */
  | 'infrastructure'
  /** Blocked for a reason the agent reported but that matches none of the above (missing data, preconditions). */
  | 'blocked';

export const FAILURE_CATEGORY_HINTS: Record<FailureCategory, string> = {
  assertion: 'Possible product defect: check the observed vs expected values.',
  sign_in: 'Fix the test account sign-in (MFA, password, or D365_STORAGE_STATE).',
  not_found: 'Update the test case or environment: a page, menu item, record or permission is missing.',
  guardrail: 'The run was refused by policy: check the allowed hosts, tools and legal entity.',
  timeout: 'The environment was slow or the case is long: raise the time limits or split the case.',
  budget: 'The token or turn budget was spent: split the case, or raise AGENT_MAX_TOKENS_PER_TEST / AGENT_MAX_STEPS.',
  unverified: 'Expected results were not checked against the page: make them observable or rerun.',
  agent: 'The agent got stuck: rerun, or add a clearer step or a learning for this form.',
  infrastructure: 'The model provider or tooling was unavailable: rerun when it is back.',
  blocked: 'Blocked by data or preconditions: prepare the data the case needs and rerun.',
};

/**
 * Failures the knowledge-base hints may have caused: a wrong route, a slow or looping approach, a check that was
 * skipped. The others (a product defect, sign-in, budget, guardrails, tooling, missing data) say nothing about
 * the hints, so they must not count against them.
 */
export const HINT_RELATED_FAILURES: ReadonlySet<FailureCategory> = new Set(['not_found', 'timeout', 'agent', 'unverified']);

/**
 * Whether a result that did not pass should count against the hints it was given. A `not_found` that is really
 * a missing permission (`no_access` on every step that stopped the case) is the environment's doing, not theirs.
 */
export function hintsMayBeAtFault(category: FailureCategory | undefined, steps: Array<Pick<StepResult, 'status' | 'cause'>>): boolean {
  if (!category || !HINT_RELATED_FAILURES.has(category)) return false;
  if (category !== 'not_found') return true;
  const causes = steps.filter((s) => s.status === 'failed' || s.status === 'blocked').map((s) => s.cause);
  return !(causes.includes('no_access') && !causes.includes('not_found'));
}

type Classifiable = Pick<TestResult, 'outcome' | 'errorMessage' | 'policyBlocks' | 'timeouts'> & { steps: Array<Pick<StepResult, 'status' | 'cause'>> };

/** Returns why a test did not pass, or undefined for passed and skipped tests. */
export function classifyFailure(result: Classifiable): FailureCategory | undefined {
  if (result.outcome === 'passed' || result.outcome === 'skipped') return undefined;
  const msg = (result.errorMessage ?? '').toLowerCase();
  const causes = new Set(result.steps.filter((s) => s.status === 'failed' || s.status === 'blocked').map((s) => s.cause));

  if (msg.startsWith('run aborted') || msg.startsWith('run interrupted') || msg.includes('transient orchestration failure') || msg.includes('provider is unavailable')) return 'infrastructure';
  // Only the model ends a case `failed` (every stop the run imposes is `blocked`), and its wording is free text
  // that may quote the page. So a failed case is judged by the step causes alone, never by matching its message.
  if (result.outcome === 'failed') {
    if (causes.has('sign_in')) return 'sign_in';
    if (causes.has('not_found') || causes.has('no_access')) return 'not_found';
    return 'assertion';
  }
  if (causes.has('sign_in') || /\bsign-in\b|multi-factor|\bmfa\b/.test(msg)) return 'sign_in';
  if (msg.includes('refused by the guardrails') || msg.includes('blocked by policy')) return 'guardrail';
  if (causes.has('not_found') || causes.has('no_access') || msg.includes('could not be found or opened')) return 'not_found';
  if (causes.has('missing_data')) return 'blocked';
  if (msg.includes('agent_max_tokens_per_test') || msg.includes('(agent_max_steps)')) return 'budget';
  if (msg.includes('agent_test_timeout_ms') || msg.includes('timed out')) return 'timeout';
  if (msg.startsWith('not counted as passed')) return 'unverified';
  if (msg.startsWith('agent stopped') || msg.includes('without a reason') || msg.includes('no tool calls and no final verdict')) return 'agent';
  if ((result.policyBlocks?.length ?? 0) > 0) return 'guardrail';
  if ((result.timeouts?.length ?? 0) > 0) return 'timeout';
  return 'blocked';
}

/** Counts results per failure category, largest first. */
export function summarizeFailures(results: TestResult[]): Array<[FailureCategory, number]> {
  const counts = new Map<FailureCategory, number>();
  for (const r of results) {
    // Results saved before triage existed have no category; classify them from what they recorded.
    const c = r.failureCategory ?? classifyFailure(r);
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}
