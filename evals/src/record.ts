import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { appendRun, emptyHistory, renderScoreChart, type History, type Report } from "./history.js";

/**
 * Adds a benchmark run to the score history and redraws the chart. CI runs
 * this on every push to main, inside a checkout of the eval-history branch.
 *
 *   tsx src/record.ts --result results/latest.json --dir <eval-history checkout> --subject "..." --committed-at <iso>
 */
const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const dir = flag("dir", "results")!;
const report = JSON.parse(readFileSync(flag("result", "results/latest.json")!, "utf8")) as Report;
const historyPath = `${dir}/history.json`;
const history: History = existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, "utf8")) : emptyHistory();

const next = appendRun(history, report, {
  subject: flag("subject", "")!,
  committedAt: flag("committed-at", report.runAt)!,
});
writeFileSync(historyPath, `${JSON.stringify(next, null, 2)}\n`);
writeFileSync(`${dir}/latest.json`, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(`${dir}/score.svg`, renderScoreChart(next.runs));
console.log(`Recorded ${report.commit.slice(0, 7)}: score ${report.summary.score} (${next.runs.length} runs)`);
