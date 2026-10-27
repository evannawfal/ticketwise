import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { loadConfig } from "../config.js";
import { parseSlackRequest, verifySlackSignature } from "../slack.js";

const sqs = new SQSClient({});

const reply = (statusCode: number, body: unknown = ""): APIGatewayProxyStructuredResultV2 => ({
  statusCode,
  headers: { "content-type": typeof body === "string" ? "text/plain" : "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

/**
 * Slack must get a response within 3 seconds, but retrieval + generation can
 * take longer. So this handler only verifies, acknowledges, and queues the work
 * on SQS; the worker Lambda answers and posts back to Slack.
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const config = await loadConfig();
  if (!config.slackSigningSecret) return reply(503, "Slack is not configured");

  const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const rawBody = event.body && event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body ?? "";

  const valid = verifySlackSignature({
    signingSecret: config.slackSigningSecret,
    timestamp: headers["x-slack-request-timestamp"],
    signature: headers["x-slack-signature"],
    rawBody,
  });
  if (!valid) return reply(401, "invalid signature");

  // Slack retries events it thinks timed out; we already queued the first one.
  if (headers["x-slack-retry-num"]) return reply(200);

  const parsed = parseSlackRequest(rawBody, headers["content-type"] ?? "");
  if (parsed.type === "challenge") return reply(200, { challenge: parsed.challenge });
  if (parsed.type === "job") {
    if (!config.slackQueueUrl) throw new Error("SLACK_QUEUE_URL is not set");
    await sqs.send(new SendMessageCommand({ QueueUrl: config.slackQueueUrl, MessageBody: JSON.stringify(parsed.job) }));
  }
  return parsed.ack ? reply(200, parsed.ack) : reply(200);
}
