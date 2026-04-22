import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { TtlLruCache } from '../src/cache.js';

describe('TtlLruCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores and retrieves values within TTL', () => {
    const cache = new TtlLruCache<string>({ ttlMs: 1000, max: 4 });
    cache.set('a', 'A');
    expect(cache.get('a')).toBe('A');
  });

  it('evicts expired entries on read', () => {
    const cache = new TtlLruCache<string>({ ttlMs: 1000, max: 4 });
    cache.set('a', 'A');
    vi.advanceTimersByTime(999);
    expect(cache.get('a')).toBe('A');
    vi.advanceTimersByTime(2);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it('LRU: evicts least-recently-used when exceeding max', () => {
    const cache = new TtlLruCache<number>({ ttlMs: 60_000, max: 3 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    // Touch 'a' so 'b' becomes LRU.
    expect(cache.get('a')).toBe(1);
    cache.set('d', 4);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });

  it('overwriting a key refreshes TTL and recency', () => {
    const cache = new TtlLruCache<number>({ ttlMs: 1000, max: 2 });
    cache.set('a', 1);
    vi.advanceTimersByTime(500);
    cache.set('a', 2);
    vi.advanceTimersByTime(600);
    // Original TTL would have expired; refreshed set survives.
    expect(cache.get('a')).toBe(2);
  });

  it('keys are isolated — no collisions across distinct keys', () => {
    const cache = new TtlLruCache<string>({ ttlMs: 1000, max: 10 });
    cache.set('market:0xabc', 'M');
    cache.set('honeypot:0xabc', 'H');
    cache.set('forensics:0xabc', 'F');
    cache.set('forensics:0xabc:0xpair', 'FP');
    expect(cache.get('market:0xabc')).toBe('M');
    expect(cache.get('honeypot:0xabc')).toBe('H');
    expect(cache.get('forensics:0xabc')).toBe('F');
    expect(cache.get('forensics:0xabc:0xpair')).toBe('FP');
  });

  it('getOrCompute computes on miss and caches; reuses on subsequent hits', async () => {
    const cache = new TtlLruCache<number>({ ttlMs: 1000, max: 4 });
    const fn = vi.fn(async () => 42);
    expect(await cache.getOrCompute('k', fn)).toBe(42);
    expect(await cache.getOrCompute('k', fn)).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('getOrCompute does NOT cache failures', async () => {
    const cache = new TtlLruCache<number>({ ttlMs: 1000, max: 4 });
    const fn = vi
      .fn<[], Promise<number>>()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce(7);
    await expect(cache.getOrCompute('k', fn)).rejects.toThrow('fail');
    expect(await cache.getOrCompute('k', fn)).toBe(7);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('rejects bad configuration', () => {
    expect(() => new TtlLruCache({ ttlMs: 0, max: 10 })).toThrow();
    expect(() => new TtlLruCache({ ttlMs: 10, max: 0 })).toThrow();
    expect(() => new TtlLruCache({ ttlMs: 10, max: 1.5 })).toThrow();
  });
});
