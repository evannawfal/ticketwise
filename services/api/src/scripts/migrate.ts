import { migrate } from "@ticketwise/core/pg";
import { getApp } from "../config.js";

const app = await getApp();
await migrate(app.pool, app.config.embeddingDim);
console.log(`Schema ready (vector(${app.config.embeddingDim}))`);
await app.pool.end();
