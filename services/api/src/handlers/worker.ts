import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { getApp } from "../config.js";
import { runSlackJob, type SlackJob } from "../slack.js";

/** SQS consumer: answers queued Slack questions and posts the result. */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const app = await getApp();
  const failures: SQSBatchResponse["batchItemFailures"] = [];
  for (const record of event.Records) {
    try {
      const job = JSON.parse(record.body) as SlackJob;
      await runSlackJob(job, { assistant: app.assistant, botToken: app.config.slackBotToken });
    } catch (err) {
      console.error("job failed", record.messageId, err);
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  // Only failed messages are retried (and land in the DLQ after 3 tries).
  return { batchItemFailures: failures };
}
