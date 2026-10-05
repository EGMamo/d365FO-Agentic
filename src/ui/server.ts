import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultRepoRoot } from '../launcher/install.js';
import { FIELD_CATALOG } from '../profiles/catalog.js';
import { serverFile, tokenFile, toolTokenFile } from '../profiles/paths.js';
import { isSecretKey, ProfileError, ProfileStore } from '../profiles/store.js';
import { loadLocalTestCases } from '../testing/loader.js';
import { TestCaseFileError, TestCaseFiles } from '../testing/store.js';
import { REPORT_FILES, RunHistory, type ReportFile } from './history.js';
import { openApiSpec, summarizeResults, TOOLS_PREFIX } from './tools.js';
import type { TestResult } from '../testing/types.js';

/**
 * Local web UI for managing profiles. It binds to the loopback interface only and is meant to be opened from the
 * launcher. Three checks keep other web pages and other local users away from the secrets it manages:
 * the Host header must be this server (blocks DNS rebinding), writes must come from this page (Origin and a custom
 * header, blocks cross-site forms) and every request needs the per-machine token held in a cookie.
 * The Open WebUI tool routes under /tools are the exception: they take a bearer token instead (see tools.ts).
 */
export const DEFAULT_PORT = 4365;
const COOKIE = 'd365fo_ui';
const MAX_BODY = 256 * 1024;
const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const MAX_LINES = 5000;
const ID = /^[\w.-]{1,64}$/;

interface RunState {
  id: number;
  kind: 'run' | 'upload';
  status: 'running' | 'passed' | 'failed' | 'stopped';
  args: string[];
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  lines: string[];
  child?: ChildProcess;
  stopRequested?: boolean;
}

export interface UiServerOptions {
  home: string;
  /** Path of the CLI entry point, run for the "check setup" button. */
  cliPath?: string;
  port?: number;
  host?: string;
  /** Project folder: test-case folders and the report folder are resolved inside it. Defaults to the repo root. */
  root?: string;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
export const isLoopback = (host: string): boolean => LOOPBACK.has(host);

export interface RunningUi {
  server: Server;
  port: number;
  token: string;
  url: string;
  /** The URL that signs the browser in (sets the cookie) and then lands on the app. */
  openUrl: string;
  /** Bearer token for the Open WebUI tool server at `<url>tools`. */
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
/** The key Open WebUI sends to the tool routes. Delete the file and restart the app to issue a new one. */
export const loadOrCreateToolToken = (home: string): Promise<string> => loadOrCreate(home, toolTokenFile(home));

const same = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function cookieValue(req: IncomingMessage): string {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
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
async function profileSecrets(store: ProfileStore, name: string): Promise<string[]> {
  return (await store.read(name, true)).filter((e) => isSecretKey(e.key) && e.value.length >= 4).map((e) => e.value);
}

/** Runs `doctor` against a profile and returns its output with that profile's secrets scrubbed. */
async function runDoctor(store: ProfileStore, name: string, cliPath: string): Promise<{ exitCode: number | null; output: string }> {
  const secrets = await profileSecrets(store, name);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, 'doctor'], {
      env: { ...process.env, D365FO_PROFILE: name, D365FO_AGENT_HOME: store.home, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const add = (b: Buffer): void => {
      if (output.length < 20_000) output += b.toString('utf8');
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => child.kill(), 90_000);
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
  const token = await loadOrCreateToken(opts.home);
  const toolToken = await loadOrCreateToolToken(opts.home);
  const host = opts.host ?? '127.0.0.1';
  let port = opts.port ?? DEFAULT_PORT;
  const cliPath = opts.cliPath ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'index.js');
  const repoRoot = opts.root ?? defaultRepoRoot();
  const caseFiles = new TestCaseFiles(repoRoot);
  let run: RunState | undefined;
  let runSeq = 0;
  const listeners = new Set<ServerResponse>();

  const broadcast = (event: string, data: unknown): void => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of listeners) res.write(msg);
  };
  const publicRun = (r: RunState) => ({ id: r.id, kind: r.kind, status: r.status, args: r.args, startedAt: r.startedAt, finishedAt: r.finishedAt, exitCode: r.exitCode });

  /** Starts the CLI as a child so a run reads the current profile, and streams its stdout/stderr back. */
  function runCli(args: string[], active?: string): ChildProcess {
    const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
    if (active) {
      env.D365FO_PROFILE = active;
      env.D365FO_AGENT_HOME = store.home;
    }
    return spawn(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
  }

  async function startRun(body: Record<string, unknown>): Promise<{ error?: string; busy?: boolean; run?: ReturnType<typeof publicRun> }> {
    if (run?.status === 'running') return { error: 'A run is already in progress', busy: true };
    const args = ['run'];
    const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
    if (body.source === 'local') {
      const dir = str('local');
      if (!dir) return { error: 'Choose a local test-case directory' };
      args.push('--local', dir);
    } else {
      const plan = str('plan');
      const suite = str('suite');
      for (const [name, v] of [['plan', plan], ['suite', suite]]) if (v && !ID.test(v)) return { error: `Invalid ${name} id` };
      if (plan) args.push('--plan', plan);
      if (suite) args.push('--suite', suite);
    }
    const caseId = str('caseId');
    if (caseId) {
      if (!ID.test(caseId)) return { error: 'Invalid case id' };
      args.push('--case', caseId);
    }
    if (body.dryRun === true) args.push('--dry-run');
    if (body.upload === true) args.push('--upload');
    if (body.retries !== undefined && body.retries !== '') {
      const n = Number(body.retries);
      if (!Number.isInteger(n) || n < 0 || n > 10) return { error: 'Retries must be 0-10' };
      args.push('--reloop-max-retries', String(n));
    }
    return startCli('run', args);
  }

  /** Uploads a run kept in the history to Azure DevOps, using the profile in use now. */
  async function startUpload(id: string, body: Record<string, unknown>): Promise<{ error?: string; busy?: boolean; run?: ReturnType<typeof publicRun> }> {
    if (run?.status === 'running') return { error: 'A run is already in progress', busy: true };
    const input = await history.file(id, 'results.json');
    if (!input) return { error: 'That run has no results to upload.' };
    const args = ['upload', '--input', input];
    const plan = typeof body.plan === 'string' ? body.plan.trim() : '';
    if (plan) {
      if (!ID.test(plan)) return { error: 'Invalid plan id' };
      args.push('--plan', plan);
    }
    return startCli('upload', args, async (state) => {
      const line = state.lines.find((l) => /^Uploaded run #\d+/.test(l));
      const m = line && /^Uploaded run #(\d+): (\S+)/.exec(line);
      if (state.status === 'passed') await history.update(id, { upload: { runId: m ? Number(m[1]) : undefined, url: m ? m[2] : undefined, at: new Date().toISOString() } });
    });
  }

  async function startCli(
    kind: RunState['kind'],
    args: string[],
    onDone?: (state: RunState) => Promise<void>,
  ): Promise<{ error?: string; busy?: boolean; run?: ReturnType<typeof publicRun> }> {
    const active = await store.getActive();
    const secrets = active ? await profileSecrets(store, active) : [];
    const state: RunState = { id: ++runSeq, kind, status: 'running', args, startedAt: new Date().toISOString(), lines: [] };
    run = state;
    const push = (line: string): void => {
      let clean = line;
      for (const s of secrets) clean = clean.split(s).join('***');
      state.lines.push(clean);
      if (state.lines.length > MAX_LINES) state.lines.splice(0, state.lines.length - MAX_LINES);
      broadcast('line', { id: state.id, line: clean });
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
      state.child = undefined;
      const finish = async (): Promise<void> => {
        try {
          if (kind === 'run') {
            const meta = await history.record({ status: state.status, args, profile: active ?? null, startedAt: state.startedAt, finishedAt: state.finishedAt }, state.id);
            push(`Saved to run history as ${meta.id}.`);
          }
          await onDone?.(state);
        } catch (e) {
          console.error(`[ui] could not update the run history: ${(e as Error).message}`);
        }
        broadcast('status', publicRun(state));
      };
      void finish();
    });
    broadcast('status', publicRun(state));
    return { run: publicRun(state) };
  }

  function stopRun(): boolean {
    const child = run?.child;
    if (!run || !child?.pid) return false;
    run.stopRequested = true;
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
    setTimeout(() => run?.child === child && kill('SIGKILL'), 5000).unref();
    return true;
  }

  /** The report folder the CLI writes to, honouring REPORT_DIR from the active profile. */
  async function reportDir(): Promise<string> {
    let dir = 'reports';
    const active = await store.getActive();
    if (active) {
      try {
        const entry = (await store.read(active, true)).find((e) => e.key === 'REPORT_DIR');
        if (entry?.value) dir = entry.value;
      } catch {
        /* fall back to the default */
      }
    }
    return resolve(repoRoot, dir);
  }
  const history = new RunHistory(reportDir);

  /** Reads a report written by the CLI: the latest run's, or a run from the history. */
  async function reportFile(name: ReportFile, runId?: string | null): Promise<string | undefined> {
    const path = runId ? await history.file(runId, name) : join(await reportDir(), name);
    return path && existsSync(path) ? readFile(path, 'utf8') : undefined;
  }

  /** Bearer tokens carry no ambient browser credentials, so any origin may call (Open WebUI user tool servers call from the browser). */
  const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS', 'Access-Control-Max-Age': '600' };
  const tsend = (res: ServerResponse, status: number, body: unknown): void => send(res, status, body, { ...CORS, 'Content-Type': 'application/json; charset=utf-8' });
  const intParam = (url: URL, name: string, def: number, max: number): number => {
    const n = Number.parseInt(url.searchParams.get(name) ?? '', 10);
    return Number.isFinite(n) ? Math.min(Math.max(n, 0), max) : def;
  };
  const runView = (tail: number) => (run ? { ...publicRun(run), log: tail ? run.lines.slice(-tail) : [], appUrl: `http://127.0.0.1:${port}/` } : null);

  /** The Open WebUI tool server: the same actions as the app, for a chat model. */
  async function toolsHandler(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<void> {
    const path = url.pathname.slice(TOOLS_PREFIX.length) || '/';
    if (method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return void res.end();
    }
    if (method === 'GET' && path === '/openapi.json') {
      const base = `http://${req.headers.host ?? `127.0.0.1:${port}`}${TOOLS_PREFIX}`;
      return tsend(res, 200, openApiSpec(base));
    }
    const auth = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    if (!auth || !same(auth[1].trim(), toolToken)) return tsend(res, 401, { error: 'Missing or wrong bearer token. Run "d365fo-agent openwebui" to see it.' });

    if (method === 'GET' && path === '/profiles') return tsend(res, 200, { active: (await store.getActive()) ?? null, profiles: await store.list() });
    if (method === 'POST' && path === '/profiles/active') {
      const body = await readJson(req);
      if (typeof body.name !== 'string' || !body.name) return tsend(res, 400, { error: 'Give the profile name.' });
      await store.read(body.name); // 404 for an unknown profile
      await store.setActive(body.name);
      return tsend(res, 200, { active: (await store.getActive()) ?? null });
    }
    if (path === '/testcases' || path === '/testcases/file') {
      const dir = url.searchParams.get('dir') ?? '';
      const file = url.searchParams.get('file') ?? '';
      if (method === 'GET' && path === '/testcases') return tsend(res, 200, await caseFiles.list(dir));
      if (method === 'GET') return tsend(res, 200, await caseFiles.read(dir, file));
      if (method === 'PUT' && path === '/testcases') return tsend(res, 200, await caseFiles.save(dir, (await readJson(req)).testCase, file || undefined));
    }
    if (method === 'POST' && path === '/runs') {
      const result = await startRun(await readJson(req));
      return tsend(res, result.busy ? 409 : result.error ? 400 : 200, result);
    }
    if (method === 'GET' && path === '/runs/current') {
      const deadline = Date.now() + intParam(url, 'waitSeconds', 0, 120) * 1000;
      while (run?.status === 'running' && Date.now() < deadline && !res.destroyed) await new Promise((r) => setTimeout(r, 500));
      return tsend(res, 200, { run: runView(intParam(url, 'tail', 40, 400)) });
    }
    if (method === 'POST' && path === '/runs/current/stop') return tsend(res, 200, { stopped: stopRun() });
    if (method === 'GET' && path === '/results') {
      const runId = url.searchParams.get('run');
      const raw = await reportFile('results.json', runId);
      if (!raw) return tsend(res, 404, { error: runId ? 'That run has no results.' : 'No results yet. Start a run first.' });
      return tsend(res, 200, { run: runId ?? 'latest', ...summarizeResults(JSON.parse(raw) as TestResult[]) });
    }
    if (method === 'GET' && path === '/history') return tsend(res, 200, { runs: (await history.list()).slice(0, intParam(url, 'limit', 20, 200) || 20) });
    const up = /^\/history\/([\w-]+)\/upload$/.exec(path);
    if (method === 'POST' && up) {
      if (!(await history.meta(up[1]))) return tsend(res, 404, { error: 'No such run.' });
      const result = await startUpload(up[1], await readJson(req));
      return tsend(res, result.busy ? 409 : result.error ? 400 : 200, result);
    }
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

    if (method === 'GET' && url.pathname === '/' && url.searchParams.has('token')) {
      if (!same(url.searchParams.get('token') ?? '', token)) return send(res, 403, { error: 'Wrong token.' });
      return send(res, 302, '', { Location: '/', 'Set-Cookie': `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000` });
    }
    if (url.pathname === '/api/health') return send(res, 200, { app: 'd365fo-agent-ui' });

    if (!same(cookieValue(req), token)) {
      return send(res, 403, '<!doctype html><meta charset="utf-8"><title>D365FO Agent</title><body style="font:16px system-ui;margin:3rem"><h2>Open this from the launcher</h2><p>Use the D365FO Agent icon on your desktop, or run <code>npm run ui</code>.</p>');
    }
    if (method !== 'GET') {
      const origin = req.headers.origin;
      if ((origin && origin !== `http://${hostHeader}`) || req.headers['x-requested-with'] !== 'd365fo-ui') return send(res, 403, { error: 'Cross-site request refused.' });
    }

    try {
      if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return send(res, 200, await readFile(join(WEB_DIR, 'index.html'), 'utf8'));
      }
      if (method === 'GET' && url.pathname === '/icon.svg') {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
        return void res.end(await readFile(join(WEB_DIR, 'icon.svg')));
      }
      if (method === 'GET' && url.pathname === '/api/state') {
        return send(res, 200, { profiles: await store.list(), active: (await store.getActive()) ?? null, home: opts.home, catalog: FIELD_CATALOG });
      }
      if (method === 'POST' && url.pathname === '/api/active') {
        const body = await readJson(req);
        await store.setActive(typeof body.name === 'string' ? body.name : undefined);
        return send(res, 200, { active: (await store.getActive()) ?? null });
      }
      if (method === 'POST' && url.pathname === '/api/profiles') {
        const body = await readJson(req);
        const name = String(body.name ?? '');
        if (typeof body.copyFrom === 'string' && body.copyFrom) await store.duplicate(body.copyFrom, name);
        else await store.write(name, body.entries ?? [], 'create');
        return send(res, 201, { name });
      }
      const m = /^\/api\/profiles\/([^/]+)(\/check)?$/.exec(url.pathname);
      if (m) {
        const name = decodeURIComponent(m[1]);
        if (m[2] && method === 'POST') return send(res, 200, await runDoctor(store, name, cliPath));
        if (!m[2] && method === 'GET') return send(res, 200, { name, entries: await store.read(name) });
        if (!m[2] && method === 'PUT') {
          await store.write(name, (await readJson(req)).entries, 'replace');
          return send(res, 200, { name });
        }
        if (!m[2] && method === 'DELETE') {
          await store.delete(name);
          return send(res, 200, { deleted: name });
        }
      }
      if (method === 'GET' && url.pathname === '/api/cases') {
        const local = url.searchParams.get('local');
        if (!local) return send(res, 200, []);
        const cases = await loadLocalTestCases(resolve(repoRoot, local));
        return send(res, 200, cases.map((c) => ({ id: c.id, title: c.title, steps: c.steps.length, legalEntity: c.legalEntity })));
      }
      if (method === 'POST' && url.pathname === '/api/run') {
        const result = await startRun(await readJson(req));
        return send(res, result.busy ? 409 : result.error ? 400 : 200, result);
      }
      if (method === 'POST' && url.pathname === '/api/run/stop') {
        return send(res, 200, { stopped: stopRun() });
      }
      if (method === 'GET' && url.pathname === '/api/run') {
        return send(res, 200, run ? { ...publicRun(run), lines: run.lines } : null);
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
      const hm = /^\/api\/history\/([\w-]+)(\/upload)?$/.exec(url.pathname);
      if (hm) {
        if (!(await history.meta(hm[1]))) return send(res, 404, { error: 'No such run.' });
        if (hm[2] && method === 'POST') {
          const result = await startUpload(hm[1], await readJson(req));
          return send(res, result.busy ? 409 : result.error ? 400 : 200, result);
        }
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

  const server = createServer((req, res) => void handler(req, res));
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
    close: () =>
      new Promise((resolve) => {
        stopRun();
        for (const l of listeners) l.end();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** If a UI from an earlier launch is still running, returns its address so the launcher can reuse it. */
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
