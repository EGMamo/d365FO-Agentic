import { resolve } from 'node:path';
import type { AppConfig } from '../config/index.js';
import { createLlmProvider } from '../llm/index.js';
import { ensurePlaywrightBrowser } from '../mcp/playwright-browser.js';
import { activeSessionFile } from '../d365fo/session.js';
import { assertSafeEnvironment } from '../d365fo/environment.js';
import { buildDefaultManager } from '../mcp/registry.js';
import { KnowledgeBase } from '../knowledge/kb.js';
import { AgentOrchestrator } from '../agent/orchestrator.js';
import { loadLocalTestCases } from '../testing/loader.js';
import { writeReports } from '../reporting/reporters.js';
import type { StepStatus, TestCase, TestResult } from '../testing/types.js';
import { AzureDevOpsClient } from '../devops/client.js';
import { LlmUnavailableError } from '../llm/errors.js';

export interface RunExecutionOptions {
  plan?: string;
  suite?: string;
  local?: string;
  caseId?: string;
  dryRun?: boolean;
  upload?: boolean;
  reloopMaxRetries?: number;
  reloopRetryOn?: StepStatus[];
  reloopCooldownMs?: number;
}

export interface RunExecutionResult {
  cases: TestCase[];
  results: TestResult[];
  reportPaths: { html: string; json: string; junit: string };
  upload?: { runId: number; url: string };
  /** Set when the run stopped early because the LLM provider was unavailable; remaining cases were not run. */
  aborted?: string;
}

export async function discoverTestCases(cfg: AppConfig, opts: Pick<RunExecutionOptions, 'plan' | 'suite' | 'local'>): Promise<TestCase[]> {
  if (opts.local) {
    return loadLocalTestCases(resolve(opts.local));
  }
  const planId = opts.plan ?? cfg.AZDO_TEST_PLAN_ID;
  const suiteId = opts.suite ?? cfg.AZDO_TEST_SUITE_ID;
  if (!planId || !suiteId) {
    throw new Error('Either --local, or --plan+--suite (or AZDO_TEST_PLAN_ID+AZDO_TEST_SUITE_ID) must be provided');
  }
  const client = new AzureDevOpsClient(cfg);
  return client.listTestCases(planId, suiteId);
}

export async function executeTestRun(cfg: AppConfig, opts: RunExecutionOptions): Promise<RunExecutionResult> {
  if (opts.dryRun) cfg.AGENT_DRY_RUN = true;
  if (opts.reloopMaxRetries !== undefined) cfg.AGENT_RELOOP_MAX_RETRIES = Math.max(0, opts.reloopMaxRetries);
  if (opts.reloopRetryOn !== undefined) cfg.AGENT_RELOOP_RETRY_ON = opts.reloopRetryOn;
  if (opts.reloopCooldownMs !== undefined) cfg.AGENT_RELOOP_COOLDOWN_MS = Math.max(0, opts.reloopCooldownMs);

  assertSafeEnvironment(cfg);

  const cases = await discoverTestCases(cfg, opts);
  const filtered = opts.caseId ? cases.filter((c) => c.id === opts.caseId) : cases;
  if (filtered.length === 0) {
    return {
      cases: filtered,
      results: [],
      reportPaths: await writeReports(cfg.REPORT_DIR, []),
    };
  }

  const llm = createLlmProvider(cfg);
  // After the LLM check so missing credentials fail before a large download.
  await ensurePlaywrightBrowser(cfg);
  const mcp = buildDefaultManager(cfg, activeSessionFile(cfg));
  const kb = new KnowledgeBase(cfg.KB_DIR);
  await kb.load();

  const orchestrator = new AgentOrchestrator({
    cfg,
    llm,
    mcp,
    kb,
    mcpServers: ['playwright', 'learn', ...(cfg.RELEASE_PLANNER_MCP_URL ? ['release-planner'] : [])],
  });

  let results: TestResult[] = [];
  let aborted: string | undefined;
  try {
    ({ results, aborted } = await runCases(orchestrator, filtered));
  } finally {
    await mcp.closeAll();
    await kb.save();
  }

  const reportPaths = await writeReports(cfg.REPORT_DIR, results);

  let upload: { runId: number; url: string } | undefined;
  // An outage is not a test result, so an aborted run is never published.
  if (opts.upload && !aborted) {
    if (!cfg.AZDO_ORG_URL || !cfg.AZDO_PROJECT || !cfg.AZDO_PAT) {
      throw new Error('--upload requires AZDO_ORG_URL, AZDO_PROJECT, and AZDO_PAT');
    }
    const planId = opts.plan ?? cfg.AZDO_TEST_PLAN_ID;
    if (!planId) {
      throw new Error('--plan or AZDO_TEST_PLAN_ID is required to upload');
    }
    const client = new AzureDevOpsClient(cfg);
    upload = await client.publishResults(planId, results);
  }

  return { cases: filtered, results, reportPaths, upload, aborted };
}

/**
 * Runs the cases one after another. If the LLM provider becomes unavailable (rate limit, auth, outage) the run
 * stops there: continuing would only record a bogus `blocked` verdict for every remaining case.
 */
export async function runCases(
  orchestrator: Pick<AgentOrchestrator, 'runTestCase'>,
  cases: TestCase[],
  log: (line: string) => void = console.log,
): Promise<{ results: TestResult[]; aborted?: string }> {
  const results: TestResult[] = [];
  for (const [i, tc] of cases.entries()) {
    log(`\n▶ Running [${tc.id}] ${tc.title}`);
    try {
      const result = await orchestrator.runTestCase(tc);
      results.push(result);
      const attempts = result.attemptCount ?? 1;
      log(`  → ${result.outcome} (${attempts} attempt${attempts > 1 ? 's' : ''}) in ${(result.durationMs / 1000).toFixed(1)}s`);
      if (result.outcome !== 'passed' && result.outcome !== 'skipped' && result.errorMessage) {
        log(`    reason: ${result.errorMessage.replace(/\s+/g, ' ').slice(0, 300)}`);
      }
    } catch (e) {
      if (!(e instanceof LlmUnavailableError)) throw e;
      const now = new Date().toISOString();
      results.push({
        testCaseId: tc.id,
        title: tc.title,
        outcome: 'blocked',
        runState: 'blocked',
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        steps: [],
        artifacts: [],
        errorMessage: `Run aborted, not a test result: ${e.message}`,
      });
      const notRun = cases.length - i - 1;
      log(`  ✖ ${e.message}`);
      log(`\nRun aborted: ${notRun} further case(s) were not run.`);
      return { results, aborted: e.message };
    }
  }
  return { results };
}
