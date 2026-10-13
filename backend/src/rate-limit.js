import { AppError } from './errors.js';

// One service replica in this milestone. A multi-replica deployment needs a shared
// limiter and a different database architecture; see SETUP.md.
export class RateLimiter {
  constructor(clock = Date.now) { this.clock = clock; this.buckets = new Map(); }

  take(key, limit, windowMs) {
    const now = this.clock();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.until <= now) {
      if (this.buckets.size >= 10_000) {
        for (const [oldKey, value] of this.buckets) if (value.until <= now) this.buckets.delete(oldKey);
      }
      if (this.buckets.size >= 10_000) throw new AppError(429, 'RATE_LIMITED', 'Please try again later.', { retryAfterSeconds: 60 });
      bucket = { used: 0, until: now + windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.used++;
    if (bucket.used > limit) throw new AppError(429, 'RATE_LIMITED', 'Please slow down.',
      { retryAfterSeconds: Math.ceil((bucket.until - now) / 1000) });
  }
}
