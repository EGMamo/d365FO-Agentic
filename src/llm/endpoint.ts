export interface EndpointCheck {
  reachable: boolean;
  models: string[];
  error?: string;
}

/** Asks an OpenAI-compatible server which models it serves (GET <base>/models). Used by `doctor`. */
export async function checkModelEndpoint(
  baseUrl: string,
  apiKey?: string,
  timeoutMs = 4000,
  fetchImpl: typeof fetch = fetch,
): Promise<EndpointCheck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    if (!res.ok) return { reachable: true, models: [], error: `HTTP ${res.status} from /models` };
    const body = (await res.json().catch(() => ({}))) as { data?: Array<{ id?: unknown }> };
    return { reachable: true, models: (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string') };
  } catch (e) {
    const reason = (e as Error).name === 'AbortError' ? `no answer within ${timeoutMs / 1000}s` : ((e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message);
    return { reachable: false, models: [], error: reason };
  } finally {
    clearTimeout(timer);
  }
}

export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';

/**
 * The base URL to hand to the Anthropic SDK, which appends `/v1/messages` itself. People paste the address in
 * several forms (`https://gw.example/anthropic/`, `.../v1`, `.../v1/messages`); all mean the same base.
 * Undefined when nothing is set, so the SDK default applies.
 */
export function normalizeAnthropicBaseUrl(url: string | undefined): string | undefined {
  const trimmed = url?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\/+$/, '').replace(/\/v1(\/messages)?$/i, '').replace(/\/+$/, '');
}

export interface AnthropicEndpointCheck {
  reachable: boolean;
  /** False when the server answered 401/403: the key or token was refused. */
  authorized: boolean;
  models: string[];
  detail: string;
}

/**
 * Asks a Claude-compatible endpoint for its model list (GET <base>/v1/models). Used by `doctor` for a custom
 * `ANTHROPIC_BASE_URL`. A gateway that does not implement the list still counts as reachable.
 */
export async function checkAnthropicEndpoint(
  baseUrl: string,
  auth: { apiKey?: string; authToken?: string },
  timeoutMs = 6000,
  fetchImpl: typeof fetch = fetch,
): Promise<AnthropicEndpointCheck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${normalizeAnthropicBaseUrl(baseUrl)}/v1/models`, {
      headers: {
        'anthropic-version': '2023-06-01',
        ...(auth.apiKey ? { 'x-api-key': auth.apiKey } : {}),
        ...(auth.authToken ? { authorization: `Bearer ${auth.authToken}` } : {}),
      },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) return { reachable: true, authorized: false, models: [], detail: `the server refused the key or token (HTTP ${res.status})` };
    if (!res.ok) return { reachable: true, authorized: true, models: [], detail: `no model list (HTTP ${res.status} from /v1/models)` };
    const body = (await res.json().catch(() => ({}))) as { data?: Array<{ id?: unknown }> };
    const models = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
    return { reachable: true, authorized: true, models, detail: `${models.length} model(s) listed` };
  } catch (e) {
    const reason = (e as Error).name === 'AbortError' ? `no answer within ${timeoutMs / 1000}s` : ((e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message);
    return { reachable: false, authorized: false, models: [], detail: reason };
  } finally {
    clearTimeout(timer);
  }
}
