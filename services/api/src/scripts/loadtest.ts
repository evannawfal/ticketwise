import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LocalHashEmbeddings,
  MemoryStore,
  OpenAiLlm,
  RequestQueue,
  ResilientLlm,
  SupportAssistant,
  readSse,
  ticketsFromCsv,
  tuningFor,
  type StreamEvent,
} from "@ticketwise/core";
import { parseFrontMatter } from "../front-matter.js";
import { createStreamHandler } from "../http.js";

/**
 * Many users at once, end to end over HTTP: N browsers open /ask/stream at the
 * same moment against a model provider that allows only LIMIT calls at a time
 * and answers 429 past that, like a real rate limit. Runs twice, without and
 * with the request queue, and prints what users saw.
 *
 *   npm run loadtest -w @ticketwise/api              # 50 users, provider limit 3
 *   USERS=100 LIMIT=5 npm run loadtest -w @ticketwise/api
 */
// The server logs every provider error; here hundreds are expected, and the table says it better.
console.error = () => undefined;

const USERS = Number(process.env.USERS ?? 50);
const LIMIT = Number(process.env.LIMIT ?? 3);
const TOKEN = "loadtest-admin-token";
const root = join(dirname(fileURLToPath(import.meta.url)), "../../../../sample-data");

const listen = (server: Server) =>
  new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));

/** An OpenAI-compatible streaming endpoint with a hard concurrency limit. */
function fakeProvider() {
  const stats = { inFlight: 0, peak: 0, served: 0, rejected: 0 };
  const words = "Refunds go back to the original payment method and take 5 to 10 business days to appear [1].".split(" ");
  const server = createServer(async (req, res) => {
    for await (const _ of req) void _; // drain the body
    if (stats.inFlight >= LIMIT) {
      stats.rejected++;
      res.writeHead(429, { "content-type": "application/json", "retry-after-ms": "300" });
      res.end(JSON.stringify({ error: { message: "Rate limit reached" } }));
      return;
    }
    stats.inFlight++;
    stats.peak = Math.max(stats.peak, stats.inFlight);
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const w of words) {
      await new Promise((r) => setTimeout(r, 15));
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${w} ` } }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 450, completion_tokens: words.length } })}\n\n`);
    res.end("data: [DONE]\n\n");
    stats.inFlight--;
    stats.served++;
  });
  return { server, stats };
}

async function loadCorpus(assistant: SupportAssistant) {
  for (const f of (await readdir(join(root, "docs"))).filter((f) => f.endsWith(".md"))) {
    const { meta, body } = parseFrontMatter(await readFile(join(root, "docs", f), "utf8"));
    await assistant.ingest({ title: meta.title ?? f, url: meta.url, content: body });
  }
  for (const t of ticketsFromCsv(await readFile(join(root, "tickets.csv"), "utf8")).documents) await assistant.ingest(t);
}

interface Outcome {
  ok: boolean;
  firstTokenMs: number | null;
  totalMs: number;
  retries: number;
  error?: string;
}

async function oneUser(url: string): Promise<Outcome> {
  const started = performance.now();
  let firstTokenMs: number | null = null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ question: "How long does a refund take to show up on my card?", mode: "off" }),
    });
    if (!res.ok || !res.body) return { ok: false, firstTokenMs, totalMs: performance.now() - started, retries: 0, error: `HTTP ${res.status}` };
    for await (const data of readSse(res.body)) {
      const ev = JSON.parse(data) as StreamEvent;
      if (ev.type === "delta" && firstTokenMs === null) firstTokenMs = performance.now() - started;
      if (ev.type === "error") return { ok: false, firstTokenMs, totalMs: performance.now() - started, retries: 0, error: ev.message };
      if (ev.type === "done") return { ok: true, firstTokenMs, totalMs: performance.now() - started, retries: ev.result.retries ?? 0 };
    }
    return { ok: false, firstTokenMs, totalMs: performance.now() - started, retries: 0, error: "stream ended early" };
  } catch (err) {
    return { ok: false, firstTokenMs, totalMs: performance.now() - started, retries: 0, error: (err as Error).message };
  }
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function scenario(name: string, queue: RequestQueue, maxRetries: number) {
  const provider = fakeProvider();
  const providerPort = await listen(provider.server);
  const store = new MemoryStore();
  const assistant = new SupportAssistant({
    store,
    embeddings: new LocalHashEmbeddings(),
    llm: new ResilientLlm(new OpenAiLlm({ apiKey: "test", baseUrl: `http://127.0.0.1:${providerPort}/v1` }), {
      queue,
      retry: { maxRetries, baseDelayMs: 200 },
    }),
    ...tuningFor("local"),
    approvedMode: "off",
  });
  await loadCorpus(assistant);
  const open = createStreamHandler({ assistant, adminToken: TOKEN, allowedOrigin: "*" });
  const api = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
    const out = await open({ method: req.method ?? "GET", path: req.url ?? "/", headers, body });
    res.writeHead(out.statusCode, out.headers);
    if (typeof out.body === "string") return res.end(out.body);
    for await (const chunk of out.body) res.write(chunk);
    res.end();
  });
  const apiPort = await listen(api);

  const started = performance.now();
  const results = await Promise.all(Array.from({ length: USERS }, () => oneUser(`http://127.0.0.1:${apiPort}/ask/stream`)));
  const wall = performance.now() - started;
  api.close();
  provider.server.close();

  const ok = results.filter((r) => r.ok);
  const errors = new Map<string, number>();
  for (const r of results.filter((r) => !r.ok)) errors.set(r.error!, (errors.get(r.error!) ?? 0) + 1);
  return {
    name,
    answered: `${ok.length}/${USERS}`,
    failed: results.length - ok.length,
    provider429s: provider.stats.rejected,
    providerPeak: provider.stats.peak,
    retries: ok.reduce((a, r) => a + r.retries, 0),
    firstTokenP50: pct(ok.map((r) => r.firstTokenMs ?? r.totalMs), 50),
    firstTokenP95: pct(ok.map((r) => r.firstTokenMs ?? r.totalMs), 95),
    totalP95: pct(ok.map((r) => r.totalMs), 95),
    wall,
    errors: [...errors].map(([e, n]) => `${n}x ${e}`).join("; "),
  };
}

const rows = [
  await scenario("no queue, no retries", new RequestQueue({ maxConcurrent: 1000 }), 0),
  await scenario("retries only", new RequestQueue({ maxConcurrent: 1000 }), 4),
  await scenario(`queue (${LIMIT} at once) + retries`, new RequestQueue({ maxConcurrent: LIMIT, maxQueue: 500 }), 4),
];

const ms = (n: number) => (Number.isNaN(n) ? "-" : `${Math.round(n)} ms`);
console.log(`\n${USERS} users at once, provider allows ${LIMIT} concurrent calls (429 past that)\n`);
console.log("| Setup | Answered | Provider 429s | Retries | First token p50 | First token p95 | Full answer p95 |");
console.log("|---|---|---|---|---|---|---|");
for (const r of rows) {
  console.log(
    `| ${r.name} | ${r.answered} | ${r.provider429s} | ${r.retries} | ${ms(r.firstTokenP50)} | ${ms(r.firstTokenP95)} | ${ms(r.totalP95)} |`,
  );
}
for (const r of rows) if (r.errors) console.log(`\n${r.name}: ${r.errors}`);
