import type { TokenInfo } from '@/types/token';
import { getFlapStocksVaultVersion } from '@/constants/flap';

const BSC_FLAP_TERMINAL_QUOTES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  '0x55d398326f99059ff775485246999027b3197955',
  '0xe9e7cea3dedca5984780bafc599bd69add087d56',
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
  '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d',
]);

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
  tokenInfo?: Pick<TokenInfo, 'flap_stocks_vault_version' | 'flap_dividend_token' | 'flap_vault_address' | 'flap_vault_factory' | 'flap_vault_is_official' | 'flap_basket_token' | 'flap_supported_assets'> | null,
): boolean {
  if (!tokenInfo) return false;
  const stocksVaultVersion = tokenInfo.flap_stocks_vault_version ?? getFlapStocksVaultVersion(chainId, tokenInfo.flap_vault_factory);
  const hasOfficialStocksVault = tokenInfo.flap_vault_is_official === true && isNonZeroAddressLike(tokenInfo.flap_vault_address);
  if (stocksVaultVersion == null && !hasOfficialStocksVault) return false;
  if (isNonZeroAddressLike(tokenInfo.flap_basket_token)) return true;
  if (Array.isArray(tokenInfo.flap_supported_assets) && tokenInfo.flap_supported_assets.some((item) => isNonZeroAddressLike(item))) return true;
  return isNonZeroAddressLike(tokenInfo.flap_vault_address) && isNonZeroAddressLike(tokenInfo.flap_dividend_token);
}

function hasPotentialFlapStocksMetadata(
  tokenInfo?: Pick<TokenInfo, 'flap_stocks_vault_version' | 'flap_dividend_token' | 'flap_vault_address' | 'flap_vault_factory' | 'flap_vault_is_official' | 'flap_basket_token' | 'flap_supported_assets'> | null,
): boolean {
  if (!tokenInfo) return false;
  if (tokenInfo.flap_stocks_vault_version != null) return true;
  if (tokenInfo.flap_vault_is_official === true && isNonZeroAddressLike(tokenInfo.flap_vault_address)) return true;
  if (isNonZeroAddressLike(tokenInfo.flap_vault_factory)) return true;
  if (isNonZeroAddressLike(tokenInfo.flap_vault_address)) return true;
  if (isNonZeroAddressLike(tokenInfo.flap_dividend_token)) return true;
  if (isNonZeroAddressLike(tokenInfo.flap_basket_token)) return true;
  return Array.isArray(tokenInfo.flap_supported_assets) && tokenInfo.flap_supported_assets.some((item) => isNonZeroAddressLike(item));
}

function hasNonTerminalFlapOuterQuote(
  chainId: number,
  tokenInfo?: Pick<TokenInfo, 'quote_token_address'> | null,
): boolean {
  if (chainId !== 56) return false;
  const quote = String(tokenInfo?.quote_token_address || '').trim().toLowerCase();
  return !!quote && !BSC_FLAP_TERMINAL_QUOTES.has(quote);
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

function normalizeFlapPlatform(platform?: string | null): 'flap' | 'flap_stocks' {
  return String(platform || '').trim().toLowerCase() === 'flap_stocks' ? 'flap_stocks' : 'flap';
}

export function classifyFlapRoute(
  chainId: number,
  tokenInfo?: Pick<TokenInfo,
    'address'
    | 'launchpad_platform'
    | 'launchpad_status'
    | 'quote_token_address'
    | 'pool_pair'
    | 'biggest_pool_address'
    | 'tpool_pool_address'
    | 'flap_pool_model'
    | 'flap_pool_compat_address'
    | 'flap_cl_pool_id'
    | 'flap_v4_fee'
    | 'flap_v4_tick_spacing'
    | 'flap_stocks_vault_version'
    | 'flap_dividend_token'
    | 'flap_vault_address'
    | 'flap_vault_factory'
    | 'flap_vault_is_official'
    | 'flap_basket_token'
    | 'flap_supported_assets'
  > | null,
): {
  isInner: boolean;
  isOuter: boolean;
  isFlapStocks: boolean;
  platform: 'flap' | 'flap_stocks';
  rawLaunchpadStatus: number | null;
  hasConfirmedOuterRoute: boolean;
} {
  const rawLaunchpadStatus = Number(tokenInfo?.launchpad_status ?? Number.NaN);
  const normalizedLaunchpadStatus = Number.isFinite(rawLaunchpadStatus) ? rawLaunchpadStatus : null;
  const hasConfirmedOuterRoute = hasConfirmedFlapOuterRoute(tokenInfo);
  const isOuter = normalizedLaunchpadStatus != null ? normalizedLaunchpadStatus === 1 : hasConfirmedOuterRoute;
  const isInner = !isOuter;
  const isFlapStocks = isInner
    ? normalizeFlapPlatform(tokenInfo?.launchpad_platform) === 'flap_stocks'
    : hasConfirmedFlapStocksIdentity(chainId, tokenInfo)
      || (hasNonTerminalFlapOuterQuote(chainId, tokenInfo) && hasPotentialFlapStocksMetadata(tokenInfo));
  return {
    isInner,
    isOuter,
    isFlapStocks,
    platform: isFlapStocks ? 'flap_stocks' : 'flap',
    rawLaunchpadStatus: normalizedLaunchpadStatus,
    hasConfirmedOuterRoute,
  };
}
