#!/usr/bin/env node
import { Command } from 'commander';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { activeModel, loadConfig, validateForRun } from '../config/index.js';
import { AzureDevOpsClient } from '../devops/client.js';
import { KnowledgeBase } from '../knowledge/kb.js';
import {
  CopilotSessionAuth,
  DEFAULT_AUTH_FILE,
  loginWithDeviceFlow,
  saveGitHubToken,
} from '../llm/github-copilot.js';
import { writeReports } from '../reporting/reporters.js';
import type { TestCase, TestResult } from '../testing/types.js';
import { discoverTestCases, executeTestRun } from '../core/runner.js';
import { checkPlaywrightBrowser } from '../mcp/playwright-browser.js';

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
    console.log(`LLM provider: ${cfg.LLM_PROVIDER} (${activeModel(cfg)})`);
    console.log(`D365 base URL: ${cfg.D365_BASE_URL ?? '(missing)'}`);
    console.log(`Azure DevOps: ${cfg.AZDO_ORG_URL ?? '(missing)'} / ${cfg.AZDO_PROJECT ?? '(missing)'}`);
    const browser = await checkPlaywrightBrowser(cfg);
    if (browser.installed === false) {
      console.log(`Playwright browser (${cfg.PW_BROWSER}): NOT INSTALLED (looked in ${browser.cacheDir})`);
      console.log(`  Install it with: ${browser.installCommand}`);
      if (cfg.PW_AUTO_INSTALL) console.log('  (PW_AUTO_INSTALL is on, so `run` will also install it automatically.)');
      else issues.push(`Playwright ${cfg.PW_BROWSER} browser is missing and PW_AUTO_INSTALL is off. Run: ${browser.installCommand}`);
    } else if (browser.installed) {
      console.log(`Playwright browser (${cfg.PW_BROWSER}): installed`);
    } else {
      console.log(`Playwright browser (${cfg.PW_BROWSER}): not checked (PLAYWRIGHT_BROWSERS_PATH=0)`);
    }
    if (issues.length) {
      console.log('\nIssues:');
      for (const i of issues) console.log(`  - ${i}`);
      process.exitCode = 1;
    } else {
      console.log('\nConfiguration looks good.');
    }
  });

program
  .command('copilot-login')
  .description('Sign in to GitHub Copilot (device flow) and save the token for LLM_PROVIDER=github-copilot')
  .action(async () => {
    const cfg = loadConfig();
    const http = {
      timeoutMs: cfg.LLM_HTTP_TIMEOUT_MS,
      maxRetries: cfg.LLM_HTTP_MAX_RETRIES,
      retryBaseMs: cfg.LLM_HTTP_RETRY_BASE_MS,
    };
    const token = await loginWithDeviceFlow({
      http,
      onPrompt: ({ userCode, verificationUri }) => {
        console.log(`\nOpen ${verificationUri} and enter the code: ${userCode}`);
        console.log('Waiting for authorization...');
      },
    });
    // Prove the account can actually get a Copilot session before saving anything.
    await new CopilotSessionAuth(token, http).get();
    await saveGitHubToken(token);
    console.log(`\nSigned in. Token saved to ${DEFAULT_AUTH_FILE}`);
    console.log('Set LLM_PROVIDER=github-copilot (and optionally GITHUB_COPILOT_MODEL) to use it.');
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
  .option('--reloop-max-retries <n>', 'Retries per case after first attempt', Number.parseInt)
  .option('--reloop-retry-on <csv>', 'Outcomes to retry (comma-separated)', 'failed,blocked')
  .option('--reloop-cooldown-ms <ms>', 'Delay between retries in milliseconds', Number.parseInt)
  .action(async (opts: {
    plan?: string;
    suite?: string;
    local?: string;
    case?: string;
    dryRun?: boolean;
    upload?: boolean;
    reloopMaxRetries?: number;
    reloopRetryOn?: string;
    reloopCooldownMs?: number;
  }) => {
    const cfg = loadConfig();
    if (opts.dryRun) cfg.AGENT_DRY_RUN = true;
    if (opts.reloopMaxRetries !== undefined && !Number.isNaN(opts.reloopMaxRetries)) {
      cfg.AGENT_RELOOP_MAX_RETRIES = Math.max(0, opts.reloopMaxRetries);
    }
    if (opts.reloopCooldownMs !== undefined && !Number.isNaN(opts.reloopCooldownMs)) {
      cfg.AGENT_RELOOP_COOLDOWN_MS = Math.max(0, opts.reloopCooldownMs);
    }
    if (opts.reloopRetryOn) {
      cfg.AGENT_RELOOP_RETRY_ON = opts.reloopRetryOn
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .filter((x): x is (typeof cfg.AGENT_RELOOP_RETRY_ON)[number] =>
          ['passed', 'failed', 'skipped', 'blocked'].includes(x),
        );
    }
    const issues = validateForRun(cfg);
    if (issues.length) {
      for (const i of issues) console.error(`config: ${i}`);
      process.exit(1);
    }

    const execution = await executeTestRun(cfg, {
      plan: opts.plan,
      suite: opts.suite,
      local: opts.local,
      caseId: opts.case,
      dryRun: cfg.AGENT_DRY_RUN,
      upload: opts.upload,
      reloopMaxRetries: cfg.AGENT_RELOOP_MAX_RETRIES,
      reloopRetryOn: cfg.AGENT_RELOOP_RETRY_ON,
      reloopCooldownMs: cfg.AGENT_RELOOP_COOLDOWN_MS,
    });
    if (execution.cases.length === 0) {
      console.log('No test cases matched.');
      return;
    }
    console.log(`\nReports:\n  ${execution.reportPaths.html}\n  ${execution.reportPaths.json}\n  ${execution.reportPaths.junit}`);
    if (execution.upload) console.log(`Uploaded to Azure DevOps run #${execution.upload.runId}: ${execution.upload.url}`);
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
  return discoverTestCases(cfg, opts);
}

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});

// Silence: this helper keeps `join` imported when only used in one branch.
void join;
