import type { FailureCategory } from './triage.js';

/**
 * Shared test-case model used across DevOps ingestion, local test files, and
 * the agent's planning loop. Kept minimal on purpose — an MVP.
 */
export interface TestStep {
  index: number;
  action: string;
  expected?: string;
  /** Azure DevOps step id and action path, retained for nested shared steps and iteration publishing. */
  adoId?: number;
  actionPath?: string;
  sharedStepId?: number;
}

export interface TestCase {
  id: string; // stable id (DevOps workItemId or file name)
  source: 'devops' | 'local';
  title: string;
  area?: string;
  module?: string; // F&O module hint, e.g. "Accounts payable"
  priority?: number;
  tags?: string[];
  preconditions?: string;
  steps: TestStep[];
  legalEntity?: string;
  rev?: number;
  url?: string;
  /** The unexpanded/unsubstituted steps and every local/shared parameter source, used to select another data row. */
  sourceSteps?: TestStep[];
  parameterData?: Array<{ names: string[]; rows: Array<Record<string, string>> }>;
  /** Dependencies that could not be loaded completely. Such a case must be blocked before browser execution. */
  problems?: string[];
  /** Azure DevOps parameter values already filled into the steps (the selected data row), and the `@Name`s that have no value. */
  parameters?: {
    row: number;
    rows: number;
    filled: string[];
    unresolved: string[];
    /** Values filled in from earlier cases of the same run (by parameter name), and the case each came from. */
    carried?: Array<{ name: string; from: string }>;
  };
}

export type StepStatus = 'passed' | 'failed' | 'skipped' | 'blocked';
export type RunState = 'pending' | 'running' | 'retrying' | 'completed' | 'failed' | 'blocked';

export type StepCause = 'not_found' | 'no_access' | 'sign_in' | 'missing_data' | 'other';

export interface StepResult {
  index: number;
  status: StepStatus;
  observed?: string;
  /** For a passed step with an expected result: true when the agent checked it against the page. */
  verified?: boolean;
  /** Why a failed or blocked step could not be done, as reported by the agent. */
  cause?: StepCause;
  errorMessage?: string;
  screenshotPath?: string;
  /** Azure DevOps action path of this step (nested shared steps included). */
  actionPath?: string;
  durationMs: number;
}

export interface CaseUsage {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Time spent waiting for the model, the rest of durationMs is mostly the browser. */
  modelMs: number;
}

export interface TestResult {
  testCaseId: string;
  title: string;
  /** 1-based parameter row and total row count. The case id itself stays stable across iterations. */
  iteration?: { row: number; count: number };
  outcome: StepStatus;
  runState: RunState;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  steps: StepResult[];
  artifacts: string[]; // absolute paths to screenshots / traces / logs / generated replay files
  specFile?: string;
  dataFile?: string;
  errorMessage?: string;
  /** Why the test did not pass (see `classifyFailure`). Absent for passed and skipped tests. */
  failureCategory?: FailureCategory;
  learnings?: string[];
  /** Tool calls the guardrails refused (disallowed tool, off-limits URL, wrong legal entity). */
  policyBlocks?: string[];
  /** Tool calls that exceeded their time budget (AGENT_TOOL_TIMEOUT_MS / AGENT_NAV_TIMEOUT_MS). */
  timeouts?: string[];
  /** Values the agent saved with `record_value` (created ids, generated numbers). Never secrets. */
  data?: Record<string, string>;
  /**
   * Values the agent chose for parameters the test case leaves unset, to suggest saving to the test case's parameter
   * values. `odata`: the value appeared in what F&O returned to a query; `agent`: it did not (chosen another way).
   */
  suggestedParameters?: Array<{ name: string; value: string; source: 'odata' | 'agent'; how?: string }>;
  /**
   * The case was first replayed from the recorded Playwright code of its last passing run, without the AI.
   * `passed`: that replay is the result. `failed`: the AI then ran the case (step and error say where the replay stopped).
   */
  replay?: { outcome: 'passed' | 'failed'; step?: number; error?: string };
  /** Model turns and tokens the case used, to see what a case costs and whether prompt caching works. */
  usage?: CaseUsage;
  /** True when Ctrl+C stopped the run during this case: not a verdict, never learned from or uploaded. */
  interrupted?: boolean;
  attemptCount?: number;
  firstOutcome?: StepStatus;
  previousOutcome?: StepStatus;
  retryHistory?: Array<{
    attempt: number;
    outcome: StepStatus;
    runState: RunState;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    retryReason?: string;
    errorMessage?: string;
  }>;
}
