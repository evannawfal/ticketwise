import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LocalHashEmbeddings, MemoryStore, OpenAiEmbeddings, approvedMatchScore, type EmbeddingProvider } from "@ticketwise/core";
import { loadApprovedSeeds, repoRoot } from "./corpus.js";
import type { BenchmarkCase } from "./grade.js";

/**
 * Prints how strongly each benchmark question matches its closest approved
 * answer, so the approved-answer threshold can be set from data: above every
 * question that must not match, below every one that must.
 *
 *   npm run calibrate -w @ticketwise/evals                     # local embeddings
 *   npm run calibrate -w @ticketwise/evals -- --provider openai
 */
const provider = process.argv.includes("openai") ? "openai" : "local";
const embeddings: EmbeddingProvider =
  provider === "openai" ? new OpenAiEmbeddings({ apiKey: process.env.OPENAI_API_KEY ?? "" }, 512) : new LocalHashEmbeddings(512);

const { cases } = JSON.parse(readFileSync(join(repoRoot, "evals/benchmark.json"), "utf8")) as { cases: BenchmarkCase[] };
const seeds = loadApprovedSeeds();
const store = new MemoryStore();
const vectors = await embeddings.embed(seeds.map((s) => s.question), "query");
for (const [i, s] of seeds.entries()) await store.addApproved(s, vectors[i]);

const rows: { id: string; shouldMatch: boolean; best: string; score: number }[] = [];
const qVectors = await embeddings.embed(cases.map((c) => c.question), "query");
for (const [i, c] of cases.entries()) {
  const hits = await store.searchApproved(qVectors[i], 5);
  const scored = hits.map((h) => ({ id: h.id, score: approvedMatchScore(c.question, h.question, h.score) }));
  const best = scored.sort((a, b) => b.score - a.score)[0];
  rows.push({ id: c.id, shouldMatch: c.type === "approved", best: best.id, score: best.score });
}

rows.sort((a, b) => b.score - a.score);
for (const r of rows) console.log(`${r.score.toFixed(3)}  ${r.shouldMatch ? "MATCH " : "      "} ${r.id.padEnd(26)} -> ${r.best}`);
const lowestMatch = Math.min(...rows.filter((r) => r.shouldMatch).map((r) => r.score));
const highestOther = Math.max(...rows.filter((r) => !r.shouldMatch).map((r) => r.score));
console.log(`\n${provider}: must-match lowest ${lowestMatch.toFixed(3)}, must-not-match highest ${highestOther.toFixed(3)}`);
console.log(
  lowestMatch > highestOther
    ? `Any threshold in (${highestOther.toFixed(3)}, ${lowestMatch.toFixed(3)}] separates them; the midpoint is ${((lowestMatch + highestOther) / 2).toFixed(2)}.`
    : "No threshold separates them: add wording variants to the approved question or improve the match score.",
);
