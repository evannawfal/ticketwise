import { ProviderError } from "../errors.js";
import { RequestQueue, estimateTokens } from "../queue.js";
import { DEFAULT_RETRY, isRetryable, retryDelay, sleep, withRetry, type RetryPolicy } from "../retry.js";
import type { EmbeddingProvider, GenerateRequest, LlmChunk, LlmProvider } from "../types.js";

export interface ResilientOptions {
  queue: RequestQueue;
  retry?: Partial<RetryPolicy>;
  /** Swappable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

/** Tokens to reserve for a call: the prompt plus the most the model may write. */
export function requestTokens(req: GenerateRequest): number {
  return estimateTokens(req.system + req.messages.map((m) => m.content).join("")) + (req.maxTokens ?? 700);
}

/**
 * Wraps a model provider so every call waits its turn in the request queue
 * and is retried on rate limits and transient errors.
 *
 * A stream is only retried if it failed before the first token reached the
 * caller. After that a retry would repeat or contradict text the user already
 * saw, so the error is passed on instead.
 */
export class ResilientLlm implements LlmProvider {
  readonly name: string;
  private policy: RetryPolicy;
  private sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    private inner: LlmProvider,
    private opts: ResilientOptions,
  ) {
    this.name = inner.name;
    this.policy = { ...DEFAULT_RETRY, ...opts.retry };
    this.sleep = opts.sleep ?? sleep;
  }

  async generate(req: GenerateRequest): Promise<string> {
    let text = "";
    for await (const c of this.stream(req)) if (c.type === "text") text += c.text;
    return text.trim();
  }

  async *stream(req: GenerateRequest, signal?: AbortSignal): AsyncIterable<LlmChunk> {
    const queue = this.opts.queue;
    const estimate = requestTokens(req);
    for (let attempt = 0; ; attempt++) {
      if (queue.busy) {
        const s = queue.stats();
        yield {
          type: "status",
          stage: "queued",
          message: s.waiting ? `Waiting for a free slot (${s.waiting} ahead).` : "Waiting for a free slot.",
        };
      }
      const lease = await queue.acquire(estimate, signal);
      let emitted = false;
      let used: number | undefined;
      let failure: unknown;
      try {
        // Inside the try, so a caller that stops reading here still frees the slot.
        yield { type: "queue", waitedMs: lease.waitedMs, attempt };
        const source = this.inner.stream ? this.inner.stream(req, signal) : once(this.inner, req);
        for await (const chunk of source) {
          if (chunk.type === "usage") used = chunk.inputTokens + chunk.outputTokens;
          if (chunk.type === "text") emitted = true;
          yield chunk;
        }
      } catch (err) {
        failure = err;
      } finally {
        // On failure, keep the whole reservation spent: the provider may have counted it.
        lease.release(failure ? estimate : used);
      }
      if (failure === undefined) return;

      if (emitted || attempt >= this.policy.maxRetries || !isRetryable(failure) || signal?.aborted) throw failure;
      const delay = retryDelay(attempt, failure, this.policy, this.opts.random);
      if (failure instanceof ProviderError && failure.status === 429) queue.pause(delay);
      yield {
        type: "status",
        stage: "retrying",
        message: `${describe(failure)} Retrying in ${(delay / 1000).toFixed(1)}s (attempt ${attempt + 2} of ${this.policy.maxRetries + 1}).`,
      };
      await this.sleep(delay, signal);
    }
  }
}

async function* once(llm: LlmProvider, req: GenerateRequest): AsyncIterable<LlmChunk> {
  yield { type: "text", text: await llm.generate(req) };
}

function describe(err: unknown): string {
  if (err instanceof ProviderError) {
    if (err.status === 429) return "The model provider is rate limiting us.";
    if (err.status === 0) return "Couldn't reach the model provider.";
    return `The model provider returned an error (${err.status}).`;
  }
  return "The model call failed.";
}

/** Retries embedding calls on rate limits and transient errors. */
export class ResilientEmbeddings implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  private policy: RetryPolicy;
  constructor(
    private inner: EmbeddingProvider,
    retry: Partial<RetryPolicy> = {},
  ) {
    this.name = inner.name;
    this.dimensions = inner.dimensions;
    this.policy = { ...DEFAULT_RETRY, ...retry };
  }
  embed(texts: string[], kind: "document" | "query"): Promise<number[][]> {
    return withRetry(() => this.inner.embed(texts, kind), this.policy);
  }
}
