import type { EmbeddingProvider, GenerateRequest, LlmProvider } from "../types.js";

export interface OpenAiOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

async function post<T>(opts: OpenAiOptions, path: string, body: unknown): Promise<T> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${opts.baseUrl ?? "https://api.openai.com/v1"}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
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
      const res = await post<{ data: { index: number; embedding: number[] }[] }>(this.opts, "/embeddings", {
        model: this.model,
        input: batch,
        dimensions: this.dimensions,
      });
      res.data.sort((a, b) => a.index - b.index).forEach((d) => out.push(d.embedding));
    }
    return out;
  }
}

export class OpenAiLlm implements LlmProvider {
  readonly name: string;
  constructor(
    private opts: OpenAiOptions,
    private model = "gpt-4o-mini",
  ) {
    this.name = `openai:${model}`;
  }

  async generate(req: GenerateRequest): Promise<string> {
    const res = await post<{ choices: { message: { content: string } }[] }>(this.opts, "/chat/completions", {
      model: this.model,
      temperature: 0.2,
      max_tokens: req.maxTokens ?? 700,
      messages: [{ role: "system", content: req.system }, ...req.messages],
    });
    return res.choices[0]?.message?.content?.trim() ?? "";
  }
}
