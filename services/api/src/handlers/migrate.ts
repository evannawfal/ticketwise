import { migrate } from "@ticketwise/core/pg";
import { getApp } from "../config.js";

/** Invoked once by the CDK deploy (custom resource) to create tables. */
export async function handler(): Promise<{ ok: true }> {
  const app = await getApp();
  await migrate(app.pool, app.config.embeddingDim);
  return { ok: true };
}
