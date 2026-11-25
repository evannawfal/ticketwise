/**
 * A FIFO request queue for model calls. It caps how many calls run at once and
 * spends from a token budget (requests per minute and tokens per minute), so a
 * burst of users waits its turn instead of tripping the provider's rate limit.
 */

export type TakeResult = { ok: true } | { ok: false; waitMs: number };

/** Where rate limits are kept: in memory for one process, or in Postgres to share across Lambdas. */
export interface TokenBudget {
  /** Take one request and `tokens` tokens if both are available now, or say how long to wait. */
  tryTake(tokens: number): Promise<TakeResult>;
  /** Return unused tokens (positive) or charge extra ones (negative) once real usage is known. */
  adjust(tokens: number): Promise<void>;
}

export interface BudgetLimits {
  requestsPerMinute?: number;
  tokensPerMinute?: number;
}

/** A refilling bucket: `capacity` per minute, starts full. */
export class Bucket {
  private level: number;
  private at: number;
  constructor(
    readonly capacity: number,
    private now: () => number = Date.now,
  ) {
    this.level = capacity;
    this.at = now();
  }
  private refill() {
    const t = this.now();
    this.level = Math.min(this.capacity, this.level + ((t - this.at) * this.capacity) / 60_000);
    this.at = t;
  }
  /** Milliseconds until `cost` is available (0 = now). */
  waitFor(cost: number): number {
    this.refill();
    const need = Math.min(cost, this.capacity) - this.level;
    return need <= 0 ? 0 : Math.ceil((need * 60_000) / this.capacity);
  }
  take(cost: number) {
    this.refill();
    this.level -= Math.min(cost, this.capacity);
  }
  add(n: number) {
    this.refill();
    this.level = Math.min(this.capacity, this.level + n);
  }
  get available(): number {
    this.refill();
    return this.level;
  }
}

export class MemoryBudget implements TokenBudget {
  private requests?: Bucket;
  private tokens?: Bucket;
  constructor(limits: BudgetLimits = {}, now: () => number = Date.now) {
    if (limits.requestsPerMinute) this.requests = new Bucket(limits.requestsPerMinute, now);
    if (limits.tokensPerMinute) this.tokens = new Bucket(limits.tokensPerMinute, now);
  }
  async tryTake(tokens: number): Promise<TakeResult> {
    const wait = Math.max(this.requests?.waitFor(1) ?? 0, this.tokens?.waitFor(tokens) ?? 0);
    if (wait > 0) return { ok: false, waitMs: wait };
    this.requests?.take(1);
    this.tokens?.take(tokens);
    return { ok: true };
  }
  async adjust(tokens: number): Promise<void> {
    if (tokens >= 0) this.tokens?.add(tokens);
    else this.tokens?.take(-tokens);
  }
}

export class QueueFullError extends Error {
  readonly status = 429;
  constructor(readonly retryAfterMs: number) {
    super("Too many questions are waiting right now. Try again in a few seconds.");
    this.name = "QueueFullError";
  }
}

export class QueueTimeoutError extends Error {
  readonly status = 503;
  constructor(waitedMs: number) {
    super(`Waited ${Math.round(waitedMs / 1000)}s for model capacity without getting a turn. Try again shortly.`);
    this.name = "QueueTimeoutError";
  }
}

export interface QueueOptions {
  /** Model calls running at the same time. */
  maxConcurrent?: number;
  /** Requests allowed to wait; past this, new ones are rejected with QueueFullError. */
  maxQueue?: number;
  /** Longest a request waits for its turn before QueueTimeoutError. */
  timeoutMs?: number;
  budget?: TokenBudget;
}

export interface Lease {
  readonly waitedMs: number;
  readonly reserved: number;
  /** Free the slot. Pass the real token count to refund (or charge) the difference from the estimate. */
  release(actualTokens?: number): void;
}

export interface QueueStats {
  inFlight: number;
  waiting: number;
  peakInFlight: number;
  started: number;
  rejected: number;
  timedOut: number;
}

interface Waiter {
  tokens: number;
  enqueuedAt: number;
  settled: boolean;
  resolve(l: Lease): void;
  reject(e: unknown): void;
  cleanup(): void;
}

export class RequestQueue {
  readonly maxConcurrent: number;
  readonly maxQueue: number;
  readonly timeoutMs: number;
  private budget: TokenBudget;
  private waiters: Waiter[] = [];
  private inFlight = 0;
  private pausedUntil = 0;
  private pumping = false;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerAt = Infinity;
  private counters = { peakInFlight: 0, started: 0, rejected: 0, timedOut: 0 };

  constructor(opts: QueueOptions = {}) {
    this.maxConcurrent = Math.max(1, opts.maxConcurrent ?? 4);
    this.maxQueue = Math.max(0, opts.maxQueue ?? 100);
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.budget = opts.budget ?? new MemoryBudget();
  }

  stats(): QueueStats {
    return { inFlight: this.inFlight, waiting: this.waiters.length, ...this.counters };
  }

  /** True when a new request would have to wait. */
  get busy(): boolean {
    return this.waiters.length > 0 || this.inFlight >= this.maxConcurrent || this.pausedUntil > Date.now();
  }

  /** Stop starting new calls for a while, e.g. after the provider returns 429 with Retry-After. */
  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
  }

  acquire(tokens: number, signal?: AbortSignal): Promise<Lease> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
    if (this.waiters.length >= this.maxQueue) {
      this.counters.rejected++;
      return Promise.reject(new QueueFullError(5000));
    }
    return new Promise<Lease>((resolve, reject) => {
      const w: Waiter = {
        tokens: Math.max(1, Math.ceil(tokens)),
        enqueuedAt: Date.now(),
        settled: false,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", onAbort);
        },
      };
      const drop = (err: unknown) => {
        if (w.settled) return;
        w.settled = true;
        w.cleanup();
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(err);
        void this.pump();
      };
      const timeout = setTimeout(() => {
        this.counters.timedOut++;
        drop(new QueueTimeoutError(Date.now() - w.enqueuedAt));
      }, this.timeoutMs);
      const onAbort = () => drop(signal!.reason ?? new Error("aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(w);
      void this.pump();
    });
  }

  private lease(w: Waiter): Lease {
    let released = false;
    const waitedMs = Date.now() - w.enqueuedAt;
    return {
      waitedMs,
      reserved: w.tokens,
      release: (actual?: number) => {
        if (released) return;
        released = true;
        this.inFlight--;
        if (actual !== undefined && Number.isFinite(actual) && actual !== w.tokens) {
          void this.budget.adjust(w.tokens - actual).catch(() => undefined);
        }
        void this.pump();
      },
    };
  }

  private schedule(ms: number) {
    // Poll at least every 2s so a shared (Postgres) budget refilled by other processes is noticed.
    const delay = Math.min(Math.max(ms, 5), 2000);
    const at = Date.now() + delay;
    if (this.timer && this.timerAt <= at) return;
    clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.timerAt = Infinity;
      void this.pump();
    }, delay);
  }

  /** Start waiting requests in order while there is a free slot and budget for the one at the front. */
  private async pump(): Promise<void> {
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.again = false;
        while (this.waiters.length && this.inFlight < this.maxConcurrent) {
          const pausedFor = this.pausedUntil - Date.now();
          if (pausedFor > 0) {
            this.schedule(pausedFor);
            break;
          }
          const w = this.waiters[0];
          let res: TakeResult;
          try {
            res = await this.budget.tryTake(w.tokens);
          } catch {
            // Budget store unreachable (e.g. database blip): try again shortly rather than fail requests.
            this.schedule(500);
            break;
          }
          if (w.settled) {
            // Timed out or aborted while we were asking the budget.
            if (res.ok) await this.budget.adjust(w.tokens).catch(() => undefined);
            continue;
          }
          if (!res.ok) {
            this.schedule(res.waitMs);
            break;
          }
          this.waiters.shift();
          w.settled = true;
          w.cleanup();
          this.inFlight++;
          this.counters.started++;
          this.counters.peakInFlight = Math.max(this.counters.peakInFlight, this.inFlight);
          w.resolve(this.lease(w));
        }
      } while (this.again);
    } finally {
      this.pumping = false;
    }
  }
}

/** Rough token count (about 4 characters per token for English). Good enough to budget with. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
