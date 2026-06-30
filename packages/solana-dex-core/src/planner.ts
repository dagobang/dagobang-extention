import { getSolanaTokenInfoRouteFingerprint, resolveKnownSolanaDirectSource, resolveSolanaSourceAlias } from './constants';
import { getSolanaTradeAdapter, getSolanaTradeAdapters } from './registry';
import type { SolanaTradeAdapter, SolanaTradePlan, SolanaTradeRequest } from './types';

const DIRECT_ONLY_PLATFORMS = new Set([
  'pump',
  'pumpfun',
  'pump.fun',
  'pumpswap',
  'pump_swap',
  'pumpamm',
  'pump amm',
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
  const knownDirectSource = resolveKnownSolanaDirectSource(input.tokenInfo, tokenAddress);
  const forceDirectOnly = DIRECT_ONLY_PLATFORMS.has(platform);
  const preferredSource = resolveSolanaSourceAlias(platform);
  // #region debug-point P4:planner-start
  fetch('http://127.0.0.1:7778/event', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: 'pumpfun-legacy-route',
      runId: 'post-fix',
      hypothesisId: 'P4',
      location: 'planner.ts:planSolanaTrade',
      msg: '[DEBUG] planner start',
      data: { platform, preferredSource, forceDirectOnly, side: input.side, inputMint: input.inputMint, outputMint: input.outputMint },
      ts: Date.now(),
    }),
  }).catch(() => { });
  // #endregion

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

  if (preferredSource && preferredSource !== 'jupiter') {
    const preferredAdapter = getSolanaTradeAdapter(preferredSource);
    const preferredSupported = await preferredAdapter.supportsTrade(input);
    // #region debug-point P4:planner-preferred-result
    fetch('http://127.0.0.1:7778/event', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: 'pumpfun-legacy-route',
        runId: 'post-fix',
        hypothesisId: 'P4',
        location: 'planner.ts:planSolanaTrade',
        msg: '[DEBUG] planner preferred adapter result',
        data: { platform, preferredSource, preferredSupported },
        ts: Date.now(),
      }),
    }).catch(() => { });
    // #endregion
    if (preferredSupported) {
      return {
        plan: {
          source: preferredSource,
          mode: preferredAdapter.capability.mode,
          reason: `platform:${platform}`,
        },
        adapter: preferredAdapter,
      };
    }
  }

  for (const adapter of getSolanaTradeAdapters()) {
    if (adapter.capability.source === 'jupiter') continue;
    const supported = await adapter.supportsTrade(input);
    // #region debug-point P4:planner-adapter-scan
    fetch('http://127.0.0.1:7778/event', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: 'pumpfun-legacy-route',
        runId: 'post-fix',
        hypothesisId: 'P4',
        location: 'planner.ts:planSolanaTrade',
        msg: '[DEBUG] planner adapter scan result',
        data: { platform, adapter: adapter.capability.source, supported },
        ts: Date.now(),
      }),
    }).catch(() => { });
    // #endregion
    if (!supported) continue;
    return {
      plan: {
        source: adapter.capability.source,
        mode: adapter.capability.mode,
        reason: platform ? `platform:${platform}` : 'direct:auto',
      },
      adapter,
    };
  }

  if (forceDirectOnly) {
    // #region debug-point P4:planner-direct-only-fail
    fetch('http://127.0.0.1:7778/event', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: 'pumpfun-legacy-route',
        runId: 'post-fix',
        hypothesisId: 'P4',
        location: 'planner.ts:planSolanaTrade',
        msg: '[DEBUG] planner direct-only failed',
        data: { platform, side: input.side, inputMint: input.inputMint, outputMint: input.outputMint },
        ts: Date.now(),
      }),
    }).catch(() => { });
    // #endregion
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
