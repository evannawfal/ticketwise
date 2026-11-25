"use client";

import { useEffect, useRef, useState } from "react";
import { EVAL_HISTORY_URL } from "@/lib/settings";

interface Summary {
  score: number;
  cases: number;
  passed: number;
  retrievalRecall: number;
  factRecall: number;
  groundedClaims: number;
  citationPrecision: number;
  quoteExactness: number | null;
  abstainAccuracy: number;
  approvedAccuracy: number;
}
interface Run {
  commit: string;
  subject: string;
  committedAt: string;
  model: string;
  summary: Summary;
}
interface LatestCase {
  id: string;
  type: string;
  question: string;
  score: number;
  pass: boolean;
  reason: string;
}

const REPO = "https://github.com/evannawfal/ticketwise";
const fmt = (v: number | null) => (v === null ? "n/a" : v.toFixed(1));

export function EvalsView() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [latest, setLatest] = useState<LatestCase[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    const get = (f: string) => fetch(`${EVAL_HISTORY_URL}/${f}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))));
    get("history.json")
      .then((h: { runs: Run[] }) => setRuns(h.runs))
      .catch(() => setError("Couldn't load the benchmark history. It's published by CI to the eval-history branch."));
    get("latest.json")
      .then((l: { cases: LatestCase[] }) => setLatest(l.cases))
      .catch(() => undefined);
  }, []);

  const last = runs?.at(-1);
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Evals</h1>
        <p>
          Every pull request runs a 30-question benchmark that checks each answer against the docs: the right facts, a
          citation on every sentence, quotes that match the source word for word, refusing what the docs don&apos;t cover,
          and approved answers returned unchanged. A merge is blocked if the score drops below main.
        </p>
      </div>
      {error && <div className="error">{error}</div>}
      {!runs && !error && <div className="meta-line">Loading the score history</div>}
      {last && (
        <>
          <div className="stats">
            <div className="stat"><div className="stat-v">{fmt(last.summary.score)}</div><div className="stat-l">Score on main (of 100)</div></div>
            <div className="stat"><div className="stat-v">{last.summary.passed}/{last.summary.cases}</div><div className="stat-l">Questions passing</div></div>
            <div className="stat"><div className="stat-v">{fmt(last.summary.groundedClaims)}%</div><div className="stat-l">Sentences backed by a quote</div></div>
            <div className="stat"><div className="stat-v">{fmt(last.summary.quoteExactness)}%</div><div className="stat-l">Quotes word for word</div></div>
          </div>
          <div className="card">
            <ScoreChart runs={runs!} />
          </div>
          <div className="card">
            <div className="section-title" style={{ marginTop: 0 }}>Runs on main</div>
            <div className="table-scroll">
              <table className="num-table">
                <thead>
                  <tr>
                    <th>Commit</th>
                    <th>Change</th>
                    <th>Score</th>
                    <th>Retrieval</th>
                    <th>Facts</th>
                    <th>Grounded</th>
                    <th>Citations</th>
                    <th>Abstain</th>
                    <th>Approved</th>
                  </tr>
                </thead>
                <tbody>
                  {[...runs!].reverse().map((r) => (
                    <tr key={r.commit}>
                      <td><a href={`${REPO}/commit/${r.commit}`} target="_blank" rel="noreferrer"><code>{r.commit.slice(0, 7)}</code></a></td>
                      <td className="cell-subject">{r.subject}</td>
                      <td><strong>{fmt(r.summary.score)}</strong></td>
                      <td>{fmt(r.summary.retrievalRecall)}</td>
                      <td>{fmt(r.summary.factRecall)}</td>
                      <td>{fmt(r.summary.groundedClaims)}</td>
                      <td>{fmt(r.summary.citationPrecision)}</td>
                      <td>{fmt(r.summary.abstainAccuracy)}</td>
                      <td>{fmt(r.summary.approvedAccuracy)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {latest.length > 0 && (
            <div className="card">
              <div className="section-title" style={{ marginTop: 0 }}>Latest run, question by question</div>
              <table>
                <thead>
                  <tr><th>Question</th><th>Kind</th><th>Score</th><th>Result</th></tr>
                </thead>
                <tbody>
                  {latest.map((c) => (
                    <tr key={c.id}>
                      <td className="cell-title">{c.question}</td>
                      <td className="meta-line">{c.type}</td>
                      <td>{c.score.toFixed(2)}</td>
                      <td className={c.pass ? "success" : "warn-line"}>{c.pass ? "Pass" : "Fail"}: {c.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="meta-line">
            Graded offline with the same deterministic models every time, so a change in score comes from a change in code.
            Benchmark and grader: <a href={`${REPO}/tree/main/evals`} target="_blank" rel="noreferrer">evals/</a>.
          </div>
        </>
      )}
    </div>
  );
}

/** Score by commit. One series, so the title names it; hover anywhere to read a run. */
function ScoreChart({ runs }: { runs: Run[] }) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 860;
  const H = 260;
  const m = { top: 16, right: 56, bottom: 30, left: 40 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const lo = Math.max(0, Math.floor((Math.min(...runs.map((r) => r.summary.score)) - 5) / 10) * 10);
  const x = (i: number) => m.left + (runs.length <= 1 ? iw / 2 : (i / (runs.length - 1)) * iw);
  const y = (v: number) => m.top + ih - ((v - lo) / (100 - lo)) * ih;
  const ticks = Array.from({ length: (100 - lo) / 10 + 1 }, (_, i) => lo + i * 10);
  const every = Math.max(1, Math.ceil(runs.length / 8));

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = ref.current!.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    for (let i = 1; i < runs.length; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    setHover(best);
  };
  const h = hover !== null ? runs[hover] : null;

  return (
    <div className="chart">
      <div className="chart-title">Benchmark score by commit on main</div>
      <div className="chart-wrap">
        <svg
          ref={ref}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Score over ${runs.length} runs, latest ${runs.at(-1)!.summary.score.toFixed(1)}`}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line className="grid" x1={m.left} x2={m.left + iw} y1={y(v)} y2={y(v)} />
              <text className="tick" x={m.left - 8} y={y(v) + 4} textAnchor="end">{v}</text>
            </g>
          ))}
          {runs.map((r, i) =>
            i % every === 0 || i === runs.length - 1 ? (
              <text key={r.commit} className="tick" x={x(i)} y={H - 8} textAnchor="middle">{r.commit.slice(0, 7)}</text>
            ) : null,
          )}
          {h && <line className="crosshair" x1={x(hover!)} x2={x(hover!)} y1={m.top} y2={m.top + ih} />}
          <path className="line" d={runs.map((r, i) => `${i ? "L" : "M"}${x(i)},${y(r.summary.score)}`).join(" ")} />
          {runs.map((r, i) => (
            <circle key={r.commit} className={`pt ${hover === i ? "on" : ""}`} cx={x(i)} cy={y(r.summary.score)} r={hover === i ? 5 : 4} />
          ))}
          <text className="value" x={x(runs.length - 1) + 10} y={y(runs.at(-1)!.summary.score) + 5}>
            {runs.at(-1)!.summary.score.toFixed(1)}
          </text>
        </svg>
        {h && (
          <div
            className={`tooltip ${y(h.summary.score) < H * 0.5 ? "below" : ""} ${x(hover!) > W * 0.75 ? "left" : x(hover!) < W * 0.25 ? "right" : ""}`}
            style={{ left: `${(x(hover!) / W) * 100}%`, top: `${(y(h.summary.score) / H) * 100}%` }}
          >
            <div className="tt-head"><code>{h.commit.slice(0, 7)}</code> {new Date(h.committedAt).toLocaleDateString()}</div>
            <div className="tt-sub">{h.subject}</div>
            <div className="tt-row"><span>Score</span><strong>{h.summary.score.toFixed(1)}</strong></div>
            <div className="tt-row"><span>Questions passing</span><span>{h.summary.passed}/{h.summary.cases}</span></div>
            <div className="tt-row"><span>Grounded sentences</span><span>{h.summary.groundedClaims.toFixed(1)}%</span></div>
          </div>
        )}
      </div>
    </div>
  );
}
