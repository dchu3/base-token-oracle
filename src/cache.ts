/**
 * Minimal in-memory LRU cache with TTL per entry.
 *
 * Uses the insertion-order property of `Map` to track recency:
 * - Touching a key on `get` re-inserts it so it becomes the most-recently used.
 * - On overflow, `Map.keys().next()` yields the least-recently used key.
 *
 * Entries that are expired at read time are evicted and reported as misses.
 * `getOrCompute` only caches successful resolutions — thrown errors are
 * rethrown without writing to the cache so we never memoize upstream failures.
 */
export interface TtlLruCacheOptions {
  ttlMs: number;
  max: number;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class TtlLruCache<V = unknown> {
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly store = new Map<string, Entry<V>>();
  private readonly now: () => number;

  constructor(options: TtlLruCacheOptions, now: () => number = Date.now) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error('TtlLruCache: ttlMs must be > 0');
    }
    if (!Number.isInteger(options.max) || options.max <= 0) {
      throw new Error('TtlLruCache: max must be a positive integer');
    }
    this.ttlMs = options.ttlMs;
    this.max = options.max;
    this.now = now;
  }

  size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  get(key: string): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    // Touch for LRU.
    this.store.delete(key);
    this.store.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V): void {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.store.size > this.max) {
      const oldest = this.store.keys().next();
      if (oldest.done) break;
      this.store.delete(oldest.value);
    }
  }

  async getOrCompute(key: string, compute: () => Promise<V>): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await compute();
    this.set(key, value);
    return value;
  }
}

export function createCacheFromEnv(env: NodeJS.ProcessEnv = process.env): TtlLruCache<unknown> {
  const ttlMs = Number(env.CACHE_TTL_MS ?? 45_000);
  return new TtlLruCache<unknown>({
    ttlMs: Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 45_000,
    max: 500,
  });
}
