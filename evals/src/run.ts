import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ExtractiveLlm,
  LocalHashEmbeddings,
  MemoryStore,
  OpenAiEmbeddings,
  OpenAiLlm,
  SupportAssistant,
} from "@ticketwise/core";
import { loadApprovedSeeds, loadCorpus, repoRoot } from "./corpus.js";
import { gradeCase, summarize, type BenchmarkCase, type CaseGrade } from "./grade.js";

/**
 * Runs the grounding benchmark and writes evals/results/latest.json.
 *
 *   npm run eval                       # offline: local embeddings + extractive generator (what CI gates on)
 *   npm run eval -- --provider openai  # real model, needs OPENAI_API_KEY
 */
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const provider = flag("provider") ?? "local";
const outPath = flag("out") ?? join(repoRoot, "evals/results/latest.json");

const benchmark = JSON.parse(readFileSync(join(repoRoot, "evals/benchmark.json"), "utf8")) as {
  name: string;
  cases: BenchmarkCase[];
};

function build() {
  const store = new MemoryStore();
  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is required for --provider openai");
    return new SupportAssistant({
      store,
      embeddings: new OpenAiEmbeddings({ apiKey }, 512),
      llm: new OpenAiLlm({ apiKey }, process.env.OPENAI_MODEL),
      minScore: 0.3,
      minCoverage: 0.1,
    });
  }
  return new SupportAssistant({
    store,
    embeddings: new LocalHashEmbeddings(512),
    llm: new ExtractiveLlm(),
    minScore: 0.12,
    minCoverage: 0.3,
  });
}

function commitSha(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const started = Date.now();
const assistant = build();
const corpusDocs = loadCorpus();
for (const d of corpusDocs) await assistant.ingest(d);
const corpus = new Map(corpusDocs.map((d) => [d.title, d.content]));
const approvedSeeds = loadApprovedSeeds();
const approved = new Map(approvedSeeds.map((a) => [a.id, a.answer]));

const grades: CaseGrade[] = [];
for (const c of benchmark.cases) {
  const retrieved = (await assistant.retrieve(c.question)).map((h) => h.title);
  const result = await assistant.ask(c.question, "eval");
  grades.push(gradeCase(c, result, { corpus, approved, retrieved }));
}

const summary = summarize(grades);
const report = {
  schema: 1,
  benchmark: benchmark.name,
  runAt: new Date().toISOString(),
  commit: commitSha(),
  provider,
  model: assistant.modelName,
  durationMs: Date.now() - started,
  summary,
  cases: grades,
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

const fmt = (v: number | null) => (v === null ? "  n/a" : `${v.toFixed(1).padStart(5)}`);
console.log(`\n${benchmark.name} (${provider}, ${assistant.modelName})\n`);
for (const g of grades) {
  console.log(`${g.pass ? "PASS" : "FAIL"}  ${g.score.toFixed(2)}  ${g.id.padEnd(26)} ${g.reason}`);
}
console.log(`
Score              ${fmt(summary.score)}   (${summary.passed}/${summary.cases} cases pass)
Retrieval recall   ${fmt(summary.retrievalRecall)}
Fact recall        ${fmt(summary.factRecall)}
Grounded claims    ${fmt(summary.groundedClaims)}
Citation precision ${fmt(summary.citationPrecision)}
Quote exactness    ${fmt(summary.quoteExactness)}
Abstain accuracy   ${fmt(summary.abstainAccuracy)}
Approved accuracy  ${fmt(summary.approvedAccuracy)}

Wrote ${outPath}`);
