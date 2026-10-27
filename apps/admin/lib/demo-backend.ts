import {
  ExtractiveLlm,
  LocalHashEmbeddings,
  MemoryStore,
  SupportAssistant,
  ticketsFromCsv,
} from "@ticketwise/core";
import type { Backend, NewDocument } from "./backend";
import sample from "./sample-data.json";

/**
 * Runs the real retrieval pipeline (chunking, embeddings, vector search,
 * hybrid re-ranking, citations) entirely in the browser, with the offline
 * extractive generator standing in for the LLM. No server, no API keys.
 */
export class DemoBackend implements Backend {
  readonly mode = "demo" as const;
  private store = new MemoryStore();
  private assistant = new SupportAssistant({
    store: this.store,
    embeddings: new LocalHashEmbeddings(512),
    llm: new ExtractiveLlm(),
    minScore: 0.12,
  });
  private ready: Promise<void>;

  constructor() {
    this.ready = (async () => {
      for (const d of sample.docs) await this.assistant.ingest({ ...d, sourceType: "doc" });
      for (const t of ticketsFromCsv(sample.ticketsCsv).documents) await this.assistant.ingest(t);
    })();
  }

  private async slow<T>(p: Promise<T>): Promise<T> {
    // A short delay so the UI shows its loading state like the real API would.
    const [v] = await Promise.all([p, new Promise((r) => setTimeout(r, 350))]);
    return v;
  }

  async ask(q: string) {
    await this.ready;
    return this.slow(this.assistant.ask(q, "demo"));
  }
  async draft(t: string) {
    await this.ready;
    return this.slow(this.assistant.draftReply(t, "demo"));
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
  async stats() {
    await this.ready;
    return this.store.stats();
  }
}
