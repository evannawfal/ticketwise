import { createHmac, timingSafeEqual } from "node:crypto";
import { resultToSlackBlocks, type SupportAssistant } from "@ticketwise/core";

/** Verify a request really came from Slack (v0 signing scheme). */
export function verifySlackSignature(opts: {
  signingSecret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string;
  nowSeconds?: number;
}): boolean {
  const { signingSecret, timestamp, signature, rawBody } = opts;
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  // Reject anything older than 5 minutes to stop replay attacks.
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 300) return false;
  const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Work item passed from the fast Slack handler to the worker. */
export interface SlackJob {
  kind: "answer" | "draft";
  text: string;
  /** Slash commands reply through response_url. */
  responseUrl?: string;
  /** Mentions reply in-thread with chat.postMessage. */
  channel?: string;
  threadTs?: string;
  user?: string;
}

export type SlackParseResult =
  | { type: "challenge"; challenge: string }
  | { type: "job"; job: SlackJob; ack: Record<string, unknown> | null }
  | { type: "ignore"; ack: Record<string, unknown> | null };

const HELP =
  "Ask me anything from the knowledge base: `/ask how do I reset 2FA?`\nDraft a customer reply: `/ask draft <paste the customer's message>`";

/** Parse a slash command (form-encoded) or Events API payload (JSON). */
export function parseSlackRequest(rawBody: string, contentType: string): SlackParseResult {
  if (contentType.includes("application/json")) {
    const payload = JSON.parse(rawBody) as {
      type: string;
      challenge?: string;
      event?: { type: string; text?: string; channel?: string; ts?: string; thread_ts?: string; user?: string; bot_id?: string };
    };
    if (payload.type === "url_verification" && payload.challenge) return { type: "challenge", challenge: payload.challenge };
    const ev = payload.event;
    if (payload.type === "event_callback" && ev?.type === "app_mention" && !ev.bot_id) {
      const text = (ev.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
      if (!text) return { type: "ignore", ack: null };
      const draft = /^draft\b[:\s]*/i.exec(text);
      return {
        type: "job",
        ack: null,
        job: {
          kind: draft ? "draft" : "answer",
          text: draft ? text.slice(draft[0].length) : text,
          channel: ev.channel,
          threadTs: ev.thread_ts ?? ev.ts,
          user: ev.user,
        },
      };
    }
    return { type: "ignore", ack: null };
  }

  const form = new URLSearchParams(rawBody);
  const text = (form.get("text") ?? "").trim();
  const responseUrl = form.get("response_url") ?? undefined;
  if (!text || /^help$/i.test(text)) {
    return { type: "ignore", ack: { response_type: "ephemeral", text: HELP } };
  }
  const draft = /^draft\b[:\s]*/i.exec(text);
  const body = draft ? text.slice(draft[0].length) : text;
  if (!body) return { type: "ignore", ack: { response_type: "ephemeral", text: HELP } };
  return {
    type: "job",
    ack: { response_type: "ephemeral", text: draft ? "Drafting a reply…" : "Searching the knowledge base…" },
    job: { kind: draft ? "draft" : "answer", text: body, responseUrl, user: form.get("user_id") ?? undefined },
  };
}

/** Run a job and post the result back to Slack. */
export async function runSlackJob(
  job: SlackJob,
  deps: { assistant: SupportAssistant; botToken?: string; fetchImpl?: typeof fetch },
): Promise<void> {
  const f = deps.fetchImpl ?? fetch;
  let message: { text: string; blocks: unknown[] };
  try {
    const result =
      job.kind === "draft"
        ? await deps.assistant.draftReply(job.text, "slack")
        : await deps.assistant.ask(job.text, "slack");
    message = resultToSlackBlocks(result, {
      heading: job.kind === "draft" ? "Draft reply (review before sending)" : undefined,
      question: job.kind === "answer" ? job.text : undefined,
    });
  } catch (err) {
    console.error("slack job failed", err);
    message = { text: "Sorry, something went wrong answering that. Try again in a minute.", blocks: [] };
  }

  if (job.responseUrl) {
    const res = await f(job.responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response_type: "in_channel", replace_original: false, ...message }),
    });
    if (!res.ok) throw new Error(`response_url post failed: ${res.status}`);
    return;
  }
  if (job.channel) {
    if (!deps.botToken) throw new Error("SLACK_BOT_TOKEN is required to reply to mentions");
    const res = await f("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${deps.botToken}` },
      body: JSON.stringify({ channel: job.channel, thread_ts: job.threadTs, ...message }),
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    if (!data.ok) throw new Error(`chat.postMessage failed: ${data.error}`);
  }
}
