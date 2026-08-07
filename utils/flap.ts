import type { TokenInfo } from '@/types/token';
import { getFlapStocksVaultVersion } from '@/constants/flap';

function isAddressLike(value: string | undefined | null): value is `0x${string}` {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || '').trim());
}

function isNonZeroAddressLike(value: string | undefined | null): value is `0x${string}` {
  return isAddressLike(value) && String(value).trim().toLowerCase() !== '0x0000000000000000000000000000000000000000';
}

export function isUsableFlapDexPoolAddress(tokenAddress: string, poolAddress?: string | null): poolAddress is `0x${string}` {
  const token = String(tokenAddress || '').trim().toLowerCase();
  const pool = String(poolAddress || '').trim();
  if (!isAddressLike(pool)) return false;
  if (pool.toLowerCase() === '0x0000000000000000000000000000000000000000') return false;
  return pool.toLowerCase() !== token;
}

export function hasConfirmedFlapStocksIdentity(
  chainId: number,
  tokenInfo?: Pick<TokenInfo, 'flap_stocks_vault_version' | 'flap_dividend_token' | 'flap_vault_factory' | 'flap_basket_token' | 'flap_supported_assets'> | null,
): boolean {
  if (!tokenInfo) return false;
  const stocksVaultVersion = tokenInfo.flap_stocks_vault_version ?? getFlapStocksVaultVersion(chainId, tokenInfo.flap_vault_factory);
  if (stocksVaultVersion == null) return false;
  if (!isNonZeroAddressLike(tokenInfo.flap_dividend_token)) return false;
  if (isNonZeroAddressLike(tokenInfo.flap_basket_token)) return true;
  return Array.isArray(tokenInfo.flap_supported_assets) && tokenInfo.flap_supported_assets.some((item) => isNonZeroAddressLike(item));
}

export function hasConfirmedFlapOuterRoute(
  tokenInfo?: Pick<TokenInfo,
    'address'
    | 'pool_pair'
    | 'biggest_pool_address'
    | 'tpool_pool_address'
    | 'flap_pool_model'
    | 'flap_pool_compat_address'
    | 'flap_cl_pool_id'
    | 'flap_v4_fee'
    | 'flap_v4_tick_spacing'
  > | null,
): boolean {
  if (!tokenInfo?.address) return false;
  if (tokenInfo.flap_pool_model === 'v4_cl') {
    return isAddressLike(tokenInfo.flap_cl_pool_id)
      && Number(tokenInfo.flap_v4_fee ?? 0) > 0
      && Number(tokenInfo.flap_v4_tick_spacing ?? 0) > 0;
  }
  return [
    tokenInfo.pool_pair,
    tokenInfo.biggest_pool_address,
    tokenInfo.tpool_pool_address,
    tokenInfo.flap_pool_model === 'infinity_cl' ? tokenInfo.flap_pool_compat_address : undefined,
  ].some((poolAddress) => isUsableFlapDexPoolAddress(tokenInfo.address, poolAddress));
}
