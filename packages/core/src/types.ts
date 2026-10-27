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

export interface Citation {
  n: number;
  documentId: string;
  title: string;
  url: string | null;
  sourceType: SourceType;
  section: string | null;
  snippet: string;
  score: number;
}

export interface AssistantResult {
  text: string;
  citations: Citation[];
  /** True when the retrieved sources were too weak to answer confidently. */
  lowConfidence: boolean;
  model: string;
  latencyMs: number;
}

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

export interface LlmProvider {
  readonly name: string;
  generate(req: GenerateRequest): Promise<string>;
}
