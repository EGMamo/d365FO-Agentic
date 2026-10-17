#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { activeModel, ignoredModelHint, loadConfig, validateForRun } from '../config/index.js';
import { dotenvFileProblems } from '../config/dotenv-check.js';
import { AzureDevOpsClient } from '../devops/client.js';
import { azdoAuthMode, azLogin, azTokenProblem } from '../devops/auth.js';
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
import { activeSessionFile, checkSession, probeBlocksRun, probeSession, DEFAULT_SESSION_FILE, interactiveSessionLogin } from '../d365fo/session.js';
import { REPLAY_FILE, ReplayStore } from '../replay/store.js';
import { exportSpecs } from '../replay/export.js';
import { loadLocalTestCases } from '../testing/loader.js';
import { checkPlaywrightBrowser } from '../mcp/playwright-browser.js';
import { ANTHROPIC_DEFAULT_BASE_URL, checkAnthropicEndpoint, checkModelEndpoint, normalizeAnthropicBaseUrl } from '../llm/endpoint.js';
import { createLlmProvider, isLoopbackUrl } from '../llm/index.js';
import { generateTestCases } from '../testing/generate.js';
import { TestCaseFiles } from '../testing/store.js';
import { D365ODataClient, hasAppRegistration } from '../d365fo/entra.js';
import { allowedHosts, describeEnvironment } from '../d365fo/environment.js';
import { environmentForChild, modelSelection, overriddenKeys, profileSelection } from '../config/load-env.js';
import { RunHistory } from '../ui/history.js';
import { agentHome, toolTokenFile } from '../profiles/paths.js';
import { DEFAULT_PORT, findRunningUi, isLoopback, loadOrCreateToken, loadOrCreateToolToken, startUiServer } from '../ui/server.js';
import { openBrowser } from '../ui/open.js';
import { composeUp, DEFAULT_WEBUI_PORT, dockerComposeAvailable, dockerToolUrl, waitForHttp, writeComposeEnv } from '../ui/studio.js';
import { defaultRepoRoot, desktopDirectory, installLauncher, uninstallLauncher, type LauncherContext } from '../launcher/install.js';

const program = new Command();
program
  .name('d365fo-agent')
  .description('Portable AI agent for D365 F&O regression and unit testing')
  .version('0.1.0')
  .option('--profile <name>', 'Use a saved settings profile (its name or its permanent id) instead of the .env file')
  .option('--model <name>', "Use this AI model setup (its name or id, from the app's AI models list) for this run instead of the profile's");

program
  .command('doctor')
  .description('Validate configuration and MCP server connectivity')
  .option('--probe', 'Also ask the F&O server whether the saved session is still accepted (one HTTP request, no browser)')
  .action(async (opts: { probe?: boolean }) => {
    const cfg = loadConfig();
    const issues = validateForRun(cfg);
    for (const p of dotenvFileProblems()) issues.push(p.message);
    console.log(profileSelection.name ? `Settings profile: ${profileSelection.name}` : 'Settings profile: none (using .env)');
    if (overriddenKeys.length) {
      console.log(`  WARNING: ${overriddenKeys.join(', ')} ${overriddenKeys.length === 1 ? 'is' : 'are'} also set in this computer's environment, and that value is used instead of the one in ${profileSelection.name ? 'the profile' : '.env'}.`);
    }
    console.log(`LLM provider: ${cfg.LLM_PROVIDER} (${activeModel(cfg)})`);
    const modelHint = ignoredModelHint(cfg);
    if (modelHint) console.log(`  WARNING: ${modelHint}`);
    if (cfg.LLM_PROVIDER === 'anthropic') {
      const custom = normalizeAnthropicBaseUrl(cfg.ANTHROPIC_BASE_URL);
      if (!custom) {
        console.log(`Claude API URL: default (${ANTHROPIC_DEFAULT_BASE_URL})`);
      } else if (!/^https?:\/\//i.test(custom)) {
        console.log(`Claude API URL: INVALID (${custom})`);
      } else {
        const ep = await checkAnthropicEndpoint(custom, { apiKey: cfg.ANTHROPIC_API_KEY, authToken: cfg.ANTHROPIC_AUTH_TOKEN });
        if (!ep.reachable) {
          console.log(`Claude API URL: NOT REACHABLE at ${custom} (${ep.detail})`);
          issues.push(`Cannot reach the custom Claude API URL ${custom} (${ep.detail}). Check the address, VPN or proxy.`);
        } else if (!ep.authorized) {
          console.log(`Claude API URL: reachable at ${custom}, but ${ep.detail}`);
          issues.push(`The custom Claude API URL refused the credentials: check ANTHROPIC_API_KEY, or set ANTHROPIC_AUTH_TOKEN if the gateway expects a bearer token.`);
        } else {
          console.log(`Claude API URL: reachable at ${custom} (${ep.detail})`);
          if (ep.models.length && !ep.models.includes(cfg.LLM_MODEL)) console.log(`  WARNING: model '${cfg.LLM_MODEL}' is not in the server's list: ${ep.models.slice(0, 8).join(', ')}`);
        }
        if (/^http:\/\//i.test(custom) && !isLoopbackUrl(custom)) console.log('  WARNING: this address is plain http, so the key and the page content sent to the model are not encrypted. Use https.');
      }
    }
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
    if (hasAppRegistration(cfg) && cfg.D365_BASE_URL) {
      const app = await new D365ODataClient(cfg).check();
      console.log(`D365 app registration: ${app.ok ? 'OK' : 'FAILED'} - ${app.detail}`);
      if (!app.ok) issues.push(`Entra app registration: ${app.detail}`);
    } else {
      console.log('D365 app registration: not configured (optional)');
    }
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
    if (cfg.AZDO_ORG_URL && cfg.AZDO_PROJECT) {
      const how = azdoAuthMode(cfg) === 'pat' ? 'personal access token' : 'Microsoft account (az login)';
      const ado = await new AzureDevOpsClient(cfg).check();
      console.log(`Azure DevOps: ${ado.ok ? 'OK' : 'FAILED'} - ${cfg.AZDO_ORG_URL} / ${cfg.AZDO_PROJECT}, ${how}: ${ado.detail}`);
      // Only a problem for a profile that reads a test plan; otherwise Azure DevOps is optional.
      if (!ado.ok && cfg.AZDO_TEST_PLAN_ID) issues.push(`Azure DevOps: ${ado.detail}`);
    } else {
      console.log('Azure DevOps: not configured (optional)');
    }
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
  .command('devops-login')
  .description('Sign in to Azure DevOps with your Microsoft work account (through the Azure CLI) instead of a personal access token')
  .action(async () => {
    const cfg = loadConfig();
    console.log('Opening the Microsoft sign-in in your browser. Finish it there, then come back here.');
    const res = await azLogin(cfg.AZDO_TENANT_ID);
    // Plain messages, no stack trace: the settings app shows this output as it is.
    if (res.missing || res.code !== 0) {
      console.error(res.missing ? azTokenProblem(res) : 'The sign-in did not finish. Try again.');
      process.exitCode = 1;
      return;
    }
    console.log('Signed in.');
    if (cfg.AZDO_ORG_URL && cfg.AZDO_PROJECT) {
      const check = await new AzureDevOpsClient({ ...cfg, AZDO_AUTH: 'azure-cli' }).check();
      console.log(`Azure DevOps: ${check.ok ? 'OK' : 'FAILED'} - ${check.detail}`);
      if (!check.ok) process.exitCode = 1;
    }
    if (azdoAuthMode(cfg) === 'pat') console.log('Note: a personal access token is also set and is used instead. Clear it (AZDO_PAT) to use this sign-in.');
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
  .option('--case <ids>', 'Only these test-case ids (comma-separated)')
  .option('--tag <tags>', 'Only cases with one of these tags (comma-separated, repeatable)', collect, [] as string[])
  .option('--module <names>', 'Only cases whose module or area contains one of these (comma-separated, repeatable)', collect, [] as string[])
  .option('--max-priority <n>', 'Only cases with this priority or more urgent (1 = highest)', intArg)
  .option('--sort-by-priority', 'Run the most urgent cases first instead of in suite or file order')
  .option('--fail-on <outcomes>', 'Exit with code 2 when any case ends with one of these outcomes (comma-separated, e.g. failed,blocked)')
  .option('--dry-run', 'Skip state-changing browser actions (click/type/fill/...); navigation and snapshots still run')
  .option('--upload', 'Upload results to Azure DevOps after the run')
  .option('--probe-session', 'Before running tests, verify the saved D365 session with one HTTP probe and fail fast if it is expired')
  .option('--reloop-max-retries <n>', 'Retries per case after first attempt', intArg)
  .option('--reloop-retry-on <csv>', 'Outcomes to retry (comma-separated)', 'failed,blocked')
  .option('--reloop-cooldown-ms <ms>', 'Delay between retries in milliseconds', intArg)
  .action(async (opts: {
    plan?: string;
    suite?: string;
    local?: string;
    case?: string;
    tag: string[];
    module: string[];
    maxPriority?: number;
    sortByPriority?: boolean;
    failOn?: string;
    dryRun?: boolean;
    upload?: boolean;
    probeSession?: boolean;
    reloopMaxRetries?: number;
    reloopRetryOn?: string;
    reloopCooldownMs?: number;
  }) => {
    const cfg = loadConfig();
    const runStartedAt = new Date().toISOString();
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
    const failOn = parseOutcomes(opts.failOn);
    if (failOn === null) {
      console.error('config: --fail-on takes a comma-separated list of passed, failed, skipped, blocked');
      process.exit(1);
    }
    const issues = validateForRun(cfg);
    // A credential cut off at a "#" would be typed into the sign-in page and can lock the account after a few tries.
    for (const p of dotenvFileProblems()) (p.secret ? issues : warnings).push(p.message);
    for (const w of warnings) console.warn(`warning: ${w}`);
    if (issues.length) {
      for (const i of issues) console.error(`config: ${i}`);
      process.exit(1);
    }
    console.log(`LLM: ${cfg.LLM_PROVIDER} (${activeModel(cfg)})${modelSelection.name ? ` from AI model "${modelSelection.name}"` : ''}`);
    const modelHint = ignoredModelHint(cfg);
    if (modelHint) console.warn(`warning: ${modelHint}`);

    if (opts.probeSession) {
      const probe = await probeSession(cfg);
      console.log(`D365 session probe: ${probe.state.toUpperCase()} - ${probe.detail}`);
      const stop = probeBlocksRun(probe);
      if (stop) {
        console.error(stop);
        process.exit(1);
      }
    }

    // First Ctrl+C stops the current case (marked interrupted) and writes reports; a second one exits at once.
    const interrupt = new AbortController();
    // SIGTERM (a cancelled CI job, `kill`) is handled the same way, with exit code 143.
    let stopCode = 130;
    const onStop = (sig: NodeJS.Signals): void => {
      const code = sig === 'SIGTERM' ? 143 : 130;
      if (interrupt.signal.aborted) process.exit(code);
      stopCode = code;
      interrupt.abort();
      console.error(`\nInterrupted (${sig}): stopping the current case, then writing reports. ${sig === 'SIGTERM' ? 'Send it again' : 'Press Ctrl+C again'} to quit now.`);
    };
    process.on('SIGINT', onStop);
    process.on('SIGTERM', onStop);
    let execution: Awaited<ReturnType<typeof executeTestRun>>;
    try {
      execution = await executeTestRun(cfg, {
        plan: opts.plan,
        suite: opts.suite,
        local: opts.local,
        caseId: opts.case,
        tags: opts.tag,
        modules: opts.module,
        maxPriority: opts.maxPriority,
        sortByPriority: opts.sortByPriority,
        signal: interrupt.signal,
        dryRun: cfg.AGENT_DRY_RUN,
        upload: opts.upload,
        reloopMaxRetries: cfg.AGENT_RELOOP_MAX_RETRIES,
        reloopRetryOn: cfg.AGENT_RELOOP_RETRY_ON,
        reloopCooldownMs: cfg.AGENT_RELOOP_COOLDOWN_MS,
      });
    } finally {
      process.off('SIGINT', onStop);
      process.off('SIGTERM', onStop);
    }
    if (execution.cases.length === 0) {
      // An empty selection is almost always a typo in a filter; exiting 0 would show green in CI with nothing tested.
      console.error('No test cases matched the source and filters; nothing was run.');
      process.exitCode = 1;
      return;
    }
    console.log(`\nReports:\n  ${execution.reportPaths.html}\n  ${execution.reportPaths.json}\n  ${execution.reportPaths.junit}`);
    if (execution.interrupted) {
      console.error('\nThe run was interrupted; the case in flight is marked interrupted and the remaining cases were not run.');
      if (opts.upload) console.error('Results were not uploaded to Azure DevOps.');
      process.exitCode = stopCode;
    } else if (execution.aborted) {
      console.error(`\nThe run was aborted by an LLM provider problem, not by the tests: ${execution.aborted}`);
      if (opts.upload) console.error('Results were not uploaded to Azure DevOps. Fix the cause and run again.');
      process.exitCode = 1;
    } else if (failOn?.length) {
      const hits = execution.results.filter((r) => failOn.includes(r.outcome));
      if (hits.length) {
        console.error(`\n${hits.length} case(s) ended ${[...new Set(hits.map((r) => r.outcome))].join('/')} (--fail-on ${failOn.join(',')}).`);
        process.exitCode = 2;
      }
    }
    if (execution.upload) console.log(`Uploaded to Azure DevOps run #${execution.upload.runId}: ${execution.upload.url}`);
    // Keep the run in the history the app shows (Results and History), whether it was started here or in the app.
    try {
      const exit = Number(process.exitCode ?? 0);
      const meta = await new RunHistory(async () => resolve(cfg.REPORT_DIR)).record(
        {
          status: execution.interrupted ? 'stopped' : exit === 0 ? 'passed' : 'failed',
          args: process.argv.slice(2),
          profile: profileSelection.name ?? null,
          profileId: cfg.PROFILE_ID ?? null,
          model: modelSelection.name ?? null,
          modelId: modelSelection.id ?? null,
          mode: cfg.AGENT_DRY_RUN ? 'dry-run' : 'live',
          origin: process.env.D365FO_ORIGIN === 'app' ? 'app' : 'cli',
          startedAt: runStartedAt,
          finishedAt: new Date().toISOString(),
        },
        process.pid % 1_000_000,
      );
      console.log(`Saved to run history as ${meta.id}.`);
    } catch (e) {
      console.warn(`warning: could not save the run to the history: ${(e as Error).message}`);
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
  .command('plans')
  .description('List the Azure DevOps test plans of the project, or the suites of one plan, with the ids `run --plan/--suite` take')
  .option('--plan <id>', 'List the suites of this test plan instead')
  .option('--json', 'Print JSON instead of a table')
  .action(async (opts: { plan?: string; json?: boolean }) => {
    const client = new AzureDevOpsClient(loadConfig());
    if (opts.plan) {
      const suites = await client.listSuites(opts.plan);
      if (opts.json) return console.log(JSON.stringify({ plan: opts.plan, suites }));
      if (!suites.length) return console.log(`Test plan ${opts.plan} has no suites.`);
      for (const s of suites) console.log(`${s.id.padStart(8)}  ${s.name}${s.type ? ` (${s.type})` : ''}${s.parentId ? `  in ${s.parentId}` : ''}`);
      return;
    }
    const plans = await client.listPlans();
    if (opts.json) return console.log(JSON.stringify({ plans }));
    if (!plans.length) return console.log('The project has no test plans.');
    for (const p of plans) console.log(`${p.id.padStart(8)}  ${p.name}${p.state ? ` [${p.state}]` : ''}${p.rootSuiteId ? `  root suite ${p.rootSuiteId}` : ''}`);
  });

program
  .command('generate')
  .description('Draft local test cases from a plain-language description with the configured LLM')
  .argument('<description...>', 'What to test, e.g. "create a vendor and post an invoice for it"')
  .option('--dir <dir>', 'Folder (inside the current folder) to save the cases in', 'test-cases')
  .option('--count <n>', 'How many cases to draft (1-10)', intArg, 1)
  .option('--module <name>', 'D365 F&O module, e.g. "Accounts payable"')
  .option('--legal-entity <code>', 'Company to test in, e.g. USMF')
  .option('--dry-run', 'Print the drafts instead of saving them')
  .option('--json', 'Print one JSON object with the saved files (or the drafts) and the rejected drafts, for the app')
  .action(async (words: string[], opts: { dir: string; count: number; module?: string; legalEntity?: string; dryRun?: boolean; json?: boolean }) => {
    const cfg = loadConfig();
    const description = words.join(' ');
    const files = new TestCaseFiles(process.cwd());
    const existing = await files.list(opts.dir);
    const kb = new KnowledgeBase(cfg.KB_DIR);
    await kb.load();
    const llm = createLlmProvider(cfg);
    if (!opts.json) console.log(`Drafting with ${llm.name} (${activeModel(cfg)})…`);
    const res = await generateTestCases(llm, description, {
      count: Number.isNaN(opts.count) ? 1 : opts.count,
      ...(opts.module ? { module: opts.module } : {}),
      ...(opts.legalEntity ? { legalEntity: opts.legalEntity } : {}),
      knowledge: kb.retrieve(description, [], 6, opts.module),
      existingIds: existing.map((c) => c.id),
    });
    if (opts.json) {
      const out: { saved: Array<{ file: string; id: string; title: string; steps: number }>; drafts?: typeof res.cases; rejected: string[] } = { saved: [], rejected: [...res.rejected] };
      if (opts.dryRun) out.drafts = res.cases;
      else {
        for (const tc of res.cases) {
          try {
            out.saved.push({ file: (await files.save(opts.dir, tc)).file, id: tc.id, title: tc.title, steps: tc.steps.length });
          } catch (e) {
            out.rejected.push(`Could not save ${tc.id} (${tc.title}): ${(e as Error).message}`);
          }
        }
      }
      console.log(JSON.stringify(out));
      if (!res.cases.length) process.exitCode = 1;
      return;
    }
    for (const r of res.rejected) console.error(`! ${r}`);
    const wanted = Math.min(10, Math.max(1, opts.count));
    if (res.cases.length && res.cases.length < wanted) console.error(`! Only ${res.cases.length} of ${wanted} test cases were drafted; run generate again for more.`);
    if (!res.cases.length) {
      console.error('No test case was drafted.');
      process.exitCode = 1;
      return;
    }
    const savedIds: string[] = [];
    for (const tc of res.cases) {
      if (opts.dryRun) {
        console.log(JSON.stringify(tc, null, 2));
        continue;
      }
      try {
        const saved = await files.save(opts.dir, tc);
        savedIds.push(tc.id);
        console.log(`Saved ${join(opts.dir, saved.file)}: ${tc.title} (${tc.steps.length} steps)`);
      } catch (e) {
        console.error(`! Could not save ${tc.id} (${tc.title}): ${(e as Error).message}`);
        process.exitCode = 1;
      }
    }
    if (savedIds.length) console.log(`Review the steps, then run them with: d365fo-agent run --local ${opts.dir} --case ${savedIds.join(',')}`);
  });

program
  .command('learn')
  .description('Inspect or maintain the local knowledge base (default: dump it as JSON)')
  .option('--output <file>', 'Write to file instead of stdout')
  .option('--stats', 'Show counts by kind and module, and how many known-good paths have gone stale')
  .option('--search <query>', 'Show the entries the agent would retrieve for this text, with scores')
  .option('--module <name>', 'Module hint for --search')
  .option('--tag <tags>', 'Tags for --search, as on the test case (comma-separated, repeatable)', collect, [] as string[])
  .option('--top <n>', 'With --search: how many entries to show (default 5, what a run retrieves)', intArg)
  .option('--prune', 'Remove unreliable entries and stale known-good paths')
  .option('--min-failures <n>', 'With --prune: remove entries that failed at least this often and more often than they succeeded (default 3)', intArg)
  .option('--max-age-days <n>', 'With --prune: also remove never-confirmed entries older than this', intArg)
  .action(async (opts: { output?: string; stats?: boolean; search?: string; module?: string; tag: string[]; top?: number; prune?: boolean; minFailures?: number; maxAgeDays?: number }) => {
    const cfg = loadConfig();
    const kb = new KnowledgeBase(cfg.KB_DIR);
    await kb.load();
    if (opts.prune) {
      const removed = kb.prune({
        ...(opts.minFailures !== undefined && !Number.isNaN(opts.minFailures) ? { minFailures: opts.minFailures } : {}),
        ...(opts.maxAgeDays !== undefined && !Number.isNaN(opts.maxAgeDays) ? { maxAgeDays: opts.maxAgeDays } : {}),
      });
      if (removed.length) await kb.save();
      console.log(`Removed ${removed.length} entr${removed.length === 1 ? 'y' : 'ies'}.`);
      for (const e of removed) console.log(`  - [${e.kind}] ${e.summary} (${e.successCount}✓ ${e.failureCount}✗)`);
    }
    if (opts.stats) {
      const s = kb.stats();
      console.log(`Knowledge base: ${s.total} entr${s.total === 1 ? 'y' : 'ies'} in ${cfg.KB_DIR}`);
      console.log(`  by kind:   ${Object.entries(s.byKind).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
      console.log(`  by module: ${Object.entries(s.byModule).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
      console.log(`  known-good paths: ${s.knownPaths} (${s.staleKnownPaths} stale)`);
    }
    if (opts.search !== undefined) {
      const tags = opts.tag.flatMap((t) => t.split(',')).map((t) => t.trim()).filter(Boolean);
      const hits = kb.search(opts.search, tags, Math.max(1, opts.top ?? 5), opts.module);
      if (!hits.length) console.log('No matching entries.');
      for (const h of hits) console.log(`${h.score.toFixed(2).padStart(6)}  [${h.entry.kind}] ${h.entry.summary}${h.entry.module ? ` (${h.entry.module})` : ''}`);
    }
    if (opts.prune || opts.stats || opts.search !== undefined) return;
    const data = JSON.stringify(kb.all(), null, 2);
    if (opts.output) {
      await writeFile(resolve(opts.output), data);
      console.log(`Wrote ${opts.output}`);
    } else {
      console.log(data);
    }
  });

/** Whole-number option. Commander passes the previous value as a second argument, so `Number.parseInt` cannot be used directly. */
function intArg(value: string): number {
  if (!/^-?\d+$/.test(value.trim())) throw new InvalidArgumentError('Expected a whole number.');
  return Number.parseInt(value, 10);
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** undefined when not given, null when it names an unknown outcome. */
function parseOutcomes(csv: string | undefined): TestResult['outcome'][] | undefined | null {
  if (csv === undefined) return undefined;
  const all: TestResult['outcome'][] = ['passed', 'failed', 'skipped', 'blocked'];
  const list = csv.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!list.length || list.some((x) => !all.includes(x as TestResult['outcome']))) return null;
  return list as TestResult['outcome'][];
}

async function discover(cfg: ReturnType<typeof loadConfig>, opts: { plan?: string; suite?: string; local?: string }): Promise<TestCase[]> {
  return discoverTestCases(cfg, opts);
}

program
  .command('export-tests')
  .description('Write the recorded passing runs as Playwright tests, to run with `npx playwright test` (no AI needed)')
  .option('--out <dir>', 'Folder to write the tests to', 'playwright-tests')
  .option('--case <ids>', 'Only these test-case ids (comma-separated)')
  .option('--local <dir>', 'Local test cases, to name each step in the test report', 'examples/testcases')
  .action(async (opts: { out: string; case?: string; local: string }) => {
    const cfg = loadConfig();
    const only = opts.case?.split(',').map((s) => s.trim()).filter(Boolean);
    const scripts = (await new ReplayStore(cfg.KB_DIR).all()).filter((s) => !only?.length || only.includes(s.testCaseId));
    if (!scripts.length) {
      console.log(`No recorded runs in ${join(cfg.KB_DIR, REPLAY_FILE)}${only?.length ? ' for those cases' : ''}. A case is recorded when a real (not dry) run of it passes.`);
      return;
    }
    const cases = new Map((await loadLocalTestCases(opts.local).catch(() => [] as TestCase[])).map((tc) => [tc.id, tc]));
    const out = resolve(opts.out);
    const res = await exportSpecs(scripts, out, { storageState: activeSessionFile(cfg), actionTimeoutMs: cfg.PW_ACTION_TIMEOUT_MS ?? 15000, cases });
    console.log(`Wrote ${res.written.length} test${res.written.length === 1 ? '' : 's'} to ${out}`);
    for (const s of res.skipped) console.log(`  skipped ${s.testCaseId}: ${s.reason}`);
    if (res.written.length) console.log(`Run them: cd ${JSON.stringify(out)} && npm install && npx playwright test`);
  });

program
  .command('ui')
  .description('Start the local settings web app and open it in your browser')
  .option('--port <n>', `Port to listen on (default ${DEFAULT_PORT})`, intArg)
  .option('--no-open', 'Do not open the browser')
  .option('--host <address>', 'Address to listen on (default 127.0.0.1). Use 0.0.0.0 only so Open WebUI in Docker on Linux can reach the tool server; the app itself still answers this computer only')
  .action(async (opts: { port?: number; open: boolean; host?: string }) => {
    const home = agentHome();
    const existing = await findRunningUi(home, await loadOrCreateToken(home));
    if (existing) {
      console.log(`The settings app is already running: ${existing.split('?')[0]}`);
      if (opts.open) await openBrowser(existing);
      return;
    }
    const ui = await startUiServer({ home, port: opts.port, host: opts.host, childEnv: environmentForChild });
    console.log(`Settings app running at ${ui.url} (this computer only). Press Ctrl+C to stop.`);
    console.log(`Profiles are stored in ${home}`);
    console.log(`Open WebUI tool server: ${ui.url}tools (run "d365fo-agent openwebui" for the key and setup steps)`);
    if (opts.host && !isLoopback(opts.host)) console.log(`Listening on ${opts.host}: only the bearer-protected /tools routes answer other addresses.`);
    if (opts.open && !(await openBrowser(ui.openUrl))) console.log(`Could not open a browser. Open this address yourself: ${ui.openUrl}`);
    const stop = (): void => void ui.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });

program
  .command('openwebui')
  .description('Show the Open WebUI tool-server address and key for the settings app')
  .option('--port <n>', `Port the settings app uses (default ${DEFAULT_PORT})`, intArg)
  .action(async (opts: { port?: number }) => {
    const home = agentHome();
    const key = await loadOrCreateToolToken(home);
    const running = await findRunningUi(home, await loadOrCreateToken(home));
    const port = running ? new URL(running).port : String(opts.port ?? DEFAULT_PORT);
    if (!running) console.log('The settings app is not running. Start it with "npm run ui" or the desktop icon first.\n');
    console.log('Add this in Open WebUI as an OpenAPI tool server (Bearer auth):\n');
    console.log(`  URL, Open WebUI opened in this computer's browser (Settings > Tools):  http://localhost:${port}/tools`);
    console.log(`  URL, Open WebUI in Docker (Admin Settings > External Tools):          http://host.docker.internal:${port}/tools`);
    console.log(`  Key:  ${key}\n`);
    console.log(`To issue a new key, delete ${toolTokenFile(home)} and restart the settings app. See docs/openwebui.md.`);
  });

program
  .command('studio')
  .description('One step to the chat front end: start the settings app and Open WebUI (Docker) already connected to it, and open Open WebUI')
  .option('--port <n>', `Port for the settings app (default ${DEFAULT_PORT})`, Number.parseInt)
  .option('--webui-port <n>', `Port for Open WebUI on this computer (default ${DEFAULT_WEBUI_PORT})`, Number.parseInt)
  .option('--no-open', 'Do not open the browser')
  .action(async (opts: { port?: number; webuiPort?: number; open: boolean }) => {
    const home = agentHome();
    const toolKey = await loadOrCreateToolToken(home);
    const webuiPort = opts.webuiPort ?? DEFAULT_WEBUI_PORT;
    const running = await findRunningUi(home, await loadOrCreateToken(home));
    let ui: Awaited<ReturnType<typeof startUiServer>> | undefined;
    let appUrl: string;
    let toolPort: number;
    if (running) {
      toolPort = Number(new URL(running).port);
      appUrl = running;
      console.log(`Using the settings app that is already running on port ${toolPort}.`);
      if (process.platform === 'linux') console.log('  On Linux, Open WebUI in Docker reaches it only if it was started with --host 0.0.0.0 (as this command does).');
    } else {
      // On Linux the container reaches the host through the Docker bridge, not loopback; only the key-protected /tools routes answer there.
      ui = await startUiServer({ home, port: opts.port, host: process.platform === 'linux' ? '0.0.0.0' : undefined, childEnv: environmentForChild });
      toolPort = ui.port;
      appUrl = ui.openUrl;
      console.log(`Settings app running at ${ui.url}`);
    }
    const dir = join(defaultRepoRoot(), 'openwebui');
    await writeComposeEnv(dir, { toolPort, toolKey, webuiPort });
    const webuiUrl = `http://localhost:${webuiPort}`;
    const manual = () => {
      console.log('\nAdd the tool server in Open WebUI yourself (Admin Panel > Settings > External Tools, type OpenAPI, Bearer auth):');
      console.log(`  URL: ${dockerToolUrl(toolPort)}  (http://localhost:${toolPort}/tools when added under your own Settings > Tools)`);
      console.log(`  Key: ${toolKey}`);
    };
    if (!(await dockerComposeAvailable())) {
      console.log('\nDocker is not available, so Open WebUI was not started. Install Docker Desktop and run this again, or use an Open WebUI you already have.');
      manual();
      if (opts.open) await openBrowser(appUrl);
    } else {
      console.log('\nStarting Open WebUI (the first start downloads its image, which takes a few minutes)...');
      if (!(await composeUp(dir))) {
        console.log('docker compose failed; see the output above.');
        manual();
      } else if (await waitForHttp(`${webuiUrl}/health`, 180_000)) {
        console.log(`\nOpen WebUI is ready at ${webuiUrl} with the "D365FO test runner" tools connected.`);
        console.log('Pick a chat model with tool calling, turn the tools on with the + button, and ask for example: "List my profiles and dry-run examples/testcases".');
        console.log('If you already had Open WebUI data from before, check the key under Admin Panel > Settings > External Tools:');
        manual();
        if (opts.open) await openBrowser(webuiUrl);
      } else {
        console.log(`Open WebUI did not answer at ${webuiUrl} yet. Check it with: docker compose -f openwebui/docker-compose.yml logs`);
      }
    }
    if (ui) {
      console.log('\nKeep this window open while you use the chat. Press Ctrl+C to stop the settings app (Open WebUI keeps running; stop it with npm run openwebui:down).');
      const stop = (): void => void ui!.close().then(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    }
  });

async function launcherContext(): Promise<LauncherContext> {
  return { platform: process.platform, repoRoot: defaultRepoRoot(), nodePath: process.execPath, home: agentHome(), desktop: await desktopDirectory() };
}

program
  .command('install-launcher')
  .description('Put a D365FO Agent icon on your desktop that starts the settings app and opens it in your browser')
  .action(async () => {
    const plan = await installLauncher(await launcherContext());
    console.log(`Created ${plan.entry}`);
    console.log('Double-click it to start the settings app. Close its window to stop.');
  });

program
  .command('uninstall-launcher')
  .description('Remove the desktop icon (saved profiles are kept)')
  .action(async () => {
    const removed = await uninstallLauncher(await launcherContext());
    console.log(removed.length ? `Removed:\n${removed.map((p) => `  ${p}`).join('\n')}` : 'Nothing to remove.');
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});
