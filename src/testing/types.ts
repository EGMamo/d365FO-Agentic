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

export interface StepResult {
  index: number;
  status: StepStatus;
  observed?: string;
  errorMessage?: string;
  screenshotPath?: string;
  durationMs: number;
}

export interface TestResult {
  testCaseId: string;
  title: string;
  outcome: StepStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  steps: StepResult[];
  artifacts: string[]; // absolute paths to screenshots / traces / logs
  errorMessage?: string;
  learnings?: string[];
}
