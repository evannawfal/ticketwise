import type { CaseGrade, Summary } from "./grade.js";

/** One benchmark run on main, as stored on the eval-history branch. */
export interface HistoryRun {
  commit: string;
  subject: string;
  committedAt: string;
  runAt: string;
  model: string;
  summary: Summary;
  cases: { id: string; pass: boolean; score: number }[];
}

export interface History {
  schema: 1;
  runs: HistoryRun[];
}

export interface Report {
  commit: string;
  runAt: string;
  model: string;
  summary: Summary;
  cases: CaseGrade[];
}

export function emptyHistory(): History {
  return { schema: 1, runs: [] };
}

/** Add a run, replacing any earlier run of the same commit, oldest first, capped at 500. */
export function appendRun(history: History, report: Report, meta: { subject: string; committedAt: string }): History {
  const run: HistoryRun = {
    commit: report.commit,
    subject: meta.subject,
    committedAt: meta.committedAt,
    runAt: report.runAt,
    model: report.model,
    summary: report.summary,
    cases: report.cases.map((c) => ({ id: c.id, pass: c.pass, score: Math.round(c.score * 1000) / 1000 })),
  };
  const runs = history.runs.filter((r) => r.commit !== run.commit).concat(run);
  runs.sort((a, b) => a.committedAt.localeCompare(b.committedAt));
  return { schema: 1, runs: runs.slice(-500) };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The score over time as a standalone SVG (for the README). One series, so no
 * legend: the title names it. Light and dark colors switch with the viewer's
 * theme. Each point has a native tooltip with the commit and score.
 */
export function renderScoreChart(runs: HistoryRun[]): string {
  const W = 760;
  const H = 300;
  const m = { top: 70, right: 64, bottom: 40, left: 60 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const scores = runs.map((r) => r.summary.score);
  const lo = Math.max(0, Math.floor((Math.min(...scores, 100) - 5) / 10) * 10);
  const hi = 100;
  const x = (i: number) => m.left + (runs.length <= 1 ? iw / 2 : (i / (runs.length - 1)) * iw);
  const y = (v: number) => m.top + ih - ((v - lo) / (hi - lo)) * ih;

  const ticks: number[] = [];
  for (let v = lo; v <= hi; v += 10) ticks.push(v);
  const grid = ticks
    .map(
      (v) =>
        `<line class="grid" x1="${m.left}" x2="${m.left + iw}" y1="${y(v)}" y2="${y(v)}"/>` +
        `<text class="tick" x="${m.left - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`,
    )
    .join("");

  // Label at most ~8 commits along the bottom so the text never collides.
  const every = Math.max(1, Math.ceil(runs.length / 8));
  const xLabels = runs
    .map((r, i) =>
      i % every === 0 || i === runs.length - 1
        ? `<text class="tick" x="${x(i)}" y="${m.top + ih + 18}" text-anchor="middle">${esc(r.commit.slice(0, 7))}</text>`
        : "",
    )
    .join("");

  const path = runs.map((r, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(r.summary.score).toFixed(1)}`).join(" ");
  const points = runs
    .map(
      (r, i) =>
        `<circle class="pt" cx="${x(i).toFixed(1)}" cy="${y(r.summary.score).toFixed(1)}" r="4">` +
        `<title>${esc(`${r.commit.slice(0, 7)}: ${r.summary.score.toFixed(1)}\n${r.subject}`)}</title></circle>`,
    )
    .join("");
  const last = runs.at(-1);
  const lastLabel = last
    ? `<text class="value" x="${x(runs.length - 1) + 10}" y="${y(last.summary.score) + 5}">${last.summary.score.toFixed(1)}</text>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">
<title id="t">Grounding benchmark score by commit on main</title>
<desc id="d">${esc(runs.map((r) => `${r.commit.slice(0, 7)}: ${r.summary.score.toFixed(1)}`).join(", "))}</desc>
<style>
  svg { --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --grid: #e4e3df; --series: #2a78d6; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  @media (prefers-color-scheme: dark) { svg { --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --grid: #34332f; --series: #3987e5; } }
  .bg { fill: var(--surface); }
  .title { fill: var(--ink); font-size: 15px; font-weight: 600; }
  .sub { fill: var(--ink-2); font-size: 12px; }
  .grid { stroke: var(--grid); stroke-width: 1; }
  .tick { fill: var(--ink-2); font-size: 11px; font-variant-numeric: tabular-nums; }
  .line { fill: none; stroke: var(--series); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .pt { fill: var(--series); stroke: var(--surface); stroke-width: 2; }
  .value { fill: var(--ink); font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
</style>
<rect class="bg" width="${W}" height="${H}" rx="8"/>
<text class="title" x="20" y="28">Grounding benchmark score</text>
<text class="sub" x="20" y="46">${runs.length} runs on main, ${esc(evalCount(runs))} questions each, out of 100</text>
${grid}${xLabels}
<path class="line" d="${path}"/>
${points}${lastLabel}
</svg>
`;
}

function evalCount(runs: HistoryRun[]): string {
  return String(runs.at(-1)?.summary.cases ?? 0);
}
