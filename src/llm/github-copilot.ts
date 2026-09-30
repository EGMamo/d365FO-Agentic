import { readFileSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fetchWithResilience, type ResilientRequestOptions } from '../utils/http.js';
import { LlmHttpError } from './errors.js';
import { OpenAiCompatibleProvider } from './openai-compatible.js';
import type { LlmProvider } from './types.js';

/**
 * GitHub Copilot adapter.
 *
 * Copilot has no static inference API key. Editor plugins sign in with GitHub's
 * OAuth device flow, then trade the resulting OAuth token for a short-lived
 * (~30 min) Copilot session token; that token authorizes an OpenAI-compatible
 * chat-completions endpoint. This file mirrors that flow.
 *
 * NOTE: the token exchange and the editor headers below are not part of a
 * documented GitHub API — they follow what the VS Code Copilot Chat extension
 * sends and can change without notice. Personal access tokens are not accepted.
 */

/** OAuth client id of the GitHub Copilot editor plugin (public, not a secret). */
const COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
const DEFAULT_API_BASE = 'https://api.githubcopilot.com';

/** Refresh the session token this long before it actually expires. */
const REFRESH_SKEW_MS = 60_000;
/** Used when the exchange response carries no `expires_at`. */
const FALLBACK_TTL_MS = 10 * 60_000;

const EDITOR_HEADERS: Record<string, string> = {
  'editor-version': 'vscode/1.95.0',
  'editor-plugin-version': 'copilot-chat/0.22.4',
  'user-agent': 'GitHubCopilotChat/0.22.4',
};

const CHAT_HEADERS: Record<string, string> = {
  ...EDITOR_HEADERS,
  'copilot-integration-id': 'vscode-chat',
  'openai-intent': 'conversation-panel',
};

const DEFAULT_HTTP: ResilientRequestOptions = { timeoutMs: 60000, maxRetries: 2, retryBaseMs: 500 };

export const DEFAULT_AUTH_FILE = join(homedir(), '.d365fo-agent', 'github-copilot.json');

/**
 * Returns the GitHub OAuth token to exchange for Copilot sessions: the explicit
 * env value wins, otherwise the token saved by `copilot-login`.
 */
export function resolveGitHubToken(envToken?: string, authFile = DEFAULT_AUTH_FILE): string | undefined {
  if (envToken?.trim()) return envToken.trim();
  try {
    const saved = JSON.parse(readFileSync(authFile, 'utf8')) as { oauth_token?: unknown };
    return typeof saved.oauth_token === 'string' && saved.oauth_token ? saved.oauth_token : undefined;
  } catch {
    return undefined;
  }
}

export async function saveGitHubToken(token: string, authFile = DEFAULT_AUTH_FILE): Promise<void> {
  await mkdir(dirname(authFile), { recursive: true, mode: 0o700 });
  await writeFile(authFile, JSON.stringify({ oauth_token: token }, null, 2), { mode: 0o600 });
  await chmod(authFile, 0o600);
}

export interface DeviceFlowPrompt {
  userCode: string;
  verificationUri: string;
}

/**
 * Runs GitHub's OAuth device flow. `onPrompt` receives the code the user must
 * enter in the browser; resolves with the OAuth token once they approve.
 */
export async function loginWithDeviceFlow(opts: {
  onPrompt: (prompt: DeviceFlowPrompt) => void;
  http?: ResilientRequestOptions;
  sleep?: (ms: number) => Promise<void>;
}): Promise<string> {
  const http = opts.http ?? DEFAULT_HTTP;
  const sleep = opts.sleep ?? defaultSleep;

  const device = await postJson<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval?: number;
  }>(DEVICE_CODE_URL, { client_id: COPILOT_CLIENT_ID, scope: 'read:user' }, http);
  opts.onPrompt({ userCode: device.user_code, verificationUri: device.verification_uri });

  let intervalMs = (device.interval ?? 5) * 1000;
  const deadline = Date.now() + device.expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const poll = await postJson<{
      access_token?: string;
      error?: string;
      error_description?: string;
      interval?: number;
    }>(
      ACCESS_TOKEN_URL,
      {
        client_id: COPILOT_CLIENT_ID,
        device_code: device.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      },
      http,
    );
    if (poll.access_token) return poll.access_token;
    switch (poll.error) {
      case 'authorization_pending':
        break;
      case 'slow_down':
        intervalMs = (poll.interval ?? intervalMs / 1000 + 5) * 1000;
        break;
      case 'expired_token':
        throw new Error('The GitHub device code expired before it was approved. Run the login again.');
      case 'access_denied':
        throw new Error('Authorization was denied in the browser.');
      default:
        throw new Error(`GitHub device flow failed: ${poll.error ?? 'unknown error'} ${poll.error_description ?? ''}`.trim());
    }
  }
  throw new Error('The GitHub device code expired before it was approved. Run the login again.');
}

export interface CopilotSession {
  token: string;
  /** Base URL of the Copilot API for this account (varies by plan). */
  apiBase: string;
  expiresAtMs: number;
}

/** Exchanges a GitHub OAuth token for Copilot session tokens and caches them until near expiry. */
export class CopilotSessionAuth {
  private session?: CopilotSession;

  constructor(
    private readonly githubToken: string,
    private readonly http: ResilientRequestOptions = DEFAULT_HTTP,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<CopilotSession> {
    if (this.session && this.session.expiresAtMs - REFRESH_SKEW_MS > this.now()) return this.session;
    this.session = await this.exchange();
    return this.session;
  }

  /** Drops the cached session so the next `get()` exchanges again. */
  invalidate(): void {
    this.session = undefined;
  }

  private async exchange(): Promise<CopilotSession> {
    const res = await fetchWithResilience(
      COPILOT_TOKEN_URL,
      {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `token ${this.githubToken}`, ...EDITOR_HEADERS },
      },
      this.http,
    );
    if (!res.ok) {
      const text = await res.text();
      throw new LlmHttpError(
        `GitHub Copilot token exchange failed (HTTP ${res.status}): ${text}\n` +
          'Check that this account has an active Copilot subscription and that the token came from ' +
          '`d365fo-agent copilot-login` (personal access tokens are not accepted).',
        res.status,
      );
    }
    const data = (await res.json()) as { token?: string; expires_at?: number; endpoints?: { api?: string } };
    if (!data.token) throw new Error('GitHub Copilot token exchange returned no token');
    return {
      token: data.token,
      apiBase: (data.endpoints?.api ?? DEFAULT_API_BASE).replace(/\/$/, ''),
      expiresAtMs: typeof data.expires_at === 'number' ? data.expires_at * 1000 : this.now() + FALLBACK_TTL_MS,
    };
  }
}

export function createGitHubCopilotProvider(opts: {
  githubToken: string;
  model: string;
  maxTokens: number;
  temperature: number;
  http?: ResilientRequestOptions;
}): LlmProvider {
  const http = opts.http ?? DEFAULT_HTTP;
  const auth = new CopilotSessionAuth(opts.githubToken, http);
  return new OpenAiCompatibleProvider({
    name: 'github-copilot',
    baseUrl: `${DEFAULT_API_BASE}/chat/completions`,
    apiKey: '', // supplied per request by resolveAuth
    model: opts.model,
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    headers: CHAT_HEADERS,
    timeoutMs: http.timeoutMs,
    maxRetries: http.maxRetries,
    retryBaseMs: http.retryBaseMs,
    resolveAuth: async () => {
      const session = await auth.get();
      return { apiKey: session.token, baseUrl: `${session.apiBase}/chat/completions` };
    },
    onUnauthorized: () => auth.invalidate(),
  });
}

async function postJson<T>(url: string, body: unknown, http: ResilientRequestOptions): Promise<T> {
  const res = await fetchWithResilience(
    url,
    {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', ...EDITOR_HEADERS },
      body: JSON.stringify(body),
    },
    http,
  );
  if (!res.ok) throw new Error(`GitHub request to ${url} failed (HTTP ${res.status}): ${await res.text()}`);
  return (await res.json()) as T;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
