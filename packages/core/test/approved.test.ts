import { describe, expect, it } from "vitest";
import {
  ExtractiveLlm,
  LocalHashEmbeddings,
  MemoryStore,
  NO_APPROVED_TEXT,
  SupportAssistant,
  approvedMatchScore,
  tuningFor,
  type LlmProvider,
  type StreamEvent,
} from "../src/index.js";
import { sampleDocs } from "./helpers.js";

// Odd spacing, curly quotes, an em dash and a trailing newline: all must survive untouched.
const STORED = "  Yes — within 14 days.\n\n“Annual” plans renew yearly.\tAsk us within 30 days.\n";

async function setup(llm: LlmProvider = new ExtractiveLlm()) {
  const store = new MemoryStore();
  const assistant = new SupportAssistant({ store, embeddings: new LocalHashEmbeddings(), llm, ...tuningFor("local") });
  for (const d of sampleDocs()) await assistant.ingest(d);
  const saved = await assistant.approve({
    question: "Can I get a refund on an annual plan?",
    answer: STORED,
    sources: [{ title: "Refund policy", url: "https://help.northpine.example/refunds" }],
  });
  return { store, assistant, saved };
}

function spy() {
  const calls: string[] = [];
  const llm: LlmProvider = { name: "spy", generate: async (r) => (calls.push(r.question ?? ""), "Something [1].") };
  return { llm, calls };
}

describe("approved answers", () => {
  it("returns the stored text byte for byte, without calling the model", async () => {
    const { llm, calls } = spy();
    const { assistant, saved } = await setup(llm);
    const res = await assistant.ask("Can I get a refund on my annual plan?");
    expect(res.text).toBe(STORED);
    expect(res.mode).toBe("approved");
    expect(res.approved).toMatchObject({ id: saved.id, sources: [{ title: "Refund policy" }] });
    expect(res.approved!.match).toBeGreaterThanOrEqual(0.7);
    expect(res.citations).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("streams it as one piece, so nothing can be split or reflowed", async () => {
    const { assistant } = await setup();
    const events: StreamEvent[] = [];
    for await (const e of assistant.stream("answer", "Can I get a refund on an annual plan?")) events.push(e);
    expect(events.map((e) => e.type)).toEqual(["delta", "done"]);
    expect((events[0] as { text: string }).text).toBe(STORED);
  });

  it("does not answer a different question with it", async () => {
    const { assistant } = await setup();
    const res = await assistant.ask("Can I get a refund on a monthly plan?");
    expect(res.mode).toBe("generated");
    expect(res.text).not.toBe(STORED);
  });

  it("can be turned off per question", async () => {
    const { assistant } = await setup();
    const res = await assistant.ask("Can I get a refund on an annual plan?", "api", "off");
    expect(res.mode).toBe("generated");
  });

  it("in approved-only mode, escalates instead of generating", async () => {
    const { llm, calls } = spy();
    const { assistant } = await setup(llm);
    const res = await assistant.ask("How long until an invite expires?", "api", "only");
    expect(res).toMatchObject({ mode: "abstained", text: NO_APPROVED_TEXT, lowConfidence: true });
    expect(calls).toEqual([]);
  });

  it("is never used for drafted replies, which must fit the customer's message", async () => {
    const { assistant } = await setup();
    const res = await assistant.draftReply("Can I get a refund on an annual plan?");
    expect(res.mode).toBe("generated");
    expect(res.text).toMatch(/^Hi there,/);
  });

  it("follows edits and deletes", async () => {
    const { assistant, store, saved } = await setup();
    await assistant.updateApproved(saved.id, { question: "Can a deleted workspace be restored?", answer: "Yes, for 30 days." });
    expect((await assistant.ask("Can a deleted workspace be restored?")).text).toBe("Yes, for 30 days.");
    expect((await assistant.ask("Can I get a refund on an annual plan?")).mode).toBe("generated");
    expect(await store.deleteApproved(saved.id)).toBe(true);
    expect((await assistant.ask("Can a deleted workspace be restored?")).mode).toBe("generated");
    expect(await assistant.updateApproved("missing", { question: "q q q", answer: "a" })).toBeNull();
  });

  it("validates input", async () => {
    const { assistant } = await setup();
    await expect(assistant.approve({ question: " ", answer: "a" })).rejects.toThrow(/question is required/);
    await expect(assistant.approve({ question: "q", answer: "  " })).rejects.toThrow(/answer is required/);
    await expect(assistant.approve({ question: "q", answer: "x".repeat(8001) })).rejects.toThrow(/too long/);
  });

  it("scores missing words from the approved question harder than extra words", () => {
    const sameVector = 0.8;
    const extra = approvedMatchScore("Can we pay by invoice instead of card?", "Can we pay by invoice?", sameVector);
    const swapped = approvedMatchScore("Refund on a monthly plan?", "Refund on an annual plan?", sameVector);
    expect(extra).toBeGreaterThan(swapped);
    expect(approvedMatchScore("Can we pay by invoice?", "Can we pay by invoice?", 1)).toBe(1);
  });
});
