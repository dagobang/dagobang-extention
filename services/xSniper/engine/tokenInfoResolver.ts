import { chainNames } from '@/constants/chains/chainName';
import { ChainId } from '@/constants/chains/chainId';
import { FourmemeAPI } from '@/services/api/fourmeme';
import { TokenFlapService } from '@/services/token/flap';
import { TokenFourmemeService } from '@/services/token/fourmeme';
import { TokenService } from '@/services/token';
import type { TokenInfo } from '@/types/token';
import { formatUnits, isAddress } from 'viem';
import { isSolanaAddress, normalizeAddress } from '@/services/xSniper/engine/metrics';
import { resolveFlapPlatform } from '@/utils/flap';

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

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const isSupportedChainAddress = (chainId: number, tokenAddress: string) => {
  if (chainId === ChainId.SOL) return isSolanaAddress(tokenAddress);
  return isAddress(tokenAddress);
};

const buildGenericTokenInfoFromMeta = async (chainId: number, tokenAddress: string): Promise<TokenInfo> => {
  const chain = chainNames[chainId as any] ?? 'bsc';
  const meta = await TokenService.getMeta(tokenAddress, chainId);
  return {
    chain,
    address: tokenAddress,
    name: '',
    symbol: String(meta.symbol ?? ''),
    decimals: Number(meta.decimals ?? (chainId === ChainId.SOL ? 9 : 18)),
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
};

export const createTokenInfoResolvers = () => {
  const fetchTokenInfoFreshWithReason = async (
    chainId: number,
    tokenAddressRaw: string,
  ): Promise<{ tokenInfo: TokenInfo | null; failureReason?: string }> => {
    const tokenAddress = normalizeAddress(String(tokenAddressRaw || '').trim());
    if (!tokenAddress || !isSupportedChainAddress(chainId, tokenAddress)) {
      return { tokenInfo: null, failureReason: 'invalid_address' };
    }
    if (chainId === ChainId.SOL) {
      try {
        return { tokenInfo: await buildGenericTokenInfoFromMeta(chainId, tokenAddress) };
      } catch (error) {
        return { tokenInfo: null, failureReason: isRateLimitError(error) ? 'rpc_rate_limited' : 'rpc_error' };
      }
    }
    const typedAddress = tokenAddress as `0x${string}`;
    const chain = chainNames[chainId as any] ?? 'bsc';

    if (isFlapAddress(typedAddress)) {
      try {
        const state = await TokenFlapService.getTokenInfo(chainId, typedAddress);
        const meta = await TokenService.getMeta(typedAddress, chainId);
        const quote = state.quoteTokenAddress && state.quoteTokenAddress !== '0x0000000000000000000000000000000000000000'
          ? state.quoteTokenAddress
          : '';
        const decimals = Number(meta.decimals ?? 18);
        const totalSupply = (() => {
          try {
            return formatUnits(BigInt(state.circulatingSupply || '0'), decimals);
          } catch {
            return undefined;
          }
        })();
        const draftInfo: TokenInfo = {
          chain,
          address: typedAddress,
          name: '',
          symbol: String(meta.symbol ?? ''),
          decimals,
          logo: '',
          launchpad: 'flap',
          launchpad_progress: Number(state.progress ?? 0),
          launchpad_platform: 'flap',
          launchpad_status: Number(state.status ?? 0),
          quote_token: '',
          quote_token_address: quote,
          pool_pair: state.poolModel === 'classic' ? state.pool || '' : '',
          biggest_pool_address: state.poolModel === 'classic' ? state.pool || '' : '',
          tpool_pool_address: state.poolModel === 'classic' ? state.pool || '' : '',
          dex_type: 'flap',
          totalSupply,
          nativeToQuoteSwapEnabled: state.nativeToQuoteSwapEnabled,
          tokenVersion: state.tokenVersion,
          extensionID: state.extensionID,
          dexId: state.dexId,
          flap_lp_fee_profile: state.lpFeeProfile,
          flap_pool_model: state.poolModel,
          flap_pool_compat_address: state.poolCompatAddress,
          flap_cl_pool_id: state.clPoolId,
          flap_v4_fee: state.v4Fee,
          flap_v4_tick_spacing: state.v4TickSpacing,
          flap_v4_hooks: state.v4Hooks,
          flap_dividend_token: state.dividendToken,
          flap_vault_address: state.vaultAddress,
          flap_vault_factory: state.vaultFactory,
          flap_vault_is_official: state.vaultIsOfficial,
            flap_vault_is_vault: state.vaultIsVault,
          flap_vault_is_ai_consumer: state.vaultIsAIConsumer,
          flap_stocks_vault_version: state.stocksVaultVersion,
          flap_basket_token: state.basketToken,
          flap_supported_assets: state.supportedAssets,
          tokenPrice: {
            price: '0',
            marketCap: '0',
            timestamp: Date.now(),
          },
        };
        draftInfo.launchpad_platform = resolveFlapPlatform(chainId, draftInfo);
        return {
          tokenInfo: draftInfo,
        };
      } catch (error) {
        return { tokenInfo: null, failureReason: isRateLimitError(error) ? 'flap_rate_limited' : 'flap_fetch_failed' };
      }
    }

    try {
      const info = await FourmemeAPI.getTokenInfo(chain, typedAddress);
      if (!info) return { tokenInfo: null, failureReason: 'fourmeme_empty' };
      // Fourmeme HTTP may lag during inner->outer migration. Always merge onchain state.
      try {
        const onchain = await TokenFourmemeService.getTokenInfo(chainId, typedAddress);
        if (onchain?.quote && String(onchain.quote).toLowerCase() !== ZERO_ADDRESS) {
          info.quote_token_address = String(onchain.quote);
        }
        if (onchain?.aiCreator !== undefined) (info as any).aiCreator = onchain.aiCreator;
        if (onchain?.liquidityAdded === true) {
          info.launchpad_status = 1;
          info.launchpad_progress = Math.max(100, Number(info.launchpad_progress || 0));
        } else if (onchain?.liquidityAdded === false && Number(info.launchpad_status) !== 1) {
          info.launchpad_status = 0;
        }
      } catch {
      }
      return { tokenInfo: info };
    } catch (error) {
      return { tokenInfo: null, failureReason: isRateLimitError(error) ? 'fourmeme_rate_limited' : 'fourmeme_error' };
    }
  };

  const fetchTokenInfoFresh = async (chainId: number, tokenAddress: string): Promise<TokenInfo | null> => {
    const result = await fetchTokenInfoFreshWithReason(chainId, tokenAddress);
    return result.tokenInfo;
  };

  const buildGenericTokenInfoWithReason = async (
    chainId: number,
    tokenAddressRaw: string,
  ): Promise<{ tokenInfo: TokenInfo | null; failureReason?: string }> => {
    try {
      const tokenAddress = normalizeAddress(String(tokenAddressRaw || '').trim());
      if (!tokenAddress || !isSupportedChainAddress(chainId, tokenAddress)) {
        return { tokenInfo: null, failureReason: 'invalid_address' };
      }
      try {
        return { tokenInfo: await buildGenericTokenInfoFromMeta(chainId, tokenAddress) };
      } catch (error) {
        return { tokenInfo: null, failureReason: isRateLimitError(error) ? 'rpc_rate_limited' : 'rpc_error' };
      }
    } catch {
      return { tokenInfo: null, failureReason: 'rpc_error' };
    }
  };

  const buildGenericTokenInfo = async (chainId: number, tokenAddress: string): Promise<TokenInfo | null> => {
    const result = await buildGenericTokenInfoWithReason(chainId, tokenAddress);
    return result.tokenInfo;
  };

  const getEntryPriceUsd = async (
    chainId: number,
    tokenAddress: string,
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
