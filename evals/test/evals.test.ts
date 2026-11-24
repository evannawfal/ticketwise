import { describe, expect, it } from "vitest";
import { gate } from "../src/gate.js";
import { gradeCase, summarize, type BenchmarkCase, type GradableResult } from "../src/grade.js";
import { appendRun, emptyHistory, renderScoreChart, type Report } from "../src/history.js";

const SOURCE = "Refunds go back to the original payment method and take 5 to 10 business days to appear.";
const ctx = {
  corpus: new Map([["Refund policy", `# Refunds\n\n${SOURCE}`]]),
  approved: new Map([["refund-annual", "Stored  answer."]]),
  retrieved: ["Refund policy"],
};
const answerCase: BenchmarkCase = {
  id: "refund-timing",
  type: "answer",
  question: "How long does a refund take?",
  sources: ["Refund policy"],
  facts: ["5 to 10 business days"],
};
const result = (text: string, quote = SOURCE): GradableResult => ({
  text,
  lowConfidence: false,
  mode: "generated",
  citations: [{ n: 1, title: "Refund policy", snippet: "", quotes: [{ text: quote }] }],
});

describe("grader", () => {
  it("passes a fully grounded answer", () => {
    const g = gradeCase(answerCase, result("Refunds take 5 to 10 business days to appear [1]."), ctx);
    expect(g).toMatchObject({ pass: true, score: 1, groundedClaims: 1, verbatimQuotes: 1 });
  });

  it("catches a quote that was reworded", () => {
    const g = gradeCase(answerCase, result("Refunds take 5 to 10 business days to appear [1].", "Refunds take 5-10 business days."), ctx);
    expect(g.verbatimQuotes).toBe(0);
    expect(g.groundedClaims).toBe(0);
    expect(g.reason).toMatch(/not verbatim/);
  });

  it("catches a missing fact and an uncited claim", () => {
    const g = gradeCase(answerCase, result("Refunds are quick [1]. Most arrive within a day."), ctx);
    expect(g.factRecall).toBe(0);
    expect(g.groundedClaims).toBeLessThan(g.claims);
    expect(g.pass).toBe(false);
  });

  it("requires approved answers to be byte for byte", () => {
    const c: BenchmarkCase = { id: "a", type: "approved", question: "q", approvedId: "refund-annual" };
    const ok = { text: "Stored  answer.", lowConfidence: false, mode: "approved", approved: { id: "refund-annual" }, citations: [] };
    expect(gradeCase(c, ok, ctx).pass).toBe(true);
    expect(gradeCase(c, { ...ok, text: "Stored answer." }, ctx).reason).toMatch(/changed/);
  });

  it("fails an answer to a question the docs don't cover, and a refusal of one they do", () => {
    const abstain: BenchmarkCase = { id: "x", type: "abstain", question: "Capital of France?" };
    expect(gradeCase(abstain, result("Paris [1]."), ctx).pass).toBe(false);
    const declined = { text: "I couldn't find this in the knowledge base.", lowConfidence: true, citations: [] };
    expect(gradeCase(abstain, declined, ctx).pass).toBe(true);
    expect(gradeCase(answerCase, declined, ctx).pass).toBe(false);
  });
});

function report(score: number, overrides: Partial<Report["summary"]> = {}, failing: string[] = []): Report {
  const grades = ["a", "b", "c"].map((id) => ({
    ...gradeCase({ id, type: "abstain", question: id }, { text: "x", lowConfidence: !failing.includes(id), citations: [] }, ctx),
  }));
  return {
    commit: `c${score}`,
    runAt: "2026-11-24T00:00:00Z",
    model: "test",
    summary: { ...summarize(grades), score, quoteExactness: 100, ...overrides },
    cases: grades,
  };
}

describe("merge gate", () => {
  const main = appendRun(emptyHistory(), report(90), { subject: "main", committedAt: "2026-11-01T00:00:00Z" }).runs[0];

  it("passes when the score holds", () => {
    expect(gate(report(90), main).blocked).toBe(false);
    expect(gate(report(90.3), main).blocked).toBe(false);
  });

  it("blocks when the score drops", () => {
    const r = gate(report(88), main);
    expect(r.blocked).toBe(true);
    expect(r.markdown).toMatch(/Score fell from 90.0 to 88.0/);
  });

  it("blocks when one guarded metric drops a lot, even if the score holds", () => {
    expect(gate(report(90, { abstainAccuracy: 80 }), { ...main, summary: { ...main.summary, abstainAccuracy: 100 } }).blocked).toBe(true);
  });

  it("blocks any quote that isn't word for word", () => {
    expect(gate(report(95, { quoteExactness: 99 }), main).reasons[0]).toMatch(/Quote exactness/);
  });

  it("names questions that broke", () => {
    expect(gate(report(90, {}, ["b"]), main).markdown).toMatch(/Now failing[\s\S]*`b`/);
  });

  it("passes the first run, when there's nothing to compare with", () => {
    expect(gate(report(50), undefined).blocked).toBe(false);
  });
});

describe("history", () => {
  it("keeps one run per commit in commit order and draws it", () => {
    let h = emptyHistory();
    h = appendRun(h, report(80), { subject: "one", committedAt: "2026-11-02T00:00:00Z" });
    h = appendRun(h, report(70), { subject: "zero", committedAt: "2026-11-01T00:00:00Z" });
    h = appendRun(h, { ...report(80), summary: { ...report(85).summary } }, { subject: "one again", committedAt: "2026-11-02T00:00:00Z" });
    expect(h.runs.map((r) => r.summary.score)).toEqual([70, 85]);
    const svg = renderScoreChart(h.runs);
    expect(svg).toMatch(/^<svg/);
    expect(svg.match(/<circle/g)).toHaveLength(2);
    expect(svg).toContain("85.0");
  });
});
