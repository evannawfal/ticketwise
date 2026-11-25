import { describe, expect, it } from "vitest";
import {
  ABSTAIN_TEXT,
  ExtractiveLlm,
  LocalHashEmbeddings,
  MemoryStore,
  OpenAiLlm,
  ProviderError,
  SupportAssistant,
  bestQuote,
  groundAnswer,
  isVerbatim,
  parseRetryAfter,
  readSse,
  sentenceSpans,
  splitClaims,
  supportScore,
  type LlmProvider,
  type SearchHit,
  type StreamEvent,
} from "../src/index.js";
import { sampleDocs } from "./helpers.js";

const REFUNDS = `## How to request a refund

The Owner or a Billing Admin must request the refund from the email address on the account. Refunds go back to the original payment method and take 5 to 10 business days to appear.

- Support agents can approve refunds up to $500.
- Anything above $500 needs a support lead.`;

const hit = (content: string, extra: Partial<SearchHit> = {}): SearchHit => ({
  documentId: "d1",
  title: "Refund policy",
  url: null,
  sourceType: "doc",
  section: null,
  content,
  score: 0.8,
  ...extra,
});

describe("claims and support", () => {
  it("splits sentences and keeps markers placed after the full stop", () => {
    const claims = splitClaims("Refunds take 5 to 10 business days. [1] Agents can approve up to $500 [2].\n- Leads approve the rest [2]");
    expect(claims.map((c) => c.cites)).toEqual([[1], [2], [2]]);
    expect(claims[0].text).toBe("Refunds take 5 to 10 business days.");
  });

  it("skips greetings and sign-offs", () => {
    expect(splitClaims("Hi there,\n\nBest,\nSupport Team")).toEqual([]);
  });

  it("scores numbers as words, so a wrong number is not supported", () => {
    const src = "Refunds take 5 to 10 business days to appear.";
    expect(supportScore("Refunds take 5 to 10 business days", src)).toBe(1);
    expect(supportScore("Refunds take 30 business days", src)).toBeLessThan(1);
  });
});

describe("exact quotes", () => {
  it("only ever returns slices of the source", () => {
    for (const sp of sentenceSpans(REFUNDS)) {
      const text = REFUNDS.slice(sp.start, sp.end);
      expect(text).toBe(text.trim());
      expect(text.startsWith("- ")).toBe(false);
      expect(text.startsWith("#")).toBe(false);
    }
  });

  it("picks the passage that backs the claim", () => {
    const q = bestQuote("Refunds take 5 to 10 business days to show up", REFUNDS)!;
    expect(q.text).toBe("Refunds go back to the original payment method and take 5 to 10 business days to appear.");
    expect(REFUNDS.slice(q.start, q.end)).toBe(q.text);
    expect(q.support).toBeGreaterThan(0.6);
  });

  it("quotes only the agent's resolution from past tickets", () => {
    const ticket = "Customer: I was charged twice for March.\n\nResolution: The second charge was the prorated amount for new members.\n\nTags: billing";
    const q = bestQuote("The second charge was for new members, not a duplicate charge", ticket, "ticket")!;
    expect(q.text).toBe("The second charge was the prorated amount for new members.");
    expect(sentenceSpans(ticket, "ticket").every((s) => s.start > ticket.indexOf("Resolution:"))).toBe(true);
  });

  it("flags a claim its citation doesn't support", () => {
    const { citations, grounding } = groundAnswer(
      "Refunds take 5 to 10 business days to appear [1]. Enterprise customers get a dedicated account manager [1].",
      [hit(REFUNDS)],
    );
    expect(grounding.total).toBe(2);
    expect(grounding.grounded).toBe(1);
    expect(grounding.claims[1].grounded).toBe(false);
    for (const q of citations[0].quotes) expect(isVerbatim(q.text, REFUNDS)).toBe(true);
  });

  it("treats a claim without a citation as ungrounded", () => {
    const { grounding } = groundAnswer("Refunds take 5 to 10 business days to appear.", [hit(REFUNDS)]);
    expect(grounding.claims[0]).toMatchObject({ cites: [], grounded: false });
  });
});

async function seeded(llm: LlmProvider = new ExtractiveLlm()) {
  const store = new MemoryStore();
  const assistant = new SupportAssistant({ store, embeddings: new LocalHashEmbeddings(), llm, minScore: 0.12 });
  for (const d of sampleDocs()) await assistant.ingest(d);
  return assistant;
}

async function drain(gen: AsyncGenerator<StreamEvent>) {
  const events: StreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe("streaming", () => {
  it("sends sources, then text, then a result whose text matches the deltas", async () => {
    const assistant = await seeded();
    const events = await drain(assistant.stream("answer", "How long does a refund take to show up?"));
    expect(events[0].type).toBe("sources");
    expect(events.at(-1)!.type).toBe("done");
    const deltas = events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text);
    expect(deltas.length).toBeGreaterThan(3);
    const done = events.at(-1) as Extract<StreamEvent, { type: "done" }>;
    expect(deltas.join("").trim()).toBe(done.result.text);
    expect(done.result.mode).toBe("generated");
    expect(done.result.grounding!.grounded).toBe(done.result.grounding!.total);
    expect(done.result.citations.every((c) => c.quotes.every((q) => q.support > 0))).toBe(true);
  });

  it("streams a fixed reply and skips the model when nothing matches", async () => {
    let called = false;
    const assistant = await seeded({ name: "spy", generate: async () => ((called = true), "x") });
    const events = await drain(assistant.stream("answer", "zebra quantum lasagna"));
    expect(events.map((e) => e.type)).toEqual(["delta", "done"]);
    expect(called).toBe(false);
  });

  it("marks the model's own refusal as abstained", async () => {
    const assistant = await seeded({ name: "refuser", generate: async () => ABSTAIN_TEXT });
    const res = await assistant.ask("How long does a refund take?");
    expect(res.mode).toBe("abstained");
    expect(res.citations).toEqual([]);
  });

  it("uses generate() for providers that can't stream", async () => {
    const assistant = await seeded({ name: "plain", generate: async () => "Refunds take 5 to 10 business days to appear [1]." });
    const res = await assistant.ask("How long does a refund take to show up?");
    expect(res.text).toMatch(/5 to 10/);
    expect(res.citations[0].quotes.length).toBe(1);
  });
});

function sseResponse(lines: string[], status = 200, headers: Record<string, string> = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      // Split across chunk boundaries on purpose.
      const text = lines.map((l) => `data: ${l}\n\n`).join("");
      const enc = new TextEncoder();
      for (let i = 0; i < text.length; i += 7) c.enqueue(enc.encode(text.slice(i, i + 7)));
      c.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream", ...headers } });
}

describe("OpenAI streaming", () => {
  const req = { system: "s", messages: [{ role: "user" as const, content: "q" }] };

  it("yields text deltas and token usage", async () => {
    const llm = new OpenAiLlm({
      apiKey: "k",
      fetchImpl: async () =>
        sseResponse([
          JSON.stringify({ choices: [{ delta: { content: "Hello " } }] }),
          JSON.stringify({ choices: [{ delta: { content: "world [1]." } }] }),
          JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 6 } }),
          "[DONE]",
        ]),
    });
    const out = [];
    for await (const c of llm.stream(req)) out.push(c);
    expect(out).toEqual([
      { type: "text", text: "Hello " },
      { type: "text", text: "world [1]." },
      { type: "usage", inputTokens: 120, outputTokens: 6 },
    ]);
  });

  it("turns a 429 into a ProviderError carrying Retry-After", async () => {
    const llm = new OpenAiLlm({
      apiKey: "k",
      fetchImpl: async () => new Response("slow down", { status: 429, headers: { "retry-after": "2" } }),
    });
    const err = await (async () => {
      for await (const _ of llm.stream(req)) void _;
    })().catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ status: 429, retryAfterMs: 2000 });
  });

  it("parses Retry-After as seconds, milliseconds or a date", () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(parseRetryAfter(h({ "retry-after": "3" }))).toBe(3000);
    expect(parseRetryAfter(h({ "retry-after-ms": "250" }))).toBe(250);
    expect(parseRetryAfter(h({ "retry-after": new Date(10_000).toUTCString() }), 4_000)).toBe(6000);
    expect(parseRetryAfter(h({}))).toBeUndefined();
  });

  it("reads SSE events split across chunks", async () => {
    const out = [];
    for await (const d of readSse(sseResponse(["a", "b c"]).body!)) out.push(d);
    expect(out).toEqual(["a", "b c"]);
  });
});
