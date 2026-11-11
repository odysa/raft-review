// In-memory token buckets keyed by client (IP or session). Enough for one
// instance; put a shared limiter in front if you run several.

export interface Limiter {
  /** true when allowed; false when the caller should get 429. */
  take(key: string, cost?: number): boolean;
  retryAfterSeconds(key: string): number;
}

export function createLimiter(opts: { capacity: number; perMinute: number }): Limiter {
  const buckets = new Map<string, { tokens: number; at: number }>();
  const refillPerMs = opts.perMinute / 60_000;
  const refill = (key: string) => {
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: opts.capacity, at: now };
    b.tokens = Math.min(opts.capacity, b.tokens + (now - b.at) * refillPerMs);
    b.at = now;
    buckets.set(key, b);
    if (buckets.size > 50_000) {
      // Drop idle full buckets.
      for (const [k, v] of buckets) if (v.tokens >= opts.capacity) buckets.delete(k);
    }
    return b;
  };
  return {
    take(key, cost = 1) {
      const b = refill(key);
      if (b.tokens < cost) return false;
      b.tokens -= cost;
      return true;
    },
    retryAfterSeconds(key) {
      const b = refill(key);
      return Math.max(1, Math.ceil((1 - b.tokens) / refillPerMs / 1000));
    },
  };
}
