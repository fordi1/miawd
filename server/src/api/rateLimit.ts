export interface RateLimitOptions {
  /** Tokens added per second (the steady request rate). */
  perSecond: number;
  /** Bucket size: how many requests may arrive at once. */
  burst: number;
  /** Time source in milliseconds (injectable for tests). */
  clock?: () => number;
}

export const DEFAULT_RATE_LIMIT = { perSecond: 20, burst: 40 };

export interface TakeResult {
  allowed: boolean;
  /** Whole requests left in the bucket. */
  remaining: number;
  /** Seconds until one more request is allowed (when denied). */
  retryAfterSec: number;
  /** Seconds until the bucket is full again. */
  resetSec: number;
}

/** A token bucket per key, in memory (one server process). */
export class TokenBuckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly clock: () => number;
  readonly perSecond: number;
  readonly burst: number;

  constructor(opts: RateLimitOptions) {
    this.perSecond = opts.perSecond;
    this.burst = opts.burst;
    this.clock = opts.clock ?? (() => performance.now());
  }

  take(key: string): TakeResult {
    const now = this.clock();
    const bucket = this.buckets.get(key) ?? { tokens: this.burst, at: now };
    bucket.tokens = Math.min(this.burst, bucket.tokens + ((now - bucket.at) / 1000) * this.perSecond);
    bucket.at = now;

    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    if (this.buckets.size > 5000) this.prune(now);

    return {
      allowed,
      remaining: Math.floor(bucket.tokens),
      retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil((1 - bucket.tokens) / this.perSecond)),
      resetSec: Math.ceil((this.burst - bucket.tokens) / this.perSecond),
    };
  }

  /** Forgets keys that have been idle long enough to be full again, so the map cannot grow forever. */
  private prune(now: number) {
    for (const [key, b] of this.buckets) if (now - b.at > 300_000) this.buckets.delete(key);
  }
}
