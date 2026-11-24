/** An error from a model provider, with what's needed to decide whether to retry. */
export class ProviderError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 for network errors. */
    readonly status: number,
    /** How long the provider asked us to wait, from Retry-After or similar. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Parse a Retry-After header (seconds or an HTTP date) or OpenAI's retry-after-ms. */
export function parseRetryAfter(headers: { get(name: string): string | null }, now = Date.now()): number | undefined {
  const ms = Number(headers.get("retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}
