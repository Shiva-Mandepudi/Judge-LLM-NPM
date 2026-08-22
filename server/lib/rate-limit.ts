// ponytail: per-instance in-memory token bucket, not cross-instance. This
// service has no Redis/Memorystore per requirements, and it's an internal
// batch tool (not user-facing), so slight over-admission across Cloud Run
// instances during a burst is an acceptable ceiling. Upgrade path if this
// ever matters: a DB-backed counter (eval_idempotency_keys-style table) with
// a windowed UPDATE ... RETURNING.
export class TokenBucketLimiter {
  private tokens: number;
  private lastRefillMs: number;

  constructor(private readonly maxPerMinute: number) {
    this.tokens = maxPerMinute;
    this.lastRefillMs = Date.now();
  }

  tryAcquire(): boolean {
    const now = Date.now();
    const elapsedMs = now - this.lastRefillMs;
    const refill = (elapsedMs / 60_000) * this.maxPerMinute;
    if (refill > 0) {
      this.tokens = Math.min(this.maxPerMinute, this.tokens + refill);
      this.lastRefillMs = now;
    }
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

const limiters = new Map<string, TokenBucketLimiter>();

export function getLimiter(key: string, maxPerMinute: number): TokenBucketLimiter {
  let limiter = limiters.get(key);
  if (!limiter) {
    limiter = new TokenBucketLimiter(maxPerMinute);
    limiters.set(key, limiter);
  }
  return limiter;
}
