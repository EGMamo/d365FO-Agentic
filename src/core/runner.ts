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
import { FAILURE_CATEGORY_HINTS, summarizeFailures } from '../testing/triage.js';

export interface RunExecutionOptions {
  plan?: string;
  suite?: string;
  local?: string;
  /** One id, or several separated by commas. */
  caseId?: string;
  /** Only cases with at least one of these tags (case-insensitive). */
  tags?: string[];
  /** Only cases whose module or area contains one of these (case-insensitive). */
  modules?: string[];
  /** Only cases with this priority or a more urgent one (1 = highest). Cases without a priority are kept. */
  maxPriority?: number;
  /** Run the most urgent cases first instead of in discovered order. Ignored when `caseId` lists the order. */
  sortByPriority?: boolean;
  /** Stops the run (Ctrl+C): the case in flight is marked interrupted, the rest are not run, reports are still written. */
  signal?: AbortSignal;
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
  /** Set when `signal` stopped the run before every case had finished. */
  interrupted?: boolean;
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
  const filtered = selectCases(cases, opts);
  const unknown = unknownCaseIds(cases, opts.caseId);
  if (unknown.length) console.warn(`warning: no test case with id ${unknown.join(', ')} was found; check --case.`);
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
    ({ results, aborted } = await runCases(orchestrator, filtered, console.log, opts.signal));
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

  return { cases: filtered, results, reportPaths, upload, aborted, interrupted: (opts.signal?.aborted && (results.length < filtered.length || results.some((r) => r.interrupted))) || undefined };
}

/**
 * Applies the run filters (ids, tags, modules, priority). Cases keep their discovered order, because a suite may
 * depend on it; with `sortByPriority` the most urgent run first, keeping the original order among equal priorities.
 */
export function selectCases(cases: TestCase[], opts: Pick<RunExecutionOptions, 'caseId' | 'tags' | 'modules' | 'maxPriority' | 'sortByPriority'>): TestCase[] {
  const ids = [...new Set(splitList(opts.caseId))];
  const tags = (opts.tags ?? []).flatMap((t) => splitList(t)).map((t) => t.toLowerCase());
  const modules = (opts.modules ?? []).flatMap((m) => splitList(m)).map((m) => m.toLowerCase());
  const selected = cases.filter((c) => {
    if (ids.length && !ids.includes(c.id)) return false;
    if (tags.length && !(c.tags ?? []).some((t) => tags.includes(t.toLowerCase()))) return false;
    if (modules.length) {
      const where = `${c.module ?? ''} ${c.area ?? ''}`.toLowerCase();
      if (!modules.some((m) => where.includes(m))) return false;
    }
    if (opts.maxPriority !== undefined && c.priority !== undefined && c.priority > opts.maxPriority) return false;
    return true;
  });
  if (ids.length) return ids.flatMap((id) => selected.filter((c) => c.id === id));
  if (!opts.sortByPriority) return selected;
  return selected
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (a.c.priority ?? 99) - (b.c.priority ?? 99) || a.i - b.i)
    .map((x) => x.c);
}

/** Ids asked for with `caseId` that no discovered case has. */
export function unknownCaseIds(cases: TestCase[], caseId: string | undefined): string[] {
  const known = new Set(cases.map((c) => c.id));
  return [...new Set(splitList(caseId))].filter((id) => !known.has(id));
}

function splitList(s: string | undefined): string[] {
  return (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
}

/**
 * Runs the cases one after another. If the LLM provider becomes unavailable (rate limit, auth, outage) the run
 * stops there: continuing would only record a bogus `blocked` verdict for every remaining case.
 */
export async function runCases(
  orchestrator: Pick<AgentOrchestrator, 'runTestCase'>,
  cases: TestCase[],
  log: (line: string) => void = console.log,
  signal?: AbortSignal,
): Promise<{ results: TestResult[]; aborted?: string }> {
  const results: TestResult[] = [];
  for (const [i, tc] of cases.entries()) {
    if (signal?.aborted) {
      const reason = 'Run interrupted';
      log(`\n${reason}: ${cases.length - i} case(s) were not run.`);
      logTriage(results, log);
      return { results, aborted: reason };
    }
    log(`\n▶ Running [${tc.id}] ${tc.title}`);
    try {
      const result = await orchestrator.runTestCase(tc, signal);
      results.push(result);
      if (result.interrupted) {
        const reason = 'Run interrupted';
        log(`  → interrupted before it finished; recorded as not a test result`);
        log(`\n${reason}: ${cases.length - i - 1} further case(s) were not run.`);
        logTriage(results.filter((r) => !r.interrupted), log);
        return { results, aborted: reason };
      }
      const attempts = result.attemptCount ?? 1;
      log(`  → ${result.outcome} (${attempts} attempt${attempts > 1 ? 's' : ''}) in ${(result.durationMs / 1000).toFixed(1)}s`);
      if (result.outcome !== 'passed' && result.outcome !== 'skipped' && result.errorMessage) {
        log(`    reason: ${result.errorMessage.replace(/\s+/g, ' ').slice(0, 300)}`);
      }
      if (result.failureCategory) log(`    category: ${result.failureCategory} — ${FAILURE_CATEGORY_HINTS[result.failureCategory]}`);
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
        failureCategory: 'infrastructure',
      });
      const notRun = cases.length - i - 1;
      log(`  ✖ ${e.message}`);
      log(`\nRun aborted: ${notRun} further case(s) were not run.`);
      return { results, aborted: e.message };
    }
  }
  logTriage(results, log);
  return { results };
}

function logTriage(results: TestResult[], log: (line: string) => void): void {
  const counts = summarizeFailures(results);
  if (!counts.length) return;
  log(`\nWhy cases did not pass: ${counts.map(([c, n]) => `${c} ${n}`).join(', ')}`);
}
