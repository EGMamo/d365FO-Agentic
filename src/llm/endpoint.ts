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
