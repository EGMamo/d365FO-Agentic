import type { AppConfig } from '../config/index.js';
import type { LlmTool } from '../llm/types.js';
import { fetchWithResilience, type ResilientRequestOptions } from '../utils/http.js';

/**
 * Entra ID app registration (client credentials) access to the F&O OData API.
 *
 * An app registration cannot sign in to the F&O web client, so it does not replace D365_USERNAME / a saved session
 * for browser steps. It gives the agent a read-only data channel: checking that a record a step created really
 * exists, or reading a value to compare with the page. The app must be registered in F&O under
 * System administration > Setup > Microsoft Entra ID applications, mapped to a user with read access.
 */
export const ODATA_TOOL_NAME = 'd365_odata_query';

export const ODATA_TOOL: LlmTool = {
  name: ODATA_TOOL_NAME,
  description:
    'Read-only query of a D365 F&O data entity through OData, signed in with the configured Entra app registration. ' +
    'Use it to verify data a step created or changed (for example that vendor V-1001 exists), not instead of doing the step in the browser. ' +
    'Pass the public entity set name (e.g. "VendorsV2", "CustomersV3", "SalesOrderHeadersV2"), an optional OData $filter, $select and $top (max 50).',
  inputSchema: {
    type: 'object',
    required: ['entity'],
    properties: {
      entity: { type: 'string', description: 'Public entity set name, e.g. VendorsV2' },
      filter: { type: 'string', description: "OData $filter, e.g. VendorAccountNumber eq 'V-1001'" },
      select: { type: 'string', description: 'Comma-separated fields for $select' },
      top: { type: 'number', description: 'Maximum rows (1-50, default 10)' },
      crossCompany: { type: 'boolean', description: 'Query every legal entity instead of the default company' },
    },
  },
};

export const hasAppRegistration = (cfg: Pick<AppConfig, 'D365_TENANT_ID' | 'D365_CLIENT_ID' | 'D365_CLIENT_SECRET'>): boolean =>
  Boolean(cfg.D365_TENANT_ID && cfg.D365_CLIENT_ID && cfg.D365_CLIENT_SECRET);

const ENTITY = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const SELECT = /^[A-Za-z0-9_, ]{1,1000}$/;
const MAX_TOP = 50;
const MAX_RESULT_CHARS = 20_000;

export interface ODataQuery {
  entity: string;
  filter?: string;
  select?: string;
  top?: number;
  crossCompany?: boolean;
}

/** Validates model-supplied arguments and builds the request path. Throws with a message the model can act on. */
export function buildODataPath(q: ODataQuery): string {
  if (!ENTITY.test(q.entity ?? '')) throw new Error('`entity` must be a public entity set name such as VendorsV2.');
  const params = new URLSearchParams();
  if (q.filter) {
    if (q.filter.length > 2000) throw new Error('`filter` is too long (max 2000 characters).');
    params.set('$filter', q.filter);
  }
  if (q.select) {
    if (!SELECT.test(q.select)) throw new Error('`select` must be a comma-separated list of field names.');
    params.set('$select', q.select.replace(/\s+/g, ''));
  }
  const top = Number.isFinite(q.top) ? Math.min(MAX_TOP, Math.max(1, Math.trunc(q.top as number))) : 10;
  params.set('$top', String(top));
  if (q.crossCompany) params.set('cross-company', 'true');
  return `/data/${q.entity}?${params.toString().replace(/\+/g, '%20')}`;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

export class D365ODataClient {
  private token?: CachedToken;
  private readonly baseUrl: string;
  private readonly http: ResilientRequestOptions;

  constructor(
    private readonly cfg: AppConfig,
    private readonly fetchImpl: typeof fetchWithResilience = fetchWithResilience,
  ) {
    if (!cfg.D365_BASE_URL) throw new Error('D365_BASE_URL is required for the app registration.');
    if (!hasAppRegistration(cfg)) throw new Error('D365_TENANT_ID, D365_CLIENT_ID and D365_CLIENT_SECRET are required for the app registration.');
    this.baseUrl = cfg.D365_BASE_URL.replace(/\/+$/, '');
    this.http = { timeoutMs: cfg.AZDO_HTTP_TIMEOUT_MS, maxRetries: cfg.AZDO_HTTP_MAX_RETRIES, retryBaseMs: cfg.AZDO_HTTP_RETRY_BASE_MS };
  }

  /** Client-credentials token for the F&O resource (`<base url>/.default`). Cached until a minute before expiry. */
  async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const authority = (this.cfg.D365_AUTHORITY_HOST || 'https://login.microsoftonline.com').replace(/\/+$/, '');
    const res = await this.fetchImpl(
      `${authority}/${encodeURIComponent(this.cfg.D365_TENANT_ID!)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.cfg.D365_CLIENT_ID!,
          client_secret: this.cfg.D365_CLIENT_SECRET!,
          scope: `${this.baseUrl}/.default`,
        }).toString(),
      },
      this.http,
    );
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) {
      const why = body.error_description?.split(/\r?\n/)[0] ?? body.error ?? `HTTP ${res.status}`;
      throw new Error(`Entra sign-in for the app registration failed: ${why}`);
    }
    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  async get(path: string): Promise<{ status: number; body: unknown }> {
    const token = await this.accessToken();
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } }, this.http);
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep text */
    }
    return { status: res.status, body };
  }

  /** Runs a validated read-only query and returns compact JSON for the model. */
  async query(q: ODataQuery): Promise<string> {
    const { status, body } = await this.get(buildODataPath(q));
    if (status >= 400) {
      const msg = (body as { error?: { message?: string } })?.error?.message ?? (typeof body === 'string' ? body.slice(0, 300) : `HTTP ${status}`);
      return JSON.stringify({ error: `OData query failed (HTTP ${status}): ${msg}` });
    }
    const rows = ((body as { value?: unknown[] })?.value ?? []).map((r) => {
      if (r && typeof r === 'object') delete (r as Record<string, unknown>)['@odata.etag'];
      return r;
    });
    let out = JSON.stringify({ count: rows.length, rows });
    if (out.length > MAX_RESULT_CHARS) out = JSON.stringify({ count: rows.length, truncated: true, rows: out.slice(0, MAX_RESULT_CHARS) });
    return out;
  }

  /** One small request used by `doctor`: proves the token is issued and F&O accepts the app. */
  async check(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.accessToken();
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
    try {
      const { status } = await this.get('/data/LegalEntities?$top=1&$select=LegalEntityId');
      if (status === 200) return { ok: true, detail: 'token issued and F&O accepted the app' };
      if (status === 401 || status === 403) {
        return { ok: false, detail: `F&O refused the app (HTTP ${status}). Register the client id under System administration > Setup > Microsoft Entra ID applications and map it to a user.` };
      }
      return { ok: false, detail: `F&O answered HTTP ${status}` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}
