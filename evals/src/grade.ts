import { isVerbatim, splitClaims, stripMarkers, supportScore } from "@ticketwise/core";

export type CaseType = "answer" | "abstain" | "approved" | "approved-miss";

export interface BenchmarkCase {
  id: string;
  type: CaseType;
  question: string;
  /** Title prefixes of documents or tickets that may be cited. */
  sources?: string[];
  /** Phrases the answer must contain. */
  facts?: string[];
  approvedId?: string;
  notApprovedId?: string;
}

/** The parts of an assistant result the grader reads. Older results may lack the optional fields. */
export interface GradableResult {
  text: string;
  lowConfidence: boolean;
  mode?: string;
  approved?: { id: string } | null;
  citations: { n: number; title: string; snippet: string; quotes?: { text: string }[] }[];
}

export interface CaseGrade {
  id: string;
  type: CaseType;
  question: string;
  score: number;
  pass: boolean;
  outcome: "answered" | "abstained" | "approved";
  reason: string;
  retrievalHit: boolean | null;
  factRecall: number | null;
  claims: number;
  groundedClaims: number;
  citations: number;
  citationsOnTarget: number;
  quotes: number;
  verbatimQuotes: number;
  text: string;
}

/** A claim counts as grounded when a cited, verbatim quote covers at least this share of its words. */
export const SUPPORT_THRESHOLD = 0.6;

const ABSTAIN = /couldn't find (this|that|an answer)|not in the knowledge base|no approved answer/i;

export function outcomeOf(r: GradableResult): CaseGrade["outcome"] {
  if (r.mode === "approved") return "approved";
  if (r.lowConfidence || r.mode === "abstained" || ABSTAIN.test(r.text)) return "abstained";
  return "answered";
}

function matchesAny(title: string, prefixes: string[] = []): boolean {
  const t = title.toLowerCase();
  return prefixes.some((p) => t.startsWith(p.toLowerCase()));
}

function plain(text: string): string {
  return stripMarkers(text).replace(/\*\*|`/g, "").replace(/\s+/g, " ").toLowerCase();
}

export interface GradeContext {
  /** Full text of every document and ticket, by title, for verbatim checks. */
  corpus: Map<string, string>;
  /** Approved answers by id, to check word-for-word returns. */
  approved: Map<string, string>;
  /** Titles the retriever returned for this question (before generation). */
  retrieved: string[];
}

export function gradeCase(c: BenchmarkCase, r: GradableResult, ctx: GradeContext): CaseGrade {
  const outcome = outcomeOf(r);
  const base: CaseGrade = {
    id: c.id,
    type: c.type,
    question: c.question,
    score: 0,
    pass: false,
    outcome,
    reason: "",
    retrievalHit: null,
    factRecall: null,
    claims: 0,
    groundedClaims: 0,
    citations: 0,
    citationsOnTarget: 0,
    quotes: 0,
    verbatimQuotes: 0,
    text: r.text,
  };

  if (c.type === "abstain") {
    const ok = outcome === "abstained";
    return { ...base, score: ok ? 1 : 0, pass: ok, reason: ok ? "declined to answer" : "answered a question the docs don't cover" };
  }

  if (c.type === "approved") {
    const stored = ctx.approved.get(c.approvedId!);
    if (outcome !== "approved") return { ...base, reason: "approved answer was not used" };
    if (r.approved?.id !== c.approvedId) return { ...base, reason: `returned the wrong approved answer (${r.approved?.id})` };
    if (r.text !== stored) return { ...base, reason: "approved text was changed" };
    return { ...base, score: 1, pass: true, reason: "returned word for word" };
  }

  // "answer" and "approved-miss" are graded as generated answers.
  if (c.type === "approved-miss" && outcome === "approved") {
    return { ...base, reason: `wrongly returned approved answer "${r.approved?.id}"` };
  }

  const retrievalHit = ctx.retrieved.some((t) => matchesAny(t, c.sources));
  if (outcome === "abstained") {
    return { ...base, retrievalHit, factRecall: 0, reason: "declined a question the docs answer" };
  }

  const text = plain(r.text);
  const facts = c.facts ?? [];
  const factsFound = facts.filter((f) => text.includes(f.toLowerCase())).length;
  const factRecall = facts.length ? factsFound / facts.length : 1;

  const byN = new Map(r.citations.map((cit) => [cit.n, cit]));
  let quotes = 0;
  let verbatimQuotes = 0;
  const evidence = new Map<number, string[]>();
  for (const cit of r.citations) {
    const source = ctx.corpus.get(cit.title) ?? "";
    const ok: string[] = [];
    if (cit.quotes?.length) {
      for (const q of cit.quotes) {
        quotes++;
        if (isVerbatim(q.text, source)) {
          verbatimQuotes++;
          ok.push(q.text);
        }
      }
    } else {
      // No quotes from the system: fall back to the snippet it showed.
      ok.push(cit.snippet);
    }
    evidence.set(cit.n, ok);
  }

  const claims = splitClaims(r.text);
  let grounded = 0;
  for (const claim of claims) {
    const best = Math.max(0, ...claim.cites.flatMap((n) => (evidence.get(n) ?? []).map((e) => supportScore(claim.text, e, c.question))));
    if (claim.cites.some((n) => byN.has(n)) && best >= SUPPORT_THRESHOLD) grounded++;
  }
  const groundedRate = claims.length ? grounded / claims.length : 0;

  const onTarget = r.citations.filter((cit) => matchesAny(cit.title, c.sources)).length;
  const precision = r.citations.length ? onTarget / r.citations.length : 0;

  const score = 0.2 * (retrievalHit ? 1 : 0) + 0.3 * factRecall + 0.35 * groundedRate + 0.15 * precision;
  const problems = [
    !retrievalHit && "expected source not retrieved",
    factRecall < 1 && `missing ${facts.length - factsFound} of ${facts.length} facts`,
    groundedRate < 1 && `${claims.length - grounded} of ${claims.length} claims not backed by a quote`,
    precision < 1 && `${r.citations.length - onTarget} off-target citations`,
    quotes > verbatimQuotes && `${quotes - verbatimQuotes} quotes not verbatim`,
  ].filter(Boolean);

  return {
    ...base,
    score,
    pass: score >= 0.8,
    reason: problems.length ? problems.join("; ") : "fully grounded",
    retrievalHit,
    factRecall,
    claims: claims.length,
    groundedClaims: grounded,
    citations: r.citations.length,
    citationsOnTarget: onTarget,
    quotes,
    verbatimQuotes,
  };
}

export interface Summary {
  /** Mean case score, 0-100. The number the merge gate watches. */
  score: number;
  cases: number;
  passed: number;
  retrievalRecall: number;
  factRecall: number;
  groundedClaims: number;
  citationPrecision: number;
  /** Share of quotes found word for word in their source. Null if the system returned no quotes. */
  quoteExactness: number | null;
  abstainAccuracy: number;
  approvedAccuracy: number;
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);

export function summarize(grades: CaseGrade[]): Summary {
  const gen = grades.filter((g) => g.type === "answer" || g.type === "approved-miss");
  const abstain = grades.filter((g) => g.type === "abstain");
  const approved = grades.filter((g) => g.type === "approved" || g.type === "approved-miss");
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const quotes = sum(grades.map((g) => g.quotes));
  return {
    score: Math.round(sum(grades.map((g) => g.score)) / grades.length * 1000) / 10,
    cases: grades.length,
    passed: grades.filter((g) => g.pass).length,
    retrievalRecall: pct(gen.filter((g) => g.retrievalHit).length, gen.length),
    factRecall: pct(sum(gen.map((g) => g.factRecall ?? 0)), gen.length),
    groundedClaims: pct(sum(gen.map((g) => g.groundedClaims)), sum(gen.map((g) => g.claims))),
    citationPrecision: pct(sum(gen.map((g) => g.citationsOnTarget)), sum(gen.map((g) => g.citations))),
    quoteExactness: quotes ? pct(sum(grades.map((g) => g.verbatimQuotes)), quotes) : null,
    abstainAccuracy: pct(abstain.filter((g) => g.pass).length, abstain.length),
    approvedAccuracy: pct(
      approved.filter((g) => (g.type === "approved" ? g.pass : g.outcome !== "approved")).length,
      approved.length,
    ),
  };
}
