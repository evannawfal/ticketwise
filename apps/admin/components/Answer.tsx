"use client";

import type { AssistantResult, Citation } from "@ticketwise/core";
import { Fragment, useState } from "react";

/** Render [n] markers as clickable citation chips. */
function withCitations(text: string, valid: Set<number>, onCite: (n: number) => void) {
  const parts = text.split(/(\[\d+(?:\s*,\s*\d+)*\])/g);
  return parts.map((part, i) => {
    const m = /^\[(\d+(?:\s*,\s*\d+)*)\]$/.exec(part);
    if (!m) return <Fragment key={i}>{part}</Fragment>;
    return (
      <Fragment key={i}>
        {m[1].split(",").map((s) => {
          const n = Number(s.trim());
          return valid.has(n) ? (
            <button key={n} className="cite" onClick={() => onCite(n)} title={`Jump to source ${n}`}>
              {n}
            </button>
          ) : null;
        })}
      </Fragment>
    );
  });
}

/** Minimal block rendering: paragraphs, bullet and numbered lists. */
export function RichText({ text, citations, onCite }: { text: string; citations: Citation[]; onCite: (n: number) => void }) {
  const valid = new Set(citations.map((c) => c.n));
  const blocks = text.split(/\n{2,}/);
  return (
    <div className="answer">
      {blocks.map((block, i) => {
        const lines = block.split("\n");
        if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
          return (
            <ul key={i}>
              {lines.map((l, j) => (
                <li key={j}>{withCitations(l.replace(/^\s*[-*]\s+/, ""), valid, onCite)}</li>
              ))}
            </ul>
          );
        }
        if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
          return (
            <ol key={i}>
              {lines.map((l, j) => (
                <li key={j}>{withCitations(l.replace(/^\s*\d+[.)]\s+/, ""), valid, onCite)}</li>
              ))}
            </ol>
          );
        }
        return (
          <p key={i}>
            {lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {withCitations(l, valid, onCite)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

export function Sources({ citations, flash }: { citations: Citation[]; flash: number | null }) {
  if (!citations.length) return null;
  return (
    <div>
      <div className="section-title">Sources</div>
      <div className="sources">
        {citations.map((c) => (
          <div key={c.n} id={`source-${c.n}`} className={`source ${flash === c.n ? "flash" : ""}`}>
            <div className="source-n">{c.n}</div>
            <div>
              <div className="source-title">
                {c.url ? (
                  <a href={c.url} target="_blank" rel="noreferrer">
                    {c.title}
                  </a>
                ) : (
                  c.title
                )}
              </div>
              <div className="source-meta">
                <span className={`badge ${c.sourceType}`}>{c.sourceType === "ticket" ? "Past ticket" : "Help doc"}</span>
                {c.section && <span>{c.section}</span>}
                <span>relevance {Math.round(c.score * 100)}%</span>
              </div>
              <div className="source-snippet">{c.snippet}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function useCiteFlash() {
  const [flash, setFlash] = useState<number | null>(null);
  const onCite = (n: number) => {
    document.getElementById(`source-${n}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlash(n);
    setTimeout(() => setFlash((f) => (f === n ? null : f)), 1400);
  };
  return { flash, onCite };
}

export function ResultMeta({ result }: { result: AssistantResult }) {
  return (
    <div className="row" style={{ justifyContent: "space-between" }}>
      {result.lowConfidence ? (
        <span className="warn-line">Nothing in the knowledge base closely matched. Escalate to a human.</span>
      ) : (
        <span />
      )}
      <span className="meta-line">
        {result.model} · {result.latencyMs} ms
      </span>
    </div>
  );
}
