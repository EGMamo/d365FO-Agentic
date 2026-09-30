export interface ResilientRequestOptions {
  timeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 30_000;

export async function fetchWithResilience(
  url: string,
  init: RequestInit,
  opts: ResilientRequestOptions,
): Promise<Response> {
  let attempt = 0;
  while (true) {
    attempt += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (response.ok) return response;
      if (attempt <= opts.maxRetries && RETRYABLE_STATUS.has(response.status)) {
        const delay = retryDelayMs(response, opts.retryBaseMs, attempt);
        if (delay !== undefined) {
          await safeDrain(response);
          await sleep(delay);
          continue;
        }
      }
      return response;
    } catch (error) {
      if (attempt <= opts.maxRetries && isRetryableError(error)) {
        await sleep(backoffDelay(opts.retryBaseMs, attempt));
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Parses a Retry-After header (seconds or an HTTP date) into milliseconds, or undefined when absent, garbage, or already past. */
export function parseRetryAfterMs(header: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/**
 * How long to wait before retrying: exponential backoff, stretched to the server's Retry-After when that is longer.
 * Returns undefined when the server asks for more than we will sit through (30s): retrying would only fail again.
 */
export function retryDelayMs(response: Pick<Response, 'headers'>, base: number, attempt: number, now: number = Date.now()): number | undefined {
  const backoff = backoffDelay(base, attempt);
  const asked = parseRetryAfterMs(response.headers.get('retry-after'), now);
  if (asked === undefined) return backoff;
  return asked > MAX_RETRY_AFTER_MS ? undefined : Math.max(backoff, asked);
}

function backoffDelay(base: number, attempt: number): number {
  const exponential = base * Math.pow(2, Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(base / 2)));
  return exponential + jitter;
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError' || /timed out|fetch failed|network/i.test(error.message);
}

async function safeDrain(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // no-op
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
