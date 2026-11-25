import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ExtractiveLlm,
  LocalHashEmbeddings,
  MemoryBudget,
  MemoryStore,
  ProviderError,
  QueueFullError,
  QueueTimeoutError,
  RequestQueue,
  ResilientLlm,
  SupportAssistant,
  isRetryable,
  retryDelay,
  type GenerateRequest,
  type LlmChunk,
  type LlmProvider,
} from "../src/index.js";
import { PgBudget, createPool, migrate } from "../src/store/pg.js";
import { sampleDocs } from "./helpers.js";

const req: GenerateRequest = { system: "s", messages: [{ role: "user", content: "q" }], maxTokens: 100 };
const tick = () => new Promise((r) => setTimeout(r, 0));

async function collect(it: AsyncIterable<LlmChunk>) {
  const out: LlmChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe("RequestQueue", () => {
  afterEach(() => vi.useRealTimers());

  it("never runs more than maxConcurrent calls and starts them in order", async () => {
    const q = new RequestQueue({ maxConcurrent: 2 });
    const order: number[] = [];
    const leases = await Promise.all([q.acquire(10), q.acquire(10)]);
    const rest = [3, 4, 5].map((n) => q.acquire(10).then((l) => (order.push(n), l)));
    await tick();
    expect(q.stats()).toMatchObject({ inFlight: 2, waiting: 3 });
    leases[0].release();
    await tick();
    expect(order).toEqual([3]);
    leases[1].release();
    (await rest[0]).release();
    await Promise.all(rest);
    expect(order).toEqual([3, 4, 5]);
    expect(q.stats().peakInFlight).toBe(2);
  });

  it("rejects new requests when the waiting line is full", async () => {
    const q = new RequestQueue({ maxConcurrent: 1, maxQueue: 1 });
    await q.acquire(1);
    void q.acquire(1).catch(() => undefined);
    await expect(q.acquire(1)).rejects.toBeInstanceOf(QueueFullError);
    expect(q.stats().rejected).toBe(1);
  });

  it("gives up after timeoutMs and lets the next one through", async () => {
    vi.useFakeTimers();
    const q = new RequestQueue({ maxConcurrent: 1, timeoutMs: 1000 });
    const first = await q.acquire(1);
    const late = q.acquire(1);
    const lateErr = late.catch((e) => e);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await lateErr).toBeInstanceOf(QueueTimeoutError);
    const next = q.acquire(1);
    first.release();
    await vi.advanceTimersByTimeAsync(1);
    await expect(next).resolves.toBeDefined();
  });

  it("drops a waiting request when its caller aborts", async () => {
    const q = new RequestQueue({ maxConcurrent: 1 });
    await q.acquire(1);
    const ac = new AbortController();
    const p = q.acquire(1, ac.signal).catch((e) => e);
    ac.abort(new Error("client went away"));
    expect(((await p) as Error).message).toBe("client went away");
    expect(q.stats().waiting).toBe(0);
  });

  it("waits for the token budget to refill, then refunds unused tokens", async () => {
    vi.useFakeTimers();
    const budget = new MemoryBudget({ tokensPerMinute: 1000 });
    const q = new RequestQueue({ maxConcurrent: 10, budget });
    const a = await q.acquire(600);
    let started = false;
    const b = q.acquire(600).then((l) => ((started = true), l));
    await vi.advanceTimersByTimeAsync(10_000); // 1000/min refills ~167 in 10s: not enough yet
    expect(started).toBe(false);
    a.release(100); // used far fewer than reserved: 500 come back
    await vi.advanceTimersByTimeAsync(20);
    expect(started).toBe(true);
    (await b).release();
  });

  it("holds every call while paused by a provider's Retry-After", async () => {
    vi.useFakeTimers();
    const q = new RequestQueue({ maxConcurrent: 5 });
    q.pause(3000);
    let started = false;
    void q.acquire(1).then(() => (started = true));
    await vi.advanceTimersByTimeAsync(2900);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(started).toBe(true);
  });
});

describe("retry policy", () => {
  it("retries rate limits, server errors and network failures only", () => {
    expect(isRetryable(new ProviderError("x", 429))).toBe(true);
    expect(isRetryable(new ProviderError("x", 503))).toBe(true);
    expect(isRetryable(new ProviderError("x", 0))).toBe(true);
    expect(isRetryable(new ProviderError("x", 400))).toBe(false);
    expect(isRetryable(new ProviderError("x", 401))).toBe(false);
    expect(isRetryable(new Error("bug"))).toBe(false);
  });

  it("backs off exponentially with jitter and honors Retry-After", () => {
    const p = { maxRetries: 5, baseDelayMs: 100, maxDelayMs: 1000 };
    expect(retryDelay(0, new Error(), p, () => 1)).toBe(100);
    expect(retryDelay(3, new Error(), p, () => 1)).toBe(800);
    expect(retryDelay(6, new Error(), p, () => 1)).toBe(1000);
    expect(retryDelay(2, new Error(), p, () => 0.5)).toBe(200);
    expect(retryDelay(0, new ProviderError("x", 429, 2500), p, () => 1)).toBe(2500);
  });
});

/** A fake model that fails its first `failures` calls with `status`, then streams "ok". */
function flaky(failures: number, status = 429, failAfterFirstToken = false): LlmProvider & { calls: number } {
  const p = {
    name: "flaky",
    calls: 0,
    async generate() {
      return "ok";
    },
    async *stream(): AsyncIterable<LlmChunk> {
      p.calls++;
      if (failAfterFirstToken) {
        yield { type: "text", text: "partial " };
        throw new ProviderError("dropped", 503);
      }
      if (p.calls <= failures) throw new ProviderError("limited", status, 50);
      yield { type: "text", text: "ok" };
      yield { type: "usage", inputTokens: 10, outputTokens: 1 };
    },
  };
  return p;
}

describe("ResilientLlm", () => {
  const noSleep = async () => undefined;
  const fast = { baseDelayMs: 1, maxDelayMs: 5 };

  it("retries a rate-limited call and reports it", async () => {
    const inner = flaky(2);
    const llm = new ResilientLlm(inner, { queue: new RequestQueue(), sleep: noSleep, retry: fast });
    const chunks = await collect(llm.stream(req));
    expect(inner.calls).toBe(3);
    expect(chunks.filter((c) => c.type === "status" && c.stage === "retrying")).toHaveLength(2);
    expect(chunks.find((c) => c.type === "text")).toEqual({ type: "text", text: "ok" });
    expect(chunks.filter((c) => c.type === "queue").at(-1)).toMatchObject({ attempt: 2 });
  });

  it("does not retry errors that won't go away", async () => {
    const inner = flaky(5, 400);
    const llm = new ResilientLlm(inner, { queue: new RequestQueue(), sleep: noSleep });
    await expect(collect(llm.stream(req))).rejects.toMatchObject({ status: 400 });
    expect(inner.calls).toBe(1);
  });

  it("gives up after maxRetries", async () => {
    const inner = flaky(10);
    const llm = new ResilientLlm(inner, { queue: new RequestQueue(), sleep: noSleep, retry: { ...fast, maxRetries: 2 } });
    await expect(collect(llm.stream(req))).rejects.toMatchObject({ status: 429 });
    expect(inner.calls).toBe(3);
  });

  it("does not retry once text has reached the caller", async () => {
    const inner = flaky(0, 503, true);
    const llm = new ResilientLlm(inner, { queue: new RequestQueue(), sleep: noSleep });
    await expect(collect(llm.stream(req))).rejects.toMatchObject({ status: 503 });
    expect(inner.calls).toBe(1);
  });

  it("frees the slot when the caller stops reading early", async () => {
    const queue = new RequestQueue({ maxConcurrent: 1 });
    const llm = new ResilientLlm(new ExtractiveLlm(), { queue });
    const it = llm.stream({ ...req, sources: [], question: "q" })[Symbol.asyncIterator]();
    await it.next();
    await it.return?.();
    expect(queue.stats().inFlight).toBe(0);
  });
});

/**
 * A provider with the same failure mode as a real one under load: more than
 * `limit` calls at once get HTTP 429.
 */
function limitedProvider(limit: number) {
  const state = { inFlight: 0, peak: 0, rejected: 0, served: 0 };
  const llm: LlmProvider = {
    name: "limited",
    generate: async () => "",
    async *stream(r) {
      if (state.inFlight >= limit) {
        state.rejected++;
        throw new ProviderError("Rate limit reached", 429, 20);
      }
      state.inFlight++;
      state.peak = Math.max(state.peak, state.inFlight);
      try {
        await new Promise((res) => setTimeout(res, 15));
        yield* new ExtractiveLlm().stream(r);
        state.served++;
      } finally {
        state.inFlight--;
      }
    },
  };
  return { llm, state };
}

describe("many users at once", () => {
  const USERS = 40;
  const questions = ["How long do refunds take?", "Do guests use a paid seat?", "What is the API rate limit?", "How do I export my data?"];

  async function run(llm: LlmProvider) {
    const store = new MemoryStore();
    const assistant = new SupportAssistant({ store, embeddings: new LocalHashEmbeddings(), llm, minScore: 0.12 });
    for (const d of sampleDocs()) await assistant.ingest(d);
    return Promise.allSettled(Array.from({ length: USERS }, (_, i) => assistant.ask(questions[i % questions.length])));
  }

  it("without the queue, a provider limit of 3 calls fails most of 40 users", async () => {
    const { llm, state } = limitedProvider(3);
    const results = await run(llm);
    const failed = results.filter((r) => r.status === "rejected").length;
    expect(failed).toBeGreaterThan(USERS / 2);
    expect(state.rejected).toBe(failed);
  });

  it("with the queue sized to the limit, all 40 succeed and the provider never says no", async () => {
    const { llm, state } = limitedProvider(3);
    const queue = new RequestQueue({ maxConcurrent: 3 });
    const results = await run(new ResilientLlm(llm, { queue }));
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(state).toMatchObject({ rejected: 0, served: USERS });
    expect(state.peak).toBeLessThanOrEqual(3);
    const waited = results.filter((r) => r.status === "fulfilled" && (r.value.queuedMs ?? 0) > 0).length;
    expect(waited).toBeGreaterThan(USERS / 2);
  });

  it("with a queue that's too generous, retries still get all 40 through", async () => {
    const { llm, state } = limitedProvider(3);
    const queue = new RequestQueue({ maxConcurrent: 8 });
    const results = await run(new ResilientLlm(llm, { queue, retry: { maxRetries: 8, baseDelayMs: 10, maxDelayMs: 100 } }));
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(state.served).toBe(USERS);
    expect(state.rejected).toBeGreaterThan(0);
    const retried = results.reduce((a, r) => a + (r.status === "fulfilled" ? (r.value.retries ?? 0) : 0), 0);
    expect(retried).toBe(state.rejected);
  });
});

const dbUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!dbUrl)("PgBudget (real Postgres)", () => {
  const pool = createPool(dbUrl ?? "");
  beforeAll(async () => {
    await migrate(pool, 512);
    await pool.query("DELETE FROM rate_buckets WHERE name LIKE 'test-%'");
  });
  afterAll(() => pool.end());

  it("shares one request budget between processes", async () => {
    // Two budgets = two Lambda containers pointing at the same database.
    const a = new PgBudget(pool, { requestsPerMinute: 5 }, "test-shared");
    const b = new PgBudget(pool, { requestsPerMinute: 5 }, "test-shared");
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).tryTake(1)));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    const denied = results.find((r) => !r.ok) as { ok: false; waitMs: number };
    expect(denied.waitMs).toBeGreaterThan(0);
    expect(denied.waitMs).toBeLessThanOrEqual(12_000);
  });

  it("charges tokens and refunds what wasn't used", async () => {
    const budget = new PgBudget(pool, { tokensPerMinute: 1000 }, "test-tokens");
    expect((await budget.tryTake(900)).ok).toBe(true);
    expect((await budget.tryTake(500)).ok).toBe(false);
    await budget.adjust(700);
    expect((await budget.tryTake(500)).ok).toBe(true);
  });
});
