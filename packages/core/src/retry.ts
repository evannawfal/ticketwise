import { ProviderError } from "./errors.js";

export interface RetryPolicy {
  /** Extra attempts after the first. */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxRetries: 4, baseDelayMs: 500, maxDelayMs: 20_000 };

/** 408, 409, 429 and 5xx, plus network failures, are worth another try. 400, 401, 403, 404 are not. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof ProviderError) {
    return err.status === 0 || err.status === 408 || err.status === 409 || err.status === 429 || err.status >= 500;
  }
  const code = (err as { code?: string })?.code;
  return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EAI_AGAIN" || code === "UND_ERR_SOCKET";
}

/**
 * Exponential backoff with full jitter, so retries from many users spread out
 * instead of arriving together. If the provider said how long to wait, wait
 * at least that long.
 */
export function retryDelay(attempt: number, err: unknown, policy: RetryPolicy = DEFAULT_RETRY, random = Math.random): number {
  const cap = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  const jittered = Math.round(random() * cap);
  const asked = err instanceof ProviderError ? err.retryAfterMs : undefined;
  return asked !== undefined ? Math.max(asked, jittered) : jittered;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Run `fn` with retries on transient errors. For calls that don't stream. */
export async function withRetry<T>(fn: () => Promise<T>, policy: RetryPolicy = DEFAULT_RETRY, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= policy.maxRetries || !isRetryable(err) || signal?.aborted) throw err;
      await sleep(retryDelay(attempt, err, policy), signal);
    }
  }
}
