import { spawn } from 'node:child_process';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * `d365fo-agent studio`: one command from nothing to a working chat. It starts (or reuses) the settings
 * app, writes the tool-server address and key to `openwebui/.env`, starts Open WebUI with Docker Compose
 * (openwebui/docker-compose.yml pre-registers the tool server from those values through Open WebUI's
 * TOOL_SERVER_CONNECTIONS setting), waits for it and opens it in the browser.
 */
export const DEFAULT_WEBUI_PORT = 3000;

export type Run = (command: string, args: string[], opts?: { cwd?: string; quiet?: boolean }) => Promise<number | null>;

export const runCommand: Run = (command, args, opts = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd: opts.cwd, stdio: opts.quiet ? 'ignore' : 'inherit', shell: process.platform === 'win32' });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code));
  });

/** The address Open WebUI, inside its container, uses to reach the settings app on this computer. */
export function dockerToolUrl(port: number): string {
  return `http://host.docker.internal:${port}/tools`;
}

export function composeEnv(opts: { toolPort: number; toolKey: string; webuiPort: number }): string {
  return [
    '# Written by `d365fo-agent studio`. Holds the tool-server key: keep it private (it is gitignored).',
    `OPENWEBUI_PORT=${opts.webuiPort}`,
    `D365FO_TOOL_URL=${dockerToolUrl(opts.toolPort)}`,
    `D365FO_TOOL_KEY=${opts.toolKey}`,
    '',
  ].join('\n');
}

export async function writeComposeEnv(dir: string, opts: { toolPort: number; toolKey: string; webuiPort: number }): Promise<string> {
  const file = join(dir, '.env');
  await writeFile(file, composeEnv(opts), { mode: 0o600 });
  await chmod(file, 0o600).catch(() => undefined);
  return file;
}

export async function dockerComposeAvailable(run: Run = runCommand): Promise<boolean> {
  return (await run('docker', ['compose', 'version'], { quiet: true })) === 0;
}

export async function composeUp(dir: string, run: Run = runCommand): Promise<boolean> {
  return (await run('docker', ['compose', '-f', join(dir, 'docker-compose.yml'), '--env-file', join(dir, '.env'), 'up', '-d'], { cwd: dir })) === 0;
}

/** Polls `url` until it answers (any status below 500) or the time is up. */
export async function waitForHttp(url: string, timeoutMs: number, fetchImpl: typeof fetch = fetch, intervalMs = 1500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(3000) });
      if (res.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
