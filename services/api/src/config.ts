import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import {
  ExtractiveLlm,
  LocalHashEmbeddings,
  OpenAiEmbeddings,
  OpenAiLlm,
  MemoryBudget,
  RequestQueue,
  ResilientEmbeddings,
  ResilientLlm,
  APPROVED_MODES,
  SupportAssistant,
  tuningFor,
  type ApprovedMode,
  type EmbeddingProvider,
  type LlmProvider,
} from "@ticketwise/core";
import { BedrockEmbeddings, BedrockLlm } from "@ticketwise/core/bedrock";
import { PgBudget, PgVectorStore, createPool } from "@ticketwise/core/pg";
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
  approvedMode: ApprovedMode;
  approvedThreshold?: number;
  allowedOrigin: string;
  slackQueueUrl?: string;
  limits: LimitsConfig;
}

/** How model calls are queued and retried. See the README section "Many users at once". */
export interface LimitsConfig {
  maxConcurrent: number;
  requestsPerMinute: number;
  tokensPerMinute: number;
  maxQueue: number;
  queueTimeoutMs: number;
  maxRetries: number;
  /** Keep the budget in Postgres so every Lambda container shares one limit. */
  sharedBudget: boolean;
}

export function parseLimits(env: Record<string, string | undefined>): LimitsConfig {
  const num = (key: string, fallback: number, min: number) => {
    const raw = env[key];
    if (raw === undefined || raw === "") return fallback;
    const v = Number(raw);
    if (!Number.isInteger(v) || v < min) throw new Error(`${key} must be a whole number of at least ${min} (got "${raw}")`);
    return v;
  };
  return {
    maxConcurrent: num("LLM_MAX_CONCURRENT", 4, 1),
    requestsPerMinute: num("LLM_REQUESTS_PER_MINUTE", 50, 1),
    tokensPerMinute: num("LLM_TOKENS_PER_MINUTE", 100_000, 100),
    maxQueue: num("LLM_MAX_QUEUE", 100, 0),
    queueTimeoutMs: num("LLM_QUEUE_TIMEOUT_MS", 60_000, 1000),
    maxRetries: num("LLM_MAX_RETRIES", 4, 0),
    sharedBudget: env.LLM_SHARED_BUDGET === "1" || env.LLM_SHARED_BUDGET === "true",
  };
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
      approvedMode: parseApprovedMode(values.APPROVED_MODE),
      approvedThreshold: parseMinScore(values.APPROVED_THRESHOLD, "APPROVED_THRESHOLD"),
      allowedOrigin: values.ALLOWED_ORIGIN || "*",
      slackQueueUrl: values.SLACK_QUEUE_URL || undefined,
      limits: parseLimits(values),
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

export function parseMinScore(raw: string | undefined, name = "MIN_SCORE"): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error(`${name} must be between 0 and 1 (got "${raw}")`);
  return v;
}

export function parseApprovedMode(raw: string | undefined): ApprovedMode {
  const v = (raw || "prefer").toLowerCase();
  if (!(APPROVED_MODES as readonly string[]).includes(v)) throw new Error(`APPROVED_MODE must be off, prefer or only (got "${raw}")`);
  return v as ApprovedMode;
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
  queue: RequestQueue;
}

let cachedApp: Promise<App> | undefined;

export function getApp(): Promise<App> {
  cachedApp ??= (async () => {
    const config = await loadConfig();
    const pool = createPool(config.databaseUrl);
    const store = new PgVectorStore(pool);
    // Neural embeddings score related text higher than hashed keywords do,
    // so the cutoffs depend on the embedding provider.
    const tuning = tuningFor(config.embeddingProvider === "local" ? "local" : "neural");
    const { limits } = config;
    const budgetLimits = { requestsPerMinute: limits.requestsPerMinute, tokensPerMinute: limits.tokensPerMinute };
    const queue = new RequestQueue({
      maxConcurrent: limits.maxConcurrent,
      maxQueue: limits.maxQueue,
      timeoutMs: limits.queueTimeoutMs,
      budget: limits.sharedBudget ? new PgBudget(pool, budgetLimits) : new MemoryBudget(budgetLimits),
    });
    const retry = { maxRetries: limits.maxRetries };
    const assistant = new SupportAssistant({
      store,
      embeddings: new ResilientEmbeddings(makeEmbeddings(config), retry),
      llm: new ResilientLlm(makeLlm(config), { queue, retry }),
      ...tuning,
      minScore: config.minScore ?? tuning.minScore,
      approvedMode: config.approvedMode,
      approvedThreshold: config.approvedThreshold ?? tuning.approvedThreshold,
    });
    return { config, pool, store, assistant, queue };
  })();
  cachedApp.catch(() => (cachedApp = undefined));
  return cachedApp;
}
