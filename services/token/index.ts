import { erc20Abi, pairV2Abi } from '@/constants/contracts/abi/swapAbi';
import { formatUnits } from 'viem';
import type { TokenInfo } from '@/types/token';
import { bscTokens } from '@/constants/tokens/chains/bsc';

import { RpcService } from '../rpc';
import { TradeService } from '../trade';
import { TokenFourmemeService } from './fourmeme';
import { TokenFlapService } from './flap';

export class TokenService {
  private static poolPairCache = new Map<string, { token0: `0x${string}`; token1: `0x${string}` }>();
  private static bnbUsdCache = { ts: 0, value: 0 };
  private static tokenUsdCache = new Map<string, { ts: number; value: number }>();
  private static balanceCacheTtlMs = 1000;
  private static nativeBalanceCache = new Map<string, { ts: number; value: string }>();
  private static nativeBalanceInFlight = new Map<string, Promise<string>>();
  private static tokenBalanceCache = new Map<string, { ts: number; value: string }>();
  private static tokenBalanceInFlight = new Map<string, Promise<string>>();

  static async getMeta(tokenAddress: string) {
    const client = await RpcService.getClient();
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address: tokenAddress as `0x${string}`, abi: erc20Abi, functionName: 'symbol' }),
      client.readContract({ address: tokenAddress as `0x${string}`, abi: erc20Abi, functionName: 'decimals' }),
    ]);
    return { symbol, decimals };
  }

  static async getBalance(tokenAddress: string, owner: string) {
    const now = Date.now();
    const key = `${owner.toLowerCase()}:${tokenAddress.toLowerCase()}`;
    const cached = this.tokenBalanceCache.get(key);
    if (cached && now - cached.ts < this.balanceCacheTtlMs) return cached.value;
    const inFlight = this.tokenBalanceInFlight.get(key);
    if (inFlight) return inFlight;
    console.log('getBalance', tokenAddress, owner);
    const client = await RpcService.getClient();
    const p = (async () => {
      const balance = await client.readContract({
        address: tokenAddress as `0x${string}`,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [owner as `0x${string}`],
      });
      const v = balance.toString();
      this.tokenBalanceCache.set(key, { ts: Date.now(), value: v });
      return v;
    })().finally(() => {
      this.tokenBalanceInFlight.delete(key);
    });
    this.tokenBalanceInFlight.set(key, p);
    return p;
  }

  static async getNativeBalance(owner: string) {
    const now = Date.now();
    const key = owner.toLowerCase();
    const cached = this.nativeBalanceCache.get(key);
    if (cached && now - cached.ts < this.balanceCacheTtlMs) return cached.value;
    const inFlight = this.nativeBalanceInFlight.get(key);
    if (inFlight) return inFlight;

    const client = await RpcService.getClient();
    const p = (async () => {
      const balance = await client.getBalance({ address: owner as `0x${string}` });
      const v = balance.toString();
      this.nativeBalanceCache.set(key, { ts: Date.now(), value: v });
      return v;
    })().finally(() => {
      this.nativeBalanceInFlight.delete(key);
    });
    this.nativeBalanceInFlight.set(key, p);
    return p;
  }

  static async getPoolPair(pair: string) {
    const key = pair.toLowerCase();
    const cached = this.poolPairCache.get(key);
    if (cached) {
      return cached;
    }

    const client = await RpcService.getClient();
    const [token0, token1] = await Promise.all([
      client.readContract({
        address: pair as `0x${string}`,
        abi: pairV2Abi,
        functionName: 'token0',
      }) as Promise<`0x${string}`>,
      client.readContract({
        address: pair as `0x${string}`,
        abi: pairV2Abi,
        functionName: 'token1',
      }) as Promise<`0x${string}`>
    ]);
    const result = { token0, token1 };
    this.poolPairCache.set(key, result);
    return result;
  }

  static async getTokenPriceUsdFromRpc(input: {
    chainId: number;
    tokenAddress: `0x${string}`;
    tokenInfo?: TokenInfo | null;
    cacheTtlMs?: number;
  }): Promise<number> {
    return this.getPriceUsdFromRpc(input);
  }

  static async getPriceUsdFromRpc(input: {
    chainId: number;
    tokenAddress: `0x${string}`;
    tokenInfo?: TokenInfo | null;
    cacheTtlMs?: number;
  }): Promise<number> {
    const { chainId, tokenAddress, tokenInfo, cacheTtlMs } = input;
    const now = Date.now();
    const ttl = typeof cacheTtlMs === 'number' && cacheTtlMs >= 0 ? cacheTtlMs : 0;
    const key = `${chainId}:${tokenAddress.toLowerCase()}`;
    const cached = this.tokenUsdCache.get(key);
    if (ttl > 0 && cached && now - cached.ts < ttl) return cached.value;

    const toNumberFromUnits = (amount: bigint, decimals: number) => {
      const s = formatUnits(amount, decimals);
      const n = Number(s);
      if (Number.isFinite(n)) return n;
      const f = parseFloat(s);
      return Number.isFinite(f) ? f : 0;
    };

    const stableByAddress = new Map<string, { address: `0x${string}`; decimals: number }>([
      [bscTokens.usdt.address.toLowerCase(), { address: bscTokens.usdt.address as `0x${string}`, decimals: bscTokens.usdt.decimals }],
      [bscTokens.usdc.address.toLowerCase(), { address: bscTokens.usdc.address as `0x${string}`, decimals: bscTokens.usdc.decimals }],
      [bscTokens.usd1.address.toLowerCase(), { address: bscTokens.usd1.address as `0x${string}`, decimals: bscTokens.usd1.decimals }],
    ]);

    const getBnbPriceUsd = async () => {
      const now2 = Date.now();
      if (this.bnbUsdCache.value > 0 && now2 - this.bnbUsdCache.ts < 30_000) return this.bnbUsdCache.value;
      if (chainId !== 56) return 0;
      const amountOut = (await TradeService.quoteBestExactIn(
        chainId,
        bscTokens.wbnb.address as `0x${string}`,
        bscTokens.usdt.address as `0x${string}`,
        10n ** 18n,
        { v3Fee: 500 }
      )).amountOut;
      const v = amountOut > 0n ? toNumberFromUnits(amountOut, bscTokens.usdt.decimals) : 0;
      if (v > 0) {
        this.bnbUsdCache.ts = now2;
        this.bnbUsdCache.value = v;
      }
      return v;
    };

    const tokenDecimals = tokenInfo?.decimals ?? (await this.getMeta(tokenAddress)).decimals;
    const oneToken = 10n ** BigInt(tokenDecimals);

    let priceUsd = 0;
    const platform = tokenInfo?.launchpad_platform?.toLowerCase() || '';
    const isInnerDisk = tokenInfo?.launchpad_status !== 1;

    if (platform.includes('fourmeme') && isInnerDisk) {
      try {
        const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
        const contractInfo = await TokenFourmemeService.getTokenInfo(chainId, tokenAddress);
        if (!contractInfo.liquidityAdded) {
          const quoteAddrRaw = typeof contractInfo.quote === 'string' ? contractInfo.quote : '';
          const quoteAddrLower = quoteAddrRaw.toLowerCase();
          const quoteAddr =
            !quoteAddrRaw || quoteAddrLower === ZERO_ADDRESS
              ? (bscTokens.wbnb.address as `0x${string}`)
              : (quoteAddrRaw as `0x${string}`);
          const priceInQuote = contractInfo.lastPrice / 1e18;
          if (Number.isFinite(priceInQuote) && priceInQuote > 0) {
            const stable = stableByAddress.get(quoteAddr.toLowerCase());
            if (stable) {
              priceUsd = priceInQuote;
            } else if (quoteAddr.toLowerCase() === bscTokens.wbnb.address.toLowerCase()) {
              const bnbUsd = await getBnbPriceUsd();
              if (bnbUsd > 0) priceUsd = priceInQuote * bnbUsd;
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
              ? (bscTokens.wbnb.address as `0x${string}`)
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
            } else if (quoteAddr.toLowerCase() === bscTokens.wbnb.address.toLowerCase()) {
              const bnbUsd = await getBnbPriceUsd();
              if (bnbUsd > 0) priceUsd = priceInQuote * bnbUsd;
            }
          }
        }
      } catch (e) {
        console.error('getTokenPriceUsdFromRpc: failed to get token price from flap', e);
      }
    }

    const quoteAddr = tokenInfo?.quote_token_address;
    if (!(priceUsd > 0) && quoteAddr && stableByAddress.has(quoteAddr.toLowerCase())) {
      const stable = stableByAddress.get(quoteAddr.toLowerCase())!;
      const q = await TradeService.quoteBestExactIn(
        chainId,
        tokenAddress,
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
        tokenAddress,
        bscTokens.wbnb.address as `0x${string}`,
        oneToken,
        { poolPair: tokenInfo?.pool_pair }
      );
      if (q.amountOut > 0n) {
        const outBnb = toNumberFromUnits(q.amountOut, bscTokens.wbnb.decimals);
        const bnbUsd = await getBnbPriceUsd();
        if (bnbUsd > 0 && outBnb > 0) {
          priceUsd = outBnb * bnbUsd;
        }
      }
    }

    if (!(priceUsd > 0) && tokenInfo && typeof (tokenInfo as any).tokenPrice?.price === 'string') {
      const v = Number((tokenInfo as any).tokenPrice.price);
      if (Number.isFinite(v) && v > 0) {
        priceUsd = v;
      }
    }
    if (priceUsd > 0) {
      this.tokenUsdCache.set(key, { ts: now, value: priceUsd });
    } else {
      this.tokenUsdCache.delete(key);
    }
    return priceUsd;
  }
}
