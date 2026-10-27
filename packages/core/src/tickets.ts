import type { DocumentInput } from "./types.js";

/** RFC 4180 CSV parser (quoted fields, escaped quotes, newlines in quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const s = text.replace(/^﻿/, "");

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

const ALIASES: Record<string, string[]> = {
  id: ["id", "ticket_id", "ticket", "number"],
  subject: ["subject", "title", "summary"],
  question: ["customer_message", "question", "description", "body", "message"],
  answer: ["agent_reply", "resolution", "answer", "response", "reply"],
  status: ["status", "state"],
  tags: ["tags", "category", "labels"],
};

function findColumn(header: string[], key: keyof typeof ALIASES): number {
  const norm = header.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  for (const alias of ALIASES[key]) {
    const i = norm.indexOf(alias);
    if (i >= 0) return i;
  }
  return -1;
}

export interface TicketImportResult {
  documents: DocumentInput[];
  skipped: number;
}

/**
 * Turn a ticket export (Zendesk/Freshdesk/Jira style CSV) into documents.
 * Only tickets with both a customer message and an agent reply are useful;
 * open or unanswered tickets are skipped.
 */
export function ticketsFromCsv(csv: string): TicketImportResult {
  const rows = parseCsv(csv);
  if (rows.length < 2) return { documents: [], skipped: 0 };
  const [header, ...data] = rows;
  const col = {
    id: findColumn(header, "id"),
    subject: findColumn(header, "subject"),
    question: findColumn(header, "question"),
    answer: findColumn(header, "answer"),
    status: findColumn(header, "status"),
    tags: findColumn(header, "tags"),
  };
  if (col.question < 0 || col.answer < 0) {
    throw new Error(
      "CSV needs a customer message column (customer_message/question/description) and a reply column (agent_reply/resolution/answer).",
    );
  }

  const documents: DocumentInput[] = [];
  let skipped = 0;
  for (const r of data) {
    const get = (i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
    const question = get(col.question);
    const answer = get(col.answer);
    const status = get(col.status).toLowerCase();
    if (!question || !answer || (status && !/(solved|resolved|closed|done)/.test(status))) {
      skipped++;
      continue;
    }
    const id = get(col.id);
    const subject = get(col.subject) || question.slice(0, 60);
    const tags = get(col.tags);
    documents.push({
      title: id ? `Ticket #${id}: ${subject}` : `Ticket: ${subject}`,
      sourceType: "ticket",
      content: [
        `Customer: ${question}`,
        `Resolution: ${answer}`,
        tags ? `Tags: ${tags}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
  }
  return { documents, skipped };
}
