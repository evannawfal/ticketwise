import type pg from "pg";
import type { BudgetLimits, TakeResult, TokenBudget } from "../queue.js";

export const RATE_LIMIT_SQL = `
CREATE TABLE IF NOT EXISTS rate_buckets (
  name       text PRIMARY KEY,
  level      double precision NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);`;

interface Spec {
  name: string;
  capacity: number;
}

/**
 * Requests-per-minute and tokens-per-minute buckets kept in Postgres, so every
 * Lambda container (or server process) draws from the same budget. Each take
 * locks both rows in one transaction, refills them by elapsed time measured
 * on the database clock, and takes from both or from neither.
 */
export class PgBudget implements TokenBudget {
  private specs: Spec[];
  private tokens?: Spec;

  constructor(
    private pool: pg.Pool,
    limits: BudgetLimits,
    prefix = "llm",
  ) {
    this.specs = [];
    if (limits.requestsPerMinute) this.specs.push({ name: `${prefix}:requests`, capacity: limits.requestsPerMinute });
    if (limits.tokensPerMinute) {
      this.tokens = { name: `${prefix}:tokens`, capacity: limits.tokensPerMinute };
      this.specs.push(this.tokens);
    }
    this.specs.sort((a, b) => a.name.localeCompare(b.name)); // fixed lock order, no deadlocks
  }

  async tryTake(tokens: number): Promise<TakeResult> {
    if (!this.specs.length) return { ok: true };
    const cost = (s: Spec) => Math.min(s === this.tokens ? tokens : 1, s.capacity);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const s of this.specs) {
        await client.query(`INSERT INTO rate_buckets (name, level) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`, [s.name, s.capacity]);
      }
      const { rows } = await client.query<{ name: string; level: number; age: number }>(
        `SELECT name, level, EXTRACT(EPOCH FROM clock_timestamp() - updated_at) AS age
           FROM rate_buckets WHERE name = ANY($1) ORDER BY name FOR UPDATE`,
        [this.specs.map((s) => s.name)],
      );
      const now = new Map(
        rows.map((r) => {
          const s = this.specs.find((x) => x.name === r.name)!;
          return [r.name, Math.min(s.capacity, Number(r.level) + (Number(r.age) * s.capacity) / 60)];
        }),
      );
      const waitMs = Math.max(
        0,
        ...this.specs.map((s) => {
          const need = cost(s) - now.get(s.name)!;
          return need > 0 ? Math.ceil((need * 60_000) / s.capacity) : 0;
        }),
      );
      const ok = waitMs === 0;
      for (const s of this.specs) {
        await client.query(`UPDATE rate_buckets SET level = $2, updated_at = clock_timestamp() WHERE name = $1`, [
          s.name,
          now.get(s.name)! - (ok ? cost(s) : 0),
        ]);
      }
      await client.query("COMMIT");
      return ok ? { ok: true } : { ok: false, waitMs };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async adjust(tokens: number): Promise<void> {
    if (!this.tokens || !tokens) return;
    await this.pool.query(`UPDATE rate_buckets SET level = LEAST($2::float8, level + $3::float8) WHERE name = $1`, [
      this.tokens.name,
      this.tokens.capacity,
      tokens,
    ]);
  }
}
