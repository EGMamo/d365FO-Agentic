#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { describeSuggestions, parameterSuggestions } from '../core/suggestions.js';
import { activeModel, loadConfig, validateForRun } from '../config/index.js';
import { dotenvFileProblems } from '../config/dotenv-check.js';
import { AzureDevOpsClient } from '../devops/client.js';
import { azdoAuthMode, azLogin, azTokenProblem } from '../devops/auth.js';
import { ODataClient } from '../d365fo/odata.js';
import { BrowserTokenSource, dataClientId, fnoOrigin, odataAuthMode, signInFile } from '../d365fo/odata-auth.js';
import { writeReports } from '../reporting/reporters.js';
import type { TestCase, TestResult } from '../testing/types.js';
import { discoverTestCases, executeTestRun } from '../core/runner.js';
import { checkSession, probeBlocksRun, probeSession, DEFAULT_SESSION_FILE, interactiveSessionLogin } from '../d365fo/session.js';
import { checkPlaywrightBrowser } from '../mcp/playwright-browser.js';
import { ANTHROPIC_DEFAULT_BASE_URL, checkAnthropicEndpoint, normalizeAnthropicBaseUrl } from '../llm/endpoint.js';
import { normalizeOpenAiBaseUrl } from '../llm/openai.js';
import { allowedHosts, assertSafeEnvironment, describeEnvironment } from '../d365fo/environment.js';
import { environmentForChild, modelSelection, overriddenKeys, profileSelection } from '../config/load-env.js';
import { RunHistory } from '../ui/history.js';
import { agentHome } from '../profiles/paths.js';
import { DEFAULT_PORT, findRunningUi, loadOrCreateToken, startUiServer } from '../ui/server.js';
import { openBrowser } from '../ui/open.js';
import { configureNetwork, redactProxy } from '../net/network.js';
import { readReplayResults, replayTestResults, startReplay } from '../replay/replay.js';

// Before any request: trust the OS certificate store and use HTTPS_PROXY on corporate networks.
const network = configureNetwork();

const program = new Command();
program
  .name('d365fo-agent')
  .description('Portable AI agent for D365 F&O regression and unit testing')
  .version('0.1.0')
  .option('--profile <name>', 'Use an environment profile (name or permanent id)');

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
    console.log(`Network: ${network.proxy ? `proxy ${redactProxy(network.proxy)}` : 'direct (no HTTPS_PROXY)'}; ${network.systemCertificates} certificate(s) added from the system store`);
    for (const note of network.notes) console.log(`  NOTE: ${note}`);
    console.log(`LLM provider: ${cfg.LLM_PROVIDER} (${activeModel(cfg)})`);
    if (cfg.LLM_PROVIDER === 'anthropic') {
      const openai = cfg.LLM_API_FORMAT === 'openai';
      console.log(`API format: ${openai ? 'OpenAI-compatible chat completions' : 'Claude Messages API'}`);
      const custom = openai ? normalizeOpenAiBaseUrl(cfg.ANTHROPIC_BASE_URL) : normalizeAnthropicBaseUrl(cfg.ANTHROPIC_BASE_URL);
      if (!custom) {
        console.log(`Claude API URL: default (${ANTHROPIC_DEFAULT_BASE_URL})`);
      } else if (!/^https?:\/\//i.test(custom)) {
        console.log(`Claude API URL: INVALID (${custom})`);
      } else {
        const ep = await checkAnthropicEndpoint(custom, { apiKey: cfg.ANTHROPIC_API_KEY, authToken: cfg.ANTHROPIC_AUTH_TOKEN }, 6000, fetch, openai ? 'openai' : 'anthropic');
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
    if (cfg.AZDO_ORG_URL && cfg.AZDO_PROJECT) {
      const how = azdoAuthMode(cfg) === 'pat' ? 'personal access token' : 'Microsoft account (az login)';
      const ado = await new AzureDevOpsClient(cfg).check();
      console.log(`Azure DevOps: ${ado.ok ? 'OK' : 'FAILED'} - ${cfg.AZDO_ORG_URL} / ${cfg.AZDO_PROJECT}, ${how}: ${ado.detail}`);
      // Only a problem for a profile that reads a test plan; otherwise Azure DevOps is optional.
      if (!ado.ok && cfg.AZDO_TEST_PLAN_ID) issues.push(`Azure DevOps: ${ado.detail}`);
    } else {
      console.log('Azure DevOps: not configured (optional)');
    }
    // Optional: reading F&O data (OData) to check prerequisites. A problem here never stops a run.
    if (!cfg.AGENT_ODATA || !cfg.D365_BASE_URL) {
      console.log(`F&O data access (OData): ${cfg.AGENT_ODATA ? 'no F&O address' : 'off (AGENT_ODATA=false)'}`);
    } else {
      try {
        const data = await new ODataClient(cfg).check();
        console.log(`F&O data access (OData): ${data.ok ? 'OK' : 'NOT READY'} - ${data.detail}`);
      } catch (e) {
        console.log(`F&O data access (OData): NOT READY - ${(e as Error).message.split('\n')[0]}`);
      }
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
  .command('d365-data-login')
  .description('Sign in once, in a browser, so the agent can read F&O data over OData (read only). MFA is fine; later runs reuse the sign-in')
  .option('--logout', 'Forget the saved data-access sign-in instead')
  .action(async (opts: { logout?: boolean }) => {
    const cfg = loadConfig();
    // Plain messages, no stack trace: the settings app shows this output as it is.
    try {
      const origin = fnoOrigin(cfg.D365_BASE_URL);
      const source = new BrowserTokenSource(origin, signInFile(cfg), undefined, undefined, dataClientId(cfg));
      if (opts.logout) {
        await source.logout();
        console.log('The data-access sign-in was removed.');
        return;
      }
      console.log(`Opening the Microsoft sign-in for ${origin} in your browser. Finish it there, then come back here.`);
      const { account } = await source.login();
      console.log(`Signed in${account ? ` as ${account}` : ''}. The sign-in is kept for this profile.`);
      const mode = odataAuthMode(cfg);
      if (mode !== 'browser') console.log(`Note: this profile reads data with the ${mode} sign-in. Set "Data access sign-in" to browser (D365_ODATA_AUTH=browser) to use this one.`);
      const check = await new ODataClient(cfg, source).check();
      console.log(`F&O data access (OData): ${check.ok ? 'OK' : 'NOT READY'} - ${check.detail}`);
      if (!check.ok) process.exitCode = 1;
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 1;
    }
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
  .option('--all-iterations', 'Run every Azure DevOps parameter row (default: only the first row)')
  .option('--fail-on <outcomes>', 'Exit with code 2 when any case ends with one of these outcomes (comma-separated, e.g. failed,blocked)')
  .option('--dry-run', 'Skip state-changing browser actions (click/type/fill/...); navigation and snapshots still run')
  .option('--upload', 'Upload results to Azure DevOps after the run')
  .option('--probe-session', 'Before running tests, verify the saved D365 session with one HTTP probe and fail fast if it is expired')
  .option('--preflight <mode>', 'Unresolved placeholders (TBC) for existing data: block = end the case blocked before it runs (default), partial = run only the other steps, off = no check')
  .action(async (opts: {
    plan?: string;
    suite?: string;
    local?: string;
    case?: string;
    tag: string[];
    module: string[];
    maxPriority?: number;
    sortByPriority?: boolean;
    allIterations?: boolean;
    failOn?: string;
    dryRun?: boolean;
    upload?: boolean;
    probeSession?: boolean;
    preflight?: string;
  }) => {
    const cfg = loadConfig();
    const runStartedAt = new Date().toISOString();
    const warnings: string[] = [];
    if (opts.dryRun) cfg.AGENT_DRY_RUN = true;
    if (opts.preflight !== undefined) {
      const mode = opts.preflight.trim().toLowerCase();
      if (mode !== 'block' && mode !== 'partial' && mode !== 'off') {
        console.error('config: --preflight takes block, partial or off');
        process.exit(1);
      }
      cfg.AGENT_PREFLIGHT = mode;
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
        allIterations: opts.allIterations,
        signal: interrupt.signal,
        dryRun: cfg.AGENT_DRY_RUN,
        upload: opts.upload,
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
    const suggested = parameterSuggestions(execution.results);
    if (suggested.length && cfg.AZDO_ORG_URL && cfg.AZDO_PROJECT) {
      console.log('\nThe agent chose these values for parameters the test case leaves unset (the cases passed with them):');
      for (const line of describeSuggestions(suggested)) console.log(line);
      console.log(`Save them to the test case parameters (only parameters without a value are filled; you are asked first):\n  d365fo-agent ${profileSelection.name ? `--profile "${profileSelection.name}" ` : ''}save-parameters`);
    }
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
  .command('replay [filters...]')
  .description('Replay generated standalone Playwright tests without a model or MCP')
  .option('--grep <pattern>', 'Only run tests whose titles match this Playwright grep pattern')
  .option('--headed', 'Run the browser headed')
  .option('--upload', 'Explicitly upload the fresh replay results to Azure DevOps')
  .option('--plan <id>', 'Azure DevOps test plan id for --upload')
  .action(async (filters: string[], opts: { grep?: string; headed?: boolean; upload?: boolean; plan?: string }) => {
    const cfg = loadConfig();
    if (!cfg.D365_BASE_URL) throw new Error('D365_BASE_URL is required to replay tests against the active profile');
    assertSafeEnvironment(cfg);
    const interrupt = new AbortController();
    let stopCode = 130;
    const onStop = (sig: NodeJS.Signals): void => {
      stopCode = sig === 'SIGTERM' ? 143 : 130;
      if (interrupt.signal.aborted) process.exit(stopCode);
      interrupt.abort();
      console.error(`\nInterrupted (${sig}): stopping Playwright. Results from an incomplete replay are not uploaded.`);
    };
    process.on('SIGINT', onStop);
    process.on('SIGTERM', onStop);
    console.log('Replaying standalone Playwright tests (no model or MCP).');
    const replay = startReplay(cfg, { files: filters, grep: opts.grep, headed: opts.headed, signal: interrupt.signal }, (text) => process.stdout.write(text));
    const code = await replay.done;
    process.off('SIGINT', onStop);
    process.off('SIGTERM', onStop);
    const rows = readReplayResults(cfg, replay.startedAt);
    if (opts.upload) {
      if (interrupt.signal.aborted) throw new Error('Not uploaded: the replay was interrupted.');
      const mappable = rows.filter((r) => /^\d+$/.test(r.caseId));
      if (!mappable.length) throw new Error('Not uploaded: this replay wrote no fresh results with Azure DevOps test case ids.');
      const planId = opts.plan ?? cfg.AZDO_TEST_PLAN_ID;
      if (!planId) throw new Error('--plan or AZDO_TEST_PLAN_ID is required to upload replay results');
      const uploaded = await new AzureDevOpsClient(cfg).publishResults(planId, replayTestResults(mappable));
      console.log(`Uploaded replay results to Azure DevOps run #${uploaded.runId}: ${uploaded.url}`);
    }
    if (interrupt.signal.aborted) process.exitCode = stopCode;
    else if (code !== 0 || !rows.length) process.exitCode = code === 0 && !rows.length ? 1 : (code ?? 1);
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
  .command('save-parameters')
  .description('Save the parameter values the agent chose from F&O to the Azure DevOps test cases (only parameters that have no value yet)')
  .option('--input <file>', 'results.json of a run (default: the latest run of this profile)')
  .option('--case <ids>', 'Only these test-case ids (comma-separated)')
  .option('--yes', 'Save without asking')
  .action(async (opts: { input?: string; case?: string; yes?: boolean }) => {
    const cfg = loadConfig();
    const file = opts.input ?? join(resolve(cfg.REPORT_DIR), 'results.json');
    // Plain messages, no stack trace: the settings app shows this output as it is.
    let results: TestResult[];
    try {
      results = JSON.parse(await readFile(file, 'utf8')) as TestResult[];
    } catch {
      console.error(`Could not read the results in ${file}. Run the cases first, or pass --input.`);
      process.exitCode = 1;
      return;
    }
    const only = (opts.case ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const list = parameterSuggestions(results, only);
    if (!list.length) {
      console.log('No parameter values to save: the agent chose none for a passed Azure DevOps test case in these results.');
      return;
    }
    if (!cfg.AZDO_ORG_URL || !cfg.AZDO_PROJECT) {
      console.error('Azure DevOps is not set up for this profile (organization URL and project).');
      process.exitCode = 1;
      return;
    }
    console.log(`These values will be saved to the test case parameters in ${cfg.AZDO_ORG_URL} / ${cfg.AZDO_PROJECT}:`);
    for (const line of describeSuggestions(list)) console.log(line);
    console.log('Only parameters without a value are filled; values already in the table are never changed.');
    if (!opts.yes) {
      if (!process.stdin.isTTY) {
        console.error('Not saved: this is not an interactive terminal. Run it again with --yes to save without asking.');
        process.exitCode = 1;
        return;
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question('Save them? [y/N] ')).trim().toLowerCase();
      rl.close();
      if (answer !== 'y' && answer !== 'yes') {
        console.log('Not saved.');
        return;
      }
    }
    const client = new AzureDevOpsClient(cfg);
    for (const s of list) {
      try {
        const { saved, skipped } = await client.saveParameterValues(s.caseId, Object.fromEntries(s.values.map((v) => [v.name, v.value])));
        console.log(`Case ${s.caseId}: saved ${saved.length ? saved.map((n) => `@${n}`).join(', ') : 'nothing'}${skipped.length ? `; left ${skipped.map((n) => `@${n}`).join(', ')} as it already had a value` : ''}.`);
      } catch (e) {
        console.error(`Case ${s.caseId}: ${(e as Error).message.split('\n')[0].slice(0, 400)}`);
        process.exitCode = 1;
      }
    }
  });

program
  .command('ui')
  .description('Start the local settings web app and open it in your browser')
  .option('--port <n>', `Port to listen on (default ${DEFAULT_PORT})`, intArg)
  .option('--no-open', 'Do not open the browser')
  .action(async (opts: { port?: number; open: boolean;  }) => {
    const home = agentHome();
    const existing = await findRunningUi(home, await loadOrCreateToken(home));
    if (existing) {
      console.log(`The settings app is already running: ${existing.split('?')[0]}`);
      if (opts.open) await openBrowser(existing);
      return;
    }
    const ui = await startUiServer({ home, port: opts.port, childEnv: environmentForChild });
    console.log(`Settings app running at ${ui.url} (this computer only). Press Ctrl+C to stop.`);
    console.log(`Profiles are stored in ${home}`);
    if (opts.open && !(await openBrowser(ui.openUrl))) console.log(`Could not open a browser. Open this address yourself: ${ui.openUrl}`);
    const stop = (): void => void ui.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});
