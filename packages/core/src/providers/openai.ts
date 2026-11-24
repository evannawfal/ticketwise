import { ProviderError, parseRetryAfter } from "../errors.js";
import { readSse } from "../sse.js";
import type { EmbeddingProvider, GenerateRequest, LlmChunk, LlmProvider } from "../types.js";

export interface OpenAiOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";

async function request(opts: OpenAiOptions, path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const f = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`${opts.baseUrl ?? "https://api.openai.com/v1"}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ProviderError(`OpenAI ${path} network error: ${(err as Error).message}`, 0);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderError(`OpenAI ${path} failed (${res.status}): ${text.slice(0, 300)}`, res.status, parseRetryAfter(res.headers));
  }
  return res;
}

export class OpenAiEmbeddings implements EmbeddingProvider {
  readonly name: string;
  constructor(
    private opts: OpenAiOptions,
    readonly dimensions = 512,
    private model = "text-embedding-3-small",
  ) {
    this.name = `openai:${model}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 96) {
      const batch = texts.slice(i, i + 96);
      const res = await request(this.opts, "/embeddings", { model: this.model, input: batch, dimensions: this.dimensions });
      const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
      json.data.sort((a, b) => a.index - b.index).forEach((d) => out.push(d.embedding));
    }
    return out;
  }
}

export class OpenAiLlm implements LlmProvider {
  readonly name: string;
  private model: string;
  constructor(
    private opts: OpenAiOptions,
    model?: string,
  ) {
    this.model = model || DEFAULT_OPENAI_MODEL;
    this.name = `openai:${this.model}`;
  }

  private body(req: GenerateRequest, stream: boolean) {
    // Reasoning models (gpt-5, o-series) only accept the default temperature.
    const fixedTemperature = /^(gpt-5|o\d)/.test(this.model);
    return {
      model: this.model,
      ...(fixedTemperature ? {} : { temperature: 0.2 }),
      max_completion_tokens: fixedTemperature ? 4000 : (req.maxTokens ?? 700),
      messages: [{ role: "system", content: req.system }, ...req.messages],
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    };
  }

  async generate(req: GenerateRequest): Promise<string> {
    const res = await request(this.opts, "/chat/completions", this.body(req, false));
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    return json.choices[0]?.message?.content?.trim() ?? "";
  }

  async *stream(req: GenerateRequest, signal?: AbortSignal): AsyncIterable<LlmChunk> {
    const res = await request(this.opts, "/chat/completions", this.body(req, true), signal);
    if (!res.body) throw new ProviderError("OpenAI returned an empty stream", 502);
    for await (const data of readSse(res.body)) {
      if (data === "[DONE]") break;
      const ev = JSON.parse(data) as {
        choices?: { delta?: { content?: string } }[];
        usage?: { prompt_tokens: number; completion_tokens: number } | null;
        error?: { message: string };
      };
      if (ev.error) throw new ProviderError(`OpenAI stream error: ${ev.error.message}`, 500);
      const text = ev.choices?.[0]?.delta?.content;
      if (text) yield { type: "text", text };
      if (ev.usage) yield { type: "usage", inputTokens: ev.usage.prompt_tokens, outputTokens: ev.usage.completion_tokens };
    }
  }
}
