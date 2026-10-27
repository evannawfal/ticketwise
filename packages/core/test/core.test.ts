import { describe, expect, it } from "vitest";
import {
  ExtractiveLlm,
  LocalHashEmbeddings,
  MemoryStore,
  SupportAssistant,
  chunkMarkdown,
  cleanSection,
  cosine,
  diversify,
  extractCitationNumbers,
  parseCsv,
  resultToSlackBlocks,
  splitSections,
  stem,
  ticketsFromCsv,
  type GenerateRequest,
  type LlmProvider,
  type SearchHit,
} from "../src/index.js";
import { sampleDocs } from "./helpers.js";

describe("chunking", () => {
  it("tracks heading paths", () => {
    const sections = splitSections("# A\nintro\n## B\nbody b\n### C\nbody c\n## D\nbody d");
    expect(sections.map((s) => s.path)).toEqual(["A", "A > B", "A > B > C", "A > D"]);
  });

  it("ignores headings inside code fences", () => {
    const sections = splitSections("# Real\n```\n# not a heading\n```\ntext");
    expect(sections).toHaveLength(1);
    expect(sections[0].body).toContain("# not a heading");
  });

  it("keeps chunks under the size limit and never mixes sections", () => {
    const para = "Sentence about refunds and billing. ".repeat(30);
    const md = `# Billing\n\n${para}\n\n${para}\n\n# Security\n\nShort 2FA note.`;
    const chunks = chunkMarkdown(md, { maxChars: 500, overlapChars: 80 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(500 + 80 + 1);
    expect(chunks.at(-1)!.section).toBe("Security");
    expect(chunks.at(-1)!.content).toBe("Short 2FA note.");
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
  });

  it("returns nothing for empty input", () => {
    expect(chunkMarkdown("   \n\n")).toEqual([]);
  });
});

describe("tickets CSV", () => {
  it("parses quotes, commas and newlines", () => {
    const rows = parseCsv('a,b\n"x, y","line1\nline2 ""quoted"""\n');
    expect(rows).toEqual([
      ["a", "b"],
      ["x, y", 'line1\nline2 "quoted"'],
    ]);
  });

  it("imports solved tickets and skips open or unanswered ones", () => {
    const csv = [
      "id,subject,question,resolution,status",
      "1,Login,Can't log in,Reset your password,solved",
      "2,Open one,Still broken,,open",
      "3,Pending,Help,We are looking,pending",
    ].join("\n");
    const { documents, skipped } = ticketsFromCsv(csv);
    expect(documents).toHaveLength(1);
    expect(documents[0].title).toBe("Ticket #1: Login");
    expect(documents[0].sourceType).toBe("ticket");
    expect(skipped).toBe(2);
  });

  it("explains missing columns", () => {
    expect(() => ticketsFromCsv("foo,bar\n1,2")).toThrow(/customer message column/);
  });
});

describe("helpers", () => {
  it("stems common suffixes", () => {
    expect(stem("refunds")).toBe("refund");
    expect(stem("refunded")).toBe("refund");
    expect(stem("policies")).toBe("policy");
  });

  it("drops section headings that repeat the title", () => {
    expect(cleanSection("Refund policy", "Refund policy > Annual plans")).toBe("Annual plans");
    expect(cleanSection("Integrations", "Integrations")).toBeNull();
    expect(cleanSection("Billing and plans", "Billing > Invoices")).toBe("Invoices");
    expect(cleanSection("Billing", "Security > SSO")).toBe("Security > SSO");
  });

  it("extracts citation numbers", () => {
    expect(extractCitationNumbers("A [1]. B [3, 2]. C [1]")).toEqual([1, 2, 3]);
    expect(extractCitationNumbers("no cites")).toEqual([]);
  });

  it("limits chunks per document", () => {
    const hit = (documentId: string, score: number): SearchHit => ({
      documentId, title: documentId, url: null, sourceType: "doc", section: null, content: "", score,
    });
    const out = diversify([hit("a", 0.9), hit("a", 0.8), hit("a", 0.7), hit("b", 0.6)], 2, 10);
    expect(out.map((h) => h.documentId)).toEqual(["a", "a", "b"]);
  });

  it("produces normalized local embeddings", async () => {
    const e = new LocalHashEmbeddings(256);
    const [a, b, c] = await e.embed(["reset two factor authentication", "reset 2FA authentication", "invoice VAT number"]);
    expect(a).toHaveLength(256);
    expect(cosine(a, a)).toBeCloseTo(1, 6);
    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
  });
});

async function seededAssistant(llm: LlmProvider = new ExtractiveLlm()) {
  const store = new MemoryStore();
  const assistant = new SupportAssistant({ store, embeddings: new LocalHashEmbeddings(), llm, minScore: 0.12 });
  for (const d of sampleDocs()) await assistant.ingest(d);
  return { store, assistant };
}

describe("retrieval on the sample help center", () => {
  const cases: [string, RegExp][] = [
    ["I lost my phone and can't get my 2FA codes", /security|2FA|phone/i],
    ["How long does a refund take to show up on my card?", /refund/i],
    ["Do guests use a paid seat?", /billing|guest/i],
    ["Our Slack channel stopped receiving notifications", /integrations|slack/i],
    ["The API keeps returning 429 errors", /integrations|429|api/i],
    ["How do I export all of our data?", /members|export/i],
  ];
  it.each(cases)("finds the right source for: %s", async (question, expected) => {
    const { assistant } = await seededAssistant();
    const hits = await assistant.retrieve(question);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.slice(0, 2).some((h) => expected.test(`${h.title} ${h.section ?? ""}`))).toBe(true);
  });
});

describe("SupportAssistant", () => {
  it("answers with citations that point at real sources", async () => {
    const { assistant, store } = await seededAssistant();
    const res = await assistant.ask("How long do refunds take to appear?");
    expect(res.text).toMatch(/\[\d\]/);
    expect(res.citations.length).toBeGreaterThan(0);
    expect(res.citations.some((c) => /refund/i.test(c.title + c.snippet))).toBe(true);
    expect(res.lowConfidence).toBe(false);
    expect((await store.stats()).questionsLast7Days).toBe(1);
  });

  it("skips the model when nothing relevant is found", async () => {
    let called = false;
    const llm: LlmProvider = { name: "spy", generate: async () => ((called = true), "x") };
    const { assistant } = await seededAssistant(llm);
    const res = await assistant.ask("zebra quantum lasagna");
    expect(res.lowConfidence).toBe(true);
    expect(called).toBe(false);
    expect(res.citations).toEqual([]);
  });

  it("doesn't treat a match on a common word as relevant", async () => {
    const { assistant } = await seededAssistant();
    // "support" appears all over the help center; "christmas" appears nowhere.
    const res = await assistant.ask("Is support open on Christmas day?");
    expect(res.lowConfidence).toBe(true);
  });

  it("sends numbered sources and the system prompt to the model", async () => {
    let seen: GenerateRequest | undefined;
    const llm: LlmProvider = { name: "spy", generate: async (r) => ((seen = r), "Use a backup code [1].") };
    const { assistant } = await seededAssistant(llm);
    const res = await assistant.draftReply("I got a new phone and my authenticator codes are gone");
    expect(seen!.system).toMatch(/draft replies/i);
    expect(seen!.messages[0].content).toMatch(/^Sources:\n\n\[1\]/);
    expect(res.citations.map((c) => c.n)).toEqual([1]);
  });

  it("drafts a reply with a greeting and sign-off", async () => {
    const { assistant } = await seededAssistant();
    const res = await assistant.draftReply("Our workspace is read only and we can't edit anything");
    expect(res.text).toMatch(/^Hi there,/);
    expect(res.text).toMatch(/Support Team$/);
    expect(res.citations.length).toBeGreaterThan(0);
  });

  it("validates input", async () => {
    const { assistant } = await seededAssistant();
    await expect(assistant.ask("   ")).rejects.toThrow(/required/);
    await expect(assistant.ingest({ title: "", content: "x" })).rejects.toThrow(/title/);
  });

  it("deletes documents and their chunks", async () => {
    const { assistant, store } = await seededAssistant();
    const before = await store.stats();
    const [doc] = await store.listDocuments();
    expect(await store.deleteDocument(doc.id)).toBe(true);
    const after = await store.stats();
    expect(after.chunks).toBe(before.chunks - doc.chunkCount);
    expect(await store.deleteDocument(doc.id)).toBe(false);
    void assistant;
  });
});

describe("Slack formatting", () => {
  it("escapes text and lists sources with links", () => {
    const msg = resultToSlackBlocks(
      {
        text: "Use **Settings** <now> [1]",
        citations: [
          { n: 1, documentId: "d", title: "Billing", url: "https://x.example/b", sourceType: "doc", section: "Plans", snippet: "", score: 1 },
        ],
        lowConfidence: false,
        model: "m",
        latencyMs: 1,
      },
      { question: "q?" },
    );
    const json = JSON.stringify(msg.blocks);
    expect(json).toContain("Use *Settings* &lt;now&gt; [1]");
    expect(json).toContain("<https://x.example/b|Billing — Plans>");
  });
});
