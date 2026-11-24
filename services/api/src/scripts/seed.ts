import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ticketsFromCsv } from "@ticketwise/core";
import { migrate } from "@ticketwise/core/pg";
import { getApp } from "../config.js";
import { parseFrontMatter } from "../front-matter.js";

/** Loads the sample help center + ticket export into the database. */
const root = join(dirname(fileURLToPath(import.meta.url)), "../../../../sample-data");
const app = await getApp();
await migrate(app.pool, app.config.embeddingDim);

if (process.argv.includes("--reset")) {
  await app.pool.query("TRUNCATE documents, approved_answers CASCADE");
  console.log("Cleared existing documents and approved answers");
}

const docsDir = join(root, "docs");
for (const file of (await readdir(docsDir)).filter((f) => f.endsWith(".md")).sort()) {
  const { meta, body } = parseFrontMatter(await readFile(join(docsDir, file), "utf8"));
  const doc = await app.assistant.ingest({ title: meta.title ?? file, url: meta.url, content: body, sourceType: "doc" });
  console.log(`doc     ${doc.title} (${doc.chunkCount} chunks)`);
}

const { documents, skipped } = ticketsFromCsv(await readFile(join(root, "tickets.csv"), "utf8"));
for (const t of documents) await app.assistant.ingest(t);
console.log(`tickets ${documents.length} imported, ${skipped} skipped (open or unanswered)`);

const approved = JSON.parse(await readFile(join(root, "approved-answers.json"), "utf8")) as Parameters<typeof app.assistant.approve>[0][];
const existing = new Set((await app.store.listApproved()).map((a) => a.id));
for (const a of approved.filter((a) => !existing.has(a.id!))) await app.assistant.approve(a);
console.log(`approved ${approved.length} approved answers loaded`);
await app.pool.end();
