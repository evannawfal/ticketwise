import type { EmbeddingProvider, GenerateRequest, LlmProvider, SearchHit } from "../types.js";
import { splitSentences, tokenize } from "../text.js";

/** FNV-1a 32-bit hash. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Offline embeddings: hashed unigrams + bigrams with sublinear term weights.
 * Not semantic like a neural model, but deterministic, free, and good enough
 * for keyword-heavy support content. Used for tests, local dev without API
 * keys, and the static browser demo.
 */
export class LocalHashEmbeddings implements EmbeddingProvider {
  readonly name = "local-hash";
  constructor(readonly dimensions = 512) {}

  embedOne(text: string): number[] {
    const v = new Float64Array(this.dimensions);
    const tokens = tokenize(text);
    const counts = new Map<string, number>();
    for (let i = 0; i < tokens.length; i++) {
      counts.set(tokens[i], (counts.get(tokens[i]) ?? 0) + 1);
      if (i + 1 < tokens.length) {
        const bi = `${tokens[i]}_${tokens[i + 1]}`;
        counts.set(bi, (counts.get(bi) ?? 0) + 0.5);
      }
    }
    for (const [term, tf] of counts) {
      const h = fnv1a(term);
      const sign = h & 1 ? 1 : -1;
      v[(h >>> 1) % this.dimensions] += sign * (1 + Math.log(tf + 1));
    }
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    return Array.from(v, (x) => x / norm);
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }
}

function scoreSentence(sentence: string, queryTerms: Set<string>): number {
  const terms = tokenize(sentence);
  if (!terms.length) return 0;
  let hits = 0;
  const seen = new Set<string>();
  for (const t of terms) {
    if (queryTerms.has(t) && !seen.has(t)) {
      hits++;
      seen.add(t);
    }
  }
  return hits / Math.sqrt(terms.length + 4);
}

function bestSentences(sources: SearchHit[], query: string, max: number) {
  const queryTerms = new Set(tokenize(query));
  const picked: { text: string; n: number; score: number }[] = [];
  sources.forEach((src, idx) => {
    // For past tickets only the agent's resolution is useful, never the customer's words.
    const text =
      src.sourceType === "ticket"
        ? (/Resolution:\s*([\s\S]*?)(?:\n\nTags:|$)/.exec(src.content)?.[1] ?? "")
        : src.content;
    const sentences = text
      .split(/\n+/)
      .map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").replace(/\*\*/g, ""))
      .flatMap(splitSentences);
    sentences.forEach((s, j) => {
      if (s.length < 25 || /^#|^\|/.test(s)) return;
      // Prefer sentences from higher-ranked sources and earlier in the chunk.
      const rankWeight = 1 / (1 + idx * 0.25);
      const score = scoreSentence(s, queryTerms) * (0.6 + src.score) * rankWeight - j * 0.002;
      if (score > 0) picked.push({ text: s, n: idx + 1, score });
    });
  });
  picked.sort((a, b) => b.score - a.score);
  const out: typeof picked = [];
  const floor = (picked[0]?.score ?? 0) * 0.55;
  for (const p of picked) {
    if (p.score < floor) break;
    if (out.some((o) => o.text === p.text)) continue;
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Offline "LLM": builds an extractive answer from the best-matching sentences
 * in the retrieved sources, with [n] citations. No API calls, so the demo and
 * test suite run anywhere. Swap for Bedrock or OpenAI in production.
 */
export class ExtractiveLlm implements LlmProvider {
  readonly name = "extractive (offline)";

  async generate(req: GenerateRequest): Promise<string> {
    const sources = req.sources ?? [];
    const question = req.question ?? req.messages[req.messages.length - 1]?.content ?? "";
    const lines = bestSentences(sources, question, req.task === "draft" ? 3 : 3);

    if (!lines.length) {
      return req.task === "draft"
        ? "Hi there,\n\nThanks for reaching out. I'm checking this with the team and will get back to you shortly.\n\nBest,\nSupport Team"
        : "I couldn't find this in the knowledge base. It may need a human agent.";
    }

    if (req.task === "draft") {
      // A resolved ticket's resolution is already a tested reply: lead with it, in order.
      const top = sources[0];
      let picked = lines;
      if (top?.sourceType === "ticket") {
        const resolution = /Resolution:\s*([\s\S]*?)(?:\n\nTags:|$)/.exec(top.content)?.[1] ?? "";
        const fromTicket = splitSentences(resolution)
          .filter((s) => s.length >= 25)
          .slice(0, 3)
          .map((text) => ({ text, n: 1, score: 1 }));
        if (fromTicket.length) picked = fromTicket;
      }
      const steps = picked.map((l) => `- ${l.text} [${l.n}]`).join("\n");
      return `Hi there,\n\nThanks for reaching out. Here's what should help:\n\n${steps}\n\nIf that doesn't fix it, reply here and we'll take a closer look.\n\nBest,\nSupport Team`;
    }
    return lines.map((l) => `${l.text} [${l.n}]`).join(" ");
  }
}
