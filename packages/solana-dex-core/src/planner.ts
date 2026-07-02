import { getSolanaTokenInfoRouteFingerprint, resolveSolanaTradeSource } from './constants';
import { getSolanaTradeAdapter } from './registry';
import type { SolanaTradeAdapter, SolanaTradePlan, SolanaTradeRequest, SolanaTradeSource } from './types';

const LIGHTWEIGHT_DIRECT_SOURCES = new Set<SolanaTradeSource>([
  'pumpfun',
  'pumpswap',
  'bonk',
  'raydium',
  'meteora',
]);

const PLAN_CACHE_TTL_MS = 15_000;

type PlanCacheEntry = {
  promise: Promise<{
    plan: SolanaTradePlan;
    adapter: SolanaTradeAdapter;
  }>;
  expiresAt: number;
};

const planCache = new Map<string, PlanCacheEntry>();

function resolvePlatform(input: SolanaTradeRequest): string {
  return String(input.tokenInfo?.launchpad_platform || input.tokenInfo?.launchpad || '').trim().toLowerCase();
}

function getPlanCacheKey(input: SolanaTradeRequest): string {
  return [
    resolvePlatform(input),
    getSolanaTokenInfoRouteFingerprint(input.tokenInfo),
    input.side,
    input.inputMint,
    input.outputMint,
  ].join('|');
}

async function planSolanaTradeUncached(input: SolanaTradeRequest): Promise<{
  plan: SolanaTradePlan;
  adapter: SolanaTradeAdapter;
}> {
  const platform = resolvePlatform(input);
  const tokenAddress = input.side === 'buy' ? input.outputMint : input.inputMint;
  const sourceResolution = resolveSolanaTradeSource({
    tokenInfo: input.tokenInfo,
    tokenAddress,
  });
  const { knownDirectSource, preferredSource, forceDirectOnly } = sourceResolution;

  if (knownDirectSource) {
    const knownAdapter = getSolanaTradeAdapter(knownDirectSource);
    return {
      plan: {
        source: knownDirectSource,
        mode: knownAdapter.capability.mode,
        reason: `tokenInfo:${knownDirectSource}`,
      },
      adapter: knownAdapter,
    };
  }

  if (preferredSource && LIGHTWEIGHT_DIRECT_SOURCES.has(preferredSource)) {
    const preferredAdapter = getSolanaTradeAdapter(preferredSource);
    return {
      plan: {
        source: preferredSource,
        mode: preferredAdapter.capability.mode,
        reason: `platform:${platform}`,
      },
      adapter: preferredAdapter,
    };
  }

  if (forceDirectOnly) {
    throw new Error(`No direct Solana adapter available for platform:${platform}`);
  }

  const fallback = getSolanaTradeAdapter('jupiter');
  return {
    plan: {
      source: 'jupiter',
      mode: 'aggregator',
      reason: platform ? `fallback:jupiter:${platform}` : 'fallback:jupiter',
    },
    adapter: fallback,
  };
}

export async function planSolanaTrade(input: SolanaTradeRequest): Promise<{
  plan: SolanaTradePlan;
  adapter: SolanaTradeAdapter;
}> {
  const key = getPlanCacheKey(input);
  const now = Date.now();
  const cached = planCache.get(key);
  if (cached && cached.expiresAt > now) return await cached.promise;
  const promise = planSolanaTradeUncached(input).catch((error) => {
    planCache.delete(key);
    throw error;
  });
  planCache.set(key, {
    promise,
    expiresAt: now + PLAN_CACHE_TTL_MS,
  });
  return await promise;
}

export async function prewarmSolanaTradePlan(input: SolanaTradeRequest): Promise<void> {
  await planSolanaTrade(input);
}
