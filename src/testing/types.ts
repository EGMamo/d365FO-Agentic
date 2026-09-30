/**
 * Shared test-case model used across DevOps ingestion, local test files, and
 * the agent's planning loop. Kept minimal on purpose — an MVP.
 */
export interface TestStep {
  index: number;
  action: string;
  expected?: string;
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
}

export type StepStatus = 'passed' | 'failed' | 'skipped' | 'blocked';
export type RunState = 'pending' | 'running' | 'retrying' | 'completed' | 'failed' | 'blocked';

export interface StepResult {
  index: number;
  status: StepStatus;
  observed?: string;
  /** For a passed step with an expected result: true when the agent checked it against the page. */
  verified?: boolean;
  errorMessage?: string;
  screenshotPath?: string;
  durationMs: number;
}

export interface TestResult {
  testCaseId: string;
  title: string;
  outcome: StepStatus;
  runState: RunState;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  steps: StepResult[];
  artifacts: string[]; // absolute paths to screenshots / traces / logs
  errorMessage?: string;
  learnings?: string[];
  /** Tool calls the guardrails refused (disallowed tool, off-limits URL, wrong legal entity). */
  policyBlocks?: string[];
  /** Tool calls that exceeded their time budget (AGENT_TOOL_TIMEOUT_MS / AGENT_NAV_TIMEOUT_MS). */
  timeouts?: string[];
  /** Values the agent saved with `record_value` (created ids, generated numbers). Never secrets. */
  data?: Record<string, string>;
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
