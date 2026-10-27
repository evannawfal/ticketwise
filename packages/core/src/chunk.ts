import type { Chunk } from "./types.js";

export interface ChunkOptions {
  /** Target max characters per chunk (~250 tokens at 1200). */
  maxChars?: number;
  /** Characters carried over from the previous chunk in the same section. */
  overlapChars?: number;
}

interface Section {
  path: string | null;
  body: string;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/** Split markdown into sections, remembering the heading path for each. */
export function splitSections(markdown: string): Section[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const stack: { level: number; text: string }[] = [];
  const sections: Section[] = [];
  let buf: string[] = [];
  let inFence = false;

  const flush = () => {
    const body = buf.join("\n").trim();
    if (body) {
      sections.push({ path: stack.length ? stack.map((h) => h.text).join(" > ") : null, body });
    }
    buf = [];
  };

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence ? HEADING.exec(line) : null;
    if (m) {
      flush();
      const level = m[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text: m[2].trim() });
    } else {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

function splitLong(paragraph: string, maxChars: number): string[] {
  if (paragraph.length <= maxChars) return [paragraph];
  const sentences = paragraph.match(/[^.!?\n]+[.!?]*\s*/g) ?? [paragraph];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + s).length > maxChars && cur) {
      out.push(cur.trim());
      cur = "";
    }
    if (s.length > maxChars) {
      for (let i = 0; i < s.length; i += maxChars) out.push(s.slice(i, i + maxChars).trim());
    } else {
      cur += s;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function tail(text: string, n: number): string {
  if (n <= 0 || text.length <= n) return n <= 0 ? "" : text;
  const cut = text.slice(text.length - n);
  const space = cut.indexOf(" ");
  return space > 0 ? cut.slice(space + 1) : cut;
}

/**
 * Markdown-aware chunker. Keeps chunks inside one section so a chunk never
 * mixes two unrelated topics, packs paragraphs up to maxChars, and adds a
 * small overlap so answers that straddle a boundary are still retrievable.
 */
export function chunkMarkdown(markdown: string, opts: ChunkOptions = {}): Chunk[] {
  const maxChars = opts.maxChars ?? 1200;
  const overlap = opts.overlapChars ?? 150;
  const chunks: Chunk[] = [];

  for (const section of splitSections(markdown)) {
    const paragraphs = section.body
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean)
      .flatMap((p) => splitLong(p, maxChars));

    let cur = "";
    let carried = "";
    for (const p of paragraphs) {
      const candidate = cur ? `${cur}\n\n${p}` : carried ? `${carried} ${p}` : p;
      if (candidate.length > maxChars && cur) {
        chunks.push({ ordinal: chunks.length, content: cur, section: section.path });
        carried = tail(cur, overlap);
        cur = carried ? `${carried} ${p}` : p;
      } else {
        cur = candidate;
      }
    }
    if (cur.trim()) chunks.push({ ordinal: chunks.length, content: cur, section: section.path });
  }
  return chunks;
}

/** Text that gets embedded: title and section give the vector useful context. */
export function embeddingText(title: string, chunk: Chunk): string {
  const head = chunk.section ? `${title} — ${chunk.section}` : title;
  return `${head}\n\n${chunk.content}`;
}
