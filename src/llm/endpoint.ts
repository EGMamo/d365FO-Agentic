import { normalizeOpenAiBaseUrl } from './openai.js';

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
  format: 'anthropic' | 'openai' = 'anthropic',
): Promise<AnthropicEndpointCheck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const openai = format === 'openai';
  const url = openai ? `${normalizeOpenAiBaseUrl(baseUrl)}/models` : `${normalizeAnthropicBaseUrl(baseUrl)}/v1/models`;
  const bearer = openai ? auth.authToken || auth.apiKey : auth.authToken;
  try {
    const res = await fetchImpl(url, {
      headers: {
        ...(openai ? {} : { 'anthropic-version': '2023-06-01' }),
        ...(auth.apiKey && !openai ? { 'x-api-key': auth.apiKey } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) return { reachable: true, authorized: false, models: [], detail: `the server refused the key or token (HTTP ${res.status})` };
    if (!res.ok) return { reachable: true, authorized: true, models: [], detail: `no model list (HTTP ${res.status} from ${new URL(url).pathname})` };
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
