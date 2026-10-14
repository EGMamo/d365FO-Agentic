import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
/** Bump when the set of installed packages changes, so an older install is replaced. */
export const INSTALL_VARIANT = 'slim-1';

/**
 * Packages left out of the install. They are Open WebUI's local AI stack (PyTorch and its GPU libraries,
 * embeddings, speech and image recognition, a bundled vector database) and cloud storage clients, none of which a
 * test chat that talks to a hosted or local model needs. Open WebUI's own slim mode (USE_SLIM_DOCKER) skips the
 * code that would import them. Leaving them out took the Linux install from 7.1 GB to 0.66 GB.
 */
export const EXCLUDED_PACKAGES = [
  'torch', 'accelerate', 'einops', 'sentence-transformers', 'sentencepiece', 'transformers',
  'chromadb', 'onnxruntime', 'opencv-python-headless', 'pyarrow', 'rapidocr', 'faster-whisper',
  'azure-ai-documentintelligence', 'azure-storage-blob', 'boto3', 'google-cloud-storage', 'opensearch-py',
];

/** A uv overrides file: a requirement with a marker that is never true is dropped from the resolution, with everything only it needed. */
export const overridesFile = (): string => `${EXCLUDED_PACKAGES.map((n) => `${n} ; sys_platform == 'never'`).join('\n')}\n`;

/**
 * Open WebUI features switched off for the desktop app. They are read on Open WebUI's first start; they hide what a
 * test chat does not use (sharing, team spaces, image and code tools, memories, cloud drives, extra model calls).
 */
export const DISABLED_FEATURES = [
  'ENABLE_COMMUNITY_SHARING', 'ENABLE_CHANNELS', 'ENABLE_NOTES', 'ENABLE_CALENDAR', 'ENABLE_FOLDERS', 'ENABLE_AUTOMATIONS',
  'ENABLE_USER_WEBHOOKS', 'ENABLE_WEB_SEARCH', 'ENABLE_IMAGE_GENERATION', 'ENABLE_IMAGE_EDIT', 'ENABLE_CODE_EXECUTION',
  'ENABLE_CODE_INTERPRETER', 'ENABLE_LOCAL_WEB_FETCH', 'ENABLE_MEMORIES', 'ENABLE_TAGGING', 'ENABLE_TAGS_GENERATION',
  'ENABLE_TITLE_GENERATION', 'ENABLE_FOLLOW_UP_GENERATION', 'ENABLE_AUTOCOMPLETE_GENERATION', 'ENABLE_EVALUATION_ARENA_MODELS',
  'ENABLE_MESSAGE_RATING', 'ENABLE_OLLAMA_API', 'ENABLE_DIRECT_CONNECTIONS', 'ENABLE_GOOGLE_DRIVE_INTEGRATION',
  'ENABLE_ONEDRIVE_INTEGRATION', 'ENABLE_API_KEYS', 'ENABLE_ADMIN_EXPORT', 'ENABLE_ADMIN_ANALYTICS',
];

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
    const m = JSON.parse(await readFile(l.marker, 'utf8')) as { version?: string; variant?: string };
    return m.version === version && m.variant === INSTALL_VARIANT;
  } catch {
    return false;
  }
}

export type Exec = (command: string, args: string[], env: NodeJS.ProcessEnv, onLine: (line: string) => void, cwd?: string) => Promise<number | null>;

export const exec: Exec = (command, args, env, onLine, cwd) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
  // A full install from an earlier app version is replaced: start from an empty environment.
  await rm(l.venv, { recursive: true, force: true });
  onLine(`Preparing Python ${PYTHON_VERSION}…`);
  // Always uv's own Python, never one that happens to be installed on the computer.
  if ((await run(p.uv, ['venv', '--allow-existing', '--managed-python', '--python', PYTHON_VERSION, l.venv], env, onLine)) !== 0) throw new Error('Could not set up Python for Open WebUI.');
  onLine(`Installing Open WebUI ${version} (first start only)…`);
  const folder = join(p.dataRoot, 'openwebui');
  await writeFile(join(folder, 'overrides.txt'), overridesFile());
  // uv cannot read an overrides file whose path has a space in it ("D365FO Agent"), so it runs in the folder and gets a bare name.
  // typer is imported by Open WebUI's entry point but only came in through one of the left-out packages.
  if ((await run(p.uv, ['pip', 'install', '--python', l.python, '--overrides', 'overrides.txt', 'typer', `open-webui==${version}`], env, onLine, folder)) !== 0) throw new Error('Could not install Open WebUI. Check the internet connection and try again.');
  // The downloaded packages are no longer needed once installed; keeping uv's cache would only take disk space.
  await rm(l.uvEnv.UV_CACHE_DIR, { recursive: true, force: true });
  await writeFile(l.marker, JSON.stringify({ version, variant: INSTALL_VARIANT, at: new Date().toISOString() }));
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

/** The D365FO tool server as Open WebUI stores it. */
export function toolConnection(opts: { toolUrl: string; toolKey: string }): Record<string, unknown> {
  return {
    type: 'openapi',
    url: opts.toolUrl,
    path: 'openapi.json',
    auth_type: 'bearer',
    key: opts.toolKey,
    config: { enable: true },
    info: { id: TOOL_SERVER_ID, name: 'D365FO test runner', description: 'Run and manage Dynamics 365 Finance & Operations tests' },
  };
}
const TOOL_SERVER_ID = 'd365fo';

/**
 * Open WebUI keeps its settings after the first start, so the tool server's address and key are written again on every
 * start through its own API. Only this one connection is replaced; other tool servers and the chat model (a global
 * setting, managed in Open WebUI) are left as the user has them.
 */
export async function syncToolServer(baseUrl: string, conn: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<void> {
  const call = async (path: string, token: string | undefined, body?: unknown): Promise<any> => {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`Open WebUI ${path} answered ${res.status}.`);
    return res.json();
  };
  // With sign-in switched off, Open WebUI signs in its one built-in local user (this is what its own page does).
  const token = (await call('/api/v1/auths/signin', undefined, { email: 'admin@localhost', password: 'admin' })).token as string | undefined;
  const current = ((await call('/api/v1/configs/tool_servers', token)).TOOL_SERVER_CONNECTIONS ?? []) as Array<{ info?: { id?: string } }>;
  const others = current.filter((c) => c.info?.id !== TOOL_SERVER_ID);
  const next = [conn, ...others];
  const mine = current.find((c) => c.info?.id === TOOL_SERVER_ID);
  if (mine && others.length === current.length - 1 && JSON.stringify(mine) === JSON.stringify(conn)) return;
  await call('/api/v1/configs/tool_servers', token, { TOOL_SERVER_CONNECTIONS: next });
}

/**
 * Points Open WebUI's first OpenAI connection at the chat AI model. The chat model is global, so this runs on every
 * start and whenever the model is changed on the Chat page; further connections the user added stay as they are.
 */
export async function syncChatModel(baseUrl: string, conn: { url: string; key: string } | undefined, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!conn) return;
  const call = async (path: string, token: string | undefined, body?: unknown): Promise<any> => {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`Open WebUI ${path} answered ${res.status}.`);
    return res.json();
  };
  const token = (await call('/api/v1/auths/signin', undefined, { email: 'admin@localhost', password: 'admin' })).token as string | undefined;
  const cur = await call('/openai/config', token);
  const urls = [...((cur.OPENAI_API_BASE_URLS ?? []) as string[])];
  const keys = [...((cur.OPENAI_API_KEYS ?? []) as string[])];
  const configs = { ...((cur.OPENAI_API_CONFIGS ?? {}) as Record<string, unknown>) };
  if (urls[0] === conn.url && keys[0] === conn.key && cur.ENABLE_OPENAI_API === true) return;
  urls[0] = conn.url;
  keys[0] = conn.key;
  configs['0'] = { ...((configs['0'] ?? {}) as object), enable: true };
  await call('/openai/config/update', token, { ENABLE_OPENAI_API: true, OPENAI_API_BASE_URLS: urls, OPENAI_API_KEYS: keys, OPENAI_API_CONFIGS: configs });
}

/** Environment for `open-webui serve`. */
export function serveEnv(opts: { dataDir: string; toolUrl: string; toolKey: string; chat?: { url: string; key: string } }, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    DATA_DIR: opts.dataDir,
    // One person on one computer: no sign-up screen.
    WEBUI_AUTH: 'False',
    // Open WebUI's slim mode: no local embeddings, speech or vector database (those packages are not installed).
    USE_SLIM_DOCKER: 'true',
    ...Object.fromEntries(DISABLED_FEATURES.map((f) => [f, 'False'])),
    // Open WebUI reads these on its first start and keeps them in its own settings after that (the tool server is written again on every start: syncToolServer).
    TOOL_SERVER_CONNECTIONS: JSON.stringify([toolConnection(opts)]),
    DEFAULT_PROMPT_SUGGESTIONS: JSON.stringify(PROMPT_SUGGESTIONS),
    ...(opts.chat ? { ENABLE_OPENAI_API: 'True', OPENAI_API_BASE_URL: opts.chat.url, OPENAI_API_KEY: opts.chat.key } : {}),
    BYPASS_EMBEDDING_AND_RETRIEVAL: 'True',
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
