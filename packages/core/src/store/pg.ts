import pg from "pg";
import type { ChunkWithEmbedding, DocumentInput, DocumentRecord, SearchHit, Stats, VectorStore } from "../types.js";

export function schemaSql(dimensions: number): string {
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 2000) {
    throw new Error(`invalid embedding dimensions: ${dimensions}`);
  }
  return `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  url         text,
  source_type text NOT NULL DEFAULT 'doc' CHECK (source_type IN ('doc', 'ticket')),
  content     text NOT NULL,
  chunk_count integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chunks (
  id          bigserial PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal     integer NOT NULL,
  section     text,
  content     text NOT NULL,
  embedding   vector(${dimensions}) NOT NULL
);

CREATE INDEX IF NOT EXISTS chunks_document_idx ON chunks (document_id);
-- HNSW gives fast approximate search with good recall and needs no training step.
CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS questions (
  id         bigserial PRIMARY KEY,
  question   text NOT NULL,
  channel    text NOT NULL,
  latency_ms integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS questions_created_idx ON questions (created_at);
`;
}

const toVector = (v: number[]) => `[${v.join(",")}]`;

export function createPool(connectionString: string): pg.Pool {
  const needsSsl = !/localhost|127\.0\.0\.1/.test(connectionString) && !/sslmode=disable/.test(connectionString);
  return new pg.Pool({
    connectionString,
    // Lambda: keep the pool tiny; each concurrent invocation gets its own container.
    max: 2,
    idleTimeoutMillis: 30_000,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  });
}

export async function migrate(pool: pg.Pool, dimensions: number): Promise<void> {
  await pool.query(schemaSql(dimensions));
}

interface DocRow {
  id: string;
  title: string;
  url: string | null;
  source_type: "doc" | "ticket";
  chunk_count: number;
  created_at: Date;
}

const toRecord = (r: DocRow): DocumentRecord => ({
  id: r.id,
  title: r.title,
  url: r.url,
  sourceType: r.source_type,
  chunkCount: r.chunk_count,
  createdAt: r.created_at.toISOString(),
});

export class PgVectorStore implements VectorStore {
  constructor(private pool: pg.Pool) {}

  async addDocument(doc: DocumentInput, chunks: ChunkWithEmbedding[]): Promise<DocumentRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<DocRow>(
        `INSERT INTO documents (title, url, source_type, content, chunk_count)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, title, url, source_type, chunk_count, created_at`,
        [doc.title, doc.url ?? null, doc.sourceType ?? "doc", doc.content, chunks.length],
      );
      const id = rows[0].id;
      // Batch insert chunks in groups to keep statements reasonably sized.
      for (let i = 0; i < chunks.length; i += 50) {
        const batch = chunks.slice(i, i + 50);
        const values: unknown[] = [];
        const tuples = batch.map((c, j) => {
          const b = j * 5;
          values.push(id, c.ordinal, c.section, c.content, toVector(c.embedding));
          return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}::vector)`;
        });
        await client.query(
          `INSERT INTO chunks (document_id, ordinal, section, content, embedding) VALUES ${tuples.join(",")}`,
          values,
        );
      }
      await client.query("COMMIT");
      return toRecord(rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async listDocuments(): Promise<DocumentRecord[]> {
    const { rows } = await this.pool.query<DocRow>(
      `SELECT id, title, url, source_type, chunk_count, created_at FROM documents ORDER BY created_at DESC LIMIT 500`,
    );
    return rows.map(toRecord);
  }

  async deleteDocument(id: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
    const res = await this.pool.query(`DELETE FROM documents WHERE id = $1`, [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async search(embedding: number[], k: number): Promise<SearchHit[]> {
    const { rows } = await this.pool.query<{
      document_id: string;
      title: string;
      url: string | null;
      source_type: "doc" | "ticket";
      section: string | null;
      content: string;
      score: number;
    }>(
      `SELECT c.document_id, d.title, d.url, d.source_type, c.section, c.content,
              1 - (c.embedding <=> $1::vector) AS score
         FROM chunks c JOIN documents d ON d.id = c.document_id
        ORDER BY c.embedding <=> $1::vector
        LIMIT $2`,
      [toVector(embedding), k],
    );
    return rows.map((r) => ({
      documentId: r.document_id,
      title: r.title,
      url: r.url,
      sourceType: r.source_type,
      section: r.section,
      content: r.content,
      score: Number(r.score),
    }));
  }

  async logQuestion(question: string, channel: string, latencyMs: number): Promise<void> {
    await this.pool.query(`INSERT INTO questions (question, channel, latency_ms) VALUES ($1, $2, $3)`, [
      question,
      channel,
      Math.round(latencyMs),
    ]);
  }

  async stats(): Promise<Stats> {
    const { rows } = await this.pool.query<{ documents: string; tickets: string; chunks: string; questions: string }>(`
      SELECT
        (SELECT count(*) FROM documents WHERE source_type = 'doc')    AS documents,
        (SELECT count(*) FROM documents WHERE source_type = 'ticket') AS tickets,
        (SELECT count(*) FROM chunks)                                 AS chunks,
        (SELECT count(*) FROM questions WHERE created_at > now() - interval '7 days') AS questions`);
    const r = rows[0];
    return {
      documents: Number(r.documents),
      tickets: Number(r.tickets),
      chunks: Number(r.chunks),
      questionsLast7Days: Number(r.questions),
    };
  }
}
