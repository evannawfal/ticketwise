import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DocumentInput } from "../src/types.js";
import { ticketsFromCsv } from "../src/tickets.js";

const root = join(import.meta.dirname, "../../../sample-data");

export function sampleDocs(): DocumentInput[] {
  const docs = readdirSync(join(root, "docs"))
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const text = readFileSync(join(root, "docs", f), "utf8");
      const m = /^---\n([\s\S]*?)\n---\n/.exec(text)!;
      const title = /title:\s*(.+)/.exec(m[1])![1];
      const url = /url:\s*(.+)/.exec(m[1])![1];
      return { title, url, content: text.slice(m[0].length), sourceType: "doc" as const };
    });
  const tickets = ticketsFromCsv(readFileSync(join(root, "tickets.csv"), "utf8")).documents;
  return [...docs, ...tickets];
}
