// Bundles sample-data/ into JSON so the static browser demo can load it.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = join(root, "sample-data/docs");

const docs = readdirSync(docsDir)
  .filter((f) => f.endsWith(".md"))
  .sort()
  .map((f) => {
    const text = readFileSync(join(docsDir, f), "utf8");
    const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
    const meta = Object.fromEntries(
      (m?.[1] ?? "").split("\n").map((l) => l.split(/:\s(.*)/s).slice(0, 2)).filter((kv) => kv.length === 2),
    );
    return { title: meta.title ?? f, url: meta.url, content: m ? text.slice(m[0].length) : text };
  });

const ticketsCsv = readFileSync(join(root, "sample-data/tickets.csv"), "utf8");
const out = join(root, "apps/admin/lib/sample-data.json");
writeFileSync(out, JSON.stringify({ docs, ticketsCsv }));
console.log(`wrote ${docs.length} docs + tickets to ${out}`);
