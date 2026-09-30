import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { chmod, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { AppConfig } from '../config/index.js';

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
  /** Set when the file looks usable but lacks the F&O session cookie (see F_AND_O_SESSION_COOKIE). */
  warning?: string;
}

/**
 * The F&O client's session cookie. FastTrack's F&O JMeter sample injects it (with `ms-dyn-csrftoken` and
 * `ms-dyn-affinity`) to skip the interactive login. A saved session with only Microsoft sign-in cookies
 * is therefore unlikely to open the F&O client. Treated as a warning, not an error, because the cookie
 * name is taken from that sample and has not been confirmed on every F&O deployment.
 */
export const F_AND_O_SESSION_COOKIE = 'DynamicsOwinAuth';

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
  const missingSessionCookie = (list: StoredCookie[]): string | undefined =>
    list.some((c) => c.name === F_AND_O_SESSION_COOKIE)
      ? undefined
      : `no ${F_AND_O_SESSION_COOKIE} cookie for the F&O host; the saved session may only hold Microsoft sign-in cookies. Run \`d365fo-agent session-login\` and wait for the F&O dashboard before closing the window`;
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
  const nowSec = now / 1000;
  const dated = relevant.filter((c) => typeof c.expires === 'number' && c.expires > 0);
  if (dated.length > 0 && dated.every((c) => (c.expires as number) <= nowSec)) {
    return { state: 'expired', path, ageHours, detail: `all dated cookies have expired (${age}); run \`d365fo-agent session-login\`` };
  }
  const warning = missingSessionCookie(relevant);
  if (ageHours > cfg.D365_SESSION_MAX_AGE_HOURS) {
    return {
      warning,
      state: 'stale',
      path,
      ageHours,
      detail: `${age}, older than D365_SESSION_MAX_AGE_HOURS=${cfg.D365_SESSION_MAX_AGE_HOURS}; it may have expired, re-run \`d365fo-agent session-login\` if runs land on the sign-in page`,
    };
  }
  return { state: 'ok', path, ageHours, warning, detail: `${age}; looks valid (the server may still have revoked it)` };
}

export type ProbeState = 'live' | 'signed-out' | 'unknown';

export interface ProbeResult {
  state: ProbeState;
  detail: string;
}

type Fetcher = (url: string, init: RequestInit) => Promise<Pick<Response, 'status' | 'headers'>>;

/**
 * Best-effort live check: sends the saved session's cookies for the F&O host in one GET (no redirects
 * followed) and looks at where the server sends us. A redirect to a Microsoft sign-in host means the
 * session is no longer accepted. Nothing is written and cookie values are never returned or logged.
 * Best-effort only: the expected redirect behaviour is inferred, not confirmed on a real F&O environment.
 */
export async function probeSession(
  cfg: Pick<AppConfig, 'D365_STORAGE_STATE' | 'D365_BASE_URL'>,
  fetcher: Fetcher = (url, init) => fetch(url, init),
  now: number = Date.now(),
): Promise<ProbeResult> {
  if (!cfg.D365_STORAGE_STATE || !cfg.D365_BASE_URL) return { state: 'unknown', detail: 'no saved session or D365_BASE_URL configured' };
  let host: string;
  try {
    host = new URL(cfg.D365_BASE_URL).hostname.toLowerCase();
  } catch {
    return { state: 'unknown', detail: 'D365_BASE_URL is not a valid URL' };
  }
  let cookies: StoredCookie[];
  try {
    const parsed = JSON.parse(await readFile(resolve(cfg.D365_STORAGE_STATE), 'utf8')) as { cookies?: StoredCookie[] };
    cookies = Array.isArray(parsed.cookies) ? parsed.cookies : [];
  } catch {
    return { state: 'unknown', detail: 'the saved session file could not be read' };
  }
  const header = cookies
    .filter((c) => c.name && c.value !== undefined && c.domain && hostMatches(c.domain, host))
    .filter((c) => !(typeof c.expires === 'number' && c.expires > 0 && c.expires <= now / 1000))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  if (!header) return { state: 'signed-out', detail: 'the saved session has no usable cookies for the F&O host' };
  let res: Pick<Response, 'status' | 'headers'>;
  try {
    res = await fetcher(cfg.D365_BASE_URL, { redirect: 'manual', headers: { cookie: header }, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    return { state: 'unknown', detail: `could not reach the F&O host (${e instanceof Error ? e.message : String(e)})` };
  }
  if (res.status >= 300 && res.status < 400) {
    let target = '';
    try {
      target = new URL(res.headers.get('location') ?? '', cfg.D365_BASE_URL).hostname.toLowerCase();
    } catch {
      target = '';
    }
    if (/(^|\.)login\.(microsoftonline|windows)\.(com|net)$/.test(target) || /(^|\.)sts\./.test(target)) {
      return { state: 'signed-out', detail: `the F&O host redirected to a sign-in page (${target}); run \`d365fo-agent session-login\`` };
    }
    return { state: 'unknown', detail: `the F&O host redirected to ${target || 'another location'}; cannot tell whether the session is accepted` };
  }
  if (res.status === 200) return { state: 'live', detail: 'the F&O host answered without sending you to sign in' };
  return { state: 'unknown', detail: `the F&O host answered HTTP ${res.status}` };
}

export function sessionLoginArgs(cfg: Pick<AppConfig, 'PW_BROWSER'>, url: string, out: string): string[] {
  return ['-y', 'playwright@latest', 'open', '--browser', cfg.PW_BROWSER, `--save-storage=${out}`, url];
}

function runInteractive(command: string, args: string[]): Promise<number | null> {
  return new Promise((res, rej) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
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
  const installCode = await run('npx', ['-y', 'playwright@latest', 'install', cfg.PW_BROWSER]);
  if (installCode !== 0) throw new Error(`Installing the ${cfg.PW_BROWSER} browser failed (exit ${installCode})`);
  const code = await run('npx', sessionLoginArgs(cfg, cfg.D365_BASE_URL, path));
  if (code !== 0) throw new Error(`The browser exited with code ${code}; no session was saved`);
  try {
    await chmod(path, 0o600);
  } catch {
    throw new Error('No session was saved: the browser was closed before any state was written');
  }
  return path;
}
