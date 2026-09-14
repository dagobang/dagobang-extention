import { ChainId } from '@/constants/chains/chainId';
import { EVM_CHAIN_RUNTIME } from '@/constants/chains/evmRuntime';
import { isOpenFour4StockName, OPENFOUR_4STOCK_QUOTE_FALLBACK } from '@/constants/openfour';
import { getBridgeTokenAddresses } from '@/constants/tokens/allTokens';
import { USDC, USDT } from '@/constants/tokens/chains/common';
import { bscTokens, bscBnbBridgePoolConfigByTokenAddress } from '@/constants/tokens/chains/bsc';
import { DeployAddress, OpenFourInnerLaunchpadManager } from '@/constants/contracts/address';
import { ContractNames } from '@/constants/contracts/names';
import type { QuickTradeRouteHop, QuickTradeRoutePreview } from '@/types/extention';
import type { TokenInfo } from '@/types/token';
import { classifyFlapRoute } from '@/utils/flap';
import { resolveTokenLaunchpadPlatform } from '@/utils/launchpadFamily';
import { resolveRouteTokenLabel } from '@/utils/quoteTokenLabels';

export type EvmTradeRouteHopKind = 'launchpad' | 'bridge' | 'market';

export type EvmTradeRoutePlanHop = QuickTradeRouteHop & {
  kind: EvmTradeRouteHopKind;
};

export type EvmTradeRoutePlan = QuickTradeRoutePreview & {
  hops: EvmTradeRoutePlanHop[];
  inner: boolean;
  platform: string;
};

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const FOUR_MEME_PLATFORMS = new Set([
  'fourmeme',
  'bn_fourmeme',
  'fourmeme_agent',
  'four_xmode_agent',
  'xmode',
  'xmode_agent',
]);

const OPEN_FOUR_PLATFORMS = new Set([
  'openfour',
  'likwid',
  'goplus_skills',
  'goplus_creator',
  'cubepeg',
]);

function isAddress(value?: string | null): value is `0x${string}` {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || '').trim());
}

function normalizeToken(chainId: number, address?: string | null): `0x${string}` | null {
  const raw = String(address || '').trim();
  if (!isAddress(raw)) return null;
  const wrapped = EVM_CHAIN_RUNTIME[chainId]?.wrappedNativeAddress.toLowerCase();
  if (raw.toLowerCase() === ZERO_ADDRESS || (wrapped && raw.toLowerCase() === wrapped)) return ZERO_ADDRESS;
  return raw as `0x${string}`;
}

function isTerminalQuote(chainId: number, address: `0x${string}`): boolean {
  const lower = address.toLowerCase();
  if (lower === ZERO_ADDRESS) return true;
  const wrapped = EVM_CHAIN_RUNTIME[chainId]?.wrappedNativeAddress.toLowerCase();
  if (wrapped && lower === wrapped) return true;
  return getBridgeTokenAddresses(chainId as ChainId).some((item) => item.toLowerCase() === lower);
}

function isBnc4(chainId: number, address?: string | null): boolean {
  return chainId === ChainId.BNB
    && !!address
    && address.toLowerCase() === OPENFOUR_4STOCK_QUOTE_FALLBACK.address.toLowerCase();
}

function usdtAddress(chainId: number): `0x${string}` | null {
  const token = USDT[chainId as ChainId]?.address ?? (chainId === ChainId.BNB ? bscTokens.usdt.address : null);
  return token ? token as `0x${string}` : null;
}

function usdgAddress(chainId: number): `0x${string}` | null {
  const token = USDC[chainId as ChainId]?.address;
  return token ? token as `0x${string}` : null;
}

function labelToken(chainId: number, address: `0x${string}`, tokenInfo: TokenInfo): string {
  return resolveRouteTokenLabel({
    chainId,
    address,
    tokenInfo,
  });
}

function isLikelyOpenFour4Stock(tokenInfo: TokenInfo): boolean {
  return isOpenFour4StockName(tokenInfo.symbol || '', tokenInfo.name)
    || isOpenFour4StockName(tokenInfo.name || '')
    || String(tokenInfo.quote_token || '').toUpperCase() === 'BNC4'
    || isBnc4(ChainId.BNB, tokenInfo.quote_token_address)
    || String(tokenInfo.tpool_launch_type || '').toLowerCase().includes('4stock');
}

export function resolveEvmTradeQuoteToken(chainId: number, tokenInfo: TokenInfo): `0x${string}` | null {
  if (chainId === ChainId.BNB && isLikelyOpenFour4Stock(tokenInfo)) {
    return OPENFOUR_4STOCK_QUOTE_FALLBACK.address;
  }
  if (isBnc4(chainId, tokenInfo.quote_token_address) || String(tokenInfo.quote_token || '').toUpperCase() === 'BNC4') {
    return OPENFOUR_4STOCK_QUOTE_FALLBACK.address;
  }
  const raw = normalizeToken(chainId, tokenInfo.quote_token_address);
  if (raw && !isTerminalQuote(chainId, raw)) return raw;
  if (raw) return raw;
  // Robinhood tokens often omit quote_token_address on GMGN; default to native like the live pool.
  if (chainId === ChainId.RH) return ZERO_ADDRESS;
  return null;
}

function isPonsPlatformName(platform: string): boolean {
  return platform === 'pons' || platform.startsWith('pons_');
}

function isInnerLaunchpad(chainId: number, tokenInfo: TokenInfo, platform: string): boolean {
  if (platform.startsWith('flap')) return classifyFlapRoute(chainId, tokenInfo).isInner;
  if (isPonsPlatformName(platform)) return tokenInfo.launchpad_status !== 1;
  if (FOUR_MEME_PLATFORMS.has(platform) || OPEN_FOUR_PLATFORMS.has(platform)) {
    return tokenInfo.launchpad_status !== 1;
  }
  return tokenInfo.launchpad_status !== 1 && !!tokenInfo.launchpad;
}

function dexTypeLooksV4(tokenInfo: TokenInfo): boolean {
  return String(tokenInfo.dex_type || '').toLowerCase().includes('v4');
}

function dexTypeLooksV3(tokenInfo: TokenInfo): boolean {
  const dex = String(tokenInfo.dex_type || '').toLowerCase();
  return dex.includes('v3') || dex.includes('clmm');
}

function lastHopDex(chainId: number, platform: string, inner: boolean, tokenInfo: TokenInfo): string {
  if (!inner) {
    // Pons v2 outer (and unlabeled pons outer) graduates to Uniswap v4, not v2.
    if (platform === 'pons_v2' || (isPonsPlatformName(platform) && platform !== 'pons_v1') || dexTypeLooksV4(tokenInfo)) {
      return 'V4';
    }
    if (platform === 'pons_v1' || dexTypeLooksV3(tokenInfo)) return 'V3';
    return chainId === ChainId.RH ? 'V3' : 'V2';
  }
  if (isPonsPlatformName(platform)) return 'pons';
  if (FOUR_MEME_PLATFORMS.has(platform)) return 'four.meme';
  if (OPEN_FOUR_PLATFORMS.has(platform)) return 'OpenFour';
  if (platform.startsWith('flap')) return 'Flap';
  return 'DEX';
}

function lastHopFee(platform: string, inner: boolean): number | null {
  if (inner) return null;
  if (platform === 'pons_v1') return 10000;
  return null;
}

function lastHopPool(chainId: number, tokenInfo: TokenInfo, platform: string, inner: boolean): string | null {
  if (inner) {
    if (isPonsPlatformName(platform)) {
      const pool = String(tokenInfo.pool_pair || '').trim();
      return isAddress(pool) ? pool : null;
    }
    const contracts = DeployAddress[chainId as ChainId] || {};
    if (FOUR_MEME_PLATFORMS.has(platform)) {
      return contracts[ContractNames.FourMemeTokenManagerV2]?.address ?? null;
    }
    if (platform.startsWith('flap')) {
      return contracts[ContractNames.FlapshTokenManager]?.address ?? null;
    }
    if (OPEN_FOUR_PLATFORMS.has(platform)) return OpenFourInnerLaunchpadManager;
    return null;
  }
  const pool = String(tokenInfo.pool_pair || tokenInfo.biggest_pool_address || '').trim();
  if (isAddress(pool)) return pool;
  if (chainId === ChainId.RH && lastHopDex(chainId, platform, inner, tokenInfo) === 'V4') {
    return DeployAddress[ChainId.RH]?.[ContractNames.PoolManager]?.address ?? null;
  }
  return null;
}

function makeHop(
  chainId: number,
  tokenInfo: TokenInfo,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  kind: EvmTradeRouteHopKind,
  dexLabel: string,
  poolAddress?: string | null,
  fee?: number | null,
): EvmTradeRoutePlanHop {
  return {
    tokenIn,
    tokenOut,
    tokenInSymbol: labelToken(chainId, tokenIn, tokenInfo),
    tokenOutSymbol: labelToken(chainId, tokenOut, tokenInfo),
    dexLabel,
    poolAddress: poolAddress || null,
    fee: fee ?? null,
    kind,
  };
}

function nativeStableHop(chainId: number, tokenInfo: TokenInfo, tokenOut: `0x${string}`): EvmTradeRoutePlanHop | null {
  const usdt = usdtAddress(chainId);
  const usdc = USDC[chainId as ChainId]?.address as `0x${string}` | undefined;
  const target = tokenOut.toLowerCase();
  if (usdt && target === usdt.toLowerCase()) {
    const pool = chainId === ChainId.BNB
      ? bscBnbBridgePoolConfigByTokenAddress[usdt.toLowerCase()]
      : null;
    return makeHop(
      chainId,
      tokenInfo,
      ZERO_ADDRESS,
      tokenOut,
      'bridge',
      pool?.kind === 'v3' ? 'V3' : 'V2',
      pool?.poolAddress ?? null,
      pool && 'fee' in pool ? pool.fee : null,
    );
  }
  if (usdc && target === usdc.toLowerCase()) {
    return makeHop(
      chainId,
      tokenInfo,
      ZERO_ADDRESS,
      tokenOut,
      'bridge',
      'V3',
      null,
      chainId === ChainId.RH ? 500 : 3000,
    );
  }
  return null;
}

export function planEvmTradeRoute(input: {
  chainId: number;
  tokenInfo: TokenInfo;
  tokenAddress?: string;
  baseTokenAddress?: string;
}): EvmTradeRoutePlan | null {
  if (input.chainId === ChainId.SOL || input.chainId === ChainId.HYPER) return null;
  const tokenAddress = normalizeToken(input.chainId, input.tokenAddress || input.tokenInfo.address);
  if (!tokenAddress || tokenAddress === ZERO_ADDRESS) return null;
  const platform = resolveTokenLaunchpadPlatform({
    address: input.tokenInfo.address,
    launchpad: input.tokenInfo.launchpad,
    launchpad_platform: input.tokenInfo.launchpad_platform,
  });
  const inner = isInnerLaunchpad(input.chainId, input.tokenInfo, platform);
  const quote = resolveEvmTradeQuoteToken(input.chainId, input.tokenInfo);
  if (!quote) return null;
  const hops: EvmTradeRoutePlanHop[] = [];
  let current: `0x${string}` = normalizeToken(input.chainId, input.baseTokenAddress) ?? ZERO_ADDRESS;
  const usdt = usdtAddress(input.chainId);

  if (quote && quote.toLowerCase() !== current.toLowerCase() && !isTerminalQuote(input.chainId, quote)) {
    if (isBnc4(input.chainId, quote) && usdt && current === ZERO_ADDRESS) {
      const first = nativeStableHop(input.chainId, input.tokenInfo, usdt);
      if (first) hops.push(first);
      hops.push(makeHop(input.chainId, input.tokenInfo, usdt, quote, 'market', 'V2'));
      current = quote;
    } else if (input.chainId === ChainId.RH && current === ZERO_ADDRESS) {
      const usdg = usdgAddress(input.chainId);
      if (usdg && usdg.toLowerCase() !== quote.toLowerCase()) {
        const first = nativeStableHop(input.chainId, input.tokenInfo, usdg);
        if (first) hops.push(first);
        hops.push(makeHop(input.chainId, input.tokenInfo, usdg, quote, 'market', 'V3'));
        current = quote;
      } else {
        hops.push(makeHop(input.chainId, input.tokenInfo, current, quote, 'market', 'V3'));
        current = quote;
      }
    } else {
      hops.push(makeHop(input.chainId, input.tokenInfo, current, quote, 'market', 'V2'));
      current = quote;
    }
  } else if (quote && isTerminalQuote(input.chainId, quote) && quote !== ZERO_ADDRESS && current === ZERO_ADDRESS) {
    const bridge = nativeStableHop(input.chainId, input.tokenInfo, quote);
    if (bridge) {
      hops.push(bridge);
      current = quote;
    }
  }

  if (current.toLowerCase() !== tokenAddress.toLowerCase()) {
    hops.push(makeHop(
      input.chainId,
      input.tokenInfo,
      current,
      tokenAddress,
      inner ? 'launchpad' : 'market',
      lastHopDex(input.chainId, platform, inner, input.tokenInfo),
      lastHopPool(input.chainId, input.tokenInfo, platform, inner),
      lastHopFee(platform, inner),
    ));
  }
  if (!hops.length) return null;
  const symbols = [hops[0].tokenInSymbol, ...hops.map((hop) => hop.tokenOutSymbol)];
  return {
    buyLabel: symbols.join(' → '),
    sellLabel: [...symbols].reverse().join(' → '),
    hops,
    inner,
    platform,
  };
}

export function buildFastQuickTradeRoutePreview(input: {
  chainId: number;
  tokenInfo: TokenInfo;
  tokenAddress?: string;
  baseTokenAddress?: string;
}): QuickTradeRoutePreview | null {
  const plan = planEvmTradeRoute(input);
  if (!plan) return null;
  return {
    buyLabel: plan.buyLabel,
    sellLabel: plan.sellLabel,
    hops: plan.hops,
  };
}
