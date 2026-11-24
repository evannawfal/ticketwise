import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { ProviderError } from "../errors.js";
import type { EmbeddingProvider, GenerateRequest, LlmChunk, LlmProvider } from "../types.js";

let shared: BedrockRuntimeClient | undefined;
function client(region?: string): BedrockRuntimeClient {
  // Retries are handled by our own queue (it knows about token budgets), so the SDK makes one attempt.
  shared ??= new BedrockRuntimeClient({ ...(region ? { region } : {}), maxAttempts: 1 });
  return shared;
}

const RETRYABLE = new Set([
  "ThrottlingException",
  "ServiceUnavailableException",
  "ModelNotReadyException",
  "InternalServerException",
  "ModelStreamErrorException",
]);

/** Translate AWS SDK errors into ProviderError so the retry policy can read them. */
export function toProviderError(err: unknown): unknown {
  const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  if (!e || typeof e !== "object" || !e.name) return err;
  if (e.name === "AbortError") return err;
  const status = e.$metadata?.httpStatusCode ?? (e.name === "ThrottlingException" ? 429 : RETRYABLE.has(e.name) ? 503 : 400);
  return new ProviderError(`Bedrock ${e.name}: ${e.message ?? ""}`.trim(), status);
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
    const res = await client(this.region)
      .send(
        new InvokeModelCommand({
          modelId: this.modelId,
          contentType: "application/json",
          accept: "application/json",
          body: JSON.stringify({ inputText: text.slice(0, 40000), dimensions: this.dimensions, normalize: true }),
        }),
      )
      .catch((e) => {
        throw toProviderError(e);
      });
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

  private input(req: GenerateRequest) {
    return {
      modelId: this.modelId,
      system: [{ text: req.system }],
      messages: req.messages.map((m) => ({ role: m.role, content: [{ text: m.content }] })),
      inferenceConfig: { maxTokens: req.maxTokens ?? 700, temperature: 0.2 },
    };
  }

  async generate(req: GenerateRequest): Promise<string> {
    const res = await client(this.region)
      .send(new ConverseCommand(this.input(req)))
      .catch((e) => {
        throw toProviderError(e);
      });
    const parts = res.output?.message?.content ?? [];
    return parts
      .map((p) => ("text" in p ? p.text : ""))
      .join("")
      .trim();
  }

  async *stream(req: GenerateRequest, signal?: AbortSignal): AsyncIterable<LlmChunk> {
    try {
      const res = await client(this.region).send(new ConverseStreamCommand(this.input(req)), { abortSignal: signal });
      for await (const ev of res.stream ?? []) {
        const text = ev.contentBlockDelta?.delta?.text;
        if (text) yield { type: "text", text };
        const usage = ev.metadata?.usage;
        if (usage) yield { type: "usage", inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 };
        const failure =
          ev.throttlingException ?? ev.serviceUnavailableException ?? ev.internalServerException ?? ev.modelStreamErrorException;
        if (failure) throw failure;
        if (ev.validationException) throw ev.validationException;
      }
    } catch (e) {
      throw toProviderError(e);
    }
  }
}
