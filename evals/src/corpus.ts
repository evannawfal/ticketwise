import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ticketsFromCsv, type DocumentInput } from "@ticketwise/core";

export const repoRoot = join(import.meta.dirname, "../..");
const sampleDir = join(repoRoot, "sample-data");

export interface ApprovedSeed {
  id: string;
  question: string;
  answer: string;
  sources: { title: string; url?: string }[];
}

function frontMatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

/** The Northpine sample help center: 7 docs plus the solved tickets. */
export function loadCorpus(): DocumentInput[] {
  const docs = readdirSync(join(sampleDir, "docs"))
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const { meta, body } = frontMatter(readFileSync(join(sampleDir, "docs", f), "utf8"));
      return { title: meta.title ?? f, url: meta.url, content: body, sourceType: "doc" as const };
    });
  const tickets = ticketsFromCsv(readFileSync(join(sampleDir, "tickets.csv"), "utf8")).documents;
  return [...docs, ...tickets];
}

export function loadApprovedSeeds(): ApprovedSeed[] {
  return JSON.parse(readFileSync(join(sampleDir, "approved-answers.json"), "utf8")) as ApprovedSeed[];
}
