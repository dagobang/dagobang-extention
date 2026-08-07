import { getQuoteTokenSymbol } from "@/constants/tokens";
import { getChainIdByName } from "@/constants/chains";

import { TokenInfo } from "@/types/token";
import DexScreenerAPI, { DexScreenerPair } from "./DexScreenerAPI";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

interface FlapCoinMetadata {
  description?: string;
  image?: string;
  buy?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  debox?: string | null;
  github?: string | null;
  youtube?: string | null;
}

export interface FlapCoinApiResponse {
  name: string;
  address: string;
  symbol: string;
  creator?: string;
  listed: boolean;
  mode?: number;
  r?: string;
  h?: string;
  k?: string;
  version?: string | number;
  dexThreshSupply?: string;
  reserve?: string;
  marketCap?: string;
  fdv?: string;
  supply?: string;
  calldata?: string | null;
  pool?: string | null;
  poolId?: string | null;
  createdAt?: number;
  quoteToken?: string | null;
  metadata?: FlapCoinMetadata;
  price?: string;
  holdersCount?: number;
  volume24h?: string;
  liquidity?: string;
  progress?: string;
  tax?: {
    hasTax?: boolean;
    buyTaxBps?: number;
    sellTaxBps?: number;
  } | null;
}

interface FlapGraphqlCoin {
  name: string;
  address: string;
  symbol: string;
  creator: string;
  meta: string;
  merged: boolean;
  messagesCount: number;
  sequence: number | null;
  listed: boolean;
  tax: string;
  mode: number;
  r: string;
  h: string;
  k: string;
  version: number;
  dexThreshSupply: string;
  reserve: string;
  marketcap: string;
  supply: string;
  calldata: string;
  pool: string;
  createdAt: number;
  quoteToken: string;
  metadata?: FlapCoinMetadata;
}

interface FlapTokenInfoResponse {
  data: {
    coin: FlapGraphqlCoin | null;
  };
}

export class FlapAPI {
  private static readonly GRAPHQL_URL = "https://0pi75kmgw9.execute-api.eu-west-3.amazonaws.com/v1";
  private static readonly TOKEN_INFO_CACHE_TTL_MS = 30_000;
  private static readonly COIN_API_HOSTS: Record<string, string> = {
    bsc: "https://bnb.taxed.fun",
    bnb: "https://bnb.taxed.fun",
  };
  private static readonly tokenInfoCache = new Map<string, { ts: number; value: TokenInfo | null }>();

  private static getTokenInfoCacheKey(chain: string, address: string): string {
    return `${this.normalizeChain(chain)}:${String(address || "").trim().toLowerCase()}`;
  }

  private static async makeRequest(url: string, options: RequestInit): Promise<Response> {
    const headers = { ...options.headers } as Record<string, string>;

    if (options.method === "POST" && options.body) {
      headers["content-length"] = new Blob([options.body as string]).size.toString();
    }

    return await fetch(url, {
      ...options,
      headers,
      credentials: "include",
      mode: "cors",
    });
  }

  private static getHeaders(): HeadersInit {
    return {
      accept: "application/json, text/plain, */*",
      "accept-encoding": "gzip, deflate, br, zstd",
      "accept-language": "zh-CN,zh;q=0.9,ru;q=0.8",
      "content-type": "application/json",
    };
  }

  private static normalizeChain(chain: string): string {
    const normalized = String(chain || "bsc").trim().toLowerCase();
    return normalized === "bnb" ? "bsc" : normalized;
  }

  private static resolveCoinApiBaseUrl(chain: string): string | null {
    return this.COIN_API_HOSTS[this.normalizeChain(chain)] ?? null;
  }

  private static toOptionalAddress(value?: string | null): string | undefined {
    const raw = String(value || "").trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) return undefined;
    if (raw.toLowerCase() === ZERO_ADDRESS.toLowerCase()) return undefined;
    return raw;
  }

  private static mapDexScreenerPairDexType(pair: DexScreenerPair | null): string | undefined {
    if (!pair) return undefined;
    const labels = Array.isArray(pair.labels) ? pair.labels.map((item) => String(item).toLowerCase()) : [];
    if (labels.some((item) => item.includes("v3") || item.includes("cl"))) {
      return "PANCAKE_SWAP_V3";
    }
    return "PANCAKE_SWAP";
  }

  private static async enrichWithDexScreener(input: {
    chain: string;
    address: string;
    tokenInfo: TokenInfo;
  }): Promise<TokenInfo> {
    const quoteTokenAddress = this.toOptionalAddress(input.tokenInfo.quote_token_address);
    if (!quoteTokenAddress || Number(input.tokenInfo.launchpad_status ?? 0) !== 1) {
      return input.tokenInfo;
    }

    const bestPair = await DexScreenerAPI.getBestPairForToken({
      chain: input.chain,
      tokenAddress: input.address,
      quoteTokenAddress,
      excludePairAddress: input.tokenInfo.flap_pool_compat_address,
    });
    if (!bestPair?.pairAddress) return input.tokenInfo;

    const pairAddress = this.toOptionalAddress(bestPair.pairAddress);
    if (!pairAddress) return input.tokenInfo;

    return {
      ...input.tokenInfo,
      // For migrated Flap tokens, prefer DexScreener's live pool over static coin.pool.
      pool_pair: pairAddress,
      biggest_pool_address: pairAddress,
      tpool_pool_address: pairAddress,
      dex_type: this.mapDexScreenerPairDexType(bestPair) || input.tokenInfo.dex_type,
    };
  }

  private static getQuoteTokenLabel(chain: string, quoteTokenAddress?: string): string {
    if (!quoteTokenAddress) return "BNB";
    const label = getQuoteTokenSymbol(getChainIdByName(this.normalizeChain(chain)), quoteTokenAddress);
    return label === "UNKNOWN" || label === "WBNB" ? "BNB" : label;
  }

  private static normalizeLaunchpadProgress(rawProgress?: string | number, supplyRaw?: string, dexThreshSupplyRaw?: string): number {
    const progress = Number(rawProgress);
    if (Number.isFinite(progress) && progress > 1) return Math.max(0, Math.min(1, progress / 100));
    if (Number.isFinite(progress) && progress >= 0) return Math.max(0, Math.min(1, progress));

    const supply = Number(supplyRaw);
    const dexThreshSupply = Number(dexThreshSupplyRaw);
    if (Number.isFinite(supply) && Number.isFinite(dexThreshSupply) && dexThreshSupply > 0) {
      return Math.max(0, Math.min(1, supply / dexThreshSupply));
    }
    return 0;
  }

  private static buildTokenInfo(chain: string, coin: FlapCoinApiResponse): TokenInfo {
    const chainNormalized = this.normalizeChain(chain);
    const metadata = coin.metadata || {};
    const quoteTokenAddress = this.toOptionalAddress(coin.quoteToken);
    const poolAddress = this.toOptionalAddress(coin.pool);
    const progress = this.normalizeLaunchpadProgress(coin.progress, coin.supply, coin.dexThreshSupply);

    return {
      chain: chainNormalized,
      address: coin.address,
      name: coin.name,
      symbol: coin.symbol,
      decimals: 18,
      logo: metadata.image || "",
      description: metadata.description || "",
      website: metadata.website || "",
      twitterUrl: metadata.twitter || "",
      telegramUrl: metadata.telegram || "",
      youtubeUrl: metadata.youtube || "",
      githubUrl: metadata.github || "",
      launchpad: "flap",
      launchpad_progress: progress,
      launchpad_platform: "flap",
      launchpad_status: coin.listed ? 1 : 0,
      quote_token: this.getQuoteTokenLabel(chainNormalized, quoteTokenAddress),
      quote_token_address: quoteTokenAddress,
      pool_pair: poolAddress,
      biggest_pool_address: poolAddress,
      tpool_pool_address: poolAddress,
      tpool_launch_type: coin.listed ? "migrated" : "launching",
      tokenVersion: Number(coin.version ?? 0) || undefined,
      tokenPrice: {
        price: String(coin.price ?? ""),
        marketCap: String(coin.marketCap ?? coin.fdv ?? ""),
        liquidity: String(coin.liquidity ?? ""),
        timestamp: Date.now(),
      },
      totalSupply: coin.supply ? String(coin.supply) : undefined,
      flap_pool_compat_address: poolAddress,
      flap_cl_pool_id: typeof coin.poolId === "string" && coin.poolId.trim() ? coin.poolId.trim() : undefined,
    };
  }

  private static buildQuery(): string {
    return `
      query Coin($address:String) {
        coin(address: $address) {
          name
          address
          symbol
          creator
          meta
          merged
          messagesCount
          sequence
          listed
          tax
          mode
          r(round: 3)
          h(round: 3)
          k(round: 3)
          version
          dexThreshSupply
          reserve(round: 18)
          marketcap(round: 18)
          supply(round: 18)
          calldata
          pool
          createdAt
          quoteToken
          metadata {
            description
            image
            buy
            website
            twitter
            telegram
          }
        }
      }
    `;
  }

  private static async getTokenInfoFromGraphql(chain: string, address: string): Promise<TokenInfo | null> {
    const payload = {
      query: this.buildQuery(),
      variables: {
        address: address.toLowerCase(),
        ticks: 60,
        interval: 3600000,
      },
    };

    const response = await this.makeRequest(this.GRAPHQL_URL, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = (await response.json()) as FlapTokenInfoResponse;
    const coin = result.data?.coin;
    if (!coin) return null;

    return this.buildTokenInfo(chain, {
      name: coin.name,
      address: coin.address,
      symbol: coin.symbol,
      creator: coin.creator,
      listed: coin.listed,
      mode: coin.mode,
      r: coin.r,
      h: coin.h,
      k: coin.k,
      version: coin.version,
      dexThreshSupply: coin.dexThreshSupply,
      reserve: coin.reserve,
      marketCap: coin.marketcap,
      supply: coin.supply,
      calldata: coin.calldata,
      pool: coin.pool,
      createdAt: coin.createdAt,
      quoteToken: coin.quoteToken,
      metadata: coin.metadata,
    });
  }

  public static async getCoin(chain: string, address: string, opts?: { refreshTag?: string | number }): Promise<FlapCoinApiResponse | null> {
    const baseUrl = this.resolveCoinApiBaseUrl(chain);
    if (!baseUrl) return null;

    const params = new URLSearchParams();
    if (opts?.refreshTag != null) {
      params.set("_refresh", String(opts.refreshTag));
    }
    const qs = params.toString();
    const url = `${baseUrl}/v3/coin/${address.toLowerCase()}${qs ? `?${qs}` : ""}`;

    try {
      const response = await this.makeRequest(url, {
        method: "GET",
        headers: this.getHeaders(),
      });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return await response.json() as FlapCoinApiResponse;
    } catch {
      return null;
    }
  }

  public static async getTokenInfo(chain: string, address: string): Promise<TokenInfo | null> {
    const cacheKey = this.getTokenInfoCacheKey(chain, address);
    const cached = this.tokenInfoCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.TOKEN_INFO_CACHE_TTL_MS) {
      return cached.value;
    }

    let tokenInfo: TokenInfo | null = null;
    const coin = await this.getCoin(chain, address);
    if (coin) {
      tokenInfo = this.buildTokenInfo(chain, coin);
    } else {
      try {
        tokenInfo = await this.getTokenInfoFromGraphql(chain, address);
      } catch (error) {
        console.error("Failed to fetch token info from Flap GraphQL fallback:", error);
        tokenInfo = null;
      }
    }

    if (tokenInfo) {
      tokenInfo = await this.enrichWithDexScreener({
        chain,
        address,
        tokenInfo,
      }).catch(() => tokenInfo);
    }

    this.tokenInfoCache.set(cacheKey, { ts: Date.now(), value: tokenInfo });
    return tokenInfo;
  }
}

export default FlapAPI;
