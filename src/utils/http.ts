export interface ResilientRequestOptions {
  timeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

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
        await safeDrain(response);
        await sleep(backoffDelay(opts.retryBaseMs, attempt));
        continue;
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
