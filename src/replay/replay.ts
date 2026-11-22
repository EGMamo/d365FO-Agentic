import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import type { AppConfig } from '../config/index.js';
import type { TestResult } from '../testing/types.js';
import { ensureTestProject, replayDir, replayProjectConfig } from './spec.js';

export interface ReplayOptions { files?: string[]; grep?: string; headed?: boolean; signal?: AbortSignal }
export interface ReplayRun { child: ChildProcess; resultsFile: string; startedAt: number; done: Promise<number | null> }

/** Resolve exactly the pinned test runner: the generated project's install first, then the app's bundled dependency. */
export function resolvePlaywrightCli(testsDir: string): { cli: string; nodePath?: string } {
  const local = path.join(testsDir, 'node_modules', '@playwright', 'test', 'cli.js');
  if (fs.existsSync(local)) return { cli: local };
  const req = createRequire(import.meta.url);
  const pkg = req.resolve('@playwright/test/package.json');
  return { cli: path.join(path.dirname(pkg), 'cli.js'), nodePath: path.resolve(path.dirname(pkg), '..', '..') };
}

export const replayResultsFile = (cfg: AppConfig): string => path.join(replayDir(cfg), 'results', 'results.json');

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SEP = '[\\\\/]';
const NAME_CHAR = '[^\\\\/]';

function globToRegExp(glob: string, isSep: RegExp): string {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*' && (i === 0 || isSep.test(glob[i - 1])) && (i + 2 === glob.length || isSep.test(glob[i + 2]))) {
      re += i + 2 === glob.length ? '.*' : `(?:${NAME_CHAR}*${SEP})*`;
      i += 2;
    } else if (c === '*') re += `${NAME_CHAR}*`;
    else if (c === '?') re += NAME_CHAR;
    else if (isSep.test(c)) re += SEP;
    else re += escapeRegExp(c);
  }
  return re;
}

export interface ReplayFilterContext {
  cwd: string;
  testsDir: string;
  path?: path.PlatformPath;
  kind?: (p: string) => 'file' | 'dir' | undefined;
}
function diskKind(p: string): 'file' | 'dir' | undefined {
  try { const s = fs.statSync(p); return s.isDirectory() ? 'dir' : s.isFile() ? 'file' : undefined; } catch { return undefined; }
}

/** Converts user paths/globs to Playwright's regex file filters without allowing a path outside the replay project. */
export function replayFilters(args: string[], ctx: ReplayFilterContext): string[] {
  const p = ctx.path ?? path;
  const kind = ctx.kind ?? diskKind;
  const isSep = p.sep === '\\' ? /[\\/]/ : /\//;
  const rel = (abs: string) => p.relative(ctx.testsDir, abs);
  const inside = (r: string) => r !== '..' && !r.startsWith('..' + p.sep) && !p.isAbsolute(r);
  return args.map((arg) => {
    const [, target, location = ''] = /^(.*?)((?::\d+){1,2})?$/.exec(arg)!;
    if (!target) return arg;
    const candidates = [p.resolve(ctx.cwd, target), p.resolve(ctx.testsDir, target)];
    const existing = candidates.filter((c) => { const k = kind(c); return k === 'file' || (k === 'dir' && isSep.test(target)); });
    const abs = existing.find((c) => inside(rel(c)));
    if (existing.length && !abs) throw new Error(`Replay paths must stay inside ${ctx.testsDir}: ${arg}`);
    if (abs) {
      const r = rel(abs);
      if (!r) return '.' + location;
      const re = SEP + r.split(isSep).map(escapeRegExp).join(SEP);
      return re + (kind(abs) === 'dir' ? SEP : '$') + location;
    }
    if (/^\/.*\/[gi]*$/.test(target)) return arg;
    if (/[*?]/.test(target)) {
      const r = candidates.map(rel).find(inside);
      if (!r) throw new Error(`Replay globs must stay inside ${ctx.testsDir}: ${arg}`);
      return SEP + globToRegExp(r, isSep) + '$' + location;
    }
    return arg;
  });
}

/** No LLM, Azure DevOps or D365 password/token variables are inherited by the standalone replay child. */
export function replayEnvironment(cfg: AppConfig, nodePath?: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { FORCE_COLOR: '0', NO_COLOR: '1' };
  const allowed = ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'TEMP', 'TMP', 'PLAYWRIGHT_BROWSERS_PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'PW_CHANNEL'];
  for (const key of allowed) if (source[key]) env[key] = source[key];
  if (cfg.D365_BASE_URL) env.D365_URL = cfg.D365_BASE_URL;
  if (cfg.D365_STORAGE_STATE) env.D365_STORAGE_STATE = path.resolve(cfg.D365_STORAGE_STATE);
  env.PW_BROWSER = cfg.PW_BROWSER;
  if (nodePath) env.NODE_PATH = nodePath;
  return env;
}

/** Starts AI-free Playwright. Old JSON/JUnit results are deleted first so a failed launch can never publish stale data. */
export function startReplay(cfg: AppConfig, opts: ReplayOptions = {}, onOutput: (text: string) => void = () => {}): ReplayRun {
  ensureTestProject(replayProjectConfig(cfg));
  const dir = replayDir(cfg);
  const { cli, nodePath } = resolvePlaywrightCli(dir);
  const resultsFile = replayResultsFile(cfg);
  fs.rmSync(resultsFile, { force: true });
  fs.rmSync(path.join(dir, 'results', 'junit.xml'), { force: true });
  const args = [cli, 'test', ...replayFilters(opts.files ?? [], { cwd: process.cwd(), testsDir: dir })];
  if (opts.grep) args.push('--grep', opts.grep);
  if (opts.headed) args.push('--headed');
  const startedAt = Date.now();
  const child = spawn(process.execPath, args, { cwd: dir, env: replayEnvironment(cfg, nodePath), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8').on('data', onOutput);
  child.stderr.setEncoding('utf8').on('data', onOutput);
  const done = new Promise<number | null>((resolve) => {
    const stop = (): void => { if (child.exitCode === null && !child.killed) child.kill('SIGTERM'); };
    if (opts.signal?.aborted) stop();
    opts.signal?.addEventListener('abort', stop, { once: true });
    child.once('error', (e) => { onOutput(`Could not start Playwright: ${e.message}\n`); resolve(null); });
    child.once('close', (code) => { opts.signal?.removeEventListener('abort', stop); resolve(code); });
  });
  return { child, resultsFile, startedAt, done };
}

export interface ReplayCaseResult { caseId: string; row: number; count: number; outcome: TestResult['outcome']; durationMs: number; error?: string; title: string; startedAt: string; finishedAt: string }

/** Reads only a report produced by this launch (or one deliberately read after an external launch). */
export function readReplayResults(cfg: AppConfig, notBefore = 0): ReplayCaseResult[] {
  const file = replayResultsFile(cfg);
  if (!fs.existsSync(file) || fs.statSync(file).mtimeMs + 1 < notBefore) return [];
  const json = JSON.parse(fs.readFileSync(file, 'utf8')) as { suites?: unknown[] };
  const out: ReplayCaseResult[] = [];
  const walk = (suite: any): void => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const annotations = t.annotations ?? spec.annotations ?? [];
        const ann = annotations.find((a: any) => a.type === 'ado-test-case' || a.type === 'test-case-id');
        const tag = (spec.tags ?? []).map((x: string) => x.match(/ado-(\d+)/)).find(Boolean);
        const caseId = String(ann?.description ?? tag?.[1] ?? '');
        if (!caseId) continue;
        const last = t.results?.[t.results.length - 1];
        const started = last?.startTime ? new Date(last.startTime) : new Date(0);
        const durationMs = last?.duration ?? 0;
        out.push({
          caseId,
          row: Number(annotations.find((a: any) => a.type === 'iteration')?.description ?? 1) || 1,
          count: Number(annotations.find((a: any) => a.type === 'iteration-count')?.description ?? 1) || 1,
          outcome: t.status === 'skipped' ? 'skipped' : (t.status === 'expected' || t.status === 'flaky') ? 'passed' : 'failed',
          durationMs,
          error: last?.error?.message,
          title: spec.title,
          startedAt: started.toISOString(),
          finishedAt: new Date(started.getTime() + durationMs).toISOString(),
        });
      }
    }
    for (const s of suite.suites ?? []) walk(s);
  };
  for (const suite of json.suites ?? []) walk(suite);
  return out;
}

/** Maps fresh replay output onto the existing DevOps publisher, which rolls rows into one case result. */
export function replayTestResults(rows: ReplayCaseResult[]): TestResult[] {
  return rows.map((r) => ({
    testCaseId: r.caseId,
    title: r.title.replace(/\s*\[row \d+\]\s*$/, ''),
    iteration: { row: r.row, count: r.count },
    outcome: r.outcome,
    runState: r.outcome === 'failed' ? 'failed' : 'completed',
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    durationMs: r.durationMs,
    steps: [],
    artifacts: [],
    ...(r.error ? { errorMessage: r.error.slice(0, 2000) } : {}),
  }));
}
