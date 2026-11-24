export type SourceType = "doc" | "ticket";

export interface DocumentInput {
  title: string;
  content: string;
  url?: string;
  sourceType?: SourceType;
}

export interface DocumentRecord {
  id: string;
  title: string;
  url: string | null;
  sourceType: SourceType;
  chunkCount: number;
  createdAt: string;
}

export interface Chunk {
  ordinal: number;
  content: string;
  /** Heading path the chunk sits under, e.g. "Billing > Refunds". */
  section: string | null;
}

export interface ChunkWithEmbedding extends Chunk {
  embedding: number[];
}

export interface SearchHit {
  documentId: string;
  title: string;
  url: string | null;
  sourceType: SourceType;
  section: string | null;
  content: string;
  /** Cosine similarity, 1 = identical. */
  score: number;
}

/** An exact passage from a source: always `content.slice(start, end)` of the cited chunk. */
export interface Quote {
  text: string;
  start: number;
  end: number;
  /** Share of the citing claim's words found in the passage, 0..1. */
  support: number;
}

export interface Citation {
  n: number;
  documentId: string;
  title: string;
  url: string | null;
  sourceType: SourceType;
  section: string | null;
  snippet: string;
  score: number;
  /** Passages quoted word for word from this source, one per claim that cites it. */
  quotes: Quote[];
}

export interface ClaimCheck {
  text: string;
  cites: number[];
  /** Best support any cited quote gives this claim, 0..1. */
  support: number;
  grounded: boolean;
}

export interface Grounding {
  claims: ClaimCheck[];
  grounded: number;
  total: number;
}

/** generated: written by the model from sources. abstained: nothing relevant, so no answer. */
export type AnswerMode = "generated" | "abstained";

export interface AssistantResult {
  text: string;
  citations: Citation[];
  mode: AnswerMode;
  /** True when the retrieved sources were too weak to answer confidently. */
  lowConfidence: boolean;
  /** Per-sentence check that each claim is backed by a quoted passage. Null when nothing was generated. */
  grounding: Grounding | null;
  model: string;
  latencyMs: number;
}

/** A retrieved source as the client sees it before the answer arrives. */
export interface SourcePreview {
  n: number;
  documentId: string;
  title: string;
  url: string | null;
  sourceType: SourceType;
  section: string | null;
  score: number;
}

/** Events sent to clients while an answer streams. */
export type StreamEvent =
  | { type: "sources"; sources: SourcePreview[] }
  | { type: "status"; stage: "queued" | "retrying"; message: string }
  | { type: "delta"; text: string }
  | { type: "done"; result: AssistantResult };

export interface Stats {
  documents: number;
  tickets: number;
  chunks: number;
  questionsLast7Days: number;
}

export interface VectorStore {
  addDocument(doc: DocumentInput, chunks: ChunkWithEmbedding[]): Promise<DocumentRecord>;
  listDocuments(): Promise<DocumentRecord[]>;
  deleteDocument(id: string): Promise<boolean>;
  search(embedding: number[], k: number): Promise<SearchHit[]>;
  logQuestion(question: string, channel: string, latencyMs: number): Promise<void>;
  stats(): Promise<Stats>;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: string[], kind: "document" | "query"): Promise<number[][]>;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateRequest {
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /** Retrieved sources, used by the offline extractive generator. */
  sources?: SearchHit[];
  task?: "answer" | "draft";
  question?: string;
}

/** What a provider yields while streaming. */
export type LlmChunk =
  | { type: "text"; text: string }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "status"; stage: "queued" | "retrying"; message: string };

export interface LlmProvider {
  readonly name: string;
  generate(req: GenerateRequest): Promise<string>;
  /** Token-by-token output. Providers without it fall back to generate(). */
  stream?(req: GenerateRequest, signal?: AbortSignal): AsyncIterable<LlmChunk>;
}
