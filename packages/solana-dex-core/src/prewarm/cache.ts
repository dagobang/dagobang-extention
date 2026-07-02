export type WarmCacheEntry<T> = {
  promise: Promise<T>;
  expiresAt: number;
};

export const SOLANA_WARM_CACHE_TTL_MS = {
  staticAccount: 1_800_000,
  mediumContext: 60_000,
  dynamicQuote: 15_000,
  blockhash: 8_000,
  missingAccount: 30_000,
} as const;

export function rememberWarmPromise<T>(
  cache: Map<string, WarmCacheEntry<T>>,
  key: string,
  ttlMs: number,
  factory: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.promise;
  const promise = factory().catch((error) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, { promise, expiresAt: now + ttlMs });
  return promise;
}

export function refreshWarmPromise<T>(
  cache: Map<string, WarmCacheEntry<T>>,
  key: string,
  ttlMs: number,
  factory: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const promise = factory().catch((error) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, { promise, expiresAt: now + ttlMs });
  return promise;
}

export function getFreshWarmPromise<T>(
  cache: Map<string, WarmCacheEntry<T>>,
  key: string,
  now = Date.now(),
): Promise<T> | null {
  const cached = cache.get(key);
  if (!cached || cached.expiresAt <= now) return null;
  return cached.promise;
}
