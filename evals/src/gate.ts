import type { Summary } from "./grade.js";
import type { HistoryRun, Report } from "./history.js";

/** Points the overall score may drop before a PR is blocked. The offline run is deterministic, so this only absorbs rounding. */
export const TOLERANCE = 0.5;
/** Points any guarded metric may drop. */
export const METRIC_TOLERANCE = 5;

const METRICS: { key: keyof Summary; label: string; guarded: boolean }[] = [
  { key: "score", label: "**Score**", guarded: false },
  { key: "retrievalRecall", label: "Retrieval recall", guarded: true },
  { key: "factRecall", label: "Fact recall", guarded: true },
  { key: "groundedClaims", label: "Grounded claims", guarded: true },
  { key: "citationPrecision", label: "Citation precision", guarded: true },
  { key: "quoteExactness", label: "Quote exactness", guarded: false },
  { key: "abstainAccuracy", label: "Abstain accuracy", guarded: true },
  { key: "approvedAccuracy", label: "Approved accuracy", guarded: true },
];

export interface GateResult {
  blocked: boolean;
  reasons: string[];
  markdown: string;
}

const fmt = (v: number | null | undefined) => (v === null || v === undefined ? "–" : v.toFixed(1));

export function gate(current: Report, base: HistoryRun | undefined, opts: { chartUrl?: string; tolerance?: number } = {}): GateResult {
  const tolerance = opts.tolerance ?? TOLERANCE;
  const s = current.summary;
  const reasons: string[] = [];
  if (s.quoteExactness !== null && s.quoteExactness < 100) {
    reasons.push(`Quote exactness is ${fmt(s.quoteExactness)}%: a quote shown to users isn't word for word from its source.`);
  }
  if (base) {
    const b = base.summary;
    if (s.score < b.score - tolerance) reasons.push(`Score fell from ${fmt(b.score)} to ${fmt(s.score)}.`);
    for (const m of METRICS.filter((m) => m.guarded)) {
      const before = b[m.key] as number;
      const after = s[m.key] as number;
      if (after < before - METRIC_TOLERANCE) reasons.push(`${m.label} fell from ${fmt(before)} to ${fmt(after)}.`);
    }
  }
  const blocked = reasons.length > 0;

  const lines: string[] = ["<!-- ticketwise-eval -->", "## Grounding benchmark", ""];
  if (blocked) {
    lines.push("**Blocked: this change makes answers less grounded.**", "", ...reasons.map((r) => `- ${r}`));
  } else if (!base) {
    lines.push("**Passed.** No run on main to compare with yet, so this run becomes the baseline once merged.");
  } else {
    const d = s.score - base.summary.score;
    lines.push(`**Passed.** Score ${fmt(s.score)} (${d >= 0 ? "+" : ""}${d.toFixed(1)} vs main).`);
  }
  lines.push("", `| Metric | main${base ? ` (\`${base.commit.slice(0, 7)}\`)` : ""} | this change | Δ |`, "|---|---:|---:|---:|");
  for (const m of METRICS) {
    const before = base ? (base.summary[m.key] as number | null) : null;
    const after = s[m.key] as number | null;
    const delta = before !== null && after !== null ? after - before : null;
    const d = delta === null ? "" : Math.abs(delta) < 0.05 ? "0" : `${delta > 0 ? "+" : ""}${delta.toFixed(1)}`;
    lines.push(`| ${m.label} | ${fmt(before)} | ${fmt(after)} | ${d} |`);
  }
  lines.push("", `${s.passed} of ${s.cases} questions pass · ${current.model}`);

  if (base) {
    const was = new Map(base.cases.map((c) => [c.id, c.pass]));
    const broke = current.cases.filter((c) => was.get(c.id) === true && !c.pass);
    const fixed = current.cases.filter((c) => was.get(c.id) === false && c.pass);
    if (broke.length) {
      lines.push("", "**Now failing**", "", ...broke.map((c) => `- \`${c.id}\`: ${c.question} (${c.reason})`));
    }
    if (fixed.length) lines.push("", "**Now passing**", "", ...fixed.map((c) => `- \`${c.id}\`: ${c.question}`));
  }
  const failing = current.cases.filter((c) => !c.pass);
  if (failing.length) {
    lines.push("", "<details><summary>All failing questions</summary>", "");
    for (const c of failing) lines.push(`- \`${c.id}\` (${c.score.toFixed(2)}): ${c.reason}`);
    lines.push("", "</details>");
  }
  if (opts.chartUrl) lines.push("", `[Score over time](${opts.chartUrl})`);
  return { blocked, reasons, markdown: `${lines.join("\n")}\n` };
}
