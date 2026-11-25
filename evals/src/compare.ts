import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { TOLERANCE, gate } from "./gate.js";
import { emptyHistory, type History, type Report } from "./history.js";

/**
 * The merge gate. Compares this run with the latest run on main and exits 1
 * if grounding got worse.
 *
 *   tsx src/compare.ts --current results/latest.json --history results/history.json --out results/report.md
 */
const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const current = JSON.parse(readFileSync(flag("current", "results/latest.json")!, "utf8")) as Report;
const historyPath = flag("history", "results/history.json")!;
const history: History = existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, "utf8")) : emptyHistory();
const baseSha = flag("base");
const runs = history.runs.filter((r) => r.commit !== current.commit);
const base = (baseSha && runs.find((r) => r.commit === baseSha)) || runs.at(-1);
const result = gate(current, base, { chartUrl: flag("chart"), tolerance: Number(flag("tolerance", String(TOLERANCE))) });
writeFileSync(flag("out", "results/report.md")!, result.markdown);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.markdown);
console.log(result.markdown);
if (result.blocked) {
  console.error("Grounding benchmark regressed. See the report above.");
  process.exit(1);
}
