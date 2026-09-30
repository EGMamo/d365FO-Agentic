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
}

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
    };
  }
  return { state: 'ok', path, ageHours, detail: `${age}; looks valid (the server may still have revoked it)` };
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
