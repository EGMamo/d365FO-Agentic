import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import type { AppConfig } from '../config/index.js';
import { agentHome } from '../profiles/paths.js';
import { openBrowser } from '../ui/open.js';
import { AzureCliTokenSource, type AzResult, type AzRunner, AZ_INSTALL_HINT } from '../devops/auth.js';

/**
 * How the agent signs in to F&O's OData endpoint (`<F&O address>/data`). Unlike the web client, `/data` does not
 * accept the browser session: it needs a Microsoft Entra access token for the F&O address. Three ways to get one:
 *
 * - browser: you sign in once in a browser window (`d365fo-agent d365-data-login`); the refresh token is kept
 *   per profile, so later runs need no sign-in and MFA is no problem.
 * - password: the same D365_USERNAME and D365_PASSWORD the tests use, sent to Microsoft's token endpoint. Only for
 *   accounts without MFA.
 * - azure-cli: the Microsoft account of `az login`.
 *
 * No app registration is needed: sign-in uses Microsoft's public Azure CLI client id, which the Azure SDKs use as
 * the default for interactive sign-in too.
 */
export type ODataAuthMode = 'browser' | 'password' | 'azure-cli';

export const PUBLIC_CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';
const LOGIN_HOST = 'https://login.microsoftonline.com';
const TENANT = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;

export interface ODataTokenSource {
  readonly mode: ODataAuthMode;
  token(signal?: AbortSignal): Promise<string>;
}

/** A sign-in problem in plain words, with what to do about it. */
export class ODataSignInError extends Error {}

type Fetch = typeof fetch;

/** The mode in use: `D365_ODATA_AUTH`, else the way the tests sign in (saved browser session, password), else the Azure CLI. */
export function odataAuthMode(cfg: Pick<AppConfig, 'D365_ODATA_AUTH' | 'D365_STORAGE_STATE' | 'D365_USERNAME' | 'D365_PASSWORD'>): ODataAuthMode {
  if (cfg.D365_ODATA_AUTH) return cfg.D365_ODATA_AUTH;
  if (cfg.D365_STORAGE_STATE) return 'browser';
  if (cfg.D365_USERNAME && cfg.D365_PASSWORD) return 'password';
  return 'azure-cli';
}

/** The origin F&O is served from: the token is issued for it, and OData lives under it. */
export function fnoOrigin(baseUrl: string | undefined): string {
  if (!baseUrl) throw new ODataSignInError('No F&O address is set (D365_BASE_URL).');
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:') throw new ODataSignInError('The F&O address must be https.');
  return url.origin;
}

/** The tenant F&O asks for tokens from, read from its 401 challenge, so a guest account signs in to the right directory. */
export async function discoverTenant(origin: string, f: Fetch = fetch): Promise<string | undefined> {
  try {
    const res = await f(`${origin}/data`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    const m = /authorization_uri="https?:\/\/[^/"]+\/([^/"]+)\//i.exec(res.headers.get('www-authenticate') ?? '');
    return m && TENANT.test(m[1]) ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

interface TokenResponse { access_token?: string; refresh_token?: string; expires_in?: number | string; error?: string; error_description?: string }

/** Plain-words reason for a refused token request. */
export function describeTokenError(body: { error?: string; error_description?: string }, hasRefresh = false): string {
  const text = `${body.error ?? ''} ${body.error_description ?? ''}`;
  if (/AADSTS50076|AADSTS50079|AADSTS50158|AADSTS53003|AADSTS530\d\d|multi-?factor|interaction_required/i.test(text) && !hasRefresh) {
    return 'This account needs multi-factor verification, so a password cannot be used for data access. Set "Data access sign-in" to browser and use "Sign in for data access" (or `d365fo-agent d365-data-login`).';
  }
  if (hasRefresh && /invalid_grant|AADSTS700082|AADSTS50173|AADSTS70043|AADSTS5007\d|interaction_required/i.test(text)) {
    return 'The data-access sign-in expired. Sign in again with "Sign in for data access" (or `d365fo-agent d365-data-login`).';
  }
  if (/AADSTS50126|AADSTS50034|AADSTS50053/i.test(text)) return 'Microsoft refused the username or password (or the account is locked). Check D365_USERNAME and D365_PASSWORD.';
  if (/AADSTS65001/i.test(text)) return 'This account has not allowed the Azure CLI to access F&O. Ask an administrator to grant consent, or choose another data-access sign-in.';
  const first = (body.error_description ?? body.error ?? 'no details').split('\n')[0].trim();
  return `Microsoft refused the sign-in for data access: ${first.slice(0, 300)}`;
}

/** The client id sign-in uses: the profile's own Entra app (D365_MCP_CLIENT_ID), else Microsoft's public Azure CLI client. */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function dataClientId(cfg: Pick<AppConfig, 'D365_MCP_CLIENT_ID'>): string {
  const id = cfg.D365_MCP_CLIENT_ID?.trim();
  if (!id) return PUBLIC_CLIENT_ID;
  if (!GUID.test(id)) throw new ODataSignInError('D365_MCP_CLIENT_ID must be the Application (client) ID of an Entra app registration: a GUID such as 00000000-0000-0000-0000-000000000000.');
  return id;
}

async function tokenRequest(tenant: string, params: Record<string, string>, f: Fetch, hasRefresh = false, clientId: string = PUBLIC_CLIENT_ID): Promise<Required<Pick<TokenResponse, 'access_token'>> & TokenResponse> {
  const res = await f(`${LOGIN_HOST}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ client_id: clientId, ...params }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !body.access_token) throw new ODataSignInError(describeTokenError(body, hasRefresh));
  return body as Required<Pick<TokenResponse, 'access_token'>> & TokenResponse;
}

/** Who a token is for, read from the token itself (never verified: only shown to the user). */
export function tokenAccount(token: string): string | undefined {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { upn?: string; unique_name?: string; preferred_username?: string };
    return claims.upn ?? claims.unique_name ?? claims.preferred_username;
  } catch {
    return undefined;
  }
}

const expiresAt = (body: TokenResponse, now: number): number => now + Math.max(60, Number(body.expires_in) || 3000) * 1000;

/** Keeps the access token until a few minutes before it expires. */
class Cached {
  private value?: { token: string; at: number };
  constructor(protected now: () => number) {}
  protected get(): string | undefined {
    return this.value && this.value.at - this.now() > 5 * 60_000 ? this.value.token : undefined;
  }
  protected set(token: string, at: number): string {
    this.value = { token, at };
    return token;
  }
}

/** The configured username and password, sent to Microsoft's token endpoint (no MFA). */
export class PasswordTokenSource extends Cached implements ODataTokenSource {
  readonly mode = 'password' as const;
  constructor(private origin: string, private username: string, private password: string, private tenant?: string, private f: Fetch = fetch, now: () => number = Date.now, private clientId: string = PUBLIC_CLIENT_ID) {
    super(now);
  }
  async token(): Promise<string> {
    const cached = this.get();
    if (cached) return cached;
    const tenant = this.tenant ?? (await discoverTenant(this.origin, this.f)) ?? 'organizations';
    const body = await tokenRequest(tenant, { grant_type: 'password', username: this.username, password: this.password, scope: `${this.origin}/.default` }, this.f, false, this.clientId);
    return this.set(body.access_token, expiresAt(body, this.now()));
  }
}

interface StoredSignIn { origin: string; tenant: string; refreshToken: string; account?: string; clientId?: string }

/** Where a profile keeps its data-access sign-in. It holds a refresh token: as private as a saved browser session. */
export function signInFile(cfg: Pick<AppConfig, 'PROFILE_ID'>, home: string = agentHome()): string {
  return join(home, 'odata', `${cfg.PROFILE_ID ?? 'default'}.json`);
}

/** The sign-in made in a browser (`d365-data-login`), renewed with its refresh token. */
export class BrowserTokenSource extends Cached implements ODataTokenSource {
  readonly mode = 'browser' as const;
  constructor(private origin: string, private file: string, private f: Fetch = fetch, now: () => number = Date.now, private clientId: string = PUBLIC_CLIENT_ID) {
    super(now);
  }

  private async load(): Promise<StoredSignIn | undefined> {
    try {
      const stored = JSON.parse(await readFile(this.file, 'utf8')) as Partial<StoredSignIn>;
      // A refresh token belongs to the app that got it: another client id means signing in again.
      return stored.origin === this.origin && stored.refreshToken && stored.tenant && (stored.clientId ?? PUBLIC_CLIENT_ID) === this.clientId ? (stored as StoredSignIn) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Whether a sign-in for this F&O address exists, and as whom. */
  async status(): Promise<{ signedIn: boolean; account?: string }> {
    const s = await this.load();
    return { signedIn: Boolean(s), ...(s?.account ? { account: s.account } : {}) };
  }

  async token(): Promise<string> {
    const cached = this.get();
    if (cached) return cached;
    const stored = await this.load();
    if (!stored) throw new ODataSignInError('Not signed in for data access yet. Use "Sign in for data access" in the settings app, or run `d365fo-agent d365-data-login`.');
    const body = await tokenRequest(stored.tenant, { grant_type: 'refresh_token', refresh_token: stored.refreshToken, scope: `${this.origin}/.default offline_access` }, this.f, true, this.clientId);
    // Microsoft rotates refresh tokens: keep the new one, or the next run would present an old one.
    if (body.refresh_token && body.refresh_token !== stored.refreshToken) await this.save({ ...stored, refreshToken: body.refresh_token });
    return this.set(body.access_token, expiresAt(body, this.now()));
  }

  private async save(s: StoredSignIn): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(s), { mode: 0o600 });
  }

  /** Opens the Microsoft sign-in in a browser and keeps the result. Resolves with who signed in. */
  async login(opts: { open?: (url: string) => void | Promise<void>; timeoutMs?: number; tenant?: string } = {}): Promise<{ account?: string }> {
    const tenant = opts.tenant ?? (await discoverTenant(this.origin, this.f)) ?? 'organizations';
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(16).toString('base64url');
    let finish!: (r: { code?: string; error?: string }) => void;
    const result = new Promise<{ code?: string; error?: string }>((resolve) => { finish = resolve; });
    const server = createServer((req, res) => {
      const q = new URL(req.url ?? '/', 'http://localhost').searchParams;
      if (!q.has('code') && !q.has('error')) { res.writeHead(404).end(); return; }
      const ok = q.get('state') === state && q.has('code');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>Sign-in</title><body style="font:16px system-ui;margin:3rem">${ok ? 'Signed in. You can close this window and go back to the app.' : 'The sign-in did not finish. Go back to the app and try again.'}</body>`);
      finish(ok ? { code: q.get('code') ?? undefined } : { error: q.get('error_description') ?? q.get('error') ?? 'the sign-in was not completed' });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as { port: number }).port;
    const redirectUri = `http://localhost:${port}`;
    const url = `${LOGIN_HOST}/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize?${new URLSearchParams({
      client_id: this.clientId, response_type: 'code', redirect_uri: redirectUri, response_mode: 'query',
      scope: `${this.origin}/.default offline_access`, state, prompt: 'select_account',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    })}`;
    const timer = setTimeout(() => finish({ error: 'no sign-in was completed within 5 minutes' }), opts.timeoutMs ?? 5 * 60_000);
    try {
      await (opts.open ?? openInBrowser)(url);
      const r = await result;
      if (!r.code) throw new ODataSignInError(`The sign-in did not finish: ${String(r.error).split('\n')[0].slice(0, 300)}`);
      const body = await tokenRequest(tenant, { grant_type: 'authorization_code', code: r.code, redirect_uri: redirectUri, code_verifier: verifier, scope: `${this.origin}/.default offline_access` }, this.f, false, this.clientId);
      if (!body.refresh_token) throw new ODataSignInError('Microsoft returned no refresh token, so the sign-in cannot be kept. Try again, or use another data-access sign-in.');
      const account = tokenAccount(body.access_token);
      await this.save({ origin: this.origin, tenant, refreshToken: body.refresh_token, ...(account ? { account } : {}), ...(this.clientId !== PUBLIC_CLIENT_ID ? { clientId: this.clientId } : {}) });
      this.set(body.access_token, expiresAt(body, this.now()));
      return { account };
    } finally {
      clearTimeout(timer);
      server.close();
    }
  }

  /** Forgets the sign-in. */
  async logout(): Promise<void> {
    await rm(this.file, { force: true });
  }
}

/** Opens the sign-in page in the default browser; when none can be started, prints the address to open by hand. */
async function openInBrowser(url: string): Promise<void> {
  if (!(await openBrowser(url))) console.log(`Open this address in a browser to sign in:\n${url}`);
}

/** The Azure CLI's token for F&O, for people who already use `az login`. */
function azureCliSource(origin: string, tenant: string | undefined, az?: AzRunner): ODataTokenSource {
  const problem = (res: AzResult): string => {
    if (res.missing) return `The Azure CLI is not installed. ${AZ_INSTALL_HINT}, or choose another data-access sign-in.`;
    const err = res.stderr.trim();
    if (/az login|not logged in|AADSTS|expired|interaction_required/i.test(err)) return 'The Azure CLI is not signed in for F&O (or the sign-in expired). Run `az login`, or choose another data-access sign-in.';
    return `The Azure CLI could not get a token for F&O: ${err.split('\n').find((l) => l.trim())?.trim() ?? `exit code ${res.code}`}`;
  };
  const source = new AzureCliTokenSource(tenant, az, Date.now, origin, problem);
  return { mode: 'azure-cli', token: () => source.token() };
}

export interface ODataAuthDeps { fetch?: Fetch; az?: AzRunner; home?: string; now?: () => number }

/** The token source for the profile's data-access sign-in. */
export function createODataTokenSource(cfg: AppConfig, deps: ODataAuthDeps = {}): ODataTokenSource {
  const origin = fnoOrigin(cfg.D365_BASE_URL);
  const mode = odataAuthMode(cfg);
  const clientId = dataClientId(cfg);
  if (mode === 'browser') return new BrowserTokenSource(origin, signInFile(cfg, deps.home), deps.fetch, deps.now, clientId);
  if (mode === 'password') {
    if (!cfg.D365_USERNAME || !cfg.D365_PASSWORD) throw new ODataSignInError('Data access with a password needs D365_USERNAME and D365_PASSWORD.');
    return new PasswordTokenSource(origin, cfg.D365_USERNAME, cfg.D365_PASSWORD, undefined, deps.fetch, deps.now, clientId);
  }
  if (clientId !== PUBLIC_CLIENT_ID) throw new ODataSignInError('The Azure CLI sign-in always uses the Azure CLI app, so it cannot use D365_MCP_CLIENT_ID. Set "Data access sign-in" to browser or password, or clear the client id.');
  return azureCliSource(origin, undefined, deps.az);
}
