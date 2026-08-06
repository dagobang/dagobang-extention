export interface DexScreenerTokenRef {
  address: string;
  name?: string;
  symbol?: string;
}

export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  url?: string;
  pairAddress: string;
  labels?: string[];
  baseToken: DexScreenerTokenRef;
  quoteToken: DexScreenerTokenRef;
  priceNative?: string;
  priceUsd?: string;
  liquidity?: {
    usd?: number;
    base?: number;
    quote?: number;
  };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    websites?: Array<{ url?: string }>;
    socials?: Array<{ platform?: string; handle?: string }>;
  };
}

interface DexScreenerPairsResponse {
  schemaVersion?: string;
  pairs?: DexScreenerPair[] | null;
}

export class DexScreenerAPI {
  private static readonly BASE_URL = "https://api.dexscreener.com";
  private static readonly CACHE_TTL_MS = 30_000;
  private static readonly pairCache = new Map<string, { ts: number; value: DexScreenerPair | null }>();
  private static readonly tokenPairsCache = new Map<string, { ts: number; value: DexScreenerPair[] }>();

  private static getCacheKey(prefix: string, ...parts: Array<string | undefined>): string {
    return `${prefix}:${parts.map((part) => String(part || "").trim().toLowerCase()).join(":")}`;
  }

  private static getCachedPair(key: string): DexScreenerPair | null | undefined {
    const cached = this.pairCache.get(key);
    if (!cached) return undefined;
    if (Date.now() - cached.ts >= this.CACHE_TTL_MS) {
      this.pairCache.delete(key);
      return undefined;
    }
    return cached.value;
  }

  private static getCachedPairs(key: string): DexScreenerPair[] | undefined {
    const cached = this.tokenPairsCache.get(key);
    if (!cached) return undefined;
    if (Date.now() - cached.ts >= this.CACHE_TTL_MS) {
      this.tokenPairsCache.delete(key);
      return undefined;
    }
    return cached.value;
  }

  private static normalizeChain(chain: string): string {
    const normalized = String(chain || "bsc").trim().toLowerCase();
    return normalized === "bnb" ? "bsc" : normalized;
  }

  private static async getJson<T>(url: string): Promise<T> {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json, text/plain, */*",
      },
      credentials: "omit",
      mode: "cors",
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return await response.json() as T;
  }

  private static sortPairsByLiquidity<T extends DexScreenerPair>(pairs: T[]): T[] {
    return [...pairs].sort((a, b) => {
      const liquidityDiff = Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0);
      if (liquidityDiff !== 0) return liquidityDiff;
      const marketCapDiff = Number(b.marketCap ?? b.fdv ?? 0) - Number(a.marketCap ?? a.fdv ?? 0);
      if (marketCapDiff !== 0) return marketCapDiff;
      return Number(b.pairCreatedAt ?? 0) - Number(a.pairCreatedAt ?? 0);
    });
  }

  public static async getPairsByToken(chain: string, tokenAddress: string): Promise<DexScreenerPair[]> {
    const chainId = this.normalizeChain(chain);
    const cacheKey = this.getCacheKey("token", chainId, tokenAddress);
    const cached = this.getCachedPairs(cacheKey);
    if (cached) return cached;
    const url = `${this.BASE_URL}/token-pairs/v1/${chainId}/${tokenAddress}`;
    try {
      const result = await this.getJson<DexScreenerPair[] | null>(url);
      const pairs = Array.isArray(result) ? this.sortPairsByLiquidity(result) : [];
      this.tokenPairsCache.set(cacheKey, { ts: Date.now(), value: pairs });
      return pairs;
    } catch (error) {
      console.error("Failed to fetch DexScreener token pairs:", error);
      return [];
    }
  }

  public static async getPair(chain: string, pairAddress: string): Promise<DexScreenerPair | null> {
    const chainId = this.normalizeChain(chain);
    const cacheKey = this.getCacheKey("pair", chainId, pairAddress);
    const cached = this.getCachedPair(cacheKey);
    if (cached !== undefined) return cached;
    const url = `${this.BASE_URL}/latest/dex/pairs/${chainId}/${pairAddress}`;
    try {
      const result = await this.getJson<DexScreenerPairsResponse>(url);
      const pairs = Array.isArray(result?.pairs) ? result.pairs : [];
      const pair = pairs[0] ?? null;
      this.pairCache.set(cacheKey, { ts: Date.now(), value: pair });
      return pair;
    } catch (error) {
      console.error("Failed to fetch DexScreener pair:", error);
      return null;
    }
  }

  public static async getBestPairForToken(input: {
    chain: string;
    tokenAddress: string;
    quoteTokenAddress?: string;
    excludePairAddress?: string;
  }): Promise<DexScreenerPair | null> {
    const pairs = await this.getPairsByToken(input.chain, input.tokenAddress);
    const token = input.tokenAddress.toLowerCase();
    const quote = String(input.quoteTokenAddress || "").trim().toLowerCase();
    const excludePair = String(input.excludePairAddress || "").trim().toLowerCase();

    const filtered = pairs.filter((pair) => {
      if (this.normalizeChain(pair.chainId) !== this.normalizeChain(input.chain)) return false;
      if (!pair?.pairAddress) return false;
      if (excludePair && pair.pairAddress.toLowerCase() === excludePair) return false;

      const base = pair.baseToken?.address?.toLowerCase?.() ?? "";
      const pairQuote = pair.quoteToken?.address?.toLowerCase?.() ?? "";
      if (base !== token && pairQuote !== token) return false;
      if (quote && base !== quote && pairQuote !== quote) return false;
      return true;
    });

    return this.sortPairsByLiquidity(filtered)[0] ?? null;
  }

  public static async getBestPairBetweenTokens(chain: string, tokenA: string, tokenB: string): Promise<DexScreenerPair | null> {
    const [bestFromA, bestFromB] = await Promise.all([
      this.getBestPairForToken({ chain, tokenAddress: tokenA, quoteTokenAddress: tokenB }),
      this.getBestPairForToken({ chain, tokenAddress: tokenB, quoteTokenAddress: tokenA }),
    ]);
    return this.sortPairsByLiquidity([bestFromA, bestFromB].filter(Boolean) as DexScreenerPair[])[0] ?? null;
  }
}

export default DexScreenerAPI;
