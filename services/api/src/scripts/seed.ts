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
  await app.pool.query("TRUNCATE documents CASCADE");
  console.log("Cleared existing documents");
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
await app.pool.end();
