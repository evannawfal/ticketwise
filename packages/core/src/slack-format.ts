import type { AssistantResult } from "./types.js";

/** Escape text for Slack mrkdwn. */
export function slackEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Convert **bold** markdown to Slack's *bold*. */
function toMrkdwn(s: string): string {
  return slackEscape(s).replace(/\*\*(.+?)\*\*/g, "*$1*");
}

export interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

/** Slack Block Kit message for an answer or draft, with a sources footer. */
export function resultToSlackBlocks(
  result: AssistantResult,
  opts: { heading?: string; question?: string } = {},
): { text: string; blocks: SlackBlock[] } {
  const blocks: SlackBlock[] = [];
  if (opts.heading) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: toMrkdwn(opts.heading) }] });
  }
  if (opts.question) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `> ${toMrkdwn(opts.question.slice(0, 300))}` }] });
  }
  // Slack section text is capped at 3000 chars.
  const body = toMrkdwn(result.text);
  for (let i = 0; i < body.length; i += 2900) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: body.slice(i, i + 2900) } });
  }
  if (result.citations.length) {
    const lines = result.citations.map((c) => {
      const label = slackEscape(c.section ? `${c.title} — ${c.section}` : c.title);
      const link = c.url ? `<${c.url}|${label}>` : label;
      const kind = c.sourceType === "ticket" ? " (past ticket)" : "";
      return `[${c.n}] ${link}${kind}`;
    });
    blocks.push({ type: "divider" });
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `*Sources*\n${lines.join("\n")}` }] });
  }
  if (result.lowConfidence) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: ":warning: Low confidence: nothing in the knowledge base closely matched." }],
    });
  }
  return { text: result.text.slice(0, 3000), blocks };
}
