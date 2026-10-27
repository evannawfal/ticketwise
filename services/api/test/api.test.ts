import { createHmac } from "node:crypto";
import { ExtractiveLlm, LocalHashEmbeddings, MemoryStore, SupportAssistant } from "@ticketwise/core";
import { PgVectorStore, createPool, migrate } from "@ticketwise/core/pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEmbeddingDim, parseMinScore } from "../src/config.js";
import { createRouter, type HttpRequest } from "../src/http.js";
import { parseSlackRequest, runSlackJob, verifySlackSignature } from "../src/slack.js";
import { sampleDocs } from "../../../packages/core/test/helpers.js";

const TOKEN = "test-admin-token-123";

function makeRouter() {
  const store = new MemoryStore();
  const assistant = new SupportAssistant({ store, embeddings: new LocalHashEmbeddings(), llm: new ExtractiveLlm(), minScore: 0.12 });
  return { store, assistant, handle: createRouter({ assistant, store, adminToken: TOKEN, allowedOrigin: "*" }) };
}

const req = (method: string, path: string, body?: unknown, token: string | null = TOKEN): HttpRequest => ({
  method,
  path,
  headers: token ? { Authorization: `Bearer ${token}` } : {},
  body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
});

describe("HTTP API", () => {
  it("serves health without auth and CORS preflight", async () => {
    const { handle } = makeRouter();
    expect((await handle(req("GET", "/health", undefined, null))).statusCode).toBe(200);
    const pre = await handle(req("OPTIONS", "/ask", undefined, null));
    expect(pre.statusCode).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe("*");
  });

  it("rejects missing or wrong tokens", async () => {
    const { handle } = makeRouter();
    expect((await handle(req("GET", "/documents", undefined, null))).statusCode).toBe(401);
    expect((await handle(req("GET", "/documents", undefined, "wrong-token-123456"))).statusCode).toBe(401);
  });

  it("validates bodies", async () => {
    const { handle } = makeRouter();
    expect((await handle(req("POST", "/documents", "not json"))).statusCode).toBe(400);
    expect((await handle(req("POST", "/documents", { title: "x" }))).statusCode).toBe(400);
    expect((await handle(req("POST", "/documents", { title: "x", content: "y", url: "javascript:alert(1)" }))).statusCode).toBe(400);
    expect((await handle(req("POST", "/ask", { question: "   " }))).statusCode).toBe(400);
    expect((await handle(req("POST", "/ask", { question: 42 }))).statusCode).toBe(400);
    expect((await handle(req("GET", "/nope"))).statusCode).toBe(404);
  });

  it("ingests docs and tickets, answers, drafts, lists and deletes", async () => {
    const { handle } = makeRouter();
    const created = await handle(
      req("POST", "/documents", {
        title: "Refund policy",
        url: "https://help.example/refunds",
        content: "# Refunds\n\nRefunds take 5 to 10 business days to appear on your card.",
      }),
    );
    expect(created.statusCode).toBe(201);
    const id = JSON.parse(created.body).document.id;

    const csv = "id,subject,customer_message,agent_reply,status\n7,Seat,Do guests use a seat?,Guests are free and don't use a seat.,solved\n8,x,y,,open";
    const tickets = JSON.parse((await handle(req("POST", "/documents/tickets", { csv }))).body);
    expect(tickets).toEqual({ imported: 1, skipped: 1 });

    const ask = JSON.parse((await handle(req("POST", "/ask", { question: "how long do refunds take to appear on my card?" }))).body);
    expect(ask.text).toMatch(/5 to 10 business days/);
    expect(ask.citations[0].url).toBe("https://help.example/refunds");

    const draft = JSON.parse((await handle(req("POST", "/draft", { ticket: "Are guests charged for a seat?" }))).body);
    expect(draft.text).toMatch(/Guests are free/);

    const stats = JSON.parse((await handle(req("GET", "/stats"))).body);
    expect(stats).toMatchObject({ documents: 1, tickets: 1, questionsLast7Days: 2 });

    expect((await handle(req("DELETE", `/documents/${id}`))).statusCode).toBe(200);
    expect((await handle(req("DELETE", `/documents/${id}`))).statusCode).toBe(404);
    const list = JSON.parse((await handle(req("GET", "/documents"))).body);
    expect(list.documents).toHaveLength(1);
  });
});

describe("config parsing", () => {
  it("validates embedding size and score cutoff", () => {
    expect(parseEmbeddingDim(undefined, "local")).toBe(512);
    expect(parseEmbeddingDim("1024", "bedrock")).toBe(1024);
    expect(() => parseEmbeddingDim("768", "bedrock")).toThrow(/256, 512 or 1024/);
    expect(() => parseEmbeddingDim("abc", "local")).toThrow(/whole number/);
    expect(parseMinScore("")).toBeUndefined();
    expect(parseMinScore("0.25")).toBe(0.25);
    expect(() => parseMinScore("5")).toThrow(/between 0 and 1/);
  });
});

describe("Slack", () => {
  const secret = "8f742231b10e8888abcd99yyyzzz85a5";
  const sign = (ts: string, body: string) => `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;

  it("verifies signatures and rejects old or tampered requests", () => {
    const now = 1_700_000_000;
    const body = "text=hello";
    const sig = sign(String(now), body);
    expect(verifySlackSignature({ signingSecret: secret, timestamp: String(now), signature: sig, rawBody: body, nowSeconds: now })).toBe(true);
    expect(verifySlackSignature({ signingSecret: secret, timestamp: String(now), signature: sig, rawBody: "text=evil", nowSeconds: now })).toBe(false);
    expect(verifySlackSignature({ signingSecret: secret, timestamp: String(now), signature: sig, rawBody: body, nowSeconds: now + 600 })).toBe(false);
    expect(verifySlackSignature({ signingSecret: secret, timestamp: undefined, signature: sig, rawBody: body })).toBe(false);
  });

  it("parses slash commands, drafts, help and URL verification", () => {
    const slash = parseSlackRequest("text=how+do+I+reset+2FA&response_url=https%3A%2F%2Fhooks.slack.com%2Fx&user_id=U1", "application/x-www-form-urlencoded");
    expect(slash).toMatchObject({ type: "job", job: { kind: "answer", text: "how do I reset 2FA", responseUrl: "https://hooks.slack.com/x" } });
    const draft = parseSlackRequest("text=draft+my+card+failed&response_url=u", "application/x-www-form-urlencoded");
    expect(draft).toMatchObject({ type: "job", job: { kind: "draft", text: "my card failed" } });
    expect(parseSlackRequest("text=help", "application/x-www-form-urlencoded").type).toBe("ignore");
    expect(parseSlackRequest(JSON.stringify({ type: "url_verification", challenge: "abc" }), "application/json")).toEqual({ type: "challenge", challenge: "abc" });
  });

  it("parses app mentions and ignores bot messages", () => {
    const ev = (extra: object) =>
      JSON.stringify({ type: "event_callback", event: { type: "app_mention", text: "<@U123> how do refunds work?", channel: "C1", ts: "1.2", ...extra } });
    expect(parseSlackRequest(ev({}), "application/json")).toMatchObject({
      type: "job",
      job: { kind: "answer", text: "how do refunds work?", channel: "C1", threadTs: "1.2" },
    });
    expect(parseSlackRequest(ev({ bot_id: "B1" }), "application/json").type).toBe("ignore");
  });

  it("posts answers to response_url and threads", async () => {
    const { assistant } = makeRouter();
    for (const d of sampleDocs()) await assistant.ingest(d);
    const calls: { url: string; body: any; auth?: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string), auth: (init.headers as Record<string, string>).authorization });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await runSlackJob({ kind: "answer", text: "Do guests use a paid seat?", responseUrl: "https://hooks.slack.com/r" }, { assistant, fetchImpl });
    await runSlackJob({ kind: "draft", text: "workspace is read only", channel: "C1", threadTs: "9.9" }, { assistant, botToken: "xoxb-test", fetchImpl });

    expect(calls[0].url).toBe("https://hooks.slack.com/r");
    expect(JSON.stringify(calls[0].body.blocks)).toContain("Sources");
    expect(calls[1].url).toBe("https://slack.com/api/chat.postMessage");
    expect(calls[1].body).toMatchObject({ channel: "C1", thread_ts: "9.9" });
    expect(calls[1].auth).toBe("Bearer xoxb-test");
  });
});

// Runs against a real Postgres + pgvector when TEST_DATABASE_URL is set (CI does this).
const dbUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!dbUrl)("PgVectorStore (real Postgres)", () => {
  const pool = createPool(dbUrl ?? "");
  const store = new PgVectorStore(pool);
  const assistant = new SupportAssistant({ store, embeddings: new LocalHashEmbeddings(), llm: new ExtractiveLlm(), minScore: 0.12 });

  beforeAll(async () => {
    await pool.query("DROP TABLE IF EXISTS chunks, documents, questions CASCADE");
    await migrate(pool, 512);
    await migrate(pool, 512); // idempotent
    for (const d of sampleDocs()) await assistant.ingest(d);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("stores documents and searches with pgvector", async () => {
    const stats = await store.stats();
    expect(stats.documents).toBe(7);
    expect(stats.tickets).toBe(16);
    const res = await assistant.ask("I lost my phone and can't get my 2FA codes");
    expect(res.citations.some((c) => /security|2FA|phone/i.test(c.title))).toBe(true);
    expect(res.text).toMatch(/backup code|Reset 2FA|reset/i);
    expect((await store.stats()).questionsLast7Days).toBe(1);
  });

  it("matches the in-memory store ranking", async () => {
    const mem = new MemoryStore();
    const memAssistant = new SupportAssistant({ store: mem, embeddings: new LocalHashEmbeddings(), llm: new ExtractiveLlm(), minScore: 0.12 });
    for (const d of sampleDocs()) await memAssistant.ingest(d);
    const q = "can we pay by invoice instead of card";
    const a = (await assistant.retrieve(q)).map((h) => h.title);
    const b = (await memAssistant.retrieve(q)).map((h) => h.title);
    expect(a[0]).toBe(b[0]);
  });

  it("cascades chunk deletes", async () => {
    const [doc] = await store.listDocuments();
    expect(await store.deleteDocument(doc.id)).toBe(true);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM chunks WHERE document_id = $1", [doc.id]);
    expect(rows[0].n).toBe(0);
    expect(await store.deleteDocument("not-a-uuid")).toBe(false);
  });
});
