import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { AppConfig } from '../config/index.js';

/**
 * Open WebUI for the desktop app, without Docker. The app ships `uv` (a single binary); on first start uv downloads a
 * standalone Python and installs a pinned Open WebUI into the app's data folder, then every start runs it from there
 * on this computer only, signed in as the single local user, with the D365FO tool server already connected.
 * Nothing here imports Electron, so it is tested like the rest of the code.
 */
export const OPENWEBUI_VERSION = '0.11.4';
export const PYTHON_VERSION = '3.11';

export interface OpenWebUiPaths {
  /** The uv binary shipped with the app. */
  uv: string;
  /** Per-user app data folder (Electron's userData). */
  dataRoot: string;
  platform?: NodeJS.Platform;
}

export function layout(p: OpenWebUiPaths) {
  const win = (p.platform ?? process.platform) === 'win32';
  const venv = join(p.dataRoot, 'openwebui', 'venv');
  return {
    venv,
    python: win ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python'),
    exe: win ? join(venv, 'Scripts', 'open-webui.exe') : join(venv, 'bin', 'open-webui'),
    /** Records the installed version, so an app update with a newer pin reinstalls. */
    marker: join(p.dataRoot, 'openwebui', 'installed.json'),
    data: join(p.dataRoot, 'openwebui', 'data'),
    /** uv's own Python downloads and cache stay inside the app folder. */
    uvEnv: { UV_PYTHON_INSTALL_DIR: join(p.dataRoot, 'openwebui', 'python'), UV_CACHE_DIR: join(p.dataRoot, 'openwebui', 'uv-cache'), UV_NO_CONFIG: '1' },
  };
}

export async function isInstalled(p: OpenWebUiPaths, version = OPENWEBUI_VERSION): Promise<boolean> {
  const l = layout(p);
  if (!existsSync(l.exe)) return false;
  try {
    return (JSON.parse(await readFile(l.marker, 'utf8')) as { version?: string }).version === version;
  } catch {
    return false;
  }
}

export type Exec = (command: string, args: string[], env: NodeJS.ProcessEnv, onLine: (line: string) => void) => Promise<number | null>;

export const exec: Exec = (command, args, env, onLine) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    for (const s of [child.stdout, child.stderr]) {
      let buf = '';
      s.setEncoding('utf8');
      s.on('data', (c: string) => {
        buf += c;
        const lines = buf.split(/\r?\n|\r/);
        buf = lines.pop() ?? '';
        for (const l of lines) if (l.trim()) onLine(l.trim());
      });
    }
    child.on('error', (e) => {
      onLine(e.message);
      resolve(null);
    });
    child.on('close', resolve);
  });

/** First start: a Python and Open WebUI in a private venv inside the app folder. */
export async function install(p: OpenWebUiPaths, onLine: (line: string) => void, run: Exec = exec, version = OPENWEBUI_VERSION): Promise<void> {
  const l = layout(p);
  const env = { ...process.env, ...l.uvEnv };
  await mkdir(l.data, { recursive: true });
  onLine(`Preparing Python ${PYTHON_VERSION}…`);
  // Always uv's own Python, never one that happens to be installed on the computer.
  if ((await run(p.uv, ['venv', '--allow-existing', '--managed-python', '--python', PYTHON_VERSION, l.venv], env, onLine)) !== 0) throw new Error('Could not set up Python for Open WebUI.');
  onLine(`Installing Open WebUI ${version} (first start only)…`);
  // PyTorch from PyPI is already the CPU build on macOS and Windows; on Linux it would pull several GB of GPU libraries.
  const cpu = (p.platform ?? process.platform) === 'linux' ? ['--torch-backend', 'cpu'] : [];
  if ((await run(p.uv, ['pip', 'install', '--python', l.python, ...cpu, `open-webui==${version}`], env, onLine)) !== 0) throw new Error('Could not install Open WebUI. Check the internet connection and try again.');
  await writeFile(l.marker, JSON.stringify({ version, at: new Date().toISOString() }));
}

export const PROMPT_SUGGESTIONS = [
  { title: ['Check my setup', 'for the profile in use'], content: 'Which profile is in use? Check its setup and tell me in plain words what is missing.' },
  { title: ['Dry-run the examples', 'and summarise the results'], content: 'Dry-run the test cases in examples/testcases, wait for the run to finish and tell me what passed and what failed, with the reason.' },
  { title: ['Write a test case', 'from a description'], content: 'Write a test case in examples/testcases: open All vendors, create a vendor with a new account number, save, and check the vendor appears in the list.' },
  { title: ['What has it learned?', 'about F&O forms'], content: 'List the F&O forms the agent has learned so far and what it knows about each.' },
  { title: ['Upload the last run', 'to Azure DevOps'], content: 'Show the latest run in the history and upload it to Azure DevOps.' },
];

/**
 * The chat model Open WebUI starts with, taken from the profile in use when it speaks an OpenAI-style API.
 * Anthropic has an OpenAI-compatible endpoint; GitHub Copilot does not, so it is left for the user to add.
 */
export function chatConnection(cfg: AppConfig | undefined): { url: string; key: string } | undefined {
  if (!cfg) return undefined;
  switch (cfg.LLM_PROVIDER) {
    case 'openai':
      return cfg.OPENAI_API_KEY ? { url: 'https://api.openai.com/v1', key: cfg.OPENAI_API_KEY } : undefined;
    case 'anthropic':
      return cfg.ANTHROPIC_API_KEY && !cfg.ANTHROPIC_BASE_URL ? { url: 'https://api.anthropic.com/v1', key: cfg.ANTHROPIC_API_KEY } : undefined;
    case 'github-models':
      return cfg.GITHUB_TOKEN ? { url: 'https://models.inference.ai.azure.com', key: cfg.GITHUB_TOKEN } : undefined;
    case 'openai-compatible':
      return { url: cfg.OPENAI_COMPATIBLE_BASE_URL.replace(/\/+$/, ''), key: cfg.OPENAI_COMPATIBLE_API_KEY ?? '' };
    default:
      return undefined;
  }
}

/** Environment for `open-webui serve`. */
export function serveEnv(opts: { dataDir: string; toolUrl: string; toolKey: string; chat?: { url: string; key: string } }, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    DATA_DIR: opts.dataDir,
    // One person on one computer: no sign-up screen.
    WEBUI_AUTH: 'False',
    // Open WebUI reads these on its first start and keeps them in its own settings after that.
    TOOL_SERVER_CONNECTIONS: JSON.stringify([
      {
        type: 'openapi',
        url: opts.toolUrl,
        path: 'openapi.json',
        auth_type: 'bearer',
        key: opts.toolKey,
        config: { enable: true },
        info: { id: 'd365fo', name: 'D365FO test runner', description: 'Run and manage Dynamics 365 Finance & Operations tests' },
      },
    ]),
    DEFAULT_PROMPT_SUGGESTIONS: JSON.stringify(PROMPT_SUGGESTIONS),
    ...(opts.chat ? { ENABLE_OPENAI_API: 'True', OPENAI_API_BASE_URL: opts.chat.url, OPENAI_API_KEY: opts.chat.key } : {}),
    // No local embedding model download on start; document search can be set up later in Open WebUI.
    BYPASS_EMBEDDING_AND_RETRIEVAL: 'True',
    RAG_EMBEDDING_MODEL_AUTO_UPDATE: 'False',
    SCARF_NO_ANALYTICS: 'true',
    DO_NOT_TRACK: 'true',
    ANONYMIZED_TELEMETRY: 'false',
    PYTHONUNBUFFERED: '1',
    // A company proxy must not get the calls to the tool server on this computer.
    NO_PROXY: [base.NO_PROXY ?? base.no_proxy, '127.0.0.1', 'localhost'].filter(Boolean).join(','),
    no_proxy: [base.NO_PROXY ?? base.no_proxy, '127.0.0.1', 'localhost'].filter(Boolean).join(','),
  };
}

/** A free port on the loopback interface. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

export function serve(p: OpenWebUiPaths, port: number, env: NodeJS.ProcessEnv, onLine: (line: string) => void): ChildProcess {
  const l = layout(p);
  mkdirSync(l.data, { recursive: true });
  const child = spawn(l.exe, ['serve', '--host', '127.0.0.1', '--port', String(port)], { cwd: l.data, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  for (const s of [child.stdout, child.stderr]) s?.on('data', (c: Buffer) => c.toString('utf8').split(/\r?\n/).filter(Boolean).forEach(onLine));
  return child;
}
