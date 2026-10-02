import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { activeModel, configProblems, ignoredModelHint, parseConfig, validateForRun } from '../config/index.js';
import { dotenvFileProblems } from '../config/dotenv-check.js';
import { discoverTestCases } from '../core/runner.js';
import { parseEnvText, updateEnvText } from './env-file.js';
import { SETTING_FIELDS, SETTING_KEYS } from './settings.js';
import { PAGE_HTML } from './page.js';

export interface UiServerOptions {
  port: number;
  /** `.env` to edit; runs read it too, since they start from `cwd`. */
  envPath: string;
  /** The compiled CLI entry point, used to start `run` and `doctor` as child processes. */
  cliPath: string;
  cwd: string;
  token?: string;
  /** Environment the UI was started with; keys that came from `.env` are removed so children re-read the file. */
  env?: NodeJS.ProcessEnv;
}

export interface UiServer {
  url: string;
  token: string;
  server: Server;
  close(): Promise<void>;
}

interface RunState {
  id: number;
  status: 'running' | 'passed' | 'failed' | 'stopped';
  args: string[];
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  lines: string[];
  child?: ChildProcess;
  stopRequested?: boolean;
}

const MAX_LINES = 5000;
const ID = /^[\w.-]{1,64}$/;
const COOKIE = 'd365fo_ui';

export function startUiServer(opts: UiServerOptions): Promise<UiServer> {
  const token = opts.token ?? randomBytes(24).toString('base64url');
  const envPath = resolve(opts.envPath);
  const baseEnv = shellEnv(opts.env ?? process.env, envPath);
  let run: RunState | undefined;
  let runSeq = 0;
  const listeners = new Set<ServerResponse>();

  const readEnvText = () => (existsSync(envPath) ? readFileSync(envPath, 'utf8') : '');
  // Same precedence as dotenv: variables from the shell win over the file.
  const effectiveEnv = (text = readEnvText()) => ({ ...parseEnvText(text), ...baseEnv });

  const broadcast = (event: string, data: unknown) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of listeners) res.write(msg);
  };
  const publicRun = (r: RunState) => ({ id: r.id, status: r.status, args: r.args, startedAt: r.startedAt, finishedAt: r.finishedAt, exitCode: r.exitCode });

  function settingsPayload() {
    const text = readEnvText();
    const file = parseEnvText(text);
    const env = effectiveEnv(text);
    const fields = SETTING_FIELDS.map((f) => ({
      ...f,
      value: f.secret ? '' : file[f.key] ?? '',
      set: !!env[f.key],
      shadowed: baseEnv[f.key] !== undefined,
    }));
    const problems: string[] = configProblems(env).map((p) => `${p.key}: ${p.message}`);
    let summary = '';
    if (!problems.length) {
      const cfg = parseConfig(env);
      problems.push(...validateForRun(cfg));
      const hint = ignoredModelHint(cfg);
      if (hint) problems.push(hint);
      summary = `${cfg.LLM_PROVIDER} (${activeModel(cfg)}) → ${cfg.D365_BASE_URL ?? '(no D365 URL)'} [company ${cfg.D365_COMPANY}]`;
    }
    problems.push(...dotenvFileProblems(envPath).map((p) => p.message));
    return { envPath, exists: existsSync(envPath), fields, problems, summary };
  }

  async function saveSettings(body: { values?: Record<string, unknown>; clear?: unknown[] }) {
    const updates: Record<string, string | null> = {};
    for (const [key, raw] of Object.entries(body.values ?? {})) {
      if (!SETTING_KEYS.has(key) || typeof raw !== 'string') continue;
      const field = SETTING_FIELDS.find((f) => f.key === key)!;
      // An empty secret box means "keep the current value"; clearing is explicit.
      if (field.secret && raw === '') continue;
      updates[key] = field.secret ? raw : raw.trim();
    }
    for (const key of body.clear ?? []) {
      if (typeof key === 'string' && SETTING_KEYS.has(key)) updates[key] = null;
    }
    const before = readEnvText();
    const next = updateEnvText(before, updates);
    const problems = configProblems(effectiveEnv(next));
    if (problems.length) return { ok: false, problems: problems.map((p) => `${p.key}: ${p.message}`) };
    if (next !== before) {
      const tmp = `${envPath}.${process.pid}.tmp`;
      await writeFile(tmp, next, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, envPath);
    }
    return { ok: true, changed: Object.keys(updates), ...settingsPayload() };
  }

  function runCli(args: string[]): ChildProcess {
    return spawn(process.execPath, [opts.cliPath, ...args], {
      cwd: opts.cwd,
      env: { ...baseEnv, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
  }

  function doctor(): Promise<{ exitCode: number | null; output: string }> {
    return new Promise((done) => {
      const child = runCli(['doctor']);
      let output = '';
      child.stdout?.on('data', (d) => (output += d));
      child.stderr?.on('data', (d) => (output += d));
      child.on('error', (e) => done({ exitCode: null, output: `${output}\n${e.message}` }));
      child.on('close', (exitCode) => done({ exitCode, output }));
    });
  }

  function startRun(body: Record<string, unknown>): { error?: string; busy?: boolean; run?: ReturnType<typeof publicRun> } {
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

    const state: RunState = { id: ++runSeq, status: 'running', args, startedAt: new Date().toISOString(), lines: [] };
    run = state;
    const push = (line: string) => {
      state.lines.push(line);
      if (state.lines.length > MAX_LINES) state.lines.splice(0, state.lines.length - MAX_LINES);
      broadcast('line', { id: state.id, line });
    };
    push(`$ d365fo-agent ${args.join(' ')}`);
    const child = runCli(args);
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
      broadcast('status', publicRun(state));
    });
    broadcast('status', publicRun(state));
    return { run: publicRun(state) };
  }

  function stopRun(): boolean {
    const child = run?.child;
    if (!run || !child?.pid) return false;
    run.stopRequested = true;
    // The run spawns MCP servers and a browser; signal the whole process group.
    const kill = (sig: NodeJS.Signals) => {
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

  async function reportFile(name: 'report.html' | 'results.json'): Promise<string | undefined> {
    let dir = './reports';
    try {
      dir = parseConfig(effectiveEnv()).REPORT_DIR;
    } catch {
      /* fall back to the default */
    }
    const path = join(resolve(opts.cwd, dir), name);
    return existsSync(path) ? readFile(path, 'utf8') : undefined;
  }

  const server = createServer(async (req, res) => {
    try {
      const port = (server.address() as { port: number }).port;
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (!allowedHost(req.headers.host, port)) return send(res, 403, 'Forbidden host');

      if (url.pathname === '/' && url.searchParams.has('token')) {
        if (!same(url.searchParams.get('token')!, token)) return send(res, 403, 'Invalid token');
        res.writeHead(303, {
          Location: '/',
          'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        });
        return res.end();
      }
      if (!same(cookie(req, COOKIE) ?? '', token)) {
        return send(res, 401, 'Open the URL printed by `d365fo-agent ui` (it contains the access token).');
      }
      if (req.method !== 'GET') {
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, 'JSON required');
        const origin = req.headers.origin;
        if (origin && !allowedOrigin(origin, port)) return send(res, 403, 'Forbidden origin');
      }

      const route = `${req.method} ${url.pathname}`;
      switch (route) {
        case 'GET /':
          return send(res, 200, PAGE_HTML, 'text/html; charset=utf-8');
        case 'GET /api/settings':
          return json(res, 200, settingsPayload());
        case 'PUT /api/settings': {
          const result = await saveSettings(await readJson(req));
          return json(res, result.ok ? 200 : 400, result);
        }
        case 'POST /api/doctor':
          return json(res, 200, await doctor());
        case 'GET /api/cases': {
          const cfg = parseConfig(effectiveEnv());
          const local = url.searchParams.get('local') || undefined;
          const cases = await discoverTestCases(cfg, {
            local: local ? resolve(opts.cwd, local) : undefined,
            plan: url.searchParams.get('plan') || undefined,
            suite: url.searchParams.get('suite') || undefined,
          });
          return json(res, 200, cases.map((c) => ({ id: c.id, title: c.title, steps: c.steps.length, legalEntity: c.legalEntity })));
        }
        case 'POST /api/run': {
          const result = startRun(await readJson(req));
          return json(res, result.busy ? 409 : result.error ? 400 : 200, result);
        }
        case 'POST /api/run/stop':
          return json(res, 200, { stopped: stopRun() });
        case 'GET /api/run':
          return json(res, 200, run ? { ...publicRun(run), lines: run.lines } : null);
        case 'GET /api/run/events': {
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
        case 'GET /api/results': {
          const raw = await reportFile('results.json');
          return raw ? send(res, 200, raw, 'application/json') : json(res, 200, null);
        }
        case 'GET /report': {
          const html = await reportFile('report.html');
          return html ? send(res, 200, html, 'text/html; charset=utf-8') : send(res, 404, 'No report yet. Run some tests first.');
        }
        default:
          return send(res, 404, 'Not found');
      }
    } catch (e) {
      return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  return new Promise((ready, fail) => {
    server.once('error', fail);
    server.listen(opts.port, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      ready({
        url: `http://127.0.0.1:${port}/?token=${token}`,
        token,
        server,
        close: () =>
          new Promise<void>((done) => {
            stopRun();
            for (const l of listeners) l.end();
            server.close(() => done());
          }),
      });
    });
  });
}

/** Drops variables that were loaded from `.env` at startup, so the file (not a stale copy) is the source of truth. */
function shellEnv(env: NodeJS.ProcessEnv, envPath: string): Record<string, string> {
  const out: Record<string, string> = {};
  let fromFile: Record<string, string> = {};
  try {
    if (existsSync(envPath) && statSync(envPath).isFile()) fromFile = parseEnvText(readFileSync(envPath, 'utf8'));
  } catch {
    /* unreadable: keep everything */
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || fromFile[k] === v) continue;
    out[k] = v;
  }
  return out;
}

function allowedHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function allowedOrigin(origin: string, port: number): boolean {
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const parsed = text ? JSON.parse(text) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object');
  return parsed as Record<string, unknown>;
}

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

function send(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS });
  res.end(body);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, JSON.stringify(body), 'application/json');
}
