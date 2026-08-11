import type { TokenInfo } from '@/types/token';
import { getFlapStocksVaultVersion } from '@/constants/flap';
import { isFlapSuffixAddress, resolveTokenLaunchpadPlatform } from '@/utils/launchpadFamily';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const BSC_FLAP_TERMINAL_QUOTES = new Set([
  ZERO_ADDRESS,
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  '0x55d398326f99059ff775485246999027b3197955',
  '0xe9e7cea3dedca5984780bafc599bd69add087d56',
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
  '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d',
]);

function isAddressLike(value: string | undefined | null): value is `0x${string}` {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || '').trim());
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
  tokenInfo?: Partial<Pick<TokenInfo, 'flap_stocks_vault_version' | 'flap_dividend_token' | 'flap_vault_address' | 'flap_vault_factory' | 'flap_vault_is_official' | 'flap_vault_is_vault' | 'flap_basket_token' | 'flap_supported_assets'>> | null,
): boolean {
  if (!tokenInfo) return false;
  if (tokenInfo.flap_vault_is_vault !== true) return false;
  const stocksVaultVersion = tokenInfo.flap_stocks_vault_version ?? getFlapStocksVaultVersion(chainId, tokenInfo.flap_vault_factory);
  return stocksVaultVersion != null;
}

export function hasConfirmedFlapOuterRoute(
  tokenInfo?: Partial<Pick<TokenInfo,
    'address'
    | 'pool_pair'
    | 'biggest_pool_address'
    | 'tpool_pool_address'
    | 'flap_pool_model'
    | 'flap_pool_compat_address'
    | 'flap_cl_pool_id'
    | 'flap_v4_fee'
    | 'flap_v4_tick_spacing'
  >> | null,
): boolean {
  if (!tokenInfo?.address) return false;
  const tokenAddress = tokenInfo.address;
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
  ].some((poolAddress) => isUsableFlapDexPoolAddress(tokenAddress, poolAddress));
}

export function normalizeFlapLaunchpadStatus(
  chainId: number,
  tokenInfo?: Partial<Pick<TokenInfo,
    'address'
    | 'launchpad_status'
    | 'pool_pair'
    | 'biggest_pool_address'
    | 'tpool_pool_address'
    | 'flap_pool_model'
    | 'flap_pool_compat_address'
    | 'flap_cl_pool_id'
    | 'flap_v4_fee'
    | 'flap_v4_tick_spacing'
  >> | null,
): 0 | 1 {
  void chainId;
  const rawLaunchpadStatus = Number(tokenInfo?.launchpad_status ?? Number.NaN);
  if (Number.isFinite(rawLaunchpadStatus) && rawLaunchpadStatus === 1) return 1;
  return hasConfirmedFlapOuterRoute(tokenInfo) ? 1 : 0;
}

function normalizeFlapPlatform(platform?: string | null): 'flap' | 'flap_stocks' {
  return String(platform || '').trim().toLowerCase() === 'flap_stocks' ? 'flap_stocks' : 'flap';
}

function isTerminalFlapQuoteToken(chainId: number, quoteTokenAddress?: string | null): boolean {
  const quote = String(quoteTokenAddress || '').trim().toLowerCase();
  if (!quote) return true;
  if (chainId === 56) return BSC_FLAP_TERMINAL_QUOTES.has(quote);
  return quote === ZERO_ADDRESS;
}

export function hasNonTerminalFlapOuterQuote(
  chainId: number,
  tokenInfo?: Partial<Pick<TokenInfo, 'launchpad_status' | 'quote_token_address'>> | null,
): boolean {
  if (!tokenInfo) return false;
  if (chainId !== 56) return false;
  if (normalizeFlapLaunchpadStatus(chainId, tokenInfo) !== 1) return false;
  const quote = String(tokenInfo.quote_token_address || '').trim();
  if (!isAddressLike(quote)) return false;
  return !isTerminalFlapQuoteToken(chainId, quote);
}

export function resolveFlapPlatform(
  chainId: number,
  tokenInfo?: Partial<Pick<TokenInfo,
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
    | 'flap_vault_is_vault'
    | 'flap_outer_quote_is_stocks'
    | 'flap_basket_token'
    | 'flap_supported_assets'
  >> | null,
  requestedPlatform?: string | null,
): 'flap' | 'flap_stocks' {
  const requested = resolveTokenLaunchpadPlatform({
    address: tokenInfo?.address,
    launchpad_platform: normalizeFlapPlatform(requestedPlatform) === 'flap_stocks'
      ? requestedPlatform
      : tokenInfo?.launchpad_platform,
    requestedPlatform,
  }) || 'flap';
  return classifyFlapRoute(chainId, {
    ...(tokenInfo ?? {}),
    launchpad_platform: requested,
  } as TokenInfo).platform;
}

export function hasConfirmedFlapLaunchpadIdentity(
  chainId: number,
  tokenInfo?: Partial<Pick<TokenInfo,
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
    | 'tokenVersion'
    | 'extensionID'
    | 'nativeToQuoteSwapEnabled'
    | 'flap_stocks_vault_version'
    | 'flap_dividend_token'
    | 'flap_vault_address'
    | 'flap_vault_factory'
    | 'flap_vault_is_official'
    | 'flap_vault_is_vault'
    | 'flap_outer_quote_is_stocks'
    | 'flap_basket_token'
    | 'flap_supported_assets'
  >> | null,
): boolean {
  if (!tokenInfo) return false;
  if (classifyFlapRoute(chainId, tokenInfo).isFlapStocks) return true;
  if (hasConfirmedFlapStocksIdentity(chainId, tokenInfo)) return true;
  if (isFlapSuffixAddress(tokenInfo.address)) return true;
  if (Number(tokenInfo.tokenVersion ?? 0) > 0) return true;
  if (tokenInfo.nativeToQuoteSwapEnabled === true) return true;
  const extensionID = String(tokenInfo.extensionID || '').trim().toLowerCase();
  return !!extensionID && extensionID !== '0x' && extensionID !== '0x0';
}

export async function resolveFlapPlatformByQuoteLineage(
  chainId: number,
  tokenInfo: Partial<Pick<TokenInfo,
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
    | 'tokenVersion'
    | 'extensionID'
    | 'nativeToQuoteSwapEnabled'
    | 'flap_stocks_vault_version'
    | 'flap_dividend_token'
    | 'flap_vault_address'
    | 'flap_vault_factory'
    | 'flap_vault_is_official'
    | 'flap_vault_is_vault'
    | 'flap_outer_quote_is_stocks'
    | 'flap_basket_token'
    | 'flap_supported_assets'
  >> | null,
  requestedPlatform: string | null | undefined,
  resolveQuoteTokenInfo: (quoteTokenAddress: `0x${string}`) => Promise<Partial<TokenInfo> | null>,
): Promise<'flap' | 'flap_stocks'> {
  const resolvedPlatform = resolveFlapPlatform(chainId, tokenInfo, requestedPlatform);
  if (resolvedPlatform === 'flap_stocks' || !tokenInfo) return resolvedPlatform;

  const flapRoute = classifyFlapRoute(chainId, {
    ...(tokenInfo ?? {}),
    launchpad_platform: resolvedPlatform,
  });
  if (!flapRoute.isOuter) return resolvedPlatform;

  const tokenAddress = String(tokenInfo.address || '').trim().toLowerCase();
  const quoteTokenAddress = String(tokenInfo.quote_token_address || '').trim();
  if (!isAddressLike(quoteTokenAddress)) return resolvedPlatform;
  if (quoteTokenAddress.toLowerCase() === tokenAddress) return resolvedPlatform;
  if (isTerminalFlapQuoteToken(chainId, quoteTokenAddress)) return resolvedPlatform;

  const quoteTokenInfo = await resolveQuoteTokenInfo(quoteTokenAddress as `0x${string}`).catch(() => null);
  if (!quoteTokenInfo) return resolvedPlatform;
  return hasConfirmedFlapStocksIdentity(chainId, quoteTokenInfo)
    || classifyFlapRoute(chainId, quoteTokenInfo).isFlapStocks
    ? 'flap_stocks'
    : resolvedPlatform;
}

export function classifyFlapRoute(
  chainId: number,
  tokenInfo?: Partial<Pick<TokenInfo,
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
    | 'flap_vault_is_vault'
    | 'flap_outer_quote_is_stocks'
    | 'flap_basket_token'
    | 'flap_supported_assets'
  >> | null,
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
  const businessLaunchpadStatus = normalizeFlapLaunchpadStatus(chainId, tokenInfo);
  const isOuter = businessLaunchpadStatus === 1;
  const isInner = !isOuter;
  const isFlapStocks = isInner
    ? normalizeFlapPlatform(tokenInfo?.launchpad_platform) === 'flap_stocks'
    : tokenInfo?.flap_outer_quote_is_stocks === true
      || hasNonTerminalFlapOuterQuote(chainId, tokenInfo)
      || hasConfirmedFlapStocksIdentity(chainId, tokenInfo);
  return {
    isInner,
    isOuter,
    isFlapStocks,
    platform: isFlapStocks ? 'flap_stocks' : 'flap',
    rawLaunchpadStatus: normalizedLaunchpadStatus,
    hasConfirmedOuterRoute,
  };
}
