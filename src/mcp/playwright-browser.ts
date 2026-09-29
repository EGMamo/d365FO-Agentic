import { spawn } from 'node:child_process';
import type { AppConfig } from '../config/index.js';

/**
 * Playwright MCP drives a Playwright-managed browser that is downloaded
 * separately from the npm package. Without it every browser tool fails and the
 * model burns steps (and writes bogus learnings) before the test is marked
 * blocked, so the run makes sure it is present up front.
 */

/** Shared by the server launch and the browser install so both resolve the same Playwright version. */
export const PLAYWRIGHT_MCP_PACKAGE = '@playwright/mcp@latest';

/** `install-browser` uses Playwright's registry names, which differ from `--browser` for chromium. */
const INSTALL_NAMES: Record<AppConfig['PW_BROWSER'], string> = {
  chromium: 'chrome-for-testing',
  firefox: 'firefox',
  webkit: 'webkit',
};

const INSTALL_TIMEOUT_MS = 15 * 60_000;
const ERROR_TAIL_LINES = 20;

export interface ExecResult {
  /** `null` when the process was killed (timeout). */
  code: number | null;
  output: string;
}

export type Exec = (command: string, args: string[], onLine: (line: string) => void) => Promise<ExecResult>;

export function playwrightInstallArgs(browser: AppConfig['PW_BROWSER']): string[] {
  // `--no-remove`: never garbage-collect browsers other projects may rely on.
  return ['-y', PLAYWRIGHT_MCP_PACKAGE, 'install-browser', '--no-progress', '--no-remove', INSTALL_NAMES[browser]];
}

/**
 * Installs the configured Playwright browser if it is missing. The installer is
 * a no-op (about a second) when everything is already present, and it is silent
 * unless it downloads something, so this is cheap to run on every test run.
 */
export async function ensurePlaywrightBrowser(
  cfg: Pick<AppConfig, 'PW_AUTO_INSTALL' | 'PW_BROWSER'>,
  exec: Exec = execCommand,
): Promise<void> {
  if (!cfg.PW_AUTO_INSTALL) return;

  const args = playwrightInstallArgs(cfg.PW_BROWSER);
  const manual = `npx ${args.join(' ')}`;
  const hint = `Run it manually (${manual}), or set PW_AUTO_INSTALL=false to skip this step.`;

  let result: ExecResult;
  try {
    result = await exec('npx', args, (line) => {
      // Only surface real downloads; the installer's warning banner is noise.
      if (/^Downloading /.test(line) || / downloaded to /.test(line)) console.log(`[agent] ${line}`);
    });
  } catch (e) {
    throw new Error(`Could not start the Playwright browser installer: ${(e as Error).message}\n${hint}`);
  }

  if (result.code !== 0) {
    const tail = result.output.trim().split(/\r?\n/).slice(-ERROR_TAIL_LINES).join('\n');
    const status = result.code === null ? 'was stopped after timing out' : `exited with code ${result.code}`;
    throw new Error(`Playwright browser install ${status}:\n${tail}\n${hint}`);
  }
}

function execCommand(command: string, args: string[], onLine: (line: string) => void): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    // npx is a .cmd shim on Windows, which Node only spawns through a shell.
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32' && command === 'npx',
    });
    let output = '';
    let pending = '';
    const timer = setTimeout(() => child.kill(), INSTALL_TIMEOUT_MS);

    const emit = (line: string) => onLine(stripAnsi(line).trim());
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      const lines = (pending + text).split(/\r\n|\n|\r/);
      pending = lines.pop() ?? '';
      lines.forEach(emit);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (pending) emit(pending);
      resolve({ code, output: stripAnsi(output) });
    });
  });
}

function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}
