#!/usr/bin/env node
import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startUiServer } from '../ui/server.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { activeModel, ignoredModelHint, loadConfig, validateForRun } from '../config/index.js';
import { dotenvFileProblems } from '../config/dotenv-check.js';
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
import { checkSession, probeSession, DEFAULT_SESSION_FILE, interactiveSessionLogin } from '../d365fo/session.js';
import { checkPlaywrightBrowser } from '../mcp/playwright-browser.js';
import { checkModelEndpoint } from '../llm/endpoint.js';
import { isLoopbackUrl } from '../llm/index.js';
import { allowedHosts, describeEnvironment } from '../d365fo/environment.js';

const program = new Command();
program
  .name('d365fo-agent')
  .description('Portable AI agent for D365 F&O regression and unit testing')
  .version('0.1.0');

program
  .command('doctor')
  .description('Validate configuration and MCP server connectivity')
  .option('--probe', 'Also ask the F&O server whether the saved session is still accepted (one HTTP request, no browser)')
  .action(async (opts: { probe?: boolean }) => {
    const cfg = loadConfig();
    const issues = validateForRun(cfg);
    for (const p of dotenvFileProblems()) issues.push(p.message);
    console.log(`LLM provider: ${cfg.LLM_PROVIDER} (${activeModel(cfg)})`);
    const modelHint = ignoredModelHint(cfg);
    if (modelHint) console.log(`  WARNING: ${modelHint}`);
    if (cfg.LLM_PROVIDER === 'openai-compatible') {
      const url = cfg.OPENAI_COMPATIBLE_BASE_URL;
      const ep = await checkModelEndpoint(url, cfg.OPENAI_COMPATIBLE_API_KEY);
      if (!ep.reachable) {
        console.log(`LLM endpoint: NOT REACHABLE at ${url} (${ep.error})`);
        issues.push(`Cannot reach the LLM endpoint at ${url}. Start the server (Ollama: open the app or run \`ollama serve\`; LM Studio: start its local server).`);
      } else {
        console.log(`LLM endpoint: reachable at ${url} (${ep.models.length} model(s) listed${ep.error ? `; ${ep.error}` : ''})`);
        const model = cfg.OPENAI_COMPATIBLE_MODEL;
        if (model && ep.models.length && !ep.models.includes(model)) {
          console.log(`  WARNING: model '${model}' is not in the server's list: ${ep.models.slice(0, 8).join(', ')}`);
        }
      }
      if (isLoopbackUrl(url)) {
        console.log('  Local models: the agent needs a context window of at least 32k tokens (Ollama: OLLAMA_CONTEXT_LENGTH=32768 or more; check with `ollama ps`).');
        if (cfg.LLM_MAX_TOKENS < 8192) console.log('  Thinking models spend output tokens on reasoning: consider LLM_MAX_TOKENS=8192 or more.');
      }
    }
    console.log(`D365 base URL: ${cfg.D365_BASE_URL ?? '(missing)'} [${describeEnvironment(cfg)}${cfg.AGENT_ALLOW_PRODUCTION ? '; production runs allowed' : ''}]`);
    console.log(`Guardrails: navigation limited to ${allowedHosts(cfg).join(', ')}; ${cfg.AGENT_ALLOWED_TOOLS_EXTRA.length} extra tool grant(s)`);
    console.log(`D365 credentials: username ${cfg.D365_USERNAME ? 'set' : 'MISSING'}, password ${cfg.D365_PASSWORD ? 'set' : 'MISSING'}`);
    const session = await checkSession(cfg);
    console.log(`D365 saved session: ${session.state === 'off' ? session.detail : `${session.state.toUpperCase()} - ${session.detail}`}`);
    if (session.state === 'expired' || session.state === 'unreadable') {
      const fallback = cfg.D365_USERNAME && cfg.D365_PASSWORD;
      if (fallback) console.log('  (username and password are set, so runs will fall back to them.)');
      else issues.push(`Saved D365 session is ${session.state}: ${session.detail}`);
    }
    for (const w of session.warnings ?? []) console.log(`  WARNING: ${w}`);
    if (opts.probe && session.state !== 'off') {
      const probe = await probeSession(cfg);
      console.log(`D365 session probe: ${probe.state.toUpperCase()} - ${probe.detail}`);
      if (probe.state === 'expired' && !(cfg.D365_USERNAME && cfg.D365_PASSWORD)) issues.push(`Saved D365 session is no longer accepted: ${probe.detail}`);
    }
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
  .command('session-login')
  .description('Sign in to D365 F&O in a headed browser (MFA included) and save the session for D365_STORAGE_STATE')
  .option('--output <file>', 'Where to save the session', undefined)
  .action(async (opts: { output?: string }) => {
    const cfg = loadConfig();
    const out = opts.output ?? cfg.D365_STORAGE_STATE ?? DEFAULT_SESSION_FILE;
    console.log(`Opening ${cfg.D365_BASE_URL ?? '(D365_BASE_URL missing)'} in a browser.`);
    console.log('Sign in yourself (MFA included), wait for the F&O dashboard, then close the browser window to save.');
    const saved = await interactiveSessionLogin(cfg, out);
    console.log(`\nSession saved to ${saved} (owner-only, gitignored by default; it grants access to your account, so keep it private).`);
    console.log(`Set D365_STORAGE_STATE=${out} in .env to use it. Run \`doctor\` to check it later.`);
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
  .option('--dry-run', 'Skip state-changing browser actions (click/type/fill/...); navigation and snapshots still run')
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
    const warnings: string[] = [];
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
    // A credential cut off at a "#" would be typed into the sign-in page and can lock the account after a few tries.
    for (const p of dotenvFileProblems()) (p.secret ? issues : warnings).push(p.message);
    for (const w of warnings) console.warn(`warning: ${w}`);
    if (issues.length) {
      for (const i of issues) console.error(`config: ${i}`);
      process.exit(1);
    }
    console.log(`LLM: ${cfg.LLM_PROVIDER} (${activeModel(cfg)})`);
    const modelHint = ignoredModelHint(cfg);
    if (modelHint) console.warn(`warning: ${modelHint}`);

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
    if (execution.aborted) {
      console.error(`\nThe run was aborted by an LLM provider problem, not by the tests: ${execution.aborted}`);
      if (opts.upload) console.error('Results were not uploaded to Azure DevOps. Fix the cause and run again.');
      process.exitCode = 1;
    }
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

program
  .command('ui')
  .description('Open a local web UI to edit settings (.env), run tests with a live log, and view results')
  .option('--port <n>', 'Port on 127.0.0.1 (0 = any free port)', '4173')
  .option('--no-open', 'Do not open the browser automatically')
  .action(async (opts: { port: string; open: boolean }) => {
    const port = Number.parseInt(opts.port, 10);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid --port: ${opts.port}`);
    const ui = await startUiServer({
      port,
      envPath: resolve('.env'),
      cliPath: fileURLToPath(import.meta.url),
      cwd: process.cwd(),
    });
    console.log(`D365 F&O Agent UI: ${ui.url}`);
    console.log('Only reachable from this machine. The link contains an access token; do not share it. Ctrl+C to stop.');
    if (opts.open) openBrowser(ui.url);
    const shutdown = () => void ui.close().then(() => process.exit(0));
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true });
  child.on('error', () => console.log('Could not open a browser; open the URL above yourself.'));
  child.unref();
}

async function discover(cfg: ReturnType<typeof loadConfig>, opts: { plan?: string; suite?: string; local?: string }): Promise<TestCase[]> {
  return discoverTestCases(cfg, opts);
}

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});

// Silence: this helper keeps `join` imported when only used in one branch.
void join;
