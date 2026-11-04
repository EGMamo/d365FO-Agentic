import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { chmod, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { AppConfig } from '../config/index.js';
import { packageCommand } from '../runtime/bundled.js';

/** Must match the Playwright version used by the pinned desktop MCP. */
export const PLAYWRIGHT_SESSION_PACKAGE = 'playwright@1.64.0-alpha-1789764292000';

/**
 * Optional login via a saved browser session (Playwright storage state) instead
 * of a username and password. The file holds live session cookies, so it is
 * written owner-only, lives in a gitignored directory, and is never logged.
 */
export const DEFAULT_SESSION_FILE = '.d365fo-session/storage-state.json';

export type SessionState = 'off' | 'missing' | 'unreadable' | 'expired' | 'stale' | 'ok';

export interface SessionStatus {
  state: SessionState;
  path?: string;
  ageHours?: number;
  detail: string;
  /** Non-fatal findings, e.g. a missing anti-forgery cookie. Never contain cookie values. */
  warnings?: string[];
}

/** The F&O session cookie named in FastTrack's JMeter sample. Its absence is a warning, since the name is unconfirmed on a real deployment. */
export const F_AND_O_AUTH_COOKIE = 'DynamicsOwinAuth';
/** Anti-forgery cookie the F&O web client sends; its absence is only a warning. */
export const F_AND_O_CSRF_COOKIE = 'ms-dyn-csrftoken';

/** Absolute path of the saved session when it is configured *and* present, else undefined. */
export function activeSessionFile(cfg: Pick<AppConfig, 'D365_STORAGE_STATE'>): string | undefined {
  if (!cfg.D365_STORAGE_STATE) return undefined;
  const path = resolve(cfg.D365_STORAGE_STATE);
  try {
    return statSync(path).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

interface StoredCookie {
  name?: string;
  value?: string;
  domain?: string;
  expires?: number;
}

function hostMatches(cookieDomain: string, host: string): boolean {
  const d = cookieDomain.replace(/^\./, '').toLowerCase();
  return host === d || host.endsWith(`.${d}`);
}

/**
 * Offline check of the saved session. It cannot know whether the server has
 * revoked it, only whether the file is present, readable, and plausibly fresh.
 */
export async function checkSession(
  cfg: Pick<AppConfig, 'D365_STORAGE_STATE' | 'D365_BASE_URL' | 'D365_SESSION_MAX_AGE_HOURS'>,
  now: number = Date.now(),
): Promise<SessionStatus> {
  if (!cfg.D365_STORAGE_STATE) return { state: 'off', detail: 'not configured (D365_STORAGE_STATE unset); using username and password' };
  const path = resolve(cfg.D365_STORAGE_STATE);
  let mtimeMs: number;
  let raw: string;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
    raw = await readFile(path, 'utf8');
  } catch {
    return { state: 'missing', path, detail: `no saved session at ${path}; run \`d365fo-agent session-login\`` };
  }
  let cookies: StoredCookie[];
  try {
    const parsed = JSON.parse(raw) as { cookies?: StoredCookie[] };
    if (!Array.isArray(parsed.cookies)) throw new Error('no cookies array');
    cookies = parsed.cookies;
  } catch {
    return { state: 'unreadable', path, detail: `${path} is not a valid Playwright storage state; run \`d365fo-agent session-login\` again` };
  }

  const ageHours = (now - mtimeMs) / 3_600_000;
  const age = `saved ${ageHours < 1 ? 'less than an hour' : `${Math.floor(ageHours)}h`} ago`;
  let host: string | undefined;
  try {
    host = cfg.D365_BASE_URL ? new URL(cfg.D365_BASE_URL).hostname.toLowerCase() : undefined;
  } catch {
    host = undefined;
  }
  const relevant = cookies.filter((c) => !host || !c.domain || hostMatches(c.domain, host));
  if (relevant.length === 0) {
    return { state: 'expired', path, ageHours, detail: `no cookies for ${host ?? 'the D365 host'} in the saved session (${age}); run \`d365fo-agent session-login\`` };
  }
  const hasCookie = (name: string) => relevant.some((c) => c.name?.toLowerCase() === name.toLowerCase());
  // Warnings only: the cookie names come from FastTrack's JMeter sample and are not confirmed on every F&O deployment.
  const warnings: string[] = [];
  if (!hasCookie(F_AND_O_AUTH_COOKIE)) {
    warnings.push(`no ${F_AND_O_AUTH_COOKIE} cookie for ${host ?? 'the D365 host'} in the saved session; if runs land on the sign-in page, the sign-in may not have reached F&O. Run \`d365fo-agent session-login\` and close the window only after the F&O dashboard has loaded`);
  }
  if (!hasCookie(F_AND_O_CSRF_COOKIE)) warnings.push(`no ${F_AND_O_CSRF_COOKIE} cookie in the saved session; F&O may reject requests until it is issued`);
  const nowSec = now / 1000;
  const dated = relevant.filter((c) => typeof c.expires === 'number' && c.expires > 0);
  if (dated.length > 0 && dated.every((c) => (c.expires as number) <= nowSec)) {
    return { state: 'expired', path, ageHours, detail: `all dated cookies have expired (${age}); run \`d365fo-agent session-login\`` };
  }
  if (ageHours > cfg.D365_SESSION_MAX_AGE_HOURS) {
    return {
      state: 'stale',
      path,
      ageHours,
      detail: `${age}, older than D365_SESSION_MAX_AGE_HOURS=${cfg.D365_SESSION_MAX_AGE_HOURS}; it may have expired, re-run \`d365fo-agent session-login\` if runs land on the sign-in page`,
      warnings: warnings.length ? warnings : undefined,
    };
  }
  return { state: 'ok', path, ageHours, detail: `${age}; looks valid (the server may still have revoked it)`, warnings: warnings.length ? warnings : undefined };
}

export type ProbeState = 'live' | 'expired' | 'unreachable' | 'skipped';

export interface ProbeResult {
  state: ProbeState;
  detail: string;
}

/**
 * Why a run must not start after a `--probe-session` preflight, or undefined when it may: a refused session and
 * an unreachable host both stop it; `live` and `skipped` (nothing to probe) do not.
 */
export function probeBlocksRun(probe: ProbeResult): string | undefined {
  if (probe.state === 'expired') return 'Saved D365 session was refused by the server. Renew it with `d365fo-agent session-login` before running tests.';
  if (probe.state === 'unreachable') return 'Could not verify the saved D365 session (`--probe-session`) because the environment was unreachable. Resolve connectivity and retry.';
  return undefined;
}

export type ProbeFetch = (url: string, init: { headers: Record<string, string>; redirect: 'manual'; signal: AbortSignal }) => Promise<{ status: number; headers: { get(name: string): string | null } }>;

/**
 * Live check of the saved session. F&O session cookies carry no expiry, so file
 * age says little; instead ask the server. One GET of the F&O URL with only the
 * cookies for that host, redirects not followed: a redirect to
 * login.microsoftonline.com means the session is no longer accepted. Read-only:
 * the session file is never written and cookie values are never printed.
 */
export async function probeSession(
  cfg: Pick<AppConfig, 'D365_STORAGE_STATE' | 'D365_BASE_URL'>,
  fetchFn: ProbeFetch = fetch as unknown as ProbeFetch,
  timeoutMs = 15_000,
): Promise<ProbeResult> {
  if (!cfg.D365_STORAGE_STATE || !cfg.D365_BASE_URL) return { state: 'skipped', detail: 'needs D365_STORAGE_STATE and D365_BASE_URL' };
  let url: URL;
  let cookies: StoredCookie[];
  try {
    url = new URL(cfg.D365_BASE_URL);
    cookies = (JSON.parse(await readFile(resolve(cfg.D365_STORAGE_STATE), 'utf8')) as { cookies?: StoredCookie[] }).cookies ?? [];
  } catch {
    return { state: 'skipped', detail: 'saved session or D365_BASE_URL could not be read' };
  }
  const host = url.hostname.toLowerCase();
  const header = cookies
    .filter((c) => c.name && c.value !== undefined && c.domain && hostMatches(c.domain, host))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  try {
    const res = await fetchFn(url.toString(), { headers: { cookie: header }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      let target: string;
      try {
        target = new URL(location, url).hostname.toLowerCase();
      } catch {
        target = '';
      }
      if (target.endsWith('login.microsoftonline.com') || target.endsWith('login.live.com')) {
        return { state: 'expired', detail: 'the server redirected to the Microsoft sign-in page; run `d365fo-agent session-login`' };
      }
      return { state: 'live', detail: `the server accepted the session (redirected within ${target || 'the environment'})` };
    }
    if (res.status === 401 || res.status === 403) return { state: 'expired', detail: `the server answered ${res.status}; run \`d365fo-agent session-login\`` };
    if (res.status >= 200 && res.status < 300) return { state: 'live', detail: 'the server accepted the session' };
    return { state: 'unreachable', detail: `unexpected HTTP ${res.status} from ${host}` };
  } catch (e) {
    return { state: 'unreachable', detail: `could not reach ${host}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function sessionLoginArgs(cfg: Pick<AppConfig, 'PW_BROWSER'>, url: string, out: string): string[] {
  return ['open', '--browser', cfg.PW_BROWSER, `--save-storage=${out}`, url];
}

export function sessionCommand(args: string[], find?: Parameters<typeof packageCommand>[4]): { command: string; args: string[] } {
  return packageCommand('playwright', PLAYWRIGHT_SESSION_PACKAGE, 'playwright', args, find);
}

function runInteractive(command: string, args: string[]): Promise<number | null> {
  return new Promise((res, rej) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' && command === 'npx' });
    child.on('error', rej);
    child.on('close', (code) => res(code));
  });
}

/**
 * Opens a headed browser on the F&O URL so the user signs in themselves (MFA
 * included), then saves the resulting storage state when the window is closed.
 */
export async function interactiveSessionLogin(
  cfg: Pick<AppConfig, 'PW_BROWSER' | 'D365_BASE_URL'>,
  out: string,
  run: typeof runInteractive = runInteractive,
): Promise<string> {
  if (!cfg.D365_BASE_URL) throw new Error('D365_BASE_URL is required for session-login');
  const path = resolve(out);
  await mkdir(dirname(path), { recursive: true });
  const install = sessionCommand(['install', cfg.PW_BROWSER]);
  const installCode = await run(install.command, install.args);
  if (installCode !== 0) throw new Error(`Installing the ${cfg.PW_BROWSER} browser failed (exit ${installCode})`);
  const open = sessionCommand(sessionLoginArgs(cfg, cfg.D365_BASE_URL, path));
  const code = await run(open.command, open.args);
  if (code !== 0) throw new Error(`The browser exited with code ${code}; no session was saved`);
  try {
    await chmod(path, 0o600);
  } catch {
    throw new Error('No session was saved: the browser was closed before any state was written');
  }
  return path;
}
