import type { Address, SwapDescLike } from './tradeTypes';
import { isTradeRouteNativeToken, normalizeTradeRouteToken } from '@/utils/tradeRouteTerminals';

/** Native-rooted outer-market routes for any quote token, not Flap-only. */
const OUTER_MARKET_ROUTE_CACHE_MS = 24 * 60 * 60_000;

type CachedRoute = {
  ts: number;
  value: SwapDescLike[];
};

const nativeRouteCache = new Map<string, CachedRoute>();
const nativeRouteInFlight = new Map<string, Promise<SwapDescLike[] | null>>();

function cacheKey(chainId: number, token: Address): string {
  return `tradable-res-v1:${chainId}:${String(token || '').trim().toLowerCase()}`;
}

function cloneDescs(descs: SwapDescLike[] | null | undefined): SwapDescLike[] | null {
  if (!descs) return null;
  return descs.map((desc) => ({ ...desc }));
}

function sameRouteToken(chainId: number, left?: string | null, right?: string | null): boolean {
  const a = normalizeTradeRouteToken(chainId, left);
  const b = normalizeTradeRouteToken(chainId, right);
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

export function getOuterMarketRoute(chainId: number, token: Address): SwapDescLike[] | null {
  const cached = nativeRouteCache.get(cacheKey(chainId, token));
  if (!cached) return null;
  if (Date.now() - cached.ts >= OUTER_MARKET_ROUTE_CACHE_MS) {
    nativeRouteCache.delete(cacheKey(chainId, token));
    return null;
  }
  return cloneDescs(cached.value);
}

export function setOuterMarketRoute(chainId: number, token: Address, descs: SwapDescLike[]): void {
  if (!descs.length) return;
  if (!isTradeRouteNativeToken(chainId, descs[0]?.tokenIn)) return;
  if (!sameRouteToken(chainId, descs[descs.length - 1]?.tokenOut, token)) return;
  nativeRouteCache.set(cacheKey(chainId, token), {
    ts: Date.now(),
    value: cloneDescs(descs) ?? [],
  });
}

export function sliceOuterMarketRoute(
  chainId: number,
  fromToken: Address,
  toToken: Address,
): SwapDescLike[] | null {
  if (sameRouteToken(chainId, fromToken, toToken)) return [];
  const cached = getOuterMarketRoute(chainId, toToken);
  if (!cached?.length) return null;
  if (!sameRouteToken(chainId, cached[cached.length - 1]?.tokenOut, toToken)) return null;
  if (sameRouteToken(chainId, cached[0]?.tokenIn, fromToken)) return cached;
  const afterOut = cached.findIndex((desc) => sameRouteToken(chainId, desc.tokenOut, fromToken));
  if (afterOut >= 0) return cloneDescs(cached.slice(afterOut + 1)) ?? [];
  const atIn = cached.findIndex((desc) => sameRouteToken(chainId, desc.tokenIn, fromToken));
  if (atIn >= 0) return cloneDescs(cached.slice(atIn)) ?? [];
  return null;
}

export function getOuterMarketRouteInFlight(
  chainId: number,
  token: Address,
): Promise<SwapDescLike[] | null> | undefined {
  return nativeRouteInFlight.get(cacheKey(chainId, token));
}

export function setOuterMarketRouteInFlight(
  chainId: number,
  token: Address,
  task: Promise<SwapDescLike[] | null>,
): void {
  nativeRouteInFlight.set(cacheKey(chainId, token), task);
}

export function clearOuterMarketRouteInFlight(chainId: number, token: Address): void {
  nativeRouteInFlight.delete(cacheKey(chainId, token));
}
