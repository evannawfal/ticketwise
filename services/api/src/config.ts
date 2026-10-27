import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import {
  ExtractiveLlm,
  LocalHashEmbeddings,
  OpenAiEmbeddings,
  OpenAiLlm,
  SupportAssistant,
  type EmbeddingProvider,
  type LlmProvider,
} from "@ticketwise/core";
import { BedrockEmbeddings, BedrockLlm } from "@ticketwise/core/bedrock";
import { PgVectorStore, createPool } from "@ticketwise/core/pg";
import type pg from "pg";

export interface AppConfig {
  databaseUrl: string;
  adminToken: string;
  slackSigningSecret?: string;
  slackBotToken?: string;
  openaiApiKey?: string;
  llmProvider: "bedrock" | "openai" | "local";
  embeddingProvider: "bedrock" | "openai" | "local";
  embeddingDim: number;
  bedrockModelId?: string;
  openaiModel?: string;
  minScore?: number;
  allowedOrigin: string;
  slackQueueUrl?: string;
}

const SECRET_KEYS = ["DATABASE_URL", "ADMIN_TOKEN", "SLACK_SIGNING_SECRET", "SLACK_BOT_TOKEN", "OPENAI_API_KEY"] as const;

let cachedConfig: Promise<AppConfig> | undefined;

/**
 * Settings come from env vars. In Lambda, secrets live in one Secrets Manager
 * JSON secret (APP_SECRET_ARN) and are fetched once per container.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<AppConfig> {
  cachedConfig ??= (async () => {
    const values: Record<string, string | undefined> = { ...env };
    if (env.APP_SECRET_ARN) {
      const sm = new SecretsManagerClient({});
      const res = await sm.send(new GetSecretValueCommand({ SecretId: env.APP_SECRET_ARN }));
      const secret = JSON.parse(res.SecretString ?? "{}") as Record<string, string>;
      for (const k of SECRET_KEYS) if (secret[k]) values[k] = secret[k];
    }
    const provider = (v: string | undefined, fallback: AppConfig["llmProvider"]) => {
      const p = (v ?? fallback).toLowerCase();
      if (p !== "bedrock" && p !== "openai" && p !== "local") throw new Error(`unknown provider "${p}"`);
      return p;
    };
    if (!values.DATABASE_URL) throw new Error("DATABASE_URL is not set");
    if (!values.ADMIN_TOKEN || values.ADMIN_TOKEN.length < 12) {
      throw new Error("ADMIN_TOKEN must be set (12+ characters)");
    }
    return {
      databaseUrl: values.DATABASE_URL,
      adminToken: values.ADMIN_TOKEN,
      slackSigningSecret: values.SLACK_SIGNING_SECRET || undefined,
      slackBotToken: values.SLACK_BOT_TOKEN || undefined,
      openaiApiKey: values.OPENAI_API_KEY || undefined,
      llmProvider: provider(values.LLM_PROVIDER, "local"),
      embeddingProvider: provider(values.EMBEDDING_PROVIDER, "local"),
      embeddingDim: parseEmbeddingDim(values.EMBEDDING_DIM, values.EMBEDDING_PROVIDER),
      bedrockModelId: values.BEDROCK_MODEL_ID || undefined,
      openaiModel: values.OPENAI_MODEL || undefined,
      minScore: parseMinScore(values.MIN_SCORE),
      allowedOrigin: values.ALLOWED_ORIGIN || "*",
      slackQueueUrl: values.SLACK_QUEUE_URL || undefined,
    };
  })();
  cachedConfig.catch(() => (cachedConfig = undefined));
  return cachedConfig;
}

export function parseEmbeddingDim(raw: string | undefined, provider: string | undefined): number {
  const dim = Number(raw ?? 512);
  if (!Number.isInteger(dim) || dim < 1 || dim > 2000) {
    throw new Error(`EMBEDDING_DIM must be a whole number between 1 and 2000 (got "${raw}")`);
  }
  // Titan Text Embeddings V2 only returns these sizes.
  if ((provider ?? "").toLowerCase() === "bedrock" && ![256, 512, 1024].includes(dim)) {
    throw new Error(`EMBEDDING_DIM must be 256, 512 or 1024 for Bedrock Titan embeddings (got ${dim})`);
  }
  return dim;
}

export function parseMinScore(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error(`MIN_SCORE must be between 0 and 1 (got "${raw}")`);
  return v;
}

/** Only for tests. */
export function resetConfigCache(): void {
  cachedConfig = undefined;
  cachedApp = undefined;
}

function makeEmbeddings(cfg: AppConfig): EmbeddingProvider {
  switch (cfg.embeddingProvider) {
    case "bedrock":
      return new BedrockEmbeddings(cfg.embeddingDim);
    case "openai":
      if (!cfg.openaiApiKey) throw new Error("OPENAI_API_KEY is required for EMBEDDING_PROVIDER=openai");
      return new OpenAiEmbeddings({ apiKey: cfg.openaiApiKey }, cfg.embeddingDim);
    default:
      return new LocalHashEmbeddings(cfg.embeddingDim);
  }
}

function makeLlm(cfg: AppConfig): LlmProvider {
  switch (cfg.llmProvider) {
    case "bedrock":
      return new BedrockLlm(cfg.bedrockModelId);
    case "openai":
      if (!cfg.openaiApiKey) throw new Error("OPENAI_API_KEY is required for LLM_PROVIDER=openai");
      return new OpenAiLlm({ apiKey: cfg.openaiApiKey }, cfg.openaiModel);
    default:
      return new ExtractiveLlm();
  }
}

export interface App {
  config: AppConfig;
  pool: pg.Pool;
  store: PgVectorStore;
  assistant: SupportAssistant;
}

let cachedApp: Promise<App> | undefined;

export function getApp(): Promise<App> {
  cachedApp ??= (async () => {
    const config = await loadConfig();
    const pool = createPool(config.databaseUrl);
    const store = new PgVectorStore(pool);
    // Neural embeddings score related text higher than hashed keywords do,
    // so the relevance cutoff depends on the embedding provider.
    const local = config.embeddingProvider === "local";
    const minScore = config.minScore ?? (local ? 0.12 : 0.3);
    const assistant = new SupportAssistant({
      store,
      embeddings: makeEmbeddings(config),
      llm: makeLlm(config),
      minScore,
      minCoverage: local ? 0.3 : 0.1,
    });
    return { config, pool, store, assistant };
  })();
  cachedApp.catch(() => (cachedApp = undefined));
  return cachedApp;
}
