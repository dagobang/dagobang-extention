import { erc20Abi, pairV2Abi, poolV3Abi } from '@/constants/contracts/abi/swapAbi';
import { formatUnits, getAddress } from 'viem';
import type { TokenInfo } from '@/types/token';
import { ChainId } from '@/constants/chains';
import { bscTokens } from '@/constants/tokens/chains/bsc';
import { ethTokens } from '@/constants/tokens/chains/eth';
import { hyperTokens } from '@/constants/tokens/chains/hyper';

import { RpcService } from '../rpc';
import { TradeService } from '../trade';
import { SwapType } from '../trade/tradeTypes';
import { TokenFourmemeService } from './fourmeme';
import { TokenFlapService } from './flap';
import { getSolanaTokenPriceUsdFromQuote } from './solanaPrice';
import { isHyperAltfunPlatform, quoteHyperSellToUsdc } from '../trade/tradeHyper';
import { SolanaRpcService } from '@/services/chain/solana/rpc';
import type { ChainAddress } from '@/types/chain/address';
import { buildScopedTokenKey, normalizeAddressKey, normalizeWalletAddressKey } from '@/services/xSniper/engine/metrics';
import { classifyFlapRoute, normalizeFlapLaunchpadStatus, resolveFlapPlatform } from '@/utils/flap';
import DexScreenerAPI from '@/hooks/DexScreenerAPI';
import { chainNames } from '@/constants/chains/chainName';

type FlapRawQuoteTopology = {
  rawQuoteToken: `0x${string}`;
  quoteTokenInfo?: TokenInfo | null;
  terminalQuoteToken?: `0x${string}`;
  terminalPoolPair?: string;
  terminalPoolPrefer?: 'v2' | 'v3';
};

export class TokenService {
  private static poolPairCache = new Map<string, { token0: `0x${string}`; token1: `0x${string}` }>();
  private static nativeUsdCache = new Map<number, { ts: number; value: number }>();
  private static tokenUsdCache = new Map<string, { ts: number; value: number }>();
  private static flapSharedQuoteUsdCache = new Map<string, { ts: number; value: number }>();
  private static flapSharedQuoteUsdInFlight = new Map<string, Promise<number>>();
  private static flapRawQuoteTopologyCache = new Map<string, { ts: number; value: FlapRawQuoteTopology }>();
  private static flapRawQuoteTopologyInFlight = new Map<string, Promise<FlapRawQuoteTopology | null>>();
  private static readonly ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  private static readonly flapRawQuoteTopologyTtlMs = 30_000;
  private static readonly flapSharedQuoteUsdTtlMs = 15_000;
  private static flapOuterDirectQuoteCache = new Map<string, { ts: number; amountOut: bigint }>();
  private static readonly Q192 = (1n << 96n) * (1n << 96n);
  private static balanceCacheTtlMs = 1000;
  private static nativeBalanceCache = new Map<string, { ts: number; value: string }>();
  private static nativeBalanceInFlight = new Map<string, Promise<string>>();
  private static tokenBalanceCache = new Map<string, { ts: number; value: string }>();
  private static tokenBalanceInFlight = new Map<string, Promise<string>>();
  private static resolveBalanceCacheTtlMs(chainId?: number) {
    return chainId === ChainId.HYPER ? 3000 : this.balanceCacheTtlMs;
  }

  private static normalizeDexPrefer(dexType?: string | null): 'v2' | 'v3' | null {
    const raw = String(dexType || '').trim().toLowerCase();
    if (!raw) return null;
    if (raw.includes('v3') || raw.includes('cl')) return 'v3';
    if (raw.includes('v2') || raw.includes('swap')) return 'v2';
    return null;
  }

  private static pickUsablePoolAddress(
    tokenAddress: string,
    ...candidates: Array<string | undefined | null>
  ): string | undefined {
    const token = normalizeAddressKey(tokenAddress);
    for (const candidate of candidates) {
      const normalized = String(candidate || '').trim().toLowerCase();
      if (!/^0x[a-f0-9]{40}$/.test(normalized)) continue;
      if (normalized === this.ZERO_ADDRESS) continue;
      if (normalized === token) continue;
      return candidate ?? undefined;
    }
    return undefined;
  }

  private static resolveOuterPoolQuoteOpts(
    tokenAddress: string,
    tokenInfo?: Pick<TokenInfo,
      'address'
      | 'pool_pair'
      | 'biggest_pool_address'
      | 'tpool_pool_address'
      | 'dex_type'
      | 'flap_pool_model'
      | 'flap_pool_compat_address'
    > | null,
  ): { poolPair?: string; prefer?: 'v2' | 'v3' } {
    const poolPair = this.pickUsablePoolAddress(
      tokenAddress,
      tokenInfo?.pool_pair,
      tokenInfo?.biggest_pool_address,
      tokenInfo?.tpool_pool_address,
      tokenInfo?.flap_pool_model === 'infinity_cl' ? tokenInfo?.flap_pool_compat_address : undefined,
    );
    const prefer =
      this.normalizeDexPrefer(tokenInfo?.dex_type)
      ?? (tokenInfo?.flap_pool_model === 'infinity_cl' ? 'v3' : undefined)
      ?? (tokenInfo?.flap_pool_model === 'classic' ? 'v2' : undefined);
    return {
      poolPair,
      prefer,
    };
  }

  private static normalizeDexPreferFromDexScreenerPair(input?: {
    dexId?: string;
    labels?: string[];
    url?: string;
  } | null): 'v2' | 'v3' | null {
    const raw = [
      String(input?.dexId || ''),
      Array.isArray(input?.labels) ? input!.labels.join(' ') : '',
      String(input?.url || ''),
    ].join(' ').trim().toLowerCase();
    if (!raw) return null;
    if (raw.includes('v3') || raw.includes('cl')) return 'v3';
    if (raw.includes('v2')) return 'v2';
    return null;
  }

  private static async resolveFlapOuterDirectQuotePlan(input: {
    chainId: number;
    tokenAddress: string;
    rawQuoteToken: string;
    tokenInfo?: Pick<TokenInfo,
      'address'
      | 'pool_pair'
      | 'biggest_pool_address'
      | 'tpool_pool_address'
      | 'dex_type'
      | 'flap_pool_model'
      | 'flap_pool_compat_address'
    > | null;
  }): Promise<{ poolPair?: string; prefer?: 'v2' | 'v3' }> {
    const fallback = this.resolveOuterPoolQuoteOpts(input.tokenAddress, input.tokenInfo);
    if (fallback.poolPair) return fallback;

    let poolPair = fallback.poolPair;
    let prefer = fallback.prefer;
    const chain = String(chainNames[input.chainId as any] || '').trim().toLowerCase();
    if (chain) {
      const pair = await DexScreenerAPI.getBestPairBetweenTokens(chain, input.tokenAddress, input.rawQuoteToken).catch(() => null);
      if (pair?.pairAddress && /^0x[a-fA-F0-9]{40}$/.test(String(pair.pairAddress))) {
        poolPair = pair.pairAddress;
        prefer = this.normalizeDexPreferFromDexScreenerPair(pair) ?? prefer;
      }
    }
    return {
      poolPair,
      prefer,
    };
  }

  private static async resolveFlapRawQuoteTopology(input: {
    chainId: number;
    rawQuoteToken: string;
    anchorToken: string;
    resolveQuoteTokenInfo: (address: `0x${string}`) => Promise<TokenInfo | null>;
  }): Promise<FlapRawQuoteTopology | null> {
    const rawQuote = normalizeAddressKey(input.rawQuoteToken);
    if (!rawQuote || rawQuote === this.ZERO_ADDRESS) return null;
    const cacheKey = `${input.chainId}:${rawQuote}:flap_raw_quote_topology`;
    const cached = this.flapRawQuoteTopologyCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.flapRawQuoteTopologyTtlMs) {
      return cached.value;
    }
    const inFlight = this.flapRawQuoteTopologyInFlight.get(cacheKey);
    if (inFlight) return await inFlight;

    const task = (async () => {
      const topology: FlapRawQuoteTopology = {
        rawQuoteToken: input.rawQuoteToken as `0x${string}`,
        quoteTokenInfo: null,
        terminalQuoteToken: undefined as `0x${string}` | undefined,
        terminalPoolPair: undefined as string | undefined,
        terminalPoolPrefer: undefined as 'v2' | 'v3' | undefined,
      };
      topology.quoteTokenInfo = await input.resolveQuoteTokenInfo(input.rawQuoteToken as `0x${string}`).catch(() => null);
      const tradeTopology = await TradeService.resolveFlapStocksPricingTopology({
        chainId: input.chainId,
        rawQuoteToken: input.rawQuoteToken as `0x${string}`,
        anchorToken: input.anchorToken as `0x${string}`,
      }).catch(() => null);
      if (tradeTopology?.rawQuotePoolAddress) {
        topology.terminalQuoteToken = tradeTopology.terminalQuoteToken as `0x${string}`;
        topology.terminalPoolPair = tradeTopology.rawQuotePoolAddress;
        topology.terminalPoolPrefer = tradeTopology.rawQuotePoolPrefer ?? undefined;
      }
      if (topology.quoteTokenInfo || topology.terminalPoolPair) {
        this.flapRawQuoteTopologyCache.set(cacheKey, { ts: Date.now(), value: topology });
        return topology;
      }
      return null;
    })().finally(() => {
      this.flapRawQuoteTopologyInFlight.delete(cacheKey);
    });
    this.flapRawQuoteTopologyInFlight.set(cacheKey, task);
    return await task;
  }

  private static async getFlapSharedQuoteUsd(input: {
    chainId: number;
    tokenAddress: `0x${string}`;
    tokenInfo?: TokenInfo | null;
    allowTokenInfoPriceFallback?: boolean;
    cacheTtlMs?: number;
  }): Promise<number> {
    const tokenKey = normalizeAddressKey(input.tokenAddress);
    if (!tokenKey || tokenKey === this.ZERO_ADDRESS) return 0;
    const cacheKey = `${input.chainId}:${tokenKey}`;
    const ttlMs = Math.max(
      this.flapSharedQuoteUsdTtlMs,
      Number(input.cacheTtlMs ?? 0),
    );
    const cached = this.flapSharedQuoteUsdCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < ttlMs) {
      return cached.value;
    }
    const inFlight = this.flapSharedQuoteUsdInFlight.get(cacheKey);
    if (inFlight) return await inFlight;

    const task = (async () => {
      const priceUsd = await this.getPriceUsdFromRpc({
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        tokenInfo: input.tokenInfo,
        cacheTtlMs: ttlMs,
        allowTokenInfoPriceFallback: input.allowTokenInfoPriceFallback,
      }).catch(() => 0);
      if (priceUsd > 0) {
        this.flapSharedQuoteUsdCache.set(cacheKey, { ts: Date.now(), value: priceUsd });
      } else {
        this.flapSharedQuoteUsdCache.delete(cacheKey);
      }
      return priceUsd;
    })().finally(() => {
      this.flapSharedQuoteUsdInFlight.delete(cacheKey);
    });
    this.flapSharedQuoteUsdInFlight.set(cacheKey, task);
    return await task;
  }

  private static async quoteV2ExactInByKnownPair(input: {
    chainId: number;
    pair: `0x${string}`;
    tokenIn: `0x${string}`;
    tokenOut: `0x${string}`;
    amountIn: bigint;
    cacheTtlMs?: number;
  }): Promise<bigint> {
    const ttlMs = Math.max(0, Number(input.cacheTtlMs ?? 0));
    const cacheKey = [
      input.chainId,
      input.pair.toLowerCase(),
      input.tokenIn.toLowerCase(),
      input.tokenOut.toLowerCase(),
      input.amountIn.toString(),
    ].join(':');
    const cached = this.flapOuterDirectQuoteCache.get(cacheKey);
    if (ttlMs > 0 && cached && Date.now() - cached.ts < ttlMs) {
      return cached.amountOut;
    }

    const tokenInAddr = getAddress(input.tokenIn);
    const tokenOutAddr = getAddress(input.tokenOut);
    const [token0, token1, reserves] = await RpcService.withBalancedReadClient({
      chainId: input.chainId,
      caller: 'token.flapOuterV2SpotQuote',
      run: async (client) => await Promise.all([
        client.readContract({
          address: input.pair,
          abi: pairV2Abi,
          functionName: 'token0',
        }) as Promise<`0x${string}`>,
        client.readContract({
          address: input.pair,
          abi: pairV2Abi,
          functionName: 'token1',
        }) as Promise<`0x${string}`>,
        client.readContract({
          address: input.pair,
          abi: pairV2Abi,
          functionName: 'getReserves',
        }) as Promise<[bigint, bigint, number]>,
      ]),
    });

    if (
      (token0.toLowerCase() !== tokenInAddr.toLowerCase() && token0.toLowerCase() !== tokenOutAddr.toLowerCase()) ||
      (token1.toLowerCase() !== tokenInAddr.toLowerCase() && token1.toLowerCase() !== tokenOutAddr.toLowerCase())
    ) {
      return 0n;
    }

    const reserve0 = BigInt(reserves[0]);
    const reserve1 = BigInt(reserves[1]);
    const isToken0In = token0.toLowerCase() === tokenInAddr.toLowerCase();
    const reserveIn = isToken0In ? reserve0 : reserve1;
    const reserveOut = isToken0In ? reserve1 : reserve0;
    if (reserveIn <= 0n || reserveOut <= 0n) return 0n;

    const feeBps = 25n;
    const amountInWithFee = input.amountIn * (10000n - feeBps);
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn * 10000n + amountInWithFee;
    const amountOut = denominator > 0n ? numerator / denominator : 0n;
    if (ttlMs > 0 && amountOut > 0n) {
      this.flapOuterDirectQuoteCache.set(cacheKey, { ts: Date.now(), amountOut });
    }
    return amountOut;
  }

  private static async quoteV3ExactInByKnownPool(input: {
    chainId: number;
    pool: `0x${string}`;
    tokenIn: `0x${string}`;
    tokenOut: `0x${string}`;
    amountIn: bigint;
    cacheTtlMs?: number;
  }): Promise<bigint> {
    const ttlMs = Math.max(0, Number(input.cacheTtlMs ?? 0));
    const cacheKey = [
      input.chainId,
      input.pool.toLowerCase(),
      input.tokenIn.toLowerCase(),
      input.tokenOut.toLowerCase(),
      input.amountIn.toString(),
      'v3',
    ].join(':');
    const cached = this.flapOuterDirectQuoteCache.get(cacheKey);
    if (ttlMs > 0 && cached && Date.now() - cached.ts < ttlMs) {
      return cached.amountOut;
    }

    const tokenInAddr = getAddress(input.tokenIn);
    const tokenOutAddr = getAddress(input.tokenOut);
    const [token0, token1, fee, slot0] = await RpcService.withBalancedReadClient({
      chainId: input.chainId,
      caller: 'token.flapOuterV3SpotQuote',
      run: async (client) => await Promise.all([
        client.readContract({
          address: input.pool,
          abi: pairV2Abi,
          functionName: 'token0',
        }) as Promise<`0x${string}`>,
        client.readContract({
          address: input.pool,
          abi: pairV2Abi,
          functionName: 'token1',
        }) as Promise<`0x${string}`>,
        client.readContract({
          address: input.pool,
          abi: poolV3Abi,
          functionName: 'fee',
        }) as Promise<number>,
        client.readContract({
          address: input.pool,
          abi: poolV3Abi,
          functionName: 'slot0',
        }) as Promise<[bigint, number, number, number, number, number, boolean]>,
      ]),
    });

    if (
      (token0.toLowerCase() !== tokenInAddr.toLowerCase() && token0.toLowerCase() !== tokenOutAddr.toLowerCase()) ||
      (token1.toLowerCase() !== tokenInAddr.toLowerCase() && token1.toLowerCase() !== tokenOutAddr.toLowerCase())
    ) {
      return 0n;
    }

    const sqrtPriceX96 = BigInt(slot0[0] ?? 0n);
    if (sqrtPriceX96 <= 0n) return 0n;
    const priceX192 = sqrtPriceX96 * sqrtPriceX96;
    if (priceX192 <= 0n) return 0n;

    const feePpm = BigInt(Math.max(0, Number(fee ?? 0)));
    const amountInAfterFee = input.amountIn * (1_000_000n - feePpm) / 1_000_000n;
    if (amountInAfterFee <= 0n) return 0n;

    let amountOut = 0n;
    if (token0.toLowerCase() === tokenInAddr.toLowerCase()) {
      amountOut = amountInAfterFee * priceX192 / this.Q192;
    } else if (token1.toLowerCase() === tokenInAddr.toLowerCase()) {
      if (priceX192 <= 0n) return 0n;
      amountOut = amountInAfterFee * this.Q192 / priceX192;
    }

    if (ttlMs > 0 && amountOut > 0n) {
      this.flapOuterDirectQuoteCache.set(cacheKey, { ts: Date.now(), amountOut });
    }
    return amountOut;
  }

  static async getMeta(tokenAddress: string, chainId: number) {
    if (chainId === ChainId.SOL) {
      return await SolanaRpcService.getMintMeta(tokenAddress);
    }
    return await RpcService.withBalancedReadClient({
      chainId,
      caller: 'token.meta',
      run: async (client) => {
        const [symbol, decimals] = await Promise.all([
          client.readContract({ address: tokenAddress as `0x${string}`, abi: erc20Abi, functionName: 'symbol' }),
          client.readContract({ address: tokenAddress as `0x${string}`, abi: erc20Abi, functionName: 'decimals' }),
        ]);
        return { symbol, decimals };
      },
    });
  }

  static async getBalance(tokenAddress: string, owner: string, chainId?: number) {
    const now = Date.now();
    const resolvedChainId = typeof chainId === 'number' && Number.isFinite(chainId) ? chainId : undefined;
    const ttlMs = this.resolveBalanceCacheTtlMs(resolvedChainId);
    const key = `${resolvedChainId ?? 'default'}:${normalizeWalletAddressKey(owner)}:${buildScopedTokenKey(resolvedChainId, tokenAddress)}`;
    const cached = this.tokenBalanceCache.get(key);
    if (cached && now - cached.ts < ttlMs) return cached.value;
    const inFlight = this.tokenBalanceInFlight.get(key);
    if (inFlight) return inFlight;
    const p = (async () => {
      try {
        if (resolvedChainId === ChainId.SOL) {
          const balance = await SolanaRpcService.getSplTokenBalance(owner, tokenAddress);
          const v = balance.toString();
          this.tokenBalanceCache.set(key, { ts: Date.now(), value: v });
          return v;
        }
        const balance = await RpcService.withBalancedReadClient({
          chainId: resolvedChainId,
          caller: 'token.erc20Balance',
          run: async (client) => {
            return await client.readContract({
              address: tokenAddress as `0x${string}`,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [owner as `0x${string}`],
            });
          },
        });
        const v = balance.toString();
        this.tokenBalanceCache.set(key, { ts: Date.now(), value: v });
        return v;
      } catch (error) {
        // Preserve the last successful on-chain balance during transient RPC failures
        // so SOL sellability does not collapse to zero on a single refresh miss.
        if (cached?.value != null) {
          return cached.value;
        }
        throw error;
      }
    })().finally(() => {
      this.tokenBalanceInFlight.delete(key);
    });
    this.tokenBalanceInFlight.set(key, p);
    return p;
  }

  static async getAllowance(tokenAddress: string, owner: string, spender: string, chainId: number) {
    const allowance = await RpcService.withBalancedReadClient({
      chainId,
      caller: 'token.allowance',
      run: async (client) => {
        return await client.readContract({
          address: tokenAddress as `0x${string}`,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [owner as `0x${string}`, spender as `0x${string}`],
        });
      },
    });
    return allowance.toString();
  }

  static async getNativeBalance(owner: string, chainId?: number) {
    const now = Date.now();
    const resolvedChainId = typeof chainId === 'number' && Number.isFinite(chainId) ? chainId : undefined;
    const ttlMs = this.resolveBalanceCacheTtlMs(resolvedChainId);
    const key = `${resolvedChainId ?? 'default'}:${owner.toLowerCase()}`;
    const cached = this.nativeBalanceCache.get(key);
    if (cached && now - cached.ts < ttlMs) return cached.value;
    const inFlight = this.nativeBalanceInFlight.get(key);
    if (inFlight) return inFlight;

    const p = (async () => {
      if (resolvedChainId === ChainId.SOL) {
        const balance = await SolanaRpcService.getNativeBalanceLamports(owner);
        const v = balance.toString();
        this.nativeBalanceCache.set(key, { ts: Date.now(), value: v });
        return v;
      }
      const balance = await RpcService.withBalancedReadClient({
        chainId: resolvedChainId,
        caller: 'token.nativeBalance',
        run: async (client) => {
          return await client.getBalance({ address: owner as `0x${string}` });
        },
      });
      const v = balance.toString();
      this.nativeBalanceCache.set(key, { ts: Date.now(), value: v });
      return v;
    })().finally(() => {
      this.nativeBalanceInFlight.delete(key);
    });
    this.nativeBalanceInFlight.set(key, p);
    return p;
  }

  static async getPoolPair(pair: string, chainId: number) {
    const key = `${chainId}:${pair.toLowerCase()}`;
    const cached = this.poolPairCache.get(key);
    if (cached) {
      return cached;
    }

    const [token0, token1] = await RpcService.withBalancedReadClient({
      chainId,
      caller: 'token.poolPair',
      run: async (client) => {
        return await Promise.all([
          client.readContract({
            address: pair as `0x${string}`,
            abi: pairV2Abi,
            functionName: 'token0',
          }) as Promise<`0x${string}`>,
          client.readContract({
            address: pair as `0x${string}`,
            abi: pairV2Abi,
            functionName: 'token1',
          }) as Promise<`0x${string}`>,
        ]);
      },
    });
    const result = { token0, token1 };
    this.poolPairCache.set(key, result);
    return result;
  }

  static async getTokenPriceUsdFromRpc(input: {
    chainId: number;
    tokenAddress: ChainAddress;
    tokenInfo?: TokenInfo | null;
    cacheTtlMs?: number;
    allowTokenInfoPriceFallback?: boolean;
  }): Promise<number> {
    return this.getPriceUsdFromRpc(input);
  }

  static async getPriceUsdFromRpc(input: {
    chainId: number;
    tokenAddress: ChainAddress;
    tokenInfo?: TokenInfo | null;
    cacheTtlMs?: number;
    allowTokenInfoPriceFallback?: boolean;
  }): Promise<number> {
    const { chainId, tokenAddress, tokenInfo, cacheTtlMs, allowTokenInfoPriceFallback } = input;
    const now = Date.now();
    const ttl = typeof cacheTtlMs === 'number' && cacheTtlMs >= 0 ? cacheTtlMs : 0;
    const key = `${chainId}:${String(tokenAddress).toLowerCase()}`;
    const cached = this.tokenUsdCache.get(key);
    if (ttl > 0 && cached && now - cached.ts < ttl) return cached.value;

    if (chainId === ChainId.SOL) {
      let priceUsd = 0;
      try {
        priceUsd = await getSolanaTokenPriceUsdFromQuote({
          tokenAddress: String(tokenAddress),
          tokenInfo,
          cacheTtlMs: ttl,
        });
      } catch (e) {
        console.error('getTokenPriceUsdFromRpc: failed to get token price from solana quote', e);
      }
      if (
        !(priceUsd > 0) &&
        allowTokenInfoPriceFallback !== false
      ) {
        const fromTokenInfo = Number(
          (tokenInfo as any)?.priceUsd
          ?? (tokenInfo as any)?.price
          ?? (tokenInfo as any)?.tokenPrice?.price
          ?? 0
        );
        if (Number.isFinite(fromTokenInfo) && fromTokenInfo > 0) {
          priceUsd = fromTokenInfo;
        }
      }
      if (priceUsd > 0) {
        this.tokenUsdCache.set(key, { ts: now, value: priceUsd });
        return priceUsd;
      }
      throw new Error('Solana RPC price unavailable');
    }

    const toNumberFromUnits = (amount: bigint, decimals: number) => {
      const s = formatUnits(amount, decimals);
      const n = Number(s);
      if (Number.isFinite(n)) return n;
      const f = parseFloat(s);
      return Number.isFinite(f) ? f : 0;
    };

    const isEth = chainId === ChainId.ETH;
    const isHyper = chainId === ChainId.HYPER;
    const wNativeAddress = (isEth
      ? ethTokens.weth.address
      : isHyper
        ? hyperTokens.whype.address
        : bscTokens.wbnb.address) as `0x${string}`;
    const wNativeDecimals = isEth ? ethTokens.weth.decimals : isHyper ? hyperTokens.whype.decimals : bscTokens.wbnb.decimals;
    const usdtToken = isEth ? ethTokens.usdt : isHyper ? null : bscTokens.usdt;
    const usdcToken = isHyper ? hyperTokens.usdc : isEth ? ethTokens.usdc : bscTokens.usdc;
    const stableByAddress = new Map<string, { address: `0x${string}`; decimals: number }>();
    if (usdtToken) {
      stableByAddress.set(usdtToken.address.toLowerCase(), { address: usdtToken.address as `0x${string}`, decimals: usdtToken.decimals });
    }
    stableByAddress.set(usdcToken.address.toLowerCase(), { address: usdcToken.address as `0x${string}`, decimals: usdcToken.decimals });
    if (!isEth && !isHyper) {
      stableByAddress.set(bscTokens.busd.address.toLowerCase(), { address: bscTokens.busd.address as `0x${string}`, decimals: bscTokens.busd.decimals });
      stableByAddress.set(bscTokens.usd1.address.toLowerCase(), { address: bscTokens.usd1.address as `0x${string}`, decimals: bscTokens.usd1.decimals });
    }

    const getNativePriceUsd = async () => {
      const now2 = Date.now();
      const nativeCached = this.nativeUsdCache.get(chainId);
      if (nativeCached && nativeCached.value > 0 && now2 - nativeCached.ts < 30_000) return nativeCached.value;
      const amountOut = (await TradeService.quoteBestExactIn(
        chainId,
        wNativeAddress as `0x${string}`,
        usdcToken.address as `0x${string}`,
        10n ** 18n,
        isHyper
          ? { v3Fee: 3000, prefer: 'v3' }
          : { v3Fee: 500 }
      )).amountOut;
      const v = amountOut > 0n ? toNumberFromUnits(amountOut, usdcToken.decimals) : 0;
      if (v > 0) {
        this.nativeUsdCache.set(chainId, { ts: now2, value: v });
      }
      return v;
    };

    const quoteByFixedFlapOuterSellRouteToUsd = async (pricingTokenAddress: `0x${string}`): Promise<number> => {
      const candidateTargets = [
        ...(Array.from(stableByAddress.values()).map((item) => item.address)),
        wNativeAddress as `0x${string}`,
      ].filter((value, index, list) =>
        list.findIndex((item) => item.toLowerCase() === value.toLowerCase()) === index,
      );

      logFlapOuterPricing('info', 'fixed_route.start', {
        pricingTokenAddress,
        candidateTargets,
        oneToken: oneToken.toString(),
      });
      for (const targetToken of candidateTargets) {
        const routeDescs = await TradeService.buildFlapOuterSellPricingRoute({
          chainId,
          currentToken: pricingTokenAddress,
          targetToken,
        }).catch(() => null);
        if (!routeDescs?.length) {
          logFlapOuterPricing('warn', 'fixed_route.missing', { targetToken });
          continue;
        }

        logFlapOuterPricing('info', 'fixed_route.route', {
          targetToken,
          routeLength: routeDescs.length,
          route: routeDescs.map((desc, index) => ({
            index,
            swapType: desc.swapType,
            tokenIn: desc.tokenIn,
            tokenOut: desc.tokenOut,
            poolAddress: desc.poolAddress,
            fee: desc.fee,
          })),
        });

        let currentAmount = oneToken;
        let finalToken = pricingTokenAddress;
        for (const [index, desc] of routeDescs.entries()) {
          const amountInBefore = currentAmount;
          const tokenInAddr = (String(desc.tokenIn).toLowerCase() === this.ZERO_ADDRESS
            ? wNativeAddress
            : desc.tokenIn) as `0x${string}`;
          const tokenOutAddr = (String(desc.tokenOut).toLowerCase() === this.ZERO_ADDRESS
            ? wNativeAddress
            : desc.tokenOut) as `0x${string}`;
          if (desc.swapType === SwapType.V2_EXACT_IN) {
            currentAmount = await this.quoteV2ExactInByKnownPair({
              chainId,
              pair: desc.poolAddress as `0x${string}`,
              tokenIn: tokenInAddr,
              tokenOut: tokenOutAddr,
              amountIn: currentAmount,
              cacheTtlMs: ttl,
            });
          } else if (desc.swapType === SwapType.V3_EXACT_IN) {
            currentAmount = await this.quoteV3ExactInByKnownPool({
              chainId,
              pool: desc.poolAddress as `0x${string}`,
              tokenIn: tokenInAddr,
              tokenOut: tokenOutAddr,
              amountIn: currentAmount,
              cacheTtlMs: ttl,
            });
          } else {
            currentAmount = 0n;
          }
          logFlapOuterPricing(currentAmount > 0n ? 'info' : 'warn', 'fixed_route.step', {
            targetToken,
            stepIndex: index,
            swapType: desc.swapType,
            tokenIn: tokenInAddr,
            tokenOut: tokenOutAddr,
            poolAddress: desc.poolAddress,
            amountIn: amountInBefore.toString(),
            amountOut: currentAmount.toString(),
          });
          if (currentAmount <= 0n) break;
          finalToken = tokenOutAddr;
        }

        if (currentAmount <= 0n) {
          logFlapOuterPricing('warn', 'fixed_route.zero_out', {
            targetToken,
            finalToken,
          });
          continue;
        }
        const finalTokenLower = finalToken.toLowerCase();
        const stable = stableByAddress.get(finalTokenLower);
        if (stable) {
          const stableAmount = toNumberFromUnits(currentAmount, stable.decimals);
          if (stableAmount > 0) {
            logFlapOuterPricing('info', 'fixed_route.resolved_stable', {
              targetToken,
              finalToken,
              amountOut: currentAmount.toString(),
              stableAmount,
            });
            return stableAmount;
          }
          continue;
        }
        if (finalTokenLower === wNativeAddress.toLowerCase()) {
          const nativeAmount = toNumberFromUnits(currentAmount, wNativeDecimals);
          const nativeUsd = await getNativePriceUsd();
          if (nativeAmount > 0 && nativeUsd > 0) {
            const resolvedPriceUsd = nativeAmount * nativeUsd;
            logFlapOuterPricing('info', 'fixed_route.resolved_native', {
              targetToken,
              finalToken,
              amountOut: currentAmount.toString(),
              nativeAmount,
              nativeUsd,
              resolvedPriceUsd,
            });
            return resolvedPriceUsd;
          }
        }
      }

      logFlapOuterPricing('warn', 'fixed_route.unresolved', {});
      return 0;
    };

    const buildFlapTokenInfoForPricing = async (address: `0x${string}`): Promise<TokenInfo | null> => {
      try {
        const [contractInfo, meta] = await Promise.all([
          TokenFlapService.getTokenInfo(chainId, address),
          this.getMeta(address, chainId),
        ]);
        const decimals = Number(meta?.decimals ?? 18);
        const supplyText = (() => {
          try {
            return formatUnits(BigInt(contractInfo.circulatingSupply || '0'), decimals);
          } catch {
            return undefined;
          }
        })();
        const draft: TokenInfo = {
          chain: chainId === ChainId.BNB ? 'bsc' : String(chainId),
          address,
          name: '',
          symbol: String(meta?.symbol ?? ''),
          decimals,
          logo: '',
          launchpad: 'flap',
          launchpad_progress: Number(contractInfo.progress ?? 0),
          launchpad_platform: 'flap',
          launchpad_status: Number(contractInfo.status ?? 0),
          quote_token: '',
          quote_token_address: contractInfo.quoteTokenAddress || '',
          pool_pair: contractInfo.poolModel === 'classic' ? contractInfo.pool || '' : '',
          biggest_pool_address: contractInfo.poolModel === 'classic' ? contractInfo.pool || '' : '',
          tpool_pool_address: contractInfo.poolModel === 'classic' ? contractInfo.pool || '' : '',
          dex_type: 'flap',
          totalSupply: supplyText,
          nativeToQuoteSwapEnabled: contractInfo.nativeToQuoteSwapEnabled,
          tokenVersion: contractInfo.tokenVersion,
          extensionID: contractInfo.extensionID,
          dexId: contractInfo.dexId,
          flap_lp_fee_profile: contractInfo.lpFeeProfile,
          flap_pool_model: contractInfo.poolModel,
          flap_pool_compat_address: contractInfo.poolCompatAddress,
          flap_cl_pool_id: contractInfo.clPoolId,
          flap_v4_fee: contractInfo.v4Fee,
          flap_v4_tick_spacing: contractInfo.v4TickSpacing,
          flap_v4_hooks: contractInfo.v4Hooks,
          flap_dividend_token: contractInfo.dividendToken,
          flap_vault_address: contractInfo.vaultAddress,
          flap_vault_factory: contractInfo.vaultFactory,
          flap_vault_is_official: contractInfo.vaultIsOfficial,
            flap_vault_is_vault: contractInfo.vaultIsVault,
          flap_vault_is_ai_consumer: contractInfo.vaultIsAIConsumer,
          flap_stocks_vault_version: contractInfo.stocksVaultVersion,
          flap_basket_token: contractInfo.basketToken,
          flap_supported_assets: contractInfo.supportedAssets,
          tokenPrice: {
            price: '0',
            marketCap: '0',
            timestamp: Date.now(),
          },
        };
        draft.launchpad_platform = resolveFlapPlatform(chainId, draft);
        draft.launchpad_status = normalizeFlapLaunchpadStatus(chainId, draft);
        return draft;
      } catch {
        return null;
      }
    };

    if (normalizeAddressKey(tokenAddress) === normalizeAddressKey(wNativeAddress)) {
      const nativeUsd = await getNativePriceUsd();
      if (nativeUsd > 0) {
        this.tokenUsdCache.set(key, { ts: now, value: nativeUsd });
        return nativeUsd;
      }
    }

    const tokenDecimals = tokenInfo?.decimals ?? (await this.getMeta(tokenAddress, chainId)).decimals;
    const oneToken = 10n ** BigInt(tokenDecimals);

    let priceUsd = 0;
    const platform = tokenInfo?.launchpad_platform?.toLowerCase() || '';
    const isInnerDisk = tokenInfo?.launchpad_status !== 1;
    const flapRoute = platform.includes('flap') ? classifyFlapRoute(chainId, tokenInfo) : null;
    const flapOuterDebugEnabled = !!flapRoute?.isOuter;
    const logFlapOuterPricing = (level: 'info' | 'warn', event: string, payload: Record<string, unknown>) => {
      if (!flapOuterDebugEnabled) return;
      const logger = level === 'warn' ? console.warn : console.info;
      logger(`[price.flap.outer][${event}]`, {
        chainId,
        tokenAddress,
        platform,
        resolvedPlatform: flapRoute?.platform ?? null,
        isFlapStocks: flapRoute?.isFlapStocks ?? null,
        launchpadStatus: tokenInfo?.launchpad_status ?? null,
        quoteTokenAddress: tokenInfo?.quote_token_address ?? null,
        poolPair: tokenInfo?.pool_pair ?? null,
        biggestPoolAddress: tokenInfo?.biggest_pool_address ?? null,
        tpoolPoolAddress: tokenInfo?.tpool_pool_address ?? null,
        flapOuterQuoteIsStocks: (tokenInfo as any)?.flap_outer_quote_is_stocks ?? null,
        flapVaultIsVault: tokenInfo?.flap_vault_is_vault ?? null,
        flapStocksVaultVersion: tokenInfo?.flap_stocks_vault_version ?? null,
        ...payload,
      });
    };

    if (chainId === ChainId.HYPER && isHyperAltfunPlatform(platform)) {
      try {
        const quotedUsdc = await quoteHyperSellToUsdc(tokenAddress as `0x${string}`, oneToken);
        if (quotedUsdc > 0n) {
          priceUsd = toNumberFromUnits(quotedUsdc, usdcToken.decimals);
        }
      } catch (e) {
        console.error('getTokenPriceUsdFromRpc: failed to get token price from hyper alt.fun', e);
      }
    }

    if (!(priceUsd > 0) && platform.includes('four') && isInnerDisk) {
      try {
        const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
        const contractInfo = await TokenFourmemeService.getTokenInfo(chainId, tokenAddress);
        if (!contractInfo.liquidityAdded) {
          const quoteAddrRaw = typeof contractInfo.quote === 'string' ? contractInfo.quote : '';
          const quoteAddrLower = quoteAddrRaw.toLowerCase();
          const quoteAddr =
            !quoteAddrRaw || quoteAddrLower === ZERO_ADDRESS
              ? (wNativeAddress as `0x${string}`)
              : (quoteAddrRaw as `0x${string}`);
          const priceInQuote = contractInfo.lastPrice / 1e18;
          if (Number.isFinite(priceInQuote) && priceInQuote > 0) {
            const stable = stableByAddress.get(quoteAddr.toLowerCase());
            if (stable) {
              priceUsd = priceInQuote;
            } else if (quoteAddr.toLowerCase() === wNativeAddress.toLowerCase()) {
              const nativeUsd = await getNativePriceUsd();
              if (nativeUsd > 0) priceUsd = priceInQuote * nativeUsd;
            }
          }
        }
      } catch (e) {
        console.error('getTokenPriceUsdFromRpc: failed to get token price from fourmeme', e);
      }
    }

    if (!(priceUsd > 0) && platform.includes('flap') && isInnerDisk) {
      try {
        const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
        const contractInfo = await TokenFlapService.getTokenInfo(chainId, tokenAddress);
        const poolLower = typeof contractInfo.pool === 'string' ? contractInfo.pool.toLowerCase() : '';
        if (!poolLower || poolLower === ZERO_ADDRESS) {
          const quoteAddrRaw = typeof contractInfo.quoteTokenAddress === 'string' ? contractInfo.quoteTokenAddress : '';
          const quoteAddrLower = quoteAddrRaw.toLowerCase();
          const quoteAddr =
            !quoteAddrRaw || quoteAddrLower === ZERO_ADDRESS
              ? (wNativeAddress as `0x${string}`)
              : (quoteAddrRaw as `0x${string}`);

          const priceWei = (() => {
            try {
              return BigInt(contractInfo.price);
            } catch {
              return 0n;
            }
          })();

          const priceInQuote = priceWei > 0n ? toNumberFromUnits(priceWei, 18) : 0;
          if (Number.isFinite(priceInQuote) && priceInQuote > 0) {
            const stable = stableByAddress.get(quoteAddr.toLowerCase());
            if (stable) {
              priceUsd = priceInQuote;
            } else if (quoteAddr.toLowerCase() === wNativeAddress.toLowerCase()) {
              const nativeUsd = await getNativePriceUsd();
              if (nativeUsd > 0) priceUsd = priceInQuote * nativeUsd;
            }
          }
        }
      } catch (e) {
        console.error('getTokenPriceUsdFromRpc: failed to get token price from flap', e);
      }
    }

    if (!(priceUsd > 0) && flapRoute?.isOuter) {
      const quoteAddrRaw = String(tokenInfo?.quote_token_address || '').trim();
      const quoteAddrLower = quoteAddrRaw.toLowerCase();
      const effectiveQuoteAddr = !quoteAddrRaw || quoteAddrLower === this.ZERO_ADDRESS
        ? wNativeAddress
        : (quoteAddrRaw as `0x${string}`);
      const effectiveQuoteAddrLower = effectiveQuoteAddr.toLowerCase();
      if (effectiveQuoteAddrLower !== normalizeAddressKey(tokenAddress)) {
          const stable = stableByAddress.get(effectiveQuoteAddrLower);
          const quoteIsNative = effectiveQuoteAddrLower === wNativeAddress.toLowerCase();
          logFlapOuterPricing('info', 'outer_branch.start', {
            effectiveQuoteAddr,
            quoteIsStable: !!stable,
            quoteIsNative,
          });
          if (!(priceUsd > 0)) {
          const directQuotePlan = await this.resolveFlapOuterDirectQuotePlan({
            chainId,
            tokenAddress: String(tokenAddress),
            rawQuoteToken: effectiveQuoteAddr,
            tokenInfo,
          }).catch(() => ({ poolPair: undefined, prefer: undefined }));
          const rawQuoteTopology = !stable && !quoteIsNative
            ? await this.resolveFlapRawQuoteTopology({
              chainId,
              rawQuoteToken: effectiveQuoteAddr,
              anchorToken: String(tokenAddress),
              resolveQuoteTokenInfo: buildFlapTokenInfoForPricing,
            }).catch(() => null)
            : null;
          logFlapOuterPricing('info', 'outer_branch.topology', {
            topology: {
              directQuotePoolPair: directQuotePlan.poolPair ?? null,
              directQuotePrefer: directQuotePlan.prefer ?? null,
              rawQuoteToken: rawQuoteTopology?.rawQuoteToken ?? effectiveQuoteAddr,
              terminalQuoteToken: rawQuoteTopology?.terminalQuoteToken ?? null,
              terminalPoolPair: rawQuoteTopology?.terminalPoolPair ?? null,
              terminalPoolPrefer: rawQuoteTopology?.terminalPoolPrefer ?? null,
            },
          });
        try {
            const directQuote = directQuotePlan.poolPair && directQuotePlan.prefer === 'v2'
              ? {
                amountOut: await this.quoteV2ExactInByKnownPair({
                  chainId,
                  pair: directQuotePlan.poolPair as `0x${string}`,
                  tokenIn: tokenAddress as `0x${string}`,
                  tokenOut: effectiveQuoteAddr,
                  amountIn: oneToken,
                  cacheTtlMs: ttl,
                }),
              }
              : directQuotePlan.poolPair && directQuotePlan.prefer === 'v3'
                ? {
                  amountOut: await this.quoteV3ExactInByKnownPool({
                    chainId,
                    pool: directQuotePlan.poolPair as `0x${string}`,
                    tokenIn: tokenAddress as `0x${string}`,
                    tokenOut: effectiveQuoteAddr,
                    amountIn: oneToken,
                    cacheTtlMs: ttl,
                  }),
                }
                : await TradeService.quoteBestExactIn(
                  chainId,
                  tokenAddress as `0x${string}`,
                  effectiveQuoteAddr,
                  oneToken,
                  {
                    poolPair: directQuotePlan.poolPair,
                    prefer: directQuotePlan.prefer,
                    cacheTtlMs: ttl,
                  }
                );
          logFlapOuterPricing(directQuote.amountOut > 0n ? 'info' : 'warn', 'outer_branch.direct_quote', {
            poolPair: directQuotePlan.poolPair ?? null,
            prefer: directQuotePlan.prefer ?? null,
            amountOut: directQuote.amountOut.toString(),
            effectiveQuoteAddr,
          });
          if (directQuote.amountOut > 0n) {
              const quoteTokenInfo = stable || quoteIsNative
                ? null
                : (rawQuoteTopology?.quoteTokenInfo ?? await buildFlapTokenInfoForPricing(effectiveQuoteAddr));
            const quoteTokenDecimals = stable?.decimals
              ?? quoteTokenInfo?.decimals
              ?? (await this.getMeta(effectiveQuoteAddr, chainId)).decimals;
            const quoteAmount = toNumberFromUnits(directQuote.amountOut, quoteTokenDecimals);
            let quoteUsd = 0;
            if (stable) {
              quoteUsd = 1;
            } else if (quoteIsNative) {
              quoteUsd = await getNativePriceUsd();
            } else {
              quoteUsd = await this.getFlapSharedQuoteUsd({
                chainId,
                tokenAddress: effectiveQuoteAddr,
                tokenInfo: quoteTokenInfo,
                cacheTtlMs: ttl,
                allowTokenInfoPriceFallback,
              });
              logFlapOuterPricing(quoteUsd > 0 ? 'info' : 'warn', 'outer_branch.raw_quote_usd', {
                effectiveQuoteAddr,
                terminalQuoteToken: rawQuoteTopology?.terminalQuoteToken ?? null,
                terminalPoolPair: rawQuoteTopology?.terminalPoolPair ?? null,
                terminalPoolPrefer: rawQuoteTopology?.terminalPoolPrefer ?? null,
                quoteUsd,
              });
            }
            if (quoteUsd > 0 && quoteAmount > 0) {
              priceUsd = quoteAmount * quoteUsd;
              logFlapOuterPricing('info', 'outer_branch.resolved', {
                quoteAmount,
                quoteUsd,
                priceUsd,
              });
            } else {
              logFlapOuterPricing('warn', 'outer_branch.unresolved_after_direct_quote', {
                quoteAmount,
                quoteUsd,
              });
            }
          } else {
            logFlapOuterPricing('warn', 'outer_branch.direct_quote_zero', {
              effectiveQuoteAddr,
            });
          }
        } catch {
        }
          }
          if (!(priceUsd > 0) && !stable && !quoteIsNative) {
            const fixedRoutePriceUsd = await quoteByFixedFlapOuterSellRouteToUsd(tokenAddress as `0x${string}`).catch(() => 0);
            if (fixedRoutePriceUsd > 0) {
              logFlapOuterPricing('info', 'outer_branch.fixed_route_hit', {
                fixedRoutePriceUsd,
              });
              priceUsd = fixedRoutePriceUsd;
            } else {
              logFlapOuterPricing('warn', 'outer_branch.fixed_route_miss', {});
            }
          }
      }
    }

    const quoteAddr = tokenInfo?.quote_token_address;
    if (!(priceUsd > 0) && quoteAddr && stableByAddress.has(quoteAddr.toLowerCase())) {
      const stable = stableByAddress.get(quoteAddr.toLowerCase())!;
      const q = await TradeService.quoteBestExactIn(
        chainId,
        tokenAddress as `0x${string}`,
        stable.address,
        oneToken,
        { poolPair: tokenInfo?.pool_pair }
      );
      if (q.amountOut > 0n) {
        priceUsd = toNumberFromUnits(q.amountOut, stable.decimals);
      }
    }

    if (!(priceUsd > 0)) {
      const q = await TradeService.quoteBestExactIn(
        chainId,
        tokenAddress as `0x${string}`,
        wNativeAddress as `0x${string}`,
        oneToken,
        { poolPair: tokenInfo?.pool_pair }
      );
      if (q.amountOut > 0n) {
        const outNative = toNumberFromUnits(q.amountOut, wNativeDecimals);
        const nativeUsd = await getNativePriceUsd();
        if (nativeUsd > 0 && outNative > 0) {
          priceUsd = outNative * nativeUsd;
        }
      }
    }

    if (
      !(priceUsd > 0) &&
      allowTokenInfoPriceFallback !== false &&
      tokenInfo &&
      typeof (tokenInfo as any).tokenPrice?.price === 'string'
    ) {
      const v = Number((tokenInfo as any).tokenPrice.price);
      if (Number.isFinite(v) && v > 0) {
        priceUsd = v;
      }
    }
    if (priceUsd > 0) {
      logFlapOuterPricing('info', 'return_price', {
        priceUsd,
      });
      this.tokenUsdCache.set(key, { ts: now, value: priceUsd });
    } else {
      logFlapOuterPricing('warn', 'return_zero', {
        allowTokenInfoPriceFallback: allowTokenInfoPriceFallback ?? null,
        tokenInfoPrice: (tokenInfo as any)?.tokenPrice?.price ?? null,
      });
      this.tokenUsdCache.delete(key);
    }
    return priceUsd;
  }
}
