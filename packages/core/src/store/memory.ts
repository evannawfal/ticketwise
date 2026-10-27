import type { ChunkWithEmbedding, DocumentInput, DocumentRecord, SearchHit, Stats, VectorStore } from "../types.js";

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

interface StoredChunk extends ChunkWithEmbedding {
  documentId: string;
}

/** In-memory store with brute-force cosine search. Used by tests and the browser demo. */
export class MemoryStore implements VectorStore {
  private docs = new Map<string, DocumentRecord>();
  private chunks: StoredChunk[] = [];
  private questions: { at: number }[] = [];

  async addDocument(doc: DocumentInput, chunks: ChunkWithEmbedding[]): Promise<DocumentRecord> {
    const record: DocumentRecord = {
      id: crypto.randomUUID(),
      title: doc.title,
      url: doc.url ?? null,
      sourceType: doc.sourceType ?? "doc",
      chunkCount: chunks.length,
      createdAt: new Date().toISOString(),
    };
    this.docs.set(record.id, record);
    for (const c of chunks) this.chunks.push({ ...c, documentId: record.id });
    return record;
  }

  async listDocuments(): Promise<DocumentRecord[]> {
    return [...this.docs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async deleteDocument(id: string): Promise<boolean> {
    const existed = this.docs.delete(id);
    this.chunks = this.chunks.filter((c) => c.documentId !== id);
    return existed;
  }

  async search(embedding: number[], k: number): Promise<SearchHit[]> {
    return this.chunks
      .map((c) => ({ c, score: cosine(embedding, c.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(({ c, score }) => {
        const d = this.docs.get(c.documentId)!;
        return {
          documentId: d.id,
          title: d.title,
          url: d.url,
          sourceType: d.sourceType,
          section: c.section,
          content: c.content,
          score,
        };
      });
  }

  async logQuestion(): Promise<void> {
    this.questions.push({ at: Date.now() });
  }

  async stats(): Promise<Stats> {
    const docs = [...this.docs.values()];
    const weekAgo = Date.now() - 7 * 864e5;
    return {
      documents: docs.filter((d) => d.sourceType === "doc").length,
      tickets: docs.filter((d) => d.sourceType === "ticket").length,
      chunks: this.chunks.length,
      questionsLast7Days: this.questions.filter((q) => q.at >= weekAgo).length,
    };
  }
}
