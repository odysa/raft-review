// Token buckets stored in SQLite, so every process sharing the database
// enforces the same limits.

import { get, run, tx, type Db } from "./db.ts";

export interface Limiter {
  /** true when allowed; false when the caller should get 429. */
  take(key: string, cost?: number): boolean;
  retryAfterSeconds(key: string): number;
}

export function createLimiter(db: Db, opts: { name: string; capacity: number; perMinute: number }): Limiter {
  const refillPerMs = opts.perMinute / 60_000;
  let lastPrune = 0;
  const level = (key: string, now: number) => {
    const row = get<{ tokens: number; at: number }>(db, "SELECT tokens, at FROM rate_limits WHERE key = ?", key);
    return row ? Math.min(opts.capacity, row.tokens + (now - row.at) * refillPerMs) : opts.capacity;
  };
  return {
    take(raw, cost = 1) {
      const key = `${opts.name}:${raw}`;
      const now = Date.now();
      const allowed = tx(db, () => {
        const tokens = level(key, now);
        const ok = tokens >= cost;
        run(
          db,
          "INSERT INTO rate_limits (key, tokens, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET tokens = excluded.tokens, at = excluded.at",
          key, ok ? tokens - cost : tokens, now,
        );
        return ok;
      });
      if (now - lastPrune > 60_000) {
        lastPrune = now;
        // Buckets idle long enough to be full again carry no information.
        run(db, "DELETE FROM rate_limits WHERE at < ?", now - 60 * 60_000);
      }
      return allowed;
    },
    retryAfterSeconds(raw) {
      const tokens = level(`${opts.name}:${raw}`, Date.now());
      return Math.max(1, Math.ceil((1 - tokens) / refillPerMs / 1000));
    },
  };
}
