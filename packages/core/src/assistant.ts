import { chunkMarkdown, embeddingText } from "./chunk.js";
import { ANSWER_SYSTEM, DRAFT_SYSTEM, answerUserMessage, draftUserMessage } from "./prompts.js";
import { tokenize, truncate } from "./text.js";
import type {
  AssistantResult,
  Citation,
  DocumentInput,
  DocumentRecord,
  EmbeddingProvider,
  LlmProvider,
  SearchHit,
  VectorStore,
} from "./types.js";

export interface AssistantOptions {
  store: VectorStore;
  embeddings: EmbeddingProvider;
  llm: LlmProvider;
  /** Chunks sent to the model. */
  topK?: number;
  /** Below this cosine similarity a hit is treated as irrelevant. */
  minScore?: number;
  /** Max chunks from the same document, so one long doc can't crowd out others. */
  maxPerDocument?: number;
  /**
   * Share of the question's (rarity-weighted) words a chunk must contain, unless
   * its vector match is very strong. Higher for keyword-style local embeddings,
   * lower for neural embeddings that already handle paraphrases.
   */
  minCoverage?: number;
}

const MAX_DOC_CHARS = 200_000;

/** Pull [n] / [n, m] markers out of model output. */
export function extractCitationNumbers(text: string): number[] {
  const nums = new Set<number>();
  for (const m of text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    for (const n of m[1].split(",")) nums.add(Number(n.trim()));
  }
  return [...nums].sort((a, b) => a - b);
}

/** Drop a leading heading that just repeats the document title ("Refund policy > Refund policy > Annual"). */
export function cleanSection(title: string, section: string | null): string | null {
  if (!section) return null;
  const parts = section.split(" > ");
  const t = title.toLowerCase();
  const first = parts[0].toLowerCase();
  if (t.startsWith(first) || first.startsWith(t)) parts.shift();
  return parts.length ? parts.join(" > ") : null;
}

export function diversify(hits: SearchHit[], maxPerDocument: number, k: number): SearchHit[] {
  const perDoc = new Map<string, number>();
  const out: SearchHit[] = [];
  for (const h of hits) {
    const c = perDoc.get(h.documentId) ?? 0;
    if (c >= maxPerDocument) continue;
    perDoc.set(h.documentId, c + 1);
    out.push(h);
    if (out.length >= k) break;
  }
  return out;
}

export class SupportAssistant {
  readonly topK: number;
  readonly minScore: number;
  readonly maxPerDocument: number;
  readonly minCoverage: number;

  constructor(private opts: AssistantOptions) {
    this.topK = opts.topK ?? 6;
    this.minScore = opts.minScore ?? 0.2;
    this.maxPerDocument = opts.maxPerDocument ?? 2;
    this.minCoverage = opts.minCoverage ?? 0.3;
  }

  get modelName(): string {
    return `${this.opts.llm.name} + ${this.opts.embeddings.name}`;
  }

  async ingest(doc: DocumentInput): Promise<DocumentRecord> {
    const title = doc.title.trim();
    const content = doc.content.trim();
    if (!title) throw new Error("title is required");
    if (!content) throw new Error("content is required");
    if (content.length > MAX_DOC_CHARS) throw new Error(`content is too long (max ${MAX_DOC_CHARS} characters)`);

    const chunks = chunkMarkdown(content);
    const vectors = await this.opts.embeddings.embed(
      chunks.map((c) => embeddingText(title, c)),
      "document",
    );
    return this.opts.store.addDocument(
      { ...doc, title, content, sourceType: doc.sourceType ?? "doc" },
      chunks.map((c, i) => ({ ...c, embedding: vectors[i] })),
    );
  }

  /**
   * Hybrid retrieval: vector search finds candidates, then a light keyword
   * check re-ranks them. Chunks that share no words with the question need a
   * much stronger vector match to survive, which filters out "close in vector
   * space but unrelated" results that make models hallucinate.
   */
  async retrieve(query: string): Promise<SearchHit[]> {
    const [vector] = await this.opts.embeddings.embed([query], "query");
    const raw = await this.opts.store.search(vector, this.topK * 4);
    const queryTerms = [...new Set(tokenize(query))];
    const strongVector = Math.max(this.minScore * 2, 0.5);

    const termSets = raw.map((h) => new Set(tokenize(`${h.title} ${h.section ?? ""} ${h.content}`)));
    // Weight query words by how rare they are among the candidates, so a match on a
    // word that is everywhere ("support", "account") counts for little and a match on
    // a distinctive word ("2fa", "invoice") counts for a lot.
    const weight = new Map(
      queryTerms.map((t) => {
        const df = termSets.filter((s) => s.has(t)).length;
        return [t, Math.log(1 + (raw.length + 1) / (df + 1))];
      }),
    );
    const totalWeight = [...weight.values()].reduce((a, b) => a + b, 0) || 1;

    const scored = raw
      .map((h, i) => {
        const matched = queryTerms.filter((t) => termSets[i].has(t));
        const coverage = matched.reduce((a, t) => a + weight.get(t)!, 0) / totalWeight;
        return { hit: h, coverage, combined: h.score * 0.75 + coverage * 0.25 };
      })
      .filter((s) => s.combined >= this.minScore && (s.coverage >= this.minCoverage || s.hit.score >= strongVector))
      .sort((a, b) => b.combined - a.combined)
      .map((s) => ({ ...s.hit, score: s.combined }));

    return diversify(scored, this.maxPerDocument, this.topK);
  }

  private toCitations(text: string, hits: SearchHit[]): Citation[] {
    let used = extractCitationNumbers(text).filter((n) => n >= 1 && n <= hits.length);
    if (!used.length) used = hits.slice(0, 3).map((_, i) => i + 1);
    return used.map((n) => {
      const h = hits[n - 1];
      return {
        n,
        documentId: h.documentId,
        title: h.title,
        url: h.url,
        sourceType: h.sourceType,
        section: cleanSection(h.title, h.section),
        snippet: truncate(
          h.content
            .replace(/^(Customer|Resolution|Tags):\s*/gm, "")
            .replace(/^\s*(?:[-*]|\d+\.)\s+/gm, "")
            .replace(/\*\*|`/g, ""),
          220,
        ),
        score: Math.round(h.score * 1000) / 1000,
      };
    });
  }

  private async run(task: "answer" | "draft", input: string, channel: string): Promise<AssistantResult> {
    const started = Date.now();
    const text = input.trim();
    if (!text) throw new Error(task === "answer" ? "question is required" : "ticket text is required");
    if (text.length > 8000) throw new Error("input is too long (max 8000 characters)");

    const hits = await this.retrieve(text);
    let output: string;
    let citations: Citation[] = [];
    const lowConfidence = hits.length === 0;

    if (lowConfidence && task === "answer") {
      // Nothing relevant: skip the model call entirely. Saves money and avoids made-up answers.
      output = "I couldn't find this in the knowledge base. It may need a human agent.";
    } else {
      output = await this.opts.llm.generate({
        task,
        question: text,
        sources: hits,
        system: task === "answer" ? ANSWER_SYSTEM : DRAFT_SYSTEM,
        messages: [
          { role: "user", content: task === "answer" ? answerUserMessage(text, hits) : draftUserMessage(text, hits) },
        ],
        maxTokens: task === "answer" ? 500 : 800,
      });
      citations = hits.length ? this.toCitations(output, hits) : [];
    }

    const latencyMs = Date.now() - started;
    await this.opts.store.logQuestion(truncate(text, 500), `${channel}:${task}`, latencyMs).catch(() => undefined);
    return { text: output, citations, lowConfidence, model: this.modelName, latencyMs };
  }

  ask(question: string, channel = "api"): Promise<AssistantResult> {
    return this.run("answer", question, channel);
  }

  draftReply(ticket: string, channel = "api"): Promise<AssistantResult> {
    return this.run("draft", ticket, channel);
  }
}
