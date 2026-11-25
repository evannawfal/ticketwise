"use client";

import type { AssistantResult, Citation, Grounding, SourcePreview } from "@ticketwise/core";
import { Fragment, useState, type ReactNode } from "react";

/** Render [n] markers as clickable citation chips. */
function withCitations(text: string, valid: Set<number>, onCite: (n: number) => void) {
  const parts = text.split(/(\[\d+(?:\s*,\s*\d+)*\])/g);
  return parts.map((part, i) => {
    const m = /^\[(\d+(?:\s*,\s*\d+)*)\]$/.exec(part);
    if (!m) return <Fragment key={i}>{inlineMarkdown(part)}</Fragment>;
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

/** **bold** and `code`, nothing else. Sources are Markdown and quotes keep their markup. */
function inlineMarkdown(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((p, i) => {
    if (/^\*\*[^*]+\*\*$/.test(p)) return <strong key={i}>{p.slice(2, -2)}</strong>;
    if (/^`[^`]+`$/.test(p)) return <code key={i}>{p.slice(1, -1)}</code>;
    return <Fragment key={i}>{p}</Fragment>;
  });
}

/** Minimal block rendering: paragraphs, bullet and numbered lists. */
export function RichText({
  text,
  citations,
  validNumbers,
  onCite,
  streaming = false,
}: {
  text: string;
  citations: Citation[];
  /** Source numbers that can be cited while the answer is still streaming. */
  validNumbers?: number[];
  onCite: (n: number) => void;
  streaming?: boolean;
}) {
  const valid = new Set(validNumbers ?? citations.map((c) => c.n));
  const blocks = text.split(/\n{2,}/);
  return (
    <div className={`answer ${streaming ? "streaming" : ""}`}>
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

/** Approved answers are shown exactly as stored: no Markdown, no reflowing. */
export function ApprovedText({ text }: { text: string }) {
  return <div className="answer approved-text">{text}</div>;
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
              {c.quotes.length ? (
                c.quotes.map((q) => (
                  <blockquote key={`${q.start}-${q.end}`} className="quote" title={`Characters ${q.start} to ${q.end} of the source`}>
                    {inlineMarkdown(q.text)}
                  </blockquote>
                ))
              ) : (
                <div className="source-snippet">{c.snippet}</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The sources found so far, shown while the answer is still being written. */
export function SourcePreviews({ sources }: { sources: SourcePreview[] }) {
  return (
    <div className="previews">
      <div className="section-title">Reading {sources.length} sources</div>
      <ol>
        {sources.map((s) => (
          <li key={s.n}>
            <span className="source-n small">{s.n}</span>
            <span>
              {s.title}
              {s.section ? <span className="meta-line">, {s.section}</span> : null}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function GroundingNote({ grounding }: { grounding: Grounding | null }) {
  if (!grounding || !grounding.total) return null;
  const weak = grounding.claims.filter((c) => !c.grounded);
  if (!weak.length) {
    return (
      <div className="grounding ok">
        Every sentence ({grounding.total}) is backed by a passage quoted below.
      </div>
    );
  }
  return (
    <div className="grounding weak">
      {grounding.grounded} of {grounding.total} sentences are backed by a quoted passage. Check these before using them:
      <ul>
        {weak.map((c, i) => (
          <li key={i}>
            {c.text}
            <span className="meta-line"> ({c.cites.length ? `cites [${c.cites.join(", ")}], best match ${Math.round(c.support * 100)}%` : "no citation"})</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ApprovedSources({ result }: { result: AssistantResult }) {
  const a = result.approved;
  if (!a) return null;
  return (
    <div className="approved-note">
      <span className="badge approved">Approved answer</span>
      <span>
        Returned word for word for the approved question &quot;{a.question}&quot; (match {Math.round(a.match * 100)}%). No model call.
      </span>
      {a.sources.length > 0 && (
        <span>
          Sources:{" "}
          {a.sources.map((s, i) => (
            <Fragment key={i}>
              {i > 0 && ", "}
              {s.url ? (
                <a href={s.url} target="_blank" rel="noreferrer">
                  {s.title}
                </a>
              ) : (
                s.title
              )}
            </Fragment>
          ))}
        </span>
      )}
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
  const facts = [
    result.model,
    `${result.latencyMs} ms`,
    result.usage ? `${result.usage.inputTokens + result.usage.outputTokens} tokens` : null,
    result.queuedMs ? `waited ${(result.queuedMs / 1000).toFixed(1)}s for a slot` : null,
    result.retries ? `${result.retries} ${result.retries === 1 ? "retry" : "retries"}` : null,
  ].filter(Boolean);
  return (
    <div className="row" style={{ justifyContent: "space-between" }}>
      {result.mode === "abstained" ? (
        <span className="warn-line">Nothing in the knowledge base answers this. Escalate to a human.</span>
      ) : (
        <span />
      )}
      <span className="meta-line facts">
        {facts.map((f) => (
          <span key={f}>{f}</span>
        ))}
      </span>
    </div>
  );
}
