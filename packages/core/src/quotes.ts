import { supportScore } from "./grounding.js";
import type { Quote, SourceType } from "./types.js";

export interface Span {
  start: number;
  end: number;
}

const MIN_SPAN = 20;
const MAX_PAIR = 420;

/**
 * Sentence-sized spans of a source, as character offsets into it. A quote is
 * always `source.slice(start, end)`, so it can only ever be the source's own
 * words. List markers and "Resolution:" labels are skipped over, not rewritten.
 * For past tickets only the agent's resolution is quotable, never the customer.
 */
export function sentenceSpans(source: string, sourceType: SourceType = "doc"): Span[] {
  let from = 0;
  let to = source.length;
  if (sourceType === "ticket") {
    const r = /Resolution:\s*/.exec(source);
    if (r) from = r.index + r[0].length;
    const tags = source.indexOf("\n\nTags:", from);
    if (tags >= 0) to = tags;
  }

  const spans: Span[] = [];
  const lineRe = /[^\n]+/g;
  lineRe.lastIndex = from;
  for (let m = lineRe.exec(source); m && m.index < to; m = lineRe.exec(source)) {
    let lineStart = m.index;
    const lineEnd = Math.min(m.index + m[0].length, to);
    const line = source.slice(lineStart, lineEnd);
    if (/^\s*(#|\||```)/.test(line)) continue;
    const prefix = /^\s*(?:[-*•]\s+|\d+[.)]\s+)?(?:(?:Customer|Resolution|Tags):\s*)?/.exec(line)![0];
    lineStart += prefix.length;

    // Sentence ends: . ! ? followed by whitespace and a capital, digit, quote or markup.
    const body = source.slice(lineStart, lineEnd);
    let s = 0;
    const endRe = /[.!?](?=\s+["“(*`A-Z0-9])/g;
    const push = (a: number, b: number) => {
      const text = source.slice(lineStart + a, lineStart + b);
      const lead = text.length - text.trimStart().length;
      const trail = text.length - text.trimEnd().length;
      if (b - a - lead - trail >= MIN_SPAN) spans.push({ start: lineStart + a + lead, end: lineStart + b - trail });
    };
    for (let e = endRe.exec(body); e; e = endRe.exec(body)) {
      push(s, e.index + 1);
      s = e.index + 1;
    }
    push(s, body.length);
  }
  return spans;
}

/**
 * The passage in `source` that best backs `claim`: the highest-support
 * sentence, or two adjacent sentences when together they cover clearly more.
 */
export function bestQuote(claim: string, source: string, sourceType: SourceType = "doc", question?: string): Quote | null {
  const spans = sentenceSpans(source, sourceType);
  if (!spans.length) return null;
  const scored = spans.map((sp) => ({ ...sp, support: supportScore(claim, source.slice(sp.start, sp.end), question) }));
  let best = scored.reduce((a, b) => (b.support > a.support ? b : a));
  for (let i = 0; i + 1 < scored.length; i++) {
    const a = scored[i];
    const b = scored[i + 1];
    if (b.end - a.start > MAX_PAIR || source.slice(a.end, b.start).includes("\n\n")) continue;
    const support = supportScore(claim, source.slice(a.start, b.end), question);
    if (support >= best.support + 0.15) best = { start: a.start, end: b.end, support };
  }
  if (best.support === 0) return null;
  return {
    text: source.slice(best.start, best.end),
    start: best.start,
    end: best.end,
    support: Math.round(best.support * 1000) / 1000,
  };
}
