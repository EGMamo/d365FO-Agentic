import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { chmod, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Open WebUI for the desktop app, without Docker. The app ships `uv` (a single binary); on first start uv downloads a
 * standalone Python and installs a pinned Open WebUI into the app's data folder, then every start runs it from there
 * on this computer only, signed in as the single local user, with the D365FO tool server already connected.
 * Nothing here imports Electron, so it is tested like the rest of the code.
 */
export const OPENWEBUI_VERSION = '0.11.4';
export const PYTHON_VERSION = '3.11';
/** Bump when the set of installed packages changes, so an older install is replaced. */
export const INSTALL_VARIANT = 'slim-auth-locked-2';

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

interface InstallMarker { version?: string; variant?: string; runtime?: string; lockHash?: string; dataBackup?: string; previous?: InstallMarker; }
const validRuntime = (name: unknown): name is string => typeof name === 'string' && /^venv-[a-z0-9-]{8,80}$/.test(name);

function marker(p: OpenWebUiPaths): InstallMarker | undefined {
  try { return JSON.parse(readFileSync(join(p.dataRoot, 'openwebui', 'installed.json'), 'utf8')) as InstallMarker; }
  catch { return undefined; }
}

/** Source-tree development and staged desktop installations use the same checked-in lock. */
export function pythonLockFile(): string {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  for (const dir of [join(root, 'runtime', 'python'), join(root, 'src', 'desktop', 'python')]) {
    const path = join(dir, 'requirements.lock');
    if (existsSync(path)) return path;
  }
  throw new Error('The pinned Open WebUI Python requirements lock is missing from this installation.');
}

const lockHash = (): string => createHash('sha256').update(readFileSync(pythonLockFile())).digest('hex');

export function layout(p: OpenWebUiPaths) {
  const win = (p.platform ?? process.platform) === 'win32';
  const installed = marker(p);
  const venv = join(p.dataRoot, 'openwebui', validRuntime(installed?.runtime) ? installed.runtime : 'venv');
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
    const m = JSON.parse(await readFile(l.marker, 'utf8')) as InstallMarker;
    return m.version === version && m.variant === INSTALL_VARIANT && m.lockHash === lockHash();
  } catch {
    return false;
  }
}

export type Exec = (command: string, args: string[], env: NodeJS.ProcessEnv, onLine: (line: string) => void, cwd?: string) => Promise<number | null>;
const setupChildren = new Set<ChildProcess>();

/** First-start setup belongs to this app lifetime, including uv's installer subprocesses. */
export function cancelInstallation(): void {
  for (const child of setupChildren) {
    if (!child.pid) continue;
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else process.kill(-child.pid, 'SIGTERM');
    } catch { /* already stopped */ }
  }
}

export const exec: Exec = (command, args, env, onLine, cwd) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    setupChildren.add(child);
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
      setupChildren.delete(child);
      onLine(e.message);
      resolve(null);
    });
    child.on('close', (code) => { setupChildren.delete(child); resolve(code); });
  });

/** First start: a Python and Open WebUI in a private venv inside the app folder. */
export async function install(p: OpenWebUiPaths, onLine: (line: string) => void, run: Exec = exec, version = OPENWEBUI_VERSION): Promise<void> {
  const l = layout(p);
  const env = { ...process.env, ...l.uvEnv };
  const folder = join(p.dataRoot, 'openwebui');
  const runtime = `venv-${randomUUID()}`;
  const candidate = join(folder, runtime);
  const python = join(candidate, (p.platform ?? process.platform) === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const requirements = readFileSync(pythonLockFile());
  const digest = createHash('sha256').update(requirements).digest('hex');
  const previous = marker(p);
  const dataBackup = previous ? `data-backup-${randomUUID()}` : undefined;
  await mkdir(l.data, { recursive: true, mode: 0o700 });
  // Virtualenv entry points contain absolute paths: never rename an installed venv. Activate an immutable candidate.
  try {
    if (dataBackup) await cp(l.data, join(folder, dataBackup), { recursive: true });
    onLine(`Preparing Python ${PYTHON_VERSION}…`);
    if ((await run(p.uv, ['venv', '--managed-python', '--python', PYTHON_VERSION, candidate], env, onLine)) !== 0) throw new Error('Could not set up Python for Open WebUI.');
    onLine(`Installing Open WebUI ${version} from the verified runtime lock…`);
    await writeFile(join(folder, 'requirements.lock'), requirements, { mode: 0o600 });
    if ((await run(p.uv, ['pip', 'install', '--python', python, '--require-hashes', '--no-deps', '-r', 'requirements.lock'], env, onLine, folder)) !== 0) throw new Error('Could not install Open WebUI. The previous runtime was retained; check the internet connection and retry.');
    const next = { version, variant: INSTALL_VARIANT, runtime, lockHash: digest, at: new Date().toISOString(), ...(previous ? { previous: { ...previous, previous: undefined }, dataBackup } : {}) };
    await writeFile(`${l.marker}.tmp`, JSON.stringify(next), { mode: 0o600 });
    await rename(`${l.marker}.tmp`, l.marker);
  } catch (e) {
    await rm(candidate, { recursive: true, force: true });
    if (dataBackup) await rm(join(folder, dataBackup), { recursive: true, force: true });
    throw e;
  } finally {
    await rm(l.uvEnv.UV_CACHE_DIR, { recursive: true, force: true }).catch(() => {});
  }
}

/** Restore the preceding runtime after a new runtime fails its first health check. Conversation data stays in place. */
export async function rollbackInstall(p: OpenWebUiPaths): Promise<boolean> {
  const current = marker(p);
  if (!current?.previous) return false;
  const previous = current.previous;
  if (previous.runtime !== undefined && !validRuntime(previous.runtime)) return false;
  const dir = join(p.dataRoot, 'openwebui', previous.runtime ?? 'venv');
  const exe = join(dir, (p.platform ?? process.platform) === 'win32' ? 'Scripts/open-webui.exe' : 'bin/open-webui');
  if (!existsSync(exe)) return false;
  const target = join(p.dataRoot, 'openwebui', 'installed.json');
  await writeFile(`${target}.tmp`, JSON.stringify(previous), { mode: 0o600 });
  if (current.dataBackup) {
    if (!/^data-backup-[a-f0-9-]{36}$/.test(current.dataBackup)) return false;
    const folder = join(p.dataRoot, 'openwebui');
    const backup = join(folder, current.dataBackup);
    if (!existsSync(backup)) return false;
    // Preserve the failed runtime's data as well; rolling back never deletes conversations.
    await rename(join(folder, 'data'), join(folder, `data-failed-${randomUUID()}`));
    await rename(backup, join(folder, 'data'));
  }
  await rename(`${target}.tmp`, target);
  return true;
}

export interface DesktopAuth { header: string; secretKey: string; }
const DESKTOP_USER = 'admin@localhost';

/** The trusted-header name is a per-launch bearer secret held only by the main process and Python. */
export async function desktopAuth(p: OpenWebUiPaths): Promise<DesktopAuth> {
  const folder = join(p.dataRoot, 'openwebui');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await chmod(folder, 0o700);
  const path = join(folder, 'desktop-auth.key');
  let secretKey: string;
  try { secretKey = (await readFile(path, 'utf8')).trim(); }
  catch { secretKey = randomBytes(32).toString('hex'); await writeFile(path, secretKey, { mode: 0o600, flag: 'wx' }); }
  if (!/^[a-f0-9]{64}$/.test(secretKey)) throw new Error('The desktop chat authentication key is invalid. Restore it from a private backup.');
  await chmod(path, 0o600);
  return { header: `x-d365fo-desktop-${randomBytes(32).toString('hex')}`, secretKey };
}

/** Electron's request hook uses frame identity, not a renderer-provided header, as the grant boundary. */
export function chatRequestHeaders(
  request: { url: string; webContentsId: number; frameUrl?: string; resourceType: string; headers: Record<string, string> },
  chat: { origin: string; webContentsId: number; splashUrl: string; currentUrl: string; auth: DesktopAuth },
): Record<string, string> {
  const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !name.toLowerCase().startsWith('x-d365fo-desktop-')));
  try {
    const frame = request.frameUrl || (request.resourceType === 'mainFrame' ? chat.currentUrl : '');
    const sourceAllowed = new URL(frame).origin === chat.origin || (request.resourceType === 'mainFrame' && frame === chat.splashUrl);
    if (request.webContentsId === chat.webContentsId && new URL(request.url).origin === chat.origin && sourceAllowed) headers[chat.auth.header] = DESKTOP_USER;
  } catch { /* Invalid or missing origins receive no capability. */ }
  return headers;
}

export async function signIn(baseUrl: string, auth: DesktopAuth, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`${baseUrl}/api/v1/auths/signin`, {
    method: 'POST', headers: { [auth.header]: DESKTOP_USER, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: DESKTOP_USER, password: '' }), signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`The protected chat session could not start (${res.status}).`);
  const body = await res.json() as { token?: unknown };
  if (typeof body.token !== 'string' || !body.token) throw new Error('The protected chat returned no session token.');
  return body.token;
}

export const PROMPT_SUGGESTIONS = [
  { title: ['Check my setup', 'before testing'], content: 'Check the active environment setup and explain anything missing.' },
  { title: ['Run selected tests', 'from a local folder or DevOps'], content: 'Help me select test cases. Show the environment and cases and ask me to confirm before starting a real run.' },
  { title: ['Explain my results', 'and the next action'], content: 'Show the latest test run results and explain any failed or blocked steps.' },
  { title: ['Compare with last run', 'what was fixed or broke'], content: 'Compare the latest run with the previous run of this environment and tell me what was fixed, what regressed and what still fails.' },
  { title: ['Rerun failed cases', 'of the latest run'], content: 'Show the failed and blocked cases of the latest run and, after I confirm, rerun only those.' },
  { title: ['Upload results', 'to Azure DevOps'], content: 'Show the latest run and ask me to confirm before uploading its results to Azure DevOps.' },
];

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
export async function syncToolServer(baseUrl: string, conn: Record<string, unknown>, token: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const call = async (path: string, body?: unknown): Promise<any> => {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Open WebUI ${path} answered ${res.status}.`);
    return res.json();
  };
  const current = ((await call('/api/v1/configs/tool_servers')).TOOL_SERVER_CONNECTIONS ?? []) as Array<{ info?: { id?: string } }>;
  const others = current.filter((c) => c.info?.id !== TOOL_SERVER_ID);
  const next = [conn, ...others];
  const mine = current.find((c) => c.info?.id === TOOL_SERVER_ID);
  if (mine && others.length === current.length - 1 && JSON.stringify(mine) === JSON.stringify(conn)) return;
  await call('/api/v1/configs/tool_servers', { TOOL_SERVER_CONNECTIONS: next });
}

/**
 * Points Open WebUI's first OpenAI connection at the chat AI model. The chat model is global, so this runs on every
 * start and whenever the model is changed on the Chat page; further connections the user added stay as they are.
 */
export async function syncChatModel(baseUrl: string, conn: { url: string; key: string } | undefined, token: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!conn) return;
  const call = async (path: string, body?: unknown): Promise<any> => {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Open WebUI ${path} answered ${res.status}.`);
    return res.json();
  };
  const cur = await call('/openai/config');
  const urls = [...((cur.OPENAI_API_BASE_URLS ?? []) as string[])];
  const keys = [...((cur.OPENAI_API_KEYS ?? []) as string[])];
  const configs = { ...((cur.OPENAI_API_CONFIGS ?? {}) as Record<string, unknown>) };
  if (urls[0] === conn.url && keys[0] === conn.key && cur.ENABLE_OPENAI_API === true) return;
  urls[0] = conn.url;
  keys[0] = conn.key;
  configs['0'] = { ...((configs['0'] ?? {}) as object), enable: true };
  await call('/openai/config/update', { ENABLE_OPENAI_API: true, OPENAI_API_BASE_URLS: urls, OPENAI_API_KEYS: keys, OPENAI_API_CONFIGS: configs });
}

/** Environment for `open-webui serve`. */
export function serveEnv(opts: { dataDir: string; toolUrl: string; toolKey: string; origin: string; auth: DesktopAuth; chat?: { url: string; key: string }; model?: string }, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!/^x-d365fo-desktop-[a-f0-9]{64}$/.test(opts.auth.header) || !/^[a-f0-9]{64}$/.test(opts.auth.secretKey)) throw new Error('A protected desktop chat session is required.');
  const origin = new URL(opts.origin);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.origin !== opts.origin) throw new Error('The chat origin must be an exact loopback HTTP origin.');
  return {
    // These credentials belong to the Node service; Python only needs the local bridge token.
    ...Object.fromEntries(Object.entries(base).filter(([key]) => !['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'D365_USERNAME', 'D365_PASSWORD', 'D365_CLIENT_SECRET', 'AZDO_PAT'].includes(key))),
    DATA_DIR: opts.dataDir,
    // The main process injects an unguessable trusted-header name for the existing local user's identity.
    WEBUI_AUTH: 'True',
    WEBUI_AUTH_TRUSTED_EMAIL_HEADER: opts.auth.header,
    WEBUI_AUTH_TRUSTED_NAME_HEADER: '',
    WEBUI_AUTH_TRUSTED_GROUPS_HEADER: '',
    WEBUI_AUTH_TRUSTED_ROLE_HEADER: '',
    WEBUI_SECRET_KEY: opts.auth.secretKey,
    ENABLE_LOGIN_FORM: 'False',
    ENABLE_SIGNUP: 'False',
    ENABLE_INITIAL_ADMIN_SIGNUP: 'False',
    ENABLE_PASSWORD_AUTH: 'True', // Upstream trusted-header signin shares this gate; passwords cannot bypass its header check.
    ENABLE_LDAP: 'False',
    ENABLE_OAUTH_SIGNUP: 'False',
    ENABLE_OAUTH_TOKEN_EXCHANGE: 'False',
    ENABLE_OAUTH_PERSISTENT_CONFIG: 'False',
    CORS_ALLOW_ORIGIN: opts.origin,
    WEBUI_URL: opts.origin,
    WEBUI_AUTH_COOKIE_SAME_SITE: 'strict',
    WEBUI_SESSION_COOKIE_SAME_SITE: 'strict',
    JWT_EXPIRES_IN: '8h',
    // App-managed settings take effect on existing installs too; conversation data stays in the same database.
    ENABLE_PERSISTENT_CONFIG: 'False',
    DEFAULT_MODELS: opts.model ?? '',
    DEFAULT_MODEL_PARAMS: JSON.stringify({ function_calling: 'native' }),
    DEFAULT_MODEL_METADATA: JSON.stringify({ toolIds: ['server:d365fo'], capabilities: { vision: false, file_upload: false, web_search: false, image_generation: false, code_interpreter: false } }),
    // Open WebUI's slim mode: no local embeddings, speech or vector database (those packages are not installed).
    USE_SLIM_DOCKER: 'true',
    ...Object.fromEntries(DISABLED_FEATURES.map((f) => [f, 'False'])),
    // Open WebUI reads these on its first start and keeps them in its own settings after that (the tool server is written again on every start: syncToolServer).
    TOOL_SERVER_CONNECTIONS: JSON.stringify([toolConnection(opts)]),
    DEFAULT_PROMPT_SUGGESTIONS: JSON.stringify(PROMPT_SUGGESTIONS),
    ...(opts.chat ? { ENABLE_OPENAI_API: 'True', OPENAI_API_BASE_URL: opts.chat.url, OPENAI_API_KEY: opts.chat.key, OPENAI_API_BASE_URLS: opts.chat.url, OPENAI_API_KEYS: opts.chat.key, OPENAI_API_CONFIGS: JSON.stringify({ '0': { enable: true, model_ids: ['d365fo-claude'] } }) } : {}),
    USER_PERMISSIONS_CHAT_FILE_UPLOAD: 'False',
    USER_PERMISSIONS_CHAT_WEB_UPLOAD: 'False',
    USER_PERMISSIONS_CHAT_STT: 'False',
    USER_PERMISSIONS_CHAT_TTS: 'False',
    USER_PERMISSIONS_CHAT_CALL: 'False',
    USER_PERMISSIONS_CHAT_MULTIPLE_MODELS: 'False',
    // The app supplies the model, its parameters and its tools; per-chat overrides only confuse a test chat.
    USER_PERMISSIONS_CHAT_CONTROLS: 'False',
    USER_PERMISSIONS_CHAT_PARAMS: 'False',
    USER_PERMISSIONS_CHAT_SYSTEM_PROMPT: 'False',
    // Looks and behaves as part of the desktop app: its name, no update banner, no upstream easter eggs.
    WEBUI_NAME: 'D365FO Agent',
    ENABLE_VERSION_UPDATE_CHECK: 'False',
    ENABLE_EASTER_EGGS: 'False',
    ENABLE_USER_STATUS: 'False',
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
