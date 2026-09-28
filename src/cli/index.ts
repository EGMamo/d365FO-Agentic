#!/usr/bin/env node
import { Command } from 'commander';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadConfig, validateForRun } from '../config/index.js';
import { createLlmProvider } from '../llm/index.js';
import { buildDefaultManager } from '../mcp/registry.js';
import { KnowledgeBase } from '../knowledge/kb.js';
import { AzureDevOpsClient } from '../devops/client.js';
import { AgentOrchestrator } from '../agent/orchestrator.js';
import { loadLocalTestCases } from '../testing/loader.js';
import { writeReports } from '../reporting/reporters.js';
import type { TestCase, TestResult } from '../testing/types.js';

const program = new Command();
program
  .name('d365fo-agent')
  .description('Portable AI agent for D365 F&O regression and unit testing')
  .version('0.1.0');

program
  .command('doctor')
  .description('Validate configuration and MCP server connectivity')
  .action(async () => {
    const cfg = loadConfig();
    const issues = validateForRun(cfg);
    console.log(`LLM provider: ${cfg.LLM_PROVIDER} (${cfg.LLM_MODEL})`);
    console.log(`D365 base URL: ${cfg.D365_BASE_URL ?? '(missing)'}`);
    console.log(`Azure DevOps: ${cfg.AZDO_ORG_URL ?? '(missing)'} / ${cfg.AZDO_PROJECT ?? '(missing)'}`);
    if (issues.length) {
      console.log('\nIssues:');
      for (const i of issues) console.log(`  - ${i}`);
      process.exitCode = 1;
    } else {
      console.log('\nConfiguration looks good.');
    }
  });

program
  .command('discover')
  .description('List test cases from Azure DevOps (or local dir)')
  .option('--plan <id>', 'Azure DevOps test plan id')
  .option('--suite <id>', 'Azure DevOps test suite id')
  .option('--local <dir>', 'Load local test cases from a directory instead')
  .option('--output <file>', 'Write discovered test cases as JSON to this file')
  .action(async (opts: { plan?: string; suite?: string; local?: string; output?: string }) => {
    const cfg = loadConfig();
    const cases = await discover(cfg, opts);
    console.log(`Discovered ${cases.length} test case(s):`);
    for (const c of cases) console.log(`  [${c.id}] ${c.title}`);
    if (opts.output) {
      await writeFile(resolve(opts.output), JSON.stringify(cases, null, 2));
      console.log(`Wrote ${opts.output}`);
    }
  });

program
  .command('run')
  .description('Execute test cases via the AI agent')
  .option('--plan <id>', 'Azure DevOps test plan id')
  .option('--suite <id>', 'Azure DevOps test suite id')
  .option('--local <dir>', 'Load local test cases from a directory instead')
  .option('--case <id>', 'Filter to a single test-case id')
  .option('--dry-run', 'Skip mutating browser actions (planning only)')
  .option('--upload', 'Upload results to Azure DevOps after the run')
  .action(async (opts: {
    plan?: string;
    suite?: string;
    local?: string;
    case?: string;
    dryRun?: boolean;
    upload?: boolean;
  }) => {
    const cfg = loadConfig();
    if (opts.dryRun) cfg.AGENT_DRY_RUN = true;
    const issues = validateForRun(cfg);
    if (issues.length) {
      for (const i of issues) console.error(`config: ${i}`);
      process.exit(1);
    }

    const cases = await discover(cfg, opts);
    const filtered = opts.case ? cases.filter((c) => c.id === opts.case) : cases;
    if (filtered.length === 0) {
      console.log('No test cases matched.');
      return;
    }

    const llm = createLlmProvider(cfg);
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
        console.log(`  → ${result.outcome} in ${(result.durationMs / 1000).toFixed(1)}s`);
      }
    } finally {
      await mcp.closeAll();
      await kb.save();
    }

    const paths = await writeReports(cfg.REPORT_DIR, results);
    console.log(`\nReports:\n  ${paths.html}\n  ${paths.json}\n  ${paths.junit}`);

    if (opts.upload) {
      if (!cfg.AZDO_ORG_URL || !cfg.AZDO_PROJECT || !cfg.AZDO_PAT) {
        console.error('--upload requires AZDO_ORG_URL, AZDO_PROJECT, and AZDO_PAT');
        process.exit(1);
      }
      const planId = opts.plan ?? cfg.AZDO_TEST_PLAN_ID;
      if (!planId) {
        console.error('--plan or AZDO_TEST_PLAN_ID is required to upload');
        process.exit(1);
      }
      const client = new AzureDevOpsClient(cfg);
      const { runId, url } = await client.publishResults(planId, results);
      console.log(`Uploaded to Azure DevOps run #${runId}: ${url}`);
    }
  });

program
  .command('report')
  .description('Re-render reports from a saved results.json')
  .requiredOption('--input <file>', 'Path to results.json produced by `run`')
  .option('--output <dir>', 'Output directory', './reports')
  .action(async (opts: { input: string; output: string }) => {
    const raw = await import('node:fs').then((m) => m.promises.readFile(resolve(opts.input), 'utf8'));
    const results = JSON.parse(raw) as TestResult[];
    await mkdir(resolve(opts.output), { recursive: true });
    const paths = await writeReports(resolve(opts.output), results);
    console.log(`Reports:\n  ${paths.html}\n  ${paths.json}\n  ${paths.junit}`);
  });

program
  .command('upload')
  .description('Upload a saved results.json to Azure DevOps as a test run')
  .requiredOption('--input <file>', 'Path to results.json')
  .option('--plan <id>', 'Azure DevOps test plan id')
  .action(async (opts: { input: string; plan?: string }) => {
    const cfg = loadConfig();
    const client = new AzureDevOpsClient(cfg);
    const raw = await import('node:fs').then((m) => m.promises.readFile(resolve(opts.input), 'utf8'));
    const results = JSON.parse(raw) as TestResult[];
    const planId = opts.plan ?? cfg.AZDO_TEST_PLAN_ID;
    if (!planId) throw new Error('--plan or AZDO_TEST_PLAN_ID is required');
    const { runId, url } = await client.publishResults(planId, results);
    console.log(`Uploaded run #${runId}: ${url}`);
  });

program
  .command('learn')
  .description('Dump the local knowledge base as JSON')
  .option('--output <file>', 'Write to file instead of stdout')
  .action(async (opts: { output?: string }) => {
    const cfg = loadConfig();
    const kb = new KnowledgeBase(cfg.KB_DIR);
    await kb.load();
    const data = JSON.stringify(kb.all(), null, 2);
    if (opts.output) {
      await writeFile(resolve(opts.output), data);
      console.log(`Wrote ${opts.output}`);
    } else {
      console.log(data);
    }
  });

async function discover(cfg: ReturnType<typeof loadConfig>, opts: { plan?: string; suite?: string; local?: string }): Promise<TestCase[]> {
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

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});

// Silence: this helper keeps `join` imported when only used in one branch.
void join;
