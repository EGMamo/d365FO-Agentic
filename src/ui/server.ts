import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultRepoRoot } from '../runtime/paths.js';
import { FIELD_CATALOG, GROUP_INFO, PROVIDER_LABELS } from '../profiles/catalog.js';
import { FAILURE_CATEGORY_HINTS } from '../testing/triage.js';
import { serverFile, tokenFile, legacyToolTokenFile, toolTokenFile } from '../profiles/paths.js';
import { isSecretKey, ProfileError, ProfileStore } from '../profiles/store.js';
import { AiSettings } from '../profiles/ai.js';
import { discoverTestCases } from '../core/runner.js';
import { resolveCaseDir, TestCaseFileError, TestCaseFiles } from '../testing/store.js';
import { HistoryIndex, REPORT_FILES, RunHistory, type ReportFile } from './history.js';
import { compareResults, failedCaseIds, MAX_WAIT_SECONDS, nextStep, openApiSpec, runProgress, runSource, summarizeResults, TOOLS_PREFIX } from './tools.js';
import { AzureDevOpsClient } from '../devops/client.js';
import { environmentForChild } from '../config/load-env.js';
import { parseConfig, type AppConfig } from '../config/index.js';
import { createLlmProvider } from '../llm/index.js';
import { checkModel as checkModelEndpoint } from '../llm/check.js';
import { redactSecrets } from '../d365fo/login.js';
import type { LlmProvider } from '../llm/types.js';
import type { TestResult } from '../testing/types.js';
import { chatToolCatalog } from './chat/catalog.js';
import { ChatService } from './chat/service.js';
import { createChatController } from './chat/controller.js';
import { JsonChatRepository } from './chat/store.js';
import type { ChatRepository } from './chat/types.js';

/**
 * Local web UI for managing profiles. It binds to the loopback interface only and is meant to be opened from the
 * desktop app or `npm run ui`. Three checks keep other web pages and other local users away from the secrets it manages:
 * the Host header must be this server (blocks DNS rebinding), writes must come from this page (Origin and a custom
 * header, blocks cross-site forms) and every request needs the per-machine token held in a cookie.
 * Optional OpenAPI integration routes under /tools are the exception: they take a bearer token instead (see tools.ts).
 */
export const DEFAULT_PORT = 4365;
const COOKIE = 'd365fo_ui';
const MAX_BODY = 256 * 1024;
const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const MAX_LINES = 5000;
/** Files of the app page besides index.html, with their content types. */
const STATIC_ASSETS: Record<string, string> = {
  'icon.svg': 'image/svg+xml',
  'app.css': 'text/css; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'chat.css': 'text/css; charset=utf-8',
  'chat.js': 'text/javascript; charset=utf-8',
  'markdown.js': 'text/javascript; charset=utf-8',
};
const assetCache = new Map<string, Buffer>();
/** The page's files are read once; set D365FO_UI_DEV=1 to re-read them on every request while editing. */
async function asset(name: string): Promise<Buffer> {
  const hit = process.env.D365FO_UI_DEV ? undefined : assetCache.get(name);
  if (hit) return hit;
  const body = await readFile(join(WEB_DIR, name));
  assetCache.set(name, body);
  return body;
}
const ID = /^[\w.-]{1,64}$/;

interface RunState {
  id: number;
  kind: 'run' | 'upload';
  status: 'running' | 'passed' | 'failed' | 'stopped';
  args: string[];
  /** The profile the run belongs to. */
  profile?: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  lines: string[];
  /** Absolute number of the first line kept in `lines` (older lines are dropped past MAX_LINES). */
  base: number;
  child?: ChildProcess;
  stopRequested?: boolean;
  /** Set once the job has ended and its history entry is written, so its results can be read. */
  settled?: boolean;
  phase: 'starting' | 'running' | 'finalizing' | 'finished';
}

export interface ToolActionApproval {
  kind: 'run' | 'rerun' | 'upload';
  profile: string | null;
  environment?: { url: string; company: string };
  source?: { type: 'local'; folder: string } | { type: 'devops'; plan?: string; suite?: string };
  cases: string[];
  runId?: string;
  plan?: string;
  devops?: { organization: string; project: string };
}

export interface UiServerOptions {
  home: string;
  /** Path of the CLI entry point, run for the "check setup" button. */
  cliPath?: string;
  port?: number;
  host?: string;
  /** Project folder: test-case folders and the report folder are resolved inside it. Defaults to the repo root. */
  root?: string;
  /**
   * Environment for the commands the app starts (checks, runs, uploads). It must not contain what this process
   * read from its own settings file, or those values would override the profile the command is told to use.
   * Defaults to this process's environment.
   */
  childEnv?: () => NodeJS.ProcessEnv;
  /** Builds the chat model from the profile in use. Defaults to the provider the profile selects; tests pass a fake. */
  modelProvider?: (cfg: AppConfig) => LlmProvider;
  /** Builds the Azure DevOps client for the profile in use (test plans and suites). Tests pass a fake. */
  devopsClient?: (cfg: AppConfig) => Pick<AzureDevOpsClient, 'listPlans' | 'listSuites'>;
  /** Native, non-model approval for live chat runs/reruns and uploads. Without it those tool actions are denied. */
  approveToolAction?: (action: ToolActionApproval) => Promise<boolean>;
  /** Conversation persistence. Defaults to private per-user JSON storage in the agent home. */
  chatRepository?: ChatRepository;
}

export interface RunningUi {
  server: Server;
  port: number;
  token: string;
  url: string;
  /** The URL that signs the browser in (sets the cookie) and then lands on the app. */
  openUrl: string;
  /** Bearer token for the optional OpenAPI integration endpoint at `<url>tools`. */
  toolToken: string;
  close: () => Promise<void>;
}

async function loadOrCreate(home: string, file: string): Promise<string> {
  try {
    const t = (await readFile(file, 'utf8')).trim();
    if (t.length >= 32) return t;
  } catch {
    /* create below */
  }
  const token = randomBytes(24).toString('hex');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(file, token, { mode: 0o600 });
  return token;
}

export const loadOrCreateToken = (home: string): Promise<string> => loadOrCreate(home, tokenFile(home));
/** The key external integration clients send to the tool routes. Delete the file and restart to rotate it. */
export const loadOrCreateToolToken = async (home: string): Promise<string> => {
  const file = toolTokenFile(home);
  try {
    const t = (await readFile(file, 'utf8')).trim();
    if (t.length >= 32) return t;
  } catch {
    /* create below */
  }
  // An install from before the Open WebUI runtime was removed keeps its token, so external
  // integrations stay connected across the upgrade.
  const previous = legacyToolTokenFile(home);
  try {
    const t = (await readFile(previous, 'utf8')).trim();
    if (t.length >= 32) {
      await mkdir(home, { recursive: true, mode: 0o700 });
      await writeFile(file, t, { mode: 0o600 });
      return t;
    }
  } catch {
    /* no previous token */
  }
  return loadOrCreate(home, file);
};

const same = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

function cookieValue(req: IncomingMessage): string {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) {
      try {
        return decodeURIComponent(v.join('='));
      } catch {
        // Malformed credentials are unauthenticated, not server errors.
        return '';
      }
    }
  }
  return '';
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const isText = typeof body === 'string';
  res.writeHead(status, {
    'Content-Type': isText ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    ...headers,
  });
  res.end(isText ? body : JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new ProfileError('Request is too large.', 413);
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new ProfileError('Request body is not valid JSON.');
  }
}

/** Secret values of a profile, used to scrub child-process output before it reaches the browser. */
async function profileSecrets(store: ProfileStore, name: string, env: NodeJS.ProcessEnv = {}): Promise<string[]> {
  return [...await store.read(name, true), ...await new AiSettings(store.home).read(true), ...Object.entries(env).map(([key, value]) => ({ key, value: value ?? '' }))].filter((e) => isSecretKey(e.key) && e.value.length >= 4).map((e) => e.value);
}

/** Runs `doctor` against a profile and returns its output with that profile's secrets scrubbed. */
function runDoctor(store: ProfileStore, name: string, cliPath: string, baseEnv: NodeJS.ProcessEnv): Promise<{ exitCode: number | null; output: string }> {
  return runProfileCommand('doctor', 90_000, store, name, cliPath, baseEnv);
}

/** Runs a CLI command against a profile and returns its output with that profile's secrets scrubbed. */
async function runProfileCommand(command: 'doctor' | 'devops-login' | 'session-login', timeoutMs: number, store: ProfileStore, name: string, cliPath: string, baseEnv: NodeJS.ProcessEnv, extra: string[] = []): Promise<{ exitCode: number | null; output: string }> {
  const secrets = await profileSecrets(store, name, baseEnv);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, command, ...extra], {
      env: { ...baseEnv, D365FO_PROFILE: name, D365FO_AGENT_HOME: store.home, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const add = (b: Buffer): void => {
      if (output.length < 20_000) output += b.toString('utf8');
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const done = (exitCode: number | null): void => {
      clearTimeout(timer);
      for (const s of secrets) output = output.split(s).join('***');
      resolve({ exitCode, output: output.trim() });
    };
    child.on('error', (e) => {
      output += `Could not start the check: ${e.message}`;
      done(null);
    });
    child.on('close', done);
  });
}

export async function startUiServer(opts: UiServerOptions): Promise<RunningUi> {
  const store = new ProfileStore(opts.home);
  const ai = new AiSettings(opts.home);
  await ai.migrate(store);
  const token = await loadOrCreateToken(opts.home);
  const toolToken = await loadOrCreateToolToken(opts.home);
  const host = opts.host ?? '127.0.0.1';
  let port = opts.port ?? DEFAULT_PORT;
  const cliPath = opts.cliPath ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'index.js');
  const repoRoot = opts.root ?? defaultRepoRoot();
  const childEnv = opts.childEnv ?? environmentForChild;
  const caseFiles = new TestCaseFiles(repoRoot);
  let run: RunState | undefined;
  let runSeq = 0;
  const listeners = new Set<ServerResponse>();
  const chatRepository = opts.chatRepository ?? new JsonChatRepository(join(opts.home, 'chats'));
  const chatService = new ChatService({
    repository: chatRepository,
    provider: async () => (opts.modelProvider ?? createLlmProvider)(await modelConfig()),
    tools: () => chatToolCatalog(executeChatOperation),
    redact: async (message) => {
      const cfg = await modelConfig().catch(() => undefined);
      return cfg ? redactSecrets(cfg, message) : message;
    },
  });
  const chatController = createChatController({ repository: chatRepository, service: chatService, send, readJson });
  /** get_run calls waiting for the current job to settle. */
  const settleWaiters = new Set<() => void>();

  const broadcast = (event: string, data: unknown): void => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of listeners) res.write(msg);
  };
  const jobBusy = (): boolean => Boolean(run && !run.settled);
  const publicRun = (r: RunState) => ({ id: r.id, kind: r.kind, status: r.settled ? r.status : 'running', phase: r.phase, args: r.args, profile: r.profile ?? null, startedAt: r.startedAt, finishedAt: r.finishedAt, exitCode: r.exitCode });
  type StartResult = { error?: string; status?: number; busy?: boolean; run?: ReturnType<typeof publicRun>; cases?: string[] };
  const settleJob = (state: RunState): void => {
    state.finishedAt ??= new Date().toISOString();
    state.phase = 'finished';
    state.settled = true;
    history.invalidate();
    for (const wake of [...settleWaiters]) wake();
    broadcast('status', { ...publicRun(state), settled: true, savedAs: savedRunId(state) });
  };
  /** Claim the slot before the first await, including source lookup and native approval. */
  async function reservedJob(kind: RunState['kind'], action: (state: RunState) => Promise<StartResult>): Promise<StartResult> {
    if (jobBusy()) return { error: 'A run is already in progress', busy: true };
    const state: RunState = { id: ++runSeq, kind, status: 'running', phase: 'starting', args: [], startedAt: new Date().toISOString(), lines: [], base: 0 };
    run = state;
    broadcast('status', publicRun(state));
    try {
      const result = await action(state);
      if (result.error) {
        state.status = state.stopRequested ? 'stopped' : 'failed';
        settleJob(state);
      }
      return result;
    } catch (e) {
      state.status = state.stopRequested ? 'stopped' : 'failed';
      settleJob(state);
      throw e;
    }
  }
  /** The run as the app page shows it: status, per-case progress and the log lines after `since` (absolute line number). */
  const runForPage = (r: RunState, since?: number) => {
    const total = r.base + r.lines.length;
    const from = since === undefined || since < r.base || since > total ? r.base : since;
    return {
      ...publicRun(r),
      ...(r.kind === 'run' ? { progress: runProgress(r.lines) } : {}),
      settled: Boolean(r.settled),
      savedAs: savedRunId(r),
      lineCount: total,
      from,
      lines: r.lines.slice(from - r.base),
    };
  };
  const savedRunId = (r: RunState): string | undefined => r.lines.map((l) => /^Saved to run history as ([\w-]+)\.$/.exec(l)).find(Boolean)?.[1];

  /** Starts the CLI as a child so a run reads the current profile, and streams its stdout/stderr back. */
  function runCli(args: string[], active?: string): ChildProcess {
    const env: NodeJS.ProcessEnv = { ...childEnv(), FORCE_COLOR: '0', NO_COLOR: '1', D365FO_ORIGIN: 'app' };
    env.D365FO_AGENT_HOME = store.home;
    env.D365FO_PROFILE = active ?? 'none';
    if (args[0] === 'run') env.AGENT_DRY_RUN = String(args.includes('--dry-run'));
    return spawn(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
  }

  function runArguments(body: Record<string, unknown>): { args: string[]; cases: string[]; error?: string } {
    const bad = (error: string) => ({ args: [], cases: [], error });
    if (['model', 'retries', 'upload', 'tags', 'modules', 'maxPriority', 'sortByPriority'].some((key) => body[key] !== undefined)) return bad('Choose cases and use the shared AI connection. Upload a selected result after the run.');
    const args = ['run'];
    const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
    if (body.source === 'local') {
      const dir = str('local');
      if (!dir) return bad('Choose a local test-case directory');
      resolveCaseDir(repoRoot, dir);
      args.push('--local', dir);
    } else if (body.source === 'devops') {
      const plan = str('plan');
      const suite = str('suite');
      for (const [name, v] of [['plan', plan], ['suite', suite]]) if (v && !/^\d+$/.test(v)) return bad(`Invalid ${name} id`);
      if (plan) args.push('--plan', plan);
      if (suite) args.push('--suite', suite);
    } else return bad('Choose a local or Azure DevOps source.');
    const caseIds = [str('caseId'), ...(Array.isArray(body.cases) ? (body.cases as unknown[]).map((c) => (typeof c === 'string' ? c.trim() : '')) : [])].filter(Boolean);
    if (caseIds.some((c) => !ID.test(c))) return bad('Invalid case id');
    if (caseIds.length) args.push('--case', caseIds.join(','));
    if (body.dryRun === true) args.push('--dry-run');
    args.push('--fail-on', 'failed,blocked');
    return { args, cases: [...new Set(caseIds)] };
  }

  async function configForProfile(profile: string | undefined): Promise<AppConfig> {
    return parseConfig({ ...(profile ? Object.fromEntries((await store.read(profile, true)).map((e) => [e.key, e.value])) : {}), ...childEnv() });
  }

  async function launchRun(state: RunState, body: Record<string, unknown>, fromTools: boolean, rerunId?: string): Promise<StartResult> {
    const parsed = runArguments(body);
    if (parsed.error) return { error: parsed.error };
    const active = await store.getActive();
    state.profile = active;
    state.args = parsed.args;
    if (fromTools && body.dryRun !== true) {
      if (!opts.approveToolAction) return { error: 'A native approval is required for live chat runs. Start this run from Tests instead.', status: 403 };
      const cfg = await configForProfile(active);
      if (!active || !cfg.D365_BASE_URL) return { error: 'Choose an environment with an F&O address before starting a live chat run.' };
      const source: NonNullable<ToolActionApproval['source']> = body.source === 'local'
        ? { type: 'local', folder: resolveCaseDir(repoRoot, String(body.local).trim()) }
        : { type: 'devops', plan: String(body.plan || cfg.AZDO_TEST_PLAN_ID || ''), suite: String(body.suite || cfg.AZDO_TEST_SUITE_ID || '') };
      const available = source.type === 'local'
        ? (await caseFiles.list(String(body.local).trim())).filter((c) => !c.error)
        : await discoverTestCases(cfg, { plan: source.plan, suite: source.suite });
      const known = new Set(available.map((c) => c.id));
      const cases = parsed.cases.length ? parsed.cases : [...known];
      if (!cases.length || cases.some((id) => !known.has(id))) return { error: 'The selected cases are missing from that source. Load the cases again before running.' };
      const approved = await opts.approveToolAction({ kind: rerunId ? 'rerun' : 'run', profile: active, environment: { url: cfg.D365_BASE_URL, company: cfg.D365_COMPANY }, source, cases, ...(rerunId ? { runId: rerunId } : {}) });
      if (!approved) return { error: 'The live run was not approved.', status: 403 };
      // Bind an "all cases" approval to the exact selection shown in the native dialog.
      if (!parsed.cases.length) parsed.args.push('--case', cases.join(','));
    }
    return startCli(state, parsed.args, active);
  }

  async function startRun(body: Record<string, unknown>, fromTools = false): Promise<StartResult> {
    const parsed = runArguments(body);
    if (parsed.error) return { error: parsed.error };
    return reservedJob('run', (state) => launchRun(state, body, fromTools));
  }

  /** Upload a saved run using its original environment, reserving the slot during all lookups. */
  async function startUpload(id: string, body: Record<string, unknown>, fromTools = false): Promise<StartResult> {
    return reservedJob('upload', async (state) => {
    if (fromTools && !opts.approveToolAction) return { error: 'A native approval is required for chat uploads. Upload this run from Results instead.', status: 403 };
    const input = await history.file(id, 'results.json');
    if (!input) return { error: 'That run has no results to upload.' };
    // Always the profile the run belongs to, whichever profile is in use now.
    const meta = await history.meta(id);
    let owner: string | undefined;
    if (meta?.profileId || meta?.profile) {
      owner = await store.resolve(meta.profileId || '').then((n) => n ?? store.resolve(meta.profile || ''));
      if (!owner) return { error: `The profile this run belongs to (${meta.profile ?? meta.profileId}) no longer exists, so its Azure DevOps settings are gone. Create it again, or upload from the terminal with --profile.` };
    }
    const args = ['upload', '--input', input];
    const plan = typeof body.plan === 'string' ? body.plan.trim() : '';
    if (plan) {
      if (!/^\d+$/.test(plan)) return { error: 'Invalid plan id' };
      args.push('--plan', plan);
    }
    state.args = args;
    state.profile = owner ?? (await store.getActive());
    if (fromTools) {
      const cfg = await configForProfile(state.profile);
      const selectedPlan = plan || cfg.AZDO_TEST_PLAN_ID;
      if (!cfg.AZDO_ORG_URL || !cfg.AZDO_PROJECT || !selectedPlan || !/^\d+$/.test(selectedPlan)) return { error: 'The saved run needs a configured Azure DevOps organization, project and numeric test plan.' };
      if (!plan) args.push('--plan', selectedPlan);
      const results = JSON.parse(await readFile(input, 'utf8')) as TestResult[];
      const approved = await opts.approveToolAction!({ kind: 'upload', profile: state.profile ?? null, cases: results.map((r) => r.testCaseId), runId: id, plan: selectedPlan, devops: { organization: cfg.AZDO_ORG_URL, project: cfg.AZDO_PROJECT } });
      if (!approved) return { error: 'The upload was not approved.', status: 403 };
    }
    return startCli(state, args, state.profile, async (state) => {
      const line = state.lines.find((l) => /^Uploaded run #\d+/.test(l));
      const m = line && /^Uploaded run #(\d+): (\S+)/.exec(line);
      if (state.status === 'passed') await history.update(id, { upload: { runId: m ? Number(m[1]) : undefined, url: m ? m[2] : undefined, at: new Date().toISOString() } });
    });
    });
  }

  async function startCli(
    state: RunState,
    args: string[],
    profile?: string,
    onDone?: (state: RunState) => Promise<void>,
  ): Promise<StartResult> {
    const active = profile ?? (await store.getActive());
    if (active) await store.idOf(active); // older profiles get their id (and report folder) before the run reads the file
    const secrets = active ? await profileSecrets(store, active, childEnv()) : (await ai.read(true)).filter((e) => isSecretKey(e.key)).map((e) => e.value);
    if (state.stopRequested) return { error: 'The job was stopped before it started.' };
    state.profile = active;
    state.args = args;
    state.phase = 'running';
    const kind = state.kind;
    const push = (line: string): void => {
      let clean = line;
      for (const s of secrets) clean = clean.split(s).join('***');
      state.lines.push(clean);
      if (state.lines.length > MAX_LINES) {
        const drop = state.lines.length - MAX_LINES;
        state.lines.splice(0, drop);
        state.base += drop;
      }
      broadcast('line', { id: state.id, line: clean, n: state.base + state.lines.length - 1 });
      // Case boundaries change the progress the page shows; other lines only extend the log.
      if (/^(?:▶ Running \[|→ |Running \d+ test case)/.test(clean.trim())) broadcast('progress', { id: state.id, progress: runProgress(state.lines) });
    };
    push(`$ d365fo-agent ${args.join(' ')}`);
    const child = runCli(args, active);
    state.child = child;
    for (const stream of [child.stdout, child.stderr]) {
      let buf = '';
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk: string) => {
        buf += chunk;
        const parts = buf.split(/\r?\n/);
        buf = parts.pop() ?? '';
        for (const p of parts) push(p);
      });
      stream?.on('end', () => buf && push(buf));
    }
    child.on('error', (e) => push(`Failed to start: ${e.message}`));
    child.on('close', (code) => {
      state.exitCode = code;
      state.finishedAt = new Date().toISOString();
      state.status = state.stopRequested ? 'stopped' : code === 0 ? 'passed' : 'failed';
      state.phase = 'finalizing';
      state.child = undefined;
      const finish = async (): Promise<void> => {
        try {
          // The run saves itself to the history; only a run that failed before it could is recorded here.
          if (kind === 'run' && !state.lines.some((l) => /^Saved to run history as \d{8}-\d{6}-\d+\./.test(l))) {
            const meta = await new RunHistory(async () => active ? reportDirOf(active) : resolve(repoRoot, 'reports')).record(
              { status: state.status, args, profile: active ?? null, profileId: active ? await store.idOf(active) : null, origin: 'app', startedAt: state.startedAt, finishedAt: state.finishedAt },
              state.id,
            );
            push(`Saved to run history as ${meta.id}.`);
          }
          await onDone?.(state);
        } catch (e) {
          console.error(`[ui] could not update the run history: ${(e as Error).message}`);
        }
        settleJob(state);
      };
      void finish();
    });
    broadcast('status', publicRun(state));
    return { run: publicRun(state) };
  }

  function stopRun(): boolean {
    const child = run?.child;
    if (!run || run.settled || run.phase === 'finalizing') return false;
    run.stopRequested = true;
    if (!child?.pid) return true;
    // The run spawns MCP servers and a browser; signal the whole process group.
    const kill = (sig: NodeJS.Signals): void => {
      try {
        if (process.platform === 'win32') child.kill(sig);
        else process.kill(-child.pid!, sig);
      } catch {
        /* already gone */
      }
    };
    kill('SIGTERM');
    // SIGTERM lets the run mark the case in flight as interrupted and write its reports; give it time to do so.
    setTimeout(() => run?.child === child && kill('SIGKILL'), 20_000).unref();
    return true;
  }

  /** A profile's own report folder: its REPORT_DIR, else reports/<profile id>. */
  async function reportDirOf(name: string): Promise<string> {
    const explicit = (await store.read(name, true)).find((e) => e.key === 'REPORT_DIR')?.value;
    return resolve(repoRoot, explicit || join('reports', await store.idOf(name)));
  }
  /** The report folder the CLI writes to for the profile in use. */
  async function reportDir(): Promise<string> {
    const active = await store.getActive();
    return active ? reportDirOf(active) : resolve(repoRoot, 'reports');
  }
  /** Every folder that can hold runs: one per profile, and the plain reports folder of runs without a profile. */
  async function allReportDirs(): Promise<string[]> {
    const dirs = [resolve(repoRoot, 'reports')];
    for (const p of await store.list()) dirs.push(await reportDirOf(p.name).catch(() => resolve(repoRoot, 'reports')));
    return dirs;
  }
  const history = new HistoryIndex(allReportDirs);

  /** The last setup check of each profile, by profile id, so the environment cards can show it. */
  const checksFile = join(opts.home, 'setup-checks.json');
  async function readChecks(): Promise<Record<string, { ok: boolean; at: string }>> {
    try {
      return JSON.parse(await readFile(checksFile, 'utf8')) as Record<string, { ok: boolean; at: string }>;
    } catch {
      return {};
    }
  }
  async function checkProfile(name: string): Promise<{ exitCode: number | null; output: string }> {
    const result = await runDoctor(store, name, cliPath, childEnv());
    try {
      const checks = await readChecks();
      checks[await store.idOf(name)] = { ok: result.exitCode === 0, at: new Date().toISOString() };
      await writeFile(checksFile, JSON.stringify(checks, null, 2), { mode: 0o600 });
    } catch (e) {
      console.error(`[ui] could not save the setup check: ${(e as Error).message}`);
    }
    return result;
  }

  /** What an environment card shows: no secret values, only whether they are set. */
  async function profileCards() {
    const checks = await readChecks();
    const out = [];
    for (const p of await store.list()) {
      try {
        const map = new Map((await store.read(p.name, true)).map((e) => [e.key, e.value]));
        const id = await store.idOf(p.name);
        let host = '';
        try {
          host = map.get('D365_BASE_URL') ? new URL(map.get('D365_BASE_URL')!).host : '';
        } catch {
          host = map.get('D365_BASE_URL') ?? '';
        }
        out.push({
          ...p,
          id,
          host,
          company: map.get('D365_COMPANY') || '',
          type: map.get('D365_ENVIRONMENT_TYPE') || '',
          signIn: map.get('D365_STORAGE_STATE') ? 'session' : map.get('D365_USERNAME') && map.get('D365_PASSWORD') ? 'password' : 'none',
          devops: Boolean(map.get('AZDO_ORG_URL') && map.get('AZDO_PROJECT')),
          check: checks[id] ?? null,
        });
      } catch {
        out.push({ ...p, id: '', host: '', company: '', type: '', signIn: 'none', devops: false, check: null });
      }
    }
    return out;
  }

  /** Signs in to F&O in a visible browser (MFA included) and stores the session file on the profile. */
  async function sessionLogin(name: string): Promise<{ exitCode: number | null; output: string; saved?: string }> {
    const id = await store.idOf(name);
    const file = join(opts.home, 'sessions', `${id}.json`);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const result = await runProfileCommand('session-login', 15 * 60_000, store, name, cliPath, childEnv(), ['--output', file]);
    if (result.exitCode !== 0 || !existsSync(file)) return result;
    const entries = (await store.read(name)).filter((e) => e.key !== 'D365_STORAGE_STATE');
    await store.write(name, [...entries, { key: 'D365_STORAGE_STATE', value: file }], 'replace');
    return { ...result, saved: file };
  }

  /** The Azure DevOps test plans of the profile in use, or the suites of one plan. */
  async function devopsListing(rawPlan: string | undefined): Promise<{ status: number; body: unknown }> {
    const plan = rawPlan ? decodeURIComponent(rawPlan) : undefined;
    if (plan !== undefined && !/^\d+$/.test(plan)) return { status: 400, body: { error: 'Give a numeric plan ID.' } };
    let client: Pick<AzureDevOpsClient, 'listPlans' | 'listSuites'>;
    try {
      client = (opts.devopsClient ?? ((cfg: AppConfig) => new AzureDevOpsClient(cfg)))(await activeConfig());
    } catch (e) {
      if (e instanceof ProfileError) throw e;
      return { status: 400, body: { error: (e as Error).message } };
    }
    try {
      return { status: 200, body: plan ? { plan, suites: await client.listSuites(plan) } : { plans: await client.listPlans() } };
    } catch (e) {
      return { status: 502, body: { error: `Azure DevOps could not be read: ${(e as Error).message.split('\n')[0].slice(0, 400)}` } };
    }
  }

  /** Starts a run of the failed and blocked cases of a run from the history, from the source it read them from. */
  async function rerunFailed(id: string, body: Record<string, unknown>, fromTools = false): Promise<StartResult> {
    return reservedJob('run', async (state) => {
    const meta = await history.meta(id);
    if (!meta) return { error: 'No such run.' };
    const raw = await reportFile('results.json', id);
    if (!raw) return { error: 'That run has no results to repeat.' };
    const cases = failedCaseIds(JSON.parse(raw) as TestResult[]);
    if (!cases.length) return { error: 'Every case of that run passed; there is nothing to rerun.' };
    const source = runSource(meta.args ?? []);
    if (!source) return { error: 'The source of that run is not known. Load its cases in Tests and run them from there.' };
    const started = await launchRun(state, { ...source, cases, dryRun: body.dryRun === true }, fromTools, id);
    return { ...started, cases };
    });
  }

  async function compareRun(id: string, withId?: string | null): Promise<{ error?: string; status: number; comparison?: ReturnType<typeof compareResults> }> {
    const raw = await reportFile('results.json', id);
    if (!raw) return { status: 404, error: 'That run has no results.' };
    const other = withId || (await history.previous(id))?.id;
    if (!other) return { status: 404, error: 'No earlier run of the same environment to compare with.' };
    const before = await reportFile('results.json', other);
    if (!before) return { status: 404, error: 'The run to compare with has no results.' };
    return { status: 200, comparison: compareResults(JSON.parse(raw) as TestResult[], JSON.parse(before) as TestResult[], other) };
  }

  async function activeIdOf(): Promise<string | null> {
    const active = await store.getActive();
    return active ? store.idOf(active) : null;
  }

  async function modelConfig(): Promise<AppConfig> {
    return parseConfig({ ...Object.fromEntries((await ai.read(true)).map((e) => [e.key, e.value])), ...childEnv() });
  }

  /** The agent's settings for the profile in use, as a run would read them. */
  async function activeConfig(): Promise<AppConfig> {
    const active = await store.getActive();
    if (!active) throw new ProfileError('Choose an environment in Settings first.');
    return parseConfig({ ...Object.fromEntries((await store.read(active, true)).map((e) => [e.key, e.value])), ...childEnv() });
  }
  async function casesFor(url: URL) {
    const plan = url.searchParams.get('plan');
    const suite = url.searchParams.get('suite');
    if (plan || suite) {
      if (!plan || !suite || !/^\d+$/.test(plan) || !/^\d+$/.test(suite)) throw new ProfileError('Give numeric plan and suite IDs.');
      return discoverTestCases(await activeConfig(), { plan, suite });
    }
    return caseFiles.list(url.searchParams.get('local') || url.searchParams.get('dir') || 'examples/testcases');
  }

  /** Reads a report written by the CLI: the latest run's, or a run from the history. */
  async function reportFile(name: ReportFile, runId?: string | null): Promise<string | undefined> {
    const path = runId ? await history.file(runId, name) : join(await reportDir(), name);
    return path && existsSync(path) ? readFile(path, 'utf8') : undefined;
  }

  const tsend = (res: ServerResponse, status: number, body: unknown): void => send(res, status, body, { 'Content-Type': 'application/json; charset=utf-8' });
  const intParam = (url: URL, name: string, def: number, max: number): number => {
    const n = Number.parseInt(url.searchParams.get(name) ?? '', 10);
    return Number.isFinite(n) ? Math.min(Math.max(n, 0), max) : def;
  };
  /** Waits until the job settles, `ms` pass, the caller goes away or the chat answer is cancelled. */
  const waitToSettle = (state: RunState, ms: number, res?: ServerResponse, signal?: AbortSignal): Promise<void> =>
    state.settled || ms <= 0 || signal?.aborted
      ? Promise.resolve()
      : new Promise((resolve) => {
          const wake = (): void => {
            clearTimeout(timer);
            settleWaiters.delete(wake);
            res?.off('close', wake);
            signal?.removeEventListener('abort', wake);
            resolve();
          };
          const timer = setTimeout(wake, ms);
          settleWaiters.add(wake);
          res?.on('close', wake);
          signal?.addEventListener('abort', wake, { once: true });
        });
  /** The results a finished run saved to the history, for get_run to hand back without another call. */
  async function settledResults(state: RunState): Promise<TestResult[] | undefined> {
    if (state.kind !== 'run' || !state.settled) return undefined;
    const saved = savedRunId(state);
    const raw = saved ? await reportFile('results.json', saved) : undefined;
    return raw ? (JSON.parse(raw) as TestResult[]) : undefined;
  }
  async function runView(tail: number): Promise<Record<string, unknown>> {
    if (!run) return { run: null, next: nextStep(null) };
    const progress = run.kind === 'run' ? runProgress(run.lines) : undefined;
    const results = await settledResults(run);
    return {
      run: { ...publicRun(run), ...(progress ? { progress } : {}), log: tail ? run.lines.slice(-tail) : [], appUrl: `http://127.0.0.1:${port}/` },
      ...(results ? { results: summarizeResults(results) } : {}),
      // Between the end of the command and its history entry the job still counts as running.
      next: nextStep({ kind: run.kind, status: run.settled ? run.status : 'running' }, progress, Boolean(results)),
    };
  }

  /**
   * The application operations available to an LLM. This is the single execution path for the app's own Chat and
   * for the optional OpenAPI adapter below. Approval remains inside startRun, startUpload and rerunFailed, so
   * neither transport can bypass the native desktop policy.
   */
  async function executeChatOperation(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const text = (key: string): string => typeof args[key] === 'string' ? String(args[key]).trim() : '';
    const numeric = (key: string, fallback: number, max: number): number => {
      const parsed = Number(args[key] ?? fallback);
      if (!Number.isFinite(parsed)) throw new ProfileError(`${key} must be a number.`);
      return Math.min(Math.max(Math.trunc(parsed), 0), max);
    };
    switch (name) {
      case 'list_profiles':
        return { active: (await store.getActive()) ?? null, profiles: await store.list() };
      case 'use_profile': {
        if (jobBusy()) throw new ProfileError('Stop the current run before switching environments.', 409);
        if (!text('name')) throw new ProfileError('Give the profile name.');
        await store.read(text('name'));
        await store.setActive(text('name'));
        return { active: await store.getActive() };
      }
      case 'list_test_cases': {
        const query = new URLSearchParams();
        for (const key of ['plan', 'suite', 'dir', 'local']) if (text(key)) query.set(key, text(key));
        return casesFor(new URL(`http://tools/testcases?${query}`));
      }
      case 'read_test_case':
        return caseFiles.read(text('dir'), text('file'));
      case 'list_devops_plans':
      case 'list_devops_suites': {
        const result = await devopsListing(name === 'list_devops_suites' ? text('plan') : undefined);
        if (result.status !== 200) throw new ProfileError(typeof (result.body as { error?: unknown })?.error === 'string' ? String((result.body as { error: string }).error) : 'Azure DevOps could not be read.', result.status);
        return result.body;
      }
      case 'start_run':
        return startRun(args, true);
      case 'get_run':
        signal?.throwIfAborted();
        if (run) await waitToSettle(run, numeric('waitSeconds', 0, MAX_WAIT_SECONDS) * 1000, undefined, signal);
        signal?.throwIfAborted();
        return runView(numeric('tail', 40, 400));
      case 'stop_run':
        return { stopped: stopRun() };
      case 'get_results': {
        const requested = text('run');
        const raw = await reportFile('results.json', requested || null);
        if (!raw) throw new ProfileError(requested ? 'That run has no results.' : 'No results yet. Start a run first.', 404);
        return { run: requested || 'latest', ...summarizeResults(JSON.parse(raw) as TestResult[]) };
      }
      case 'check_setup': {
        const active = await store.getActive();
        if (!active) throw new ProfileError('No profile is in use. Create one in Settings, then call use_profile.');
        return { profile: active, ...(await checkProfile(active)) };
      }
      case 'list_runs':
        return { runs: (await history.list()).slice(0, numeric('limit', 20, 200) || 20) };
      case 'rerun_failed':
        return rerunFailed(text('id'), args, true);
      case 'compare_runs': {
        const result = await compareRun(text('id'), text('with') || null);
        return result.comparison ? { run: text('id'), ...result.comparison } : { run: text('id'), status: result.status, error: result.error };
      }
      case 'upload_run':
        return startUpload(text('id'), args, true);
      default:
        throw new ProfileError(`Unknown tool: ${name}`, 404);
    }
  }

  /**
   * Optional OpenAPI adapter over the exact operations used by the app's Chat, for external integration clients
   * (scripts, a self-hosted assistant) holding the tool token. Those send no Origin header; any request that does
   * comes from a web page, which has no business here, so browsers are refused and no CORS is offered.
   */
  async function toolsHandler(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<void> {
    const path = url.pathname.slice(TOOLS_PREFIX.length) || '/';
    if (req.headers.origin) return tsend(res, 403, { error: 'The tool API does not accept requests from web pages.' });
    if (method === 'GET' && path === '/openapi.json') {
      const base = `http://${req.headers.host ?? `127.0.0.1:${port}`}${TOOLS_PREFIX}`;
      return tsend(res, 200, openApiSpec(base));
    }
    const auth = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    if (!auth || !same(auth[1].trim(), toolToken)) return tsend(res, 401, { error: 'Missing or wrong tool-server token. Restart the desktop app to reconnect.' });

    const invoke = async (name: string, args: Record<string, unknown>): Promise<void> => {
      const result = await executeChatOperation(name, args);
      const value = result as { status?: number; error?: string; busy?: boolean } | undefined;
      const missing = value?.error === 'No such run.' || value?.error === 'That run has no results to upload.';
      const status = value?.busy ? 409 : value?.status ?? (value?.error ? (missing ? 404 : 400) : 200);
      return tsend(res, status, result);
    };
    if (method === 'GET' && path === '/profiles') return invoke('list_profiles', {});
    if (method === 'POST' && path === '/profiles/active') return invoke('use_profile', await readJson(req));
    if (method === 'GET' && path === '/testcases') return invoke('list_test_cases', Object.fromEntries(url.searchParams));
    if (method === 'GET' && path === '/testcases/file') return invoke('read_test_case', Object.fromEntries(url.searchParams));
    if (method === 'POST' && path === '/runs') return invoke('start_run', await readJson(req));
    if (method === 'GET' && path === '/runs/current') {
      if (run) await waitToSettle(run, intParam(url, 'waitSeconds', 0, MAX_WAIT_SECONDS) * 1000, res);
      return tsend(res, 200, await runView(intParam(url, 'tail', 40, 400)));
    }
    const plans = /^\/devops\/plans(?:\/([^/]+)\/suites)?$/.exec(path);
    if (method === 'GET' && plans) return invoke(plans[1] === undefined ? 'list_devops_plans' : 'list_devops_suites', plans[1] === undefined ? {} : { plan: plans[1] });
    if (method === 'POST' && path === '/runs/current/stop') return invoke('stop_run', {});
    if (method === 'GET' && path === '/results') return invoke('get_results', Object.fromEntries(url.searchParams));
    if (method === 'POST' && path === '/setup/check') return invoke('check_setup', {});
    if (method === 'GET' && path === '/history') return invoke('list_runs', Object.fromEntries(url.searchParams));
    const rr = /^\/history\/([\w-]+)\/rerun$/.exec(path);
    if (method === 'POST' && rr) return invoke('rerun_failed', { ...(await readJson(req)), id: rr[1] });
    const cmp = /^\/history\/([\w-]+)\/compare$/.exec(path);
    if (method === 'GET' && cmp) return invoke('compare_runs', { ...Object.fromEntries(url.searchParams), id: cmp[1] });
    const up = /^\/history\/([\w-]+)\/upload$/.exec(path);
    if (method === 'POST' && up) return invoke('upload_run', { ...(await readJson(req)), id: up[1] });
    return tsend(res, 404, { error: 'Not found.' });
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method0 = req.method ?? 'GET';
    const path0 = (req.url ?? '/').split('?')[0];
    if (path0 === TOOLS_PREFIX || path0.startsWith(`${TOOLS_PREFIX}/`)) {
      try {
        return await toolsHandler(req, res, new URL(req.url ?? '/', 'http://tools'), method0);
      } catch (e) {
        if (e instanceof ProfileError || e instanceof TestCaseFileError) return tsend(res, e.status, { error: e.message });
        console.error(`[ui] ${(e as Error).message}`);
        return tsend(res, 500, { error: 'Something went wrong. See the settings app window for details.' });
      }
    }
    const hostHeader = (req.headers.host ?? '').toLowerCase();
    if (hostHeader !== `127.0.0.1:${port}` && hostHeader !== `localhost:${port}`) return send(res, 403, { error: 'Unexpected Host header.' });
    const url = new URL(req.url ?? '/', `http://${hostHeader}`);
    const method = req.method ?? 'GET';
    // Chat uses the same cookie-authenticated app API as Tests/Results; there is no second model protocol bridge.

    if (method === 'GET' && url.pathname === '/' && url.searchParams.has('token')) {
      if (!same(url.searchParams.get('token') ?? '', token)) return send(res, 403, { error: 'Wrong token.' });
      return send(res, 302, '', { Location: '/', 'Set-Cookie': `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000` });
    }
    if (url.pathname === '/api/health') return send(res, 200, { app: 'd365fo-agent-ui' });

    if (!same(cookieValue(req), token)) {
      return send(res, 403, '<!doctype html><meta charset="utf-8"><title>D365FO Agent</title><body style="font:16px system-ui;margin:3rem"><h2>Open this from the app</h2><p>Use the D365FO Agent desktop app, or run <code>npm run ui</code>.</p>');
    }
    if (method !== 'GET') {
      const origin = req.headers.origin;
      if ((origin && origin !== `http://${hostHeader}`) || req.headers['x-requested-with'] !== 'd365fo-ui') return send(res, 403, { error: 'Cross-site request refused.' });
    }

    try {
      if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return send(res, 200, (await asset('index.html')).toString('utf8'));
      }
      const file = method === 'GET' ? STATIC_ASSETS[url.pathname.slice(1)] : undefined;
      if (file) {
        res.writeHead(200, { 'Content-Type': file, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
        return void res.end(await asset(url.pathname.slice(1)));
      }
      if (method === 'GET' && url.pathname === '/api/state') {
        return send(res, 200, { profiles: await profileCards(), aiConfigured: (await ai.read(true)).some((e) => ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].includes(e.key) && e.value), active: (await store.getActive()) ?? null, activeId: await activeIdOf(), home: opts.home, catalog: FIELD_CATALOG, groups: GROUP_INFO, providers: PROVIDER_LABELS, categoryHints: FAILURE_CATEGORY_HINTS });
      }
      if (await chatController.handle(req, res, url, method)) return;
      if (method === 'POST' && url.pathname === '/api/active') {
        const body = await readJson(req);
        if (jobBusy()) return send(res, 409, { error: 'A run is in progress. Wait for it to finish or stop it before switching profiles.' });
        await store.setActive(typeof body.name === 'string' ? body.name : undefined);
        return send(res, 200, { active: (await store.getActive()) ?? null });
      }
      if (method === 'POST' && url.pathname === '/api/profiles') {
        if (jobBusy()) return send(res, 409, { error: 'Wait for the current job before changing environments.' });
        const body = await readJson(req);
        const name = String(body.name ?? '');
        if (typeof body.copyFrom === 'string' && body.copyFrom) await store.duplicate(body.copyFrom, name);
        else await store.write(name, body.entries ?? [], 'create');
        return send(res, 201, { name });
      }
      const m = /^\/api\/profiles\/([^/]+)(\/check|\/devops-login|\/session-login)?$/.exec(url.pathname);
      if (m) {
        const name = decodeURIComponent(m[1]);
        if (method !== 'GET' && jobBusy()) return send(res, 409, { error: 'Wait for the current job before changing environments.' });
        if (m[2] === '/check' && method === 'POST') return send(res, 200, await checkProfile(name));
        if (m[2] === '/session-login' && method === 'POST') return send(res, 200, await sessionLogin(name));
        // Opens the Microsoft sign-in in the browser and waits for it (up to 5 minutes), then checks the project.
        if (m[2] === '/devops-login' && method === 'POST') return send(res, 200, await runProfileCommand('devops-login', 300_000, store, name, cliPath, childEnv()));
        if (!m[2] && method === 'GET') return send(res, 200, { name, id: await store.idOf(name), entries: await store.read(name) });
        if (!m[2] && method === 'PUT') {
          await store.write(name, (await readJson(req)).entries, 'replace');
          return send(res, 200, { name });
        }
        if (!m[2] && method === 'PATCH') {
          const to = String((await readJson(req)).name ?? '');
          await store.rename(name, to);
          return send(res, 200, { name: to });
        }
        if (!m[2] && method === 'DELETE') {
          await store.delete(name);
          return send(res, 200, { deleted: name });
        }
      }
      if (url.pathname === '/api/ai') {
        if (method === 'GET') return send(res, 200, { entries: await ai.read() });
        if (method === 'PUT') {
          if (jobBusy()) return send(res, 409, { error: 'Wait for the current run before changing the AI connection.' });
          await ai.write((await readJson(req)).entries);
          return send(res, 200, { saved: true });
        }
      }
      if (method === 'POST' && url.pathname === '/api/ai/check') {
        const cfg = await modelConfig();
        const secrets = Object.entries(cfg).filter(([key, value]) => isSecretKey(key) && typeof value === 'string' && value.length >= 4).map(([, value]) => String(value));
        return send(res, 200, await checkModelEndpoint(cfg, secrets, opts.modelProvider));
      }
      if (method === 'GET' && url.pathname === '/api/cases') return send(res, 200, await casesFor(url));
      const dp = /^\/api\/devops\/plans(?:\/([^/]+)\/suites)?$/.exec(url.pathname);
      if (method === 'GET' && dp) {
        const result = await devopsListing(dp[1]);
        return send(res, result.status, result.body);
      }
      if (method === 'POST' && url.pathname === '/api/run') {
        const result = await startRun(await readJson(req));
        return send(res, result.busy ? 409 : result.status ?? (result.error ? 400 : 200), result);
      }
      if (method === 'POST' && url.pathname === '/api/run/stop') {
        return send(res, 200, { stopped: stopRun() });
      }
      if (method === 'GET' && url.pathname === '/api/run') {
        const since = url.searchParams.has('since') ? intParam(url, 'since', 0, Number.MAX_SAFE_INTEGER) : undefined;
        return send(res, 200, run ? runForPage(run, since) : null);
      }
      if (method === 'GET' && url.pathname === '/api/run/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(': connected\n\n');
        listeners.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => {
          clearInterval(ping);
          listeners.delete(res);
        });
        return;
      }
      if (method === 'GET' && url.pathname === '/api/results') {
        const raw = await reportFile('results.json', url.searchParams.get('run'));
        return raw ? send(res, 200, raw, { 'Content-Type': 'application/json; charset=utf-8' }) : send(res, 200, null);
      }
      if (method === 'GET' && url.pathname === '/report') {
        const html = await reportFile('report.html', url.searchParams.get('run'));
        return html ? send(res, 200, html) : send(res, 404, { error: 'No report yet. Run some tests first.' });
      }
      const dl = /^\/download\/([\w.-]+)$/.exec(url.pathname);
      if (method === 'GET' && dl && (REPORT_FILES as readonly string[]).includes(dl[1])) {
        const runId = url.searchParams.get('run');
        const body = await reportFile(dl[1] as ReportFile, runId);
        if (body === undefined) return send(res, 404, { error: 'No such report.' });
        const type = dl[1].endsWith('.html') ? 'text/html' : dl[1].endsWith('.xml') ? 'application/xml' : 'application/json';
        res.writeHead(200, {
          'Content-Type': `${type}; charset=utf-8`,
          'Content-Disposition': `attachment; filename="${runId ?? 'latest'}-${dl[1]}"`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        return void res.end(body);
      }
      if (method === 'GET' && url.pathname === '/api/history') return send(res, 200, await history.list());
      const hx = /^\/api\/history\/([\w-]+)\/(rerun|compare)$/.exec(url.pathname);
      if (hx && hx[2] === 'rerun' && method === 'POST') {
        const result = await rerunFailed(hx[1], await readJson(req));
        return send(res, result.busy ? 409 : result.status ?? (result.error ? (result.error === 'No such run.' ? 404 : 400) : 200), result);
      }
      if (hx && hx[2] === 'compare' && method === 'GET') {
        const result = await compareRun(hx[1], url.searchParams.get('with'));
        return send(res, result.status, result.comparison ?? { error: result.error });
      }
      const hm = /^\/api\/history\/([\w-]+)(\/upload)?$/.exec(url.pathname);
      if (hm) {
        if (hm[2] && method === 'POST') {
          const result = await startUpload(hm[1], await readJson(req));
          return send(res, result.busy ? 409 : result.status ?? (result.error ? (result.error === 'That run has no results to upload.' ? 404 : 400) : 200), result);
        }
        if (!(await history.meta(hm[1]))) return send(res, 404, { error: 'No such run.' });
        if (!hm[2] && method === 'DELETE') return send(res, 200, { deleted: await history.delete(hm[1]) });
      }
      if (url.pathname === '/api/testcases') {
        const dir = url.searchParams.get('dir') ?? '';
        const file = url.searchParams.get('file') ?? '';
        if (method === 'GET') return send(res, 200, file ? await caseFiles.read(dir, file) : await caseFiles.list(dir));
        if (method === 'PUT') {
          const body = await readJson(req);
          return send(res, 200, await caseFiles.save(dir, body.testCase, file || undefined));
        }
        if (method === 'DELETE' && file) {
          await caseFiles.delete(dir, file);
          return send(res, 200, { deleted: file });
        }
      }
      return send(res, 404, { error: 'Not found.' });
    } catch (e) {
      if (e instanceof ProfileError || e instanceof TestCaseFileError) return send(res, e.status, { error: e.message });
      console.error(`[ui] ${(e as Error).message}`);
      return send(res, 500, { error: 'Something went wrong. See the terminal window for details.' });
    }
  };

  // One request per connection. Node closes an idle keep-alive socket after 5 seconds, but Safari keeps reusing it
  // longer and does not retry a PUT or POST that hits the closed socket: the save fails with "Load failed".
  // On the loopback address a fresh connection per request costs nothing.
  const server = createServer((req, res) => {
    res.setHeader('Connection', 'close');
    void handler(req, res);
  });
  // Try the preferred port and the few after it, so a second copy or another program on 4365 does not block the UI.
  const first = port;
  for (;;) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || first === 0 || port >= first + 20) throw e;
      port++;
    }
  }
  port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/`;
  await mkdir(opts.home, { recursive: true, mode: 0o700 });
  await writeFile(serverFile(opts.home), JSON.stringify({ port, pid: process.pid }), { mode: 0o600 });
  return {
    server,
    port,
    token,
    url,
    openUrl: `${url}?token=${token}`,
    toolToken,
    close: async () => {
      // A run in progress gets SIGTERM and time to mark its case interrupted and write its partial reports
      // (the child is force-killed after 20 s), so quitting the app does not leave a run without a history entry.
      const pending = run && !run.settled ? run : undefined;
      stopRun();
      chatController.close();
      if (pending) await waitToSettle(pending, 25_000);
      for (const l of listeners) l.end();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** If a UI from an earlier launch is still running, returns its address so a new start can reuse it. */
export async function findRunningUi(home: string, token: string): Promise<string | undefined> {
  try {
    const { port } = JSON.parse(await readFile(serverFile(home), 'utf8')) as { port: number };
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const body = (await res.json()) as { app?: string };
    return body.app === 'd365fo-agent-ui' ? `http://127.0.0.1:${port}/?token=${token}` : undefined;
  } catch {
    return undefined;
  }
}

export const webAssetsPresent = (): boolean => existsSync(join(WEB_DIR, 'index.html'));
