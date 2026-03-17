import { chainNames } from '@/constants/chains/chainName';
import { FourmemeAPI } from '@/services/api/fourmeme';
import { TokenFourmemeService } from '@/services/token/fourmeme';
import { TokenFlapService } from '@/services/token/flap';
import { TokenService } from '@/services/token';
import type { TokenInfo } from '@/types/token';

const isFlapAddress = (addr: string) => {
  const low = addr.toLowerCase();
  return low.endsWith('7777') || low.endsWith('8888');
};

export const createTokenInfoResolvers = () => {
  const fetchTokenInfoFresh = async (chainId: number, tokenAddress: `0x${string}`): Promise<TokenInfo | null> => {
    const chain = chainNames[chainId as any] ?? 'bsc';

    if (isFlapAddress(tokenAddress)) {
      try {
        const state = await TokenFlapService.getTokenInfo(chainId, tokenAddress);
        const meta = await TokenService.getMeta(tokenAddress);
        const quote = state.quoteTokenAddress && state.quoteTokenAddress !== '0x0000000000000000000000000000000000000000'
          ? state.quoteTokenAddress
          : '';
        return {
          chain,
          address: tokenAddress,
          name: '',
          symbol: String(meta.symbol ?? ''),
          decimals: Number(meta.decimals ?? 18),
          logo: '',
          launchpad: 'flap',
          launchpad_progress: Number(state.progress ?? 0),
          launchpad_platform: 'flap',
          launchpad_status: Number(state.status ?? 0),
          quote_token: '',
          quote_token_address: quote,
          pool_pair: state.pool || '',
          dex_type: 'flap',
          tokenPrice: {
            price: '0',
            marketCap: '0',
            timestamp: Date.now(),
          },
        };
      } catch {
        return null;
      }
    }

    try {
      const info = await FourmemeAPI.getTokenInfo(chain, tokenAddress);
      if (!info) return null;
      try {
        const onchain = await TokenFourmemeService.getTokenInfo(chainId, tokenAddress);
        if (onchain?.quote) info.quote_token_address = String(onchain.quote);
        if (onchain?.aiCreator !== undefined) (info as any).aiCreator = onchain.aiCreator;
      } catch {}
      return info;
    } catch {
      return null;
    }
  };

  const buildGenericTokenInfo = async (chainId: number, tokenAddress: `0x${string}`): Promise<TokenInfo | null> => {
    try {
      const chain = chainNames[chainId as any] ?? 'bsc';
      const meta = await TokenService.getMeta(tokenAddress);
      return {
        chain,
        address: tokenAddress,
        name: '',
        symbol: String(meta.symbol ?? ''),
        decimals: Number(meta.decimals ?? 18),
        logo: '',
        launchpad: '',
        launchpad_progress: 0,
        launchpad_platform: '',
        launchpad_status: 1,
        quote_token: '',
        quote_token_address: '',
        pool_pair: '',
        dex_type: '',
        tokenPrice: {
          price: '0',
          marketCap: '0',
          timestamp: Date.now(),
        },
      };
    } catch {
      return null;
    }
  };

  const getEntryPriceUsd = async (
    chainId: number,
    tokenAddress: `0x${string}`,
    tokenInfo: TokenInfo,
    fallback: number | null,
    fallbackMcapUsd: number | null,
  ) => {
    try {
      const q = await TokenService.getTokenPriceUsdFromRpc({
        chainId,
        tokenAddress,
        tokenInfo,
        cacheTtlMs: 0,
      } as any);
      const n = typeof q === 'number' ? q : Number(q);
      if (Number.isFinite(n) && n > 0) return n;
    } catch {
    }
    if (fallback != null && Number.isFinite(fallback) && fallback > 0) return fallback;
    const p = Number(tokenInfo?.tokenPrice?.price ?? 0);
    const mcap = Number(fallbackMcapUsd ?? tokenInfo?.tokenPrice?.marketCap ?? 0);
    if (Number.isFinite(p) && p > 0) {
      if (Number.isFinite(mcap) && mcap > 0) {
        const impliedSupply = mcap / p;
        if (Number.isFinite(impliedSupply) && impliedSupply > 0 && impliedSupply <= 1e15) return p;
      } else {
        return p;
      }
    }
    return null;
  };

  return {
    fetchTokenInfoFresh,
    buildGenericTokenInfo,
    getEntryPriceUsd,
  };
};
