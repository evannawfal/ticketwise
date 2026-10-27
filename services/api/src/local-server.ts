import { createServer, type IncomingMessage } from "node:http";
import { migrate } from "@ticketwise/core/pg";
import { getApp } from "./config.js";
import { createRouter } from "./http.js";
import { parseSlackRequest, runSlackJob, verifySlackSignature } from "./slack.js";

/**
 * Local dev server: same router and Slack logic as the Lambdas, but Slack jobs
 * run in-process instead of going through SQS.
 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

class BodyTooLarge extends Error {}

/** Read the request body, giving up past 2 MB so one request can't exhaust memory. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c: Buffer) => {
      if (tooLarge) return; // keep draining so we can still send a 413
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const port = Number(process.env.PORT ?? 8787);
const app = await getApp();
await migrate(app.pool, app.config.embeddingDim);
const router = createRouter({
  assistant: app.assistant,
  store: app.store,
  adminToken: app.config.adminToken,
  allowedOrigin: app.config.allowedOrigin,
});

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    if (err instanceof BodyTooLarge) res.writeHead(413, { connection: "close" }).end("request body too large");
    else res.writeHead(400).end("bad request");
    return;
  }
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));

  if (url.pathname === "/slack/events" && req.method === "POST") {
    const secret = app.config.slackSigningSecret;
    if (!secret) {
      res.writeHead(503).end("Slack is not configured");
      return;
    }
    const ok = verifySlackSignature({
      signingSecret: secret,
      timestamp: headers["x-slack-request-timestamp"],
      signature: headers["x-slack-signature"],
      rawBody: body,
    });
    if (!ok) {
      res.writeHead(401).end("invalid signature");
      return;
    }
    const parsed = parseSlackRequest(body, headers["content-type"] ?? "");
    if (parsed.type === "challenge") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ challenge: parsed.challenge }));
      return;
    }
    if (parsed.type === "job") {
      void runSlackJob(parsed.job, { assistant: app.assistant, botToken: app.config.slackBotToken }).catch((e) =>
        console.error(e),
      );
    }
    res.writeHead(200, { "content-type": "application/json" }).end(parsed.ack ? JSON.stringify(parsed.ack) : "");
    return;
  }

  const out = await router({ method: req.method ?? "GET", path: url.pathname, headers, body });
  res.writeHead(out.statusCode, out.headers).end(out.body);
}).listen(port, () => {
  console.log(`Ticketwise API on http://localhost:${port}  (llm=${app.config.llmProvider}, embeddings=${app.config.embeddingProvider})`);
});
