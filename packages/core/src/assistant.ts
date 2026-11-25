import { chunkMarkdown, embeddingText } from "./chunk.js";
import { approvedMatchScore, splitClaims } from "./grounding.js";
import { ABSTAIN_TEXT, ANSWER_SYSTEM, DRAFT_SYSTEM, NO_APPROVED_TEXT, answerUserMessage, draftUserMessage } from "./prompts.js";
import { bestQuote } from "./quotes.js";
import { tokenize, truncate } from "./text.js";
import type {
  ApprovedAnswer,
  ApprovedAnswerInput,
  ApprovedHit,
  ApprovedMode,
  AssistantResult,
  Citation,
  ClaimCheck,
  DocumentInput,
  DocumentRecord,
  EmbeddingProvider,
  GenerateRequest,
  Grounding,
  LlmChunk,
  LlmProvider,
  Quote,
  SearchHit,
  SourcePreview,
  StreamEvent,
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
  /** Default for questions that don't say. */
  approvedMode?: ApprovedMode;
  /** approvedMatchScore needed to return an approved answer. Calibrated on the benchmark. */
  approvedThreshold?: number;
}

export interface RunOptions {
  /** Where the question came from, for usage stats ("web", "slack", "eval"...). */
  channel?: string;
  signal?: AbortSignal;
  /** Overrides the assistant's default for this question. Drafts always generate. */
  approvedMode?: ApprovedMode;
}

const MAX_DOC_CHARS = 200_000;
const MAX_INPUT_CHARS = 8000;
const MAX_APPROVED_QUESTION = 1000;
const MAX_APPROVED_ANSWER = 8000;
export const APPROVED_MODES: readonly ApprovedMode[] = ["off", "prefer", "only"];

/**
 * Cutoffs that suit each kind of embedding. Hashed keyword vectors score
 * related text lower than neural ones do, so every threshold moves with them.
 * The approved-answer thresholds come from `npm run calibrate -w @ticketwise/evals`.
 */
export function tuningFor(embeddings: "local" | "neural"): Pick<AssistantOptions, "minScore" | "minCoverage" | "approvedThreshold"> {
  return embeddings === "local"
    ? { minScore: 0.12, minCoverage: 0.3, approvedThreshold: 0.74 }
    : { minScore: 0.3, minCoverage: 0.1, approvedThreshold: 0.83 };
}
/** A claim is grounded when a quoted passage from a source it cites covers this share of its words. */
export const GROUNDED_SUPPORT = 0.6;

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

function snippetOf(content: string): string {
  return truncate(
    content
      .replace(/^(Customer|Resolution|Tags):\s*/gm, "")
      .replace(/^\s*(?:[-*]|\d+\.)\s+/gm, "")
      .replace(/\*\*|`/g, ""),
    220,
  );
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Map [n] markers to sources and quote, for each claim, the exact passage in
 * the cited source that backs it. Also scores every claim, so a sentence with
 * no citation, or one whose citation doesn't actually say it, is flagged.
 */
export function groundAnswer(
  text: string,
  hits: SearchHit[],
  question?: string,
): { citations: Citation[]; grounding: Grounding } {
  const valid = (n: number) => n >= 1 && n <= hits.length;
  const quotesByN = new Map<number, Quote[]>();
  const checks: ClaimCheck[] = [];

  for (const claim of splitClaims(text)) {
    const cites = claim.cites.filter(valid);
    let support = 0;
    for (const n of cites) {
      const h = hits[n - 1];
      const q = bestQuote(claim.text, h.content, h.sourceType, question);
      if (!q) continue;
      support = Math.max(support, q.support);
      const list = quotesByN.get(n) ?? [];
      if (!list.some((x) => x.start === q.start && x.end === q.end)) list.push(q);
      quotesByN.set(n, list);
    }
    checks.push({ text: claim.text, cites, support: round(support), grounded: cites.length > 0 && support >= GROUNDED_SUPPORT });
  }

  let used = extractCitationNumbers(text).filter(valid);
  // The model cited nothing: still show the top sources so an agent can check.
  if (!used.length) used = hits.slice(0, 3).map((_, i) => i + 1);
  const citations = used.map((n): Citation => {
    const h = hits[n - 1];
    return {
      n,
      documentId: h.documentId,
      title: h.title,
      url: h.url,
      sourceType: h.sourceType,
      section: cleanSection(h.title, h.section),
      snippet: snippetOf(h.content),
      score: round(h.score),
      quotes: (quotesByN.get(n) ?? []).sort((a, b) => a.start - b.start),
    };
  });
  return { citations, grounding: { claims: checks, grounded: checks.filter((c) => c.grounded).length, total: checks.length } };
}

async function* llmStream(llm: LlmProvider, req: GenerateRequest, signal?: AbortSignal): AsyncIterable<LlmChunk> {
  if (llm.stream) {
    yield* llm.stream(req, signal);
  } else {
    yield { type: "text", text: await llm.generate(req) };
  }
}

export class SupportAssistant {
  readonly topK: number;
  readonly minScore: number;
  readonly maxPerDocument: number;
  readonly minCoverage: number;
  readonly approvedMode: ApprovedMode;
  readonly approvedThreshold: number;

  constructor(private opts: AssistantOptions) {
    this.topK = opts.topK ?? 6;
    this.minScore = opts.minScore ?? 0.2;
    this.maxPerDocument = opts.maxPerDocument ?? 2;
    this.minCoverage = opts.minCoverage ?? 0.3;
    this.approvedMode = opts.approvedMode ?? "prefer";
    this.approvedThreshold = opts.approvedThreshold ?? 0.6;
  }

  private validateApproved(input: ApprovedAnswerInput): ApprovedAnswerInput {
    const question = input.question?.trim();
    if (!question) throw new Error("question is required");
    if (!input.answer?.trim()) throw new Error("answer is required");
    if (question.length > MAX_APPROVED_QUESTION) throw new Error(`question is too long (max ${MAX_APPROVED_QUESTION} characters)`);
    if (input.answer.length > MAX_APPROVED_ANSWER) throw new Error(`answer is too long (max ${MAX_APPROVED_ANSWER} characters)`);
    const sources = (input.sources ?? []).filter((s) => s?.title?.trim()).map((s) => ({ title: s.title.trim(), url: s.url || null }));
    // The answer is stored exactly as given, whitespace and all: it is returned word for word.
    return { question, answer: input.answer, sources };
  }

  /** Save an answer to be returned word for word whenever a question matches `question`. */
  async approve(input: ApprovedAnswerInput & { id?: string }): Promise<ApprovedAnswer> {
    const clean = this.validateApproved(input);
    const [vector] = await this.opts.embeddings.embed([clean.question], "query");
    return this.opts.store.addApproved({ ...clean, id: input.id }, vector);
  }

  async updateApproved(id: string, input: ApprovedAnswerInput): Promise<ApprovedAnswer | null> {
    const clean = this.validateApproved(input);
    const [vector] = await this.opts.embeddings.embed([clean.question], "query");
    return this.opts.store.updateApproved(id, clean, vector);
  }

  /** The best approved answer for a question, if it clears the threshold. */
  async matchApproved(question: string, vector?: number[]): Promise<(ApprovedHit & { match: number }) | null> {
    const v = vector ?? (await this.opts.embeddings.embed([question], "query"))[0];
    const candidates = await this.opts.store.searchApproved(v, 5);
    let best: (ApprovedHit & { match: number }) | null = null;
    for (const c of candidates) {
      const match = approvedMatchScore(question, c.question, c.score);
      if (match >= this.approvedThreshold && (!best || match > best.match)) best = { ...c, match: round(match) };
    }
    return best;
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

  async retrieve(query: string): Promise<SearchHit[]> {
    const [vector] = await this.opts.embeddings.embed([query], "query");
    return this.retrieveWith(query, vector);
  }

  /**
   * Hybrid retrieval: vector search finds candidates, then a light keyword
   * check re-ranks them. Chunks that share no words with the question need a
   * much stronger vector match to survive, which filters out "close in vector
   * space but unrelated" results that make models hallucinate.
   */
  private async retrieveWith(query: string, vector: number[]): Promise<SearchHit[]> {
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

  /**
   * Answer (or draft a reply) as a stream: the retrieved sources first, then the
   * text as the model writes it, then the final result with citations, exact
   * quotes and a per-claim grounding check.
   */
  async *stream(task: "answer" | "draft", input: string, opts: RunOptions = {}): AsyncGenerator<StreamEvent, AssistantResult> {
    const started = Date.now();
    const text = input.trim();
    if (!text) throw new Error(task === "answer" ? "question is required" : "ticket text is required");
    if (text.length > MAX_INPUT_CHARS) throw new Error(`input is too long (max ${MAX_INPUT_CHARS} characters)`);

    const finish = async (r: Omit<AssistantResult, "latencyMs" | "model">, model = this.modelName): Promise<AssistantResult> => {
      const latencyMs = Date.now() - started;
      await this.opts.store
        .logQuestion(truncate(text, 500), `${opts.channel ?? "api"}:${task}`, latencyMs)
        .catch(() => undefined);
      return { ...r, model, latencyMs };
    };

    const [vector] = await this.opts.embeddings.embed([text], "query");
    const approvedMode = task === "answer" ? (opts.approvedMode ?? this.approvedMode) : "off";
    if (approvedMode !== "off") {
      const match = await this.matchApproved(text, vector);
      if (match) {
        // Word for word: the stored text goes out untouched, with no model call.
        yield { type: "delta", text: match.answer };
        const result = await finish(
          {
            text: match.answer,
            citations: [],
            mode: "approved",
            approved: { id: match.id, question: match.question, match: match.match, sources: match.sources },
            lowConfidence: false,
            grounding: null,
          },
          "approved answer (no model call)",
        );
        yield { type: "done", result };
        return result;
      }
      if (approvedMode === "only") {
        yield { type: "delta", text: NO_APPROVED_TEXT };
        const result = await finish(
          { text: NO_APPROVED_TEXT, citations: [], mode: "abstained", lowConfidence: true, grounding: null },
          "approved answers only",
        );
        yield { type: "done", result };
        return result;
      }
    }

    const hits = await this.retrieveWith(text, vector);

    if (!hits.length && task === "answer") {
      // Nothing relevant: skip the model call entirely. Saves money and avoids made-up answers.
      yield { type: "delta", text: ABSTAIN_TEXT };
      const result = await finish({ text: ABSTAIN_TEXT, citations: [], mode: "abstained", lowConfidence: true, grounding: null });
      yield { type: "done", result };
      return result;
    }

    yield {
      type: "sources",
      sources: hits.map(
        (h, i): SourcePreview => ({
          n: i + 1,
          documentId: h.documentId,
          title: h.title,
          url: h.url,
          sourceType: h.sourceType,
          section: cleanSection(h.title, h.section),
          score: round(h.score),
        }),
      ),
    };

    const req: GenerateRequest = {
      task,
      question: text,
      sources: hits,
      system: task === "answer" ? ANSWER_SYSTEM : DRAFT_SYSTEM,
      messages: [{ role: "user", content: task === "answer" ? answerUserMessage(text, hits) : draftUserMessage(text, hits) }],
      maxTokens: task === "answer" ? 500 : 800,
    };
    let output = "";
    let usage: AssistantResult["usage"];
    let queuedMs = 0;
    let retries = 0;
    for await (const chunk of llmStream(this.opts.llm, req, opts.signal)) {
      if (chunk.type === "text" && chunk.text) {
        output += chunk.text;
        yield { type: "delta", text: chunk.text };
      } else if (chunk.type === "status") {
        yield { type: "status", stage: chunk.stage, message: chunk.message };
      } else if (chunk.type === "usage") {
        usage = { inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens };
      } else if (chunk.type === "queue") {
        queuedMs += chunk.waitedMs;
        retries = chunk.attempt;
      }
    }
    output = output.trim();
    const callStats = { ...(usage ? { usage } : {}), queuedMs, retries };

    const declined = task === "answer" && output.startsWith(ABSTAIN_TEXT.slice(0, 30)) && !extractCitationNumbers(output).length;
    const result = await finish(
      declined || !hits.length
        ? { text: output, citations: [], mode: "abstained", lowConfidence: true, grounding: null, ...callStats }
        : {
            text: output,
            ...groundAnswer(output, hits, task === "answer" ? text : undefined),
            mode: "generated",
            lowConfidence: false,
            ...callStats,
          },
    );
    yield { type: "done", result };
    return result;
  }

  private async collect(gen: AsyncGenerator<StreamEvent, AssistantResult>): Promise<AssistantResult> {
    for (;;) {
      const next = await gen.next();
      if (next.done) return next.value;
    }
  }

  ask(question: string, channel = "api", approvedMode?: ApprovedMode): Promise<AssistantResult> {
    return this.collect(this.stream("answer", question, { channel, approvedMode }));
  }

  draftReply(ticket: string, channel = "api"): Promise<AssistantResult> {
    return this.collect(this.stream("draft", ticket, { channel }));
  }
}
