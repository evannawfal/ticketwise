import {
  ExtractiveLlm,
  LocalHashEmbeddings,
  MemoryStore,
  RequestQueue,
  ResilientLlm,
  SupportAssistant,
  ticketsFromCsv,
  tuningFor,
  type ApprovedAnswerInput,
  type ApprovedMode,
  type AssistantResult,
  type StreamEvent,
} from "@ticketwise/core";
import type { Backend, NewDocument, OnEvent } from "./backend";
import sample from "./sample-data.json";

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

/**
 * Runs the real pipeline (chunking, embeddings, vector search, hybrid
 * re-ranking, exact quotes, grounding checks, approved answers, the request
 * queue) in the browser, with the offline extractive generator standing in for
 * the LLM. No server, no API keys.
 */
export class DemoBackend implements Backend {
  readonly mode = "demo" as const;
  private store = new MemoryStore();
  private assistant = new SupportAssistant({
    store: this.store,
    embeddings: new LocalHashEmbeddings(512),
    // Same queue as production, so two questions asked at once wait their turn.
    llm: new ResilientLlm(new ExtractiveLlm(), { queue: new RequestQueue({ maxConcurrent: 2 }) }),
    ...tuningFor("local"),
  });
  private ready: Promise<void>;

  constructor() {
    this.ready = (async () => {
      for (const d of sample.docs) await this.assistant.ingest({ ...d, sourceType: "doc" });
      for (const t of ticketsFromCsv(sample.ticketsCsv).documents) await this.assistant.ingest(t);
      for (const a of sample.approved) await this.assistant.approve(a);
    })();
  }

  /** Replays the stream at a reading pace, so it looks like a model writing. */
  private async play(gen: AsyncGenerator<StreamEvent, AssistantResult>, onEvent: OnEvent, signal?: AbortSignal) {
    await this.ready;
    await wait(250, signal);
    for await (const ev of gen) {
      if (signal?.aborted) throw signal.reason;
      if (ev.type === "delta" && ev.text.length < 40) await wait(28, signal);
      onEvent(ev);
      if (ev.type === "done") return ev.result;
    }
    throw new Error("stream ended early");
  }

  ask(q: string, mode: ApprovedMode, onEvent: OnEvent, signal?: AbortSignal) {
    return this.play(this.assistant.stream("answer", q, { channel: "demo", approvedMode: mode, signal }), onEvent, signal);
  }
  draft(t: string, onEvent: OnEvent, signal?: AbortSignal) {
    return this.play(this.assistant.stream("draft", t, { channel: "demo", signal }), onEvent, signal);
  }
  async listDocuments() {
    await this.ready;
    return this.store.listDocuments();
  }
  async addDocument(doc: NewDocument) {
    await this.ready;
    return this.assistant.ingest(doc);
  }
  async importTickets(csv: string) {
    await this.ready;
    const { documents, skipped } = ticketsFromCsv(csv);
    for (const d of documents) await this.assistant.ingest(d);
    return { imported: documents.length, skipped };
  }
  async deleteDocument(id: string) {
    await this.ready;
    await this.store.deleteDocument(id);
  }
  async listApproved() {
    await this.ready;
    return this.store.listApproved();
  }
  async addApproved(input: ApprovedAnswerInput) {
    await this.ready;
    return this.assistant.approve(input);
  }
  async updateApproved(id: string, input: ApprovedAnswerInput) {
    await this.ready;
    const updated = await this.assistant.updateApproved(id, input);
    if (!updated) throw new Error("That approved answer no longer exists.");
    return updated;
  }
  async deleteApproved(id: string) {
    await this.ready;
    await this.store.deleteApproved(id);
  }
  async stats() {
    await this.ready;
    return this.store.stats();
  }
}
