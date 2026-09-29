import { resolve } from 'node:path';
import type { AppConfig } from '../config/index.js';
import { createLlmProvider } from '../llm/index.js';
import { ensurePlaywrightBrowser } from '../mcp/playwright-browser.js';
import { buildDefaultManager } from '../mcp/registry.js';
import { KnowledgeBase } from '../knowledge/kb.js';
import { AgentOrchestrator } from '../agent/orchestrator.js';
import { loadLocalTestCases } from '../testing/loader.js';
import { writeReports } from '../reporting/reporters.js';
import type { StepStatus, TestCase, TestResult } from '../testing/types.js';
import { AzureDevOpsClient } from '../devops/client.js';

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
  const mcp = buildDefaultManager(cfg);
  const kb = new KnowledgeBase(cfg.KB_DIR);
  await kb.load();

  const orchestrator = new AgentOrchestrator({
    cfg,
    llm,
    mcp,
    kb,
    mcpServers: ['playwright', 'learn'],
  });

  const results: TestResult[] = [];
  try {
    for (const tc of filtered) {
      console.log(`\n▶ Running [${tc.id}] ${tc.title}`);
      const result = await orchestrator.runTestCase(tc);
      results.push(result);
      console.log(
        `  → ${result.outcome} (${result.attemptCount ?? 1} attempt${(result.attemptCount ?? 1) > 1 ? 's' : ''}) in ${(
          result.durationMs / 1000
        ).toFixed(1)}s`,
      );
    }
  } finally {
    await mcp.closeAll();
    await kb.save();
  }

  const reportPaths = await writeReports(cfg.REPORT_DIR, results);

  let upload: { runId: number; url: string } | undefined;
  if (opts.upload) {
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

  return { cases: filtered, results, reportPaths, upload };
}
