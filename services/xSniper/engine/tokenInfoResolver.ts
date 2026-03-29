import { chainNames } from '@/constants/chains/chainName';
import { FourmemeAPI } from '@/services/api/fourmeme';
import { TokenFourmemeService } from '@/services/token/fourmeme';
import { TokenFlapService } from '@/services/token/flap';
import { TokenService } from '@/services/token';
import type { TokenInfo } from '@/types/token';
import { isAddress } from 'viem';

const isFlapAddress = (addr: string) => {
  const low = addr.toLowerCase();
  return low.endsWith('7777') || low.endsWith('8888');
};

const getErrorStatus = (error: unknown): number => {
  const e = error as any;
  const status = Number(
    e?.status
    ?? e?.response?.status
    ?? e?.cause?.status
    ?? e?.cause?.response?.status
    ?? 0,
  );
  return Number.isFinite(status) ? status : 0;
};

const isRateLimitError = (error: unknown): boolean => {
  if (getErrorStatus(error) === 429) return true;
  const e = error as any;
  const message = String(
    e?.shortMessage
    ?? e?.message
    ?? e?.cause?.message
    ?? '',
  ).toLowerCase();
  return message.includes('429') || message.includes('too many requests') || message.includes('rate limit');
};

export const createTokenInfoResolvers = () => {
  const fetchTokenInfoFreshWithReason = async (
    chainId: number,
    tokenAddressRaw: string,
  ): Promise<{ tokenInfo: TokenInfo | null; failureReason?: string }> => {
    const tokenAddress = String(tokenAddressRaw || '').trim();
    if (!isAddress(tokenAddress)) {
      return { tokenInfo: null, failureReason: 'invalid_address' };
    }
    const typedAddress = tokenAddress as `0x${string}`;
    const chain = chainNames[chainId as any] ?? 'bsc';

    if (isFlapAddress(typedAddress)) {
      try {
        const state = await TokenFlapService.getTokenInfo(chainId, typedAddress);
        const meta = await TokenService.getMeta(typedAddress);
        const quote = state.quoteTokenAddress && state.quoteTokenAddress !== '0x0000000000000000000000000000000000000000'
          ? state.quoteTokenAddress
          : '';
        return {
          tokenInfo: {
            chain,
            address: typedAddress,
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
          },
        };
      } catch (error) {
        return { tokenInfo: null, failureReason: isRateLimitError(error) ? 'flap_rate_limited' : 'flap_fetch_failed' };
      }
    }

    try {
      const info = await FourmemeAPI.getTokenInfo(chain, typedAddress);
      if (!info) return { tokenInfo: null, failureReason: 'fourmeme_empty' };
      try {
        const onchain = await TokenFourmemeService.getTokenInfo(chainId, typedAddress);
        if (onchain?.quote) info.quote_token_address = String(onchain.quote);
        if (onchain?.aiCreator !== undefined) (info as any).aiCreator = onchain.aiCreator;
      } catch {}
      return { tokenInfo: info };
    } catch (error) {
      return { tokenInfo: null, failureReason: isRateLimitError(error) ? 'fourmeme_rate_limited' : 'fourmeme_error' };
    }
  };

  const fetchTokenInfoFresh = async (chainId: number, tokenAddress: `0x${string}`): Promise<TokenInfo | null> => {
    const result = await fetchTokenInfoFreshWithReason(chainId, tokenAddress);
    return result.tokenInfo;
  };

  const buildGenericTokenInfoWithReason = async (
    chainId: number,
    tokenAddressRaw: string,
  ): Promise<{ tokenInfo: TokenInfo | null; failureReason?: string }> => {
    try {
      const tokenAddress = String(tokenAddressRaw || '').trim();
      if (!isAddress(tokenAddress)) {
        return { tokenInfo: null, failureReason: 'invalid_address' };
      }
      const typedAddress = tokenAddress as `0x${string}`;
      const chain = chainNames[chainId as any] ?? 'bsc';
      try {
        const meta = await TokenService.getMeta(typedAddress);
        return {
          tokenInfo: {
            chain,
            address: typedAddress,
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
          },
        };
      } catch (error) {
        return { tokenInfo: null, failureReason: isRateLimitError(error) ? 'rpc_rate_limited' : 'rpc_error' };
      }
    } catch {
      return { tokenInfo: null, failureReason: 'rpc_error' };
    }
  };

  const buildGenericTokenInfo = async (chainId: number, tokenAddress: `0x${string}`): Promise<TokenInfo | null> => {
    const result = await buildGenericTokenInfoWithReason(chainId, tokenAddress);
    return result.tokenInfo;
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
    fetchTokenInfoFreshWithReason,
    fetchTokenInfoFresh,
    buildGenericTokenInfoWithReason,
    buildGenericTokenInfo,
    getEntryPriceUsd,
  };
};
