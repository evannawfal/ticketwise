import { tokenize } from "./text.js";

const MARKER = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

export interface Claim {
  /** The sentence or list item, without its [n] markers. */
  text: string;
  /** Source numbers cited by this claim. */
  cites: number[];
}

export function stripMarkers(text: string): string {
  return text
    .replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, "")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

/** Unique content words (stemmed, no stopwords) in a piece of text. */
export function contentTerms(text: string): Set<string> {
  return new Set(tokenize(stripMarkers(text)));
}

/**
 * Share of a claim's content words that appear in the evidence, 0..1.
 * A lexical proxy for "is this claim backed by that passage". Numbers count as
 * words, so "5 days" is not supported by a passage that says "7 days".
 *
 * Words the claim repeats from the question ("the maximum attachment size is
 * 10 MB") aren't something the passage has to prove, so when a question is
 * given only the words the answer adds are checked.
 */
export function supportScore(claim: string, evidence: string, question?: string): number {
  const all = contentTerms(claim);
  if (!all.size) return 0;
  const asked = question ? contentTerms(question) : new Set<string>();
  const added = [...all].filter((t) => !asked.has(t));
  const terms = added.length ? added : [...all];
  const e = contentTerms(evidence);
  let hit = 0;
  for (const t of terms) if (e.has(t)) hit++;
  return hit / terms.length;
}

/**
 * Split an answer into claims (sentences and list items) and the source
 * numbers each one cites. Markers placed after the full stop ("Done. [2]")
 * belong to the sentence before them.
 */
export function splitClaims(text: string): Claim[] {
  const claims: Claim[] = [];
  const normalized = text.replace(/([.!?])((?:\s*\[\d+(?:\s*,\s*\d+)*\])+)/g, "$2$1");
  for (const rawLine of normalized.split(/\n+/)) {
    const line = rawLine.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim();
    if (!line) continue;
    for (const sentence of line.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/)) {
      const cites = new Set<number>();
      for (const m of sentence.matchAll(MARKER)) for (const n of m[1].split(",")) cites.add(Number(n.trim()));
      const clean = stripMarkers(sentence);
      // Greetings, sign-offs and fragments carry no checkable facts.
      if (contentTerms(clean).size < 3) continue;
      claims.push({ text: clean, cites: [...cites].sort((a, b) => a - b) });
    }
  }
  return claims;
}

/** Collapse whitespace and unify quote characters, for verbatim comparisons. */
export function normalizeForMatch(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** True when `quote` appears word for word in `source` (ignoring whitespace runs). */
export function isVerbatim(quote: string, source: string): boolean {
  const q = normalizeForMatch(quote);
  return q.length > 0 && normalizeForMatch(source).includes(q);
}
