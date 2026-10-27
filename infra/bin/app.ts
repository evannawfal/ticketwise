import { App } from "aws-cdk-lib";
import { TicketwiseStack } from "../lib/ticketwise-stack.js";

const app = new App();
const ctx = (key: string) => app.node.tryGetContext(key);

new TicketwiseStack(app, "Ticketwise", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  llmProvider: ctx("llmProvider"),
  embeddingProvider: ctx("embeddingProvider"),
  embeddingDim: Number(ctx("embeddingDim")),
  secretName: ctx("secretName"),
  bedrockModelId: ctx("bedrockModelId"),
});
