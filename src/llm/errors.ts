/** An HTTP failure from an LLM endpoint, keeping the status so callers can tell "down" from "bad request". */
export class LlmHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** How long the server asked us to wait (Retry-After), when it said. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'LlmHttpError';
  }
}

/**
 * The model could not be reached or refused us (rate limit, auth, outage). That says nothing about the test,
 * so it must abort the run instead of being recorded as a `blocked` verdict for every remaining case.
 */
export class LlmUnavailableError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

const NETWORK_ERROR = /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|Connection error/i;

/** Classifies an error thrown by a provider adapter (after its own retries) as "provider unavailable", or not. */
export function toUnavailable(e: unknown): LlmUnavailableError | undefined {
  if (e instanceof LlmUnavailableError) return e;
  const status = (e as { status?: unknown } | null)?.status;
  const message = e instanceof Error ? e.message : String(e);
  if (typeof status === 'number' && (status === 401 || status === 403 || status === 429 || status >= 500)) {
    const retryAfterMs = (e as { retryAfterMs?: unknown }).retryAfterMs;
    const wait = typeof retryAfterMs === 'number' ? ` (the provider asks for ~${formatWait(retryAfterMs)})` : '';
    const hint = status === 429 ? ` Wait for the rate limit to reset${wait}, or switch LLM_PROVIDER.` : '';
    return new LlmUnavailableError(`LLM provider unavailable (HTTP ${status}): ${message}${hint}`, status);
  }
  if (e instanceof Error && (e.name === 'AbortError' || NETWORK_ERROR.test(message))) {
    return new LlmUnavailableError(`LLM provider unreachable: ${message}`);
  }
  return undefined;
}

function formatWait(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s} s`;
  const min = Math.round(s / 60);
  return min < 120 ? `${min} min` : `${Math.round(min / 60)} h`;
}
