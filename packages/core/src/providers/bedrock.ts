import {
  BedrockRuntimeClient,
  ConverseCommand,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type { EmbeddingProvider, GenerateRequest, LlmProvider } from "../types.js";

let shared: BedrockRuntimeClient | undefined;
function client(region?: string): BedrockRuntimeClient {
  shared ??= new BedrockRuntimeClient(region ? { region } : {});
  return shared;
}

/** Amazon Titan Text Embeddings V2 (supports 256, 512 or 1024 dimensions). */
export class BedrockEmbeddings implements EmbeddingProvider {
  readonly name: string;
  constructor(
    readonly dimensions = 512,
    private modelId = "amazon.titan-embed-text-v2:0",
    private region?: string,
  ) {
    this.name = `bedrock:${modelId}`;
  }

  private async embedOne(text: string): Promise<number[]> {
    const res = await client(this.region).send(
      new InvokeModelCommand({
        modelId: this.modelId,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({ inputText: text.slice(0, 40000), dimensions: this.dimensions, normalize: true }),
      }),
    );
    const json = JSON.parse(new TextDecoder().decode(res.body)) as { embedding: number[] };
    return json.embedding;
  }

  async embed(texts: string[]): Promise<number[][]> {
    // Titan takes one input per call; run a few in parallel.
    const out: number[][] = new Array(texts.length);
    const concurrency = 8;
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, texts.length) }, async () => {
        while (next < texts.length) {
          const i = next++;
          out[i] = await this.embedOne(texts[i]);
        }
      }),
    );
    return out;
  }
}

/** Any Bedrock chat model through the Converse API (Claude, Llama, Nova...). */
export class BedrockLlm implements LlmProvider {
  readonly name: string;
  constructor(
    private modelId = "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    private region?: string,
  ) {
    this.name = `bedrock:${modelId}`;
  }

  async generate(req: GenerateRequest): Promise<string> {
    const res = await client(this.region).send(
      new ConverseCommand({
        modelId: this.modelId,
        system: [{ text: req.system }],
        messages: req.messages.map((m) => ({ role: m.role, content: [{ text: m.content }] })),
        inferenceConfig: { maxTokens: req.maxTokens ?? 700, temperature: 0.2 },
      }),
    );
    const parts = res.output?.message?.content ?? [];
    return parts
      .map((p) => ("text" in p ? p.text : ""))
      .join("")
      .trim();
  }
}
