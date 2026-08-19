import { browser } from 'wxt/browser';
import { ChainId } from '@/constants/chains/chainId';
import { SettingsService } from '@/services/settings';
import { TokenService } from '@/services/token';
import { getLimitOrders } from '@/services/storage';
import { applyTrailingStopUpdate, hitLimitOrder, normalizeLimitOrderType, patchLimitOrder } from '@/services/limitOrders/store';
import { getWalletAdapter } from '@/services/chain/registry';
import { buildScopedTokenKey } from '@/services/xSniper/engine/metrics';
import { normalizePriceValue } from '@/utils/format';
import { classifyFlapRoute } from '@/utils/flap';
import type { LimitOrder, LimitOrderScanStatus } from '@/types/extention';

const LIMIT_SCAN_ALARM = 'limitOrder:scan';
const LIMIT_SCAN_INTERVAL_DEFAULT_MS = 3000;
const LIMIT_SCAN_INTERVAL_OPTIONS_MS = [1000, 3000, 5000, 10000, 30000, 60000, 120000] as const;
const ORDER_EXECUTE_MAX_RETRY = 2;
const EXTERNAL_PRICE_TTL_MS = 10000;

const isRetryableOrderError = (rawMessage: string) => {
  const msg = rawMessage.toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('network') ||
    msg.includes('nonce') ||
    msg.includes('underpriced') ||
    msg.includes('already known') ||
    msg.includes('temporarily unavailable') ||
    msg.includes('429') ||
    msg.includes('503')
  );
};

const getRetryDelayMs = (retryCount: number) => {
  if (retryCount <= 0) return 1500;
  if (retryCount === 1) return 3000;
  return 5000;
};

const normalizeLimitScanIntervalMs = (value: any) => {
  const v = Math.floor(Number(value));
  if (!Number.isFinite(v)) return LIMIT_SCAN_INTERVAL_DEFAULT_MS;
  if (LIMIT_SCAN_INTERVAL_OPTIONS_MS.includes(v as any)) return v;
  return LIMIT_SCAN_INTERVAL_DEFAULT_MS;
};

export const createLimitOrderScanner = (deps: {
  executeLimitOrder: (order: LimitOrder, ctx?: { priceUsd?: number }) => Promise<string>;
  resolveLatestTokenInfo?: (input: { chainId: number; tokenAddress: string; tokenInfo?: any | null }) => Promise<any | null>;
  onStateChanged: () => void;
  onOrderFailed?: (input: { order: LimitOrder; error: string }) => void;
  onObserveOrder?: (input: { order: LimitOrder; tokenInfo?: any | null }) => void;
}) => {
  let limitScanIntervalMs = LIMIT_SCAN_INTERVAL_DEFAULT_MS;
  const limitScanPricesByTokenKey = new Map<string, { priceUsd: number; ts: number; source?: 'rpc' | 'gmgn' | 'external' | 'site' }>();
  const observedExternalPricesByTokenKey = new Map<string, { priceUsd: number; ts: number; source?: 'gmgn' | 'external' }>();
  const trackedTokensByKey = new Map<string, { chainId: number; tokenAddress: string; tokenInfo: any | null }>();
  let limitScanRunning = false;
  let limitScanLastAtMs = 0;
  let limitScanLastOk = true;
  let limitScanLastError: string | null = null;

  const toPriceKey = (chainId: number, tokenAddress: string) => buildScopedTokenKey(chainId, tokenAddress);

  const upsertDisplayPrice = (
    chainId: number,
    tokenAddress: string,
    priceUsd: number,
    ts = Date.now(),
    source: 'rpc' | 'gmgn' | 'external' | 'site' = 'rpc',
  ) => {
    const scanPriceUsd = normalizePriceValue(priceUsd, 4, 6);
    if (!Number.isFinite(scanPriceUsd) || scanPriceUsd <= 0) return false;
    const priceKey = toPriceKey(chainId, tokenAddress);
    const prevPrice = limitScanPricesByTokenKey.get(priceKey);
    limitScanPricesByTokenKey.set(priceKey, { priceUsd: scanPriceUsd, ts, source });
    return !prevPrice || prevPrice.priceUsd !== scanPriceUsd || prevPrice.ts !== ts || prevPrice.source !== source;
  };

  const refreshIntervalFromSettings = async () => {
    try {
      const settings = await SettingsService.get();
      limitScanIntervalMs = normalizeLimitScanIntervalMs((settings as any).limitOrderScanIntervalMs);
    } catch {
    }
  };

  const scheduleNext = (delayMs: number) => {
    try {
      const safeDelayMs = Number.isFinite(delayMs) ? Math.max(0, delayMs) : limitScanIntervalMs;
      (browser as any).alarms?.create(LIMIT_SCAN_ALARM, { when: Date.now() + safeDelayMs });
    } catch {
    }
  };

  const scheduleFromStorage = async () => {
    let hasOpen = trackedTokensByKey.size > 0;
    try {
      const all = await getLimitOrders();
      hasOpen = hasOpen || all.some((o) => o.status === 'open');
    } catch {
    }
    if (!hasOpen) {
      try {
        (browser as any).alarms?.clear?.(LIMIT_SCAN_ALARM);
      } catch {
      }
      return;
    }
    scheduleNext(limitScanIntervalMs);
  };

  const scanOnce = async () => {
    if (limitScanRunning) return;
    limitScanRunning = true;
    const startedAt = Date.now();
    limitScanLastOk = true;
    limitScanLastError = null;
    try {
      const all = await getLimitOrders();
      const openOrders = all.filter((o) => o.status === 'open');
      const walletStatusByChain = new Map<number, Awaited<ReturnType<ReturnType<typeof getWalletAdapter>['getStatus']>>>();
      for (const chainId of new Set(openOrders.map((o) => o.chainId))) {
        try {
          walletStatusByChain.set(chainId, await getWalletAdapter(chainId).getStatus());
        } catch {
        }
      }

      let changed = false;
      let softError: string | null = null;

      const byToken = new Map<string, { orders: LimitOrder[]; chainId: number; tokenAddress: string; tokenInfo: any | null }>();
      for (const o of openOrders) {
        const k = toPriceKey(o.chainId, o.tokenAddress);
        const current = byToken.get(k) ?? { orders: [], chainId: o.chainId, tokenAddress: o.tokenAddress, tokenInfo: o.tokenInfo ?? null };
        current.orders.push(o);
        if (!current.tokenInfo && o.tokenInfo) current.tokenInfo = o.tokenInfo;
        byToken.set(k, current);
      }
      for (const [k, tracked] of trackedTokensByKey.entries()) {
        if (byToken.has(k)) continue;
        byToken.set(k, { orders: [], chainId: tracked.chainId, tokenAddress: tracked.tokenAddress, tokenInfo: tracked.tokenInfo ?? null });
      }
      if (!byToken.size) return;

      for (const [, entry] of byToken) {
        const { orders, chainId, tokenAddress, tokenInfo } = entry;
        const base = orders[0] ?? null;
        const priceKey = toPriceKey(chainId, tokenAddress);
        const walletStatus = base ? (walletStatusByChain.get(chainId) ?? null) : null;
        const resolvedTokenInfo = deps.resolveLatestTokenInfo
          ? await deps.resolveLatestTokenInfo({ chainId, tokenAddress, tokenInfo: tokenInfo ?? null })
          : (tokenInfo ?? null);
        for (const order of orders) {
          deps.onObserveOrder?.({ order, tokenInfo: resolvedTokenInfo ?? order.tokenInfo ?? null });
        }
        if (resolvedTokenInfo && JSON.stringify(tokenInfo ?? null) !== JSON.stringify(resolvedTokenInfo)) {
          entry.tokenInfo = resolvedTokenInfo;
          for (const order of orders) {
            if (JSON.stringify(order.tokenInfo ?? null) === JSON.stringify(resolvedTokenInfo)) continue;
            await patchLimitOrder(order.id, { tokenInfo: resolvedTokenInfo });
            changed = true;
          }
        }
        let priceUsd = 0;
        let resolvedPriceSource: 'rpc' | 'gmgn' | 'external' | 'site' = 'rpc';
        const observedExternalPrice = (() => {
          const observed = observedExternalPricesByTokenKey.get(priceKey);
          if (!observed) return null;
          const ageMs = Date.now() - observed.ts;
          if (ageMs > EXTERNAL_PRICE_TTL_MS) return null;
          return observed;
        })();
        try {
          const platform = String(resolvedTokenInfo?.launchpad_platform || resolvedTokenInfo?.launchpad || '').toLowerCase();
          const launchpadStatus = Number(resolvedTokenInfo?.launchpad_status ?? Number.NaN);
          const flapRoute = platform.includes('flap')
            ? classifyFlapRoute(chainId, resolvedTokenInfo)
            : null;
          const allowTokenInfoPriceFallback = platform.includes('flap');
          const tokenInfoPriceUsd = Number(
            resolvedTokenInfo?.tokenPrice?.price
            ?? resolvedTokenInfo?.priceUsd
            ?? resolvedTokenInfo?.price
            ?? 0,
          );
          const preferTokenInfoPrice =
            Number.isFinite(tokenInfoPriceUsd) &&
            tokenInfoPriceUsd > 0 &&
            launchpadStatus !== 1 &&
            (
              platform.includes('four') ||
              platform.includes('altfun') ||
              platform.includes('flap')
            );
          if (flapRoute?.isOuter) {
            console.info('[limitOrder.price.request]', {
              chainId,
              tokenAddress,
              platform: resolvedTokenInfo?.launchpad_platform ?? resolvedTokenInfo?.launchpad ?? null,
              resolvedPlatform: flapRoute.platform,
              isFlapStocks: flapRoute.isFlapStocks,
              launchpadStatus: resolvedTokenInfo?.launchpad_status ?? null,
              quoteTokenAddress: resolvedTokenInfo?.quote_token_address ?? null,
              poolPair: resolvedTokenInfo?.pool_pair ?? null,
              biggestPoolAddress: resolvedTokenInfo?.biggest_pool_address ?? null,
              tpoolPoolAddress: resolvedTokenInfo?.tpool_pool_address ?? null,
              flapOuterQuoteIsStocks: resolvedTokenInfo?.flap_outer_quote_is_stocks ?? null,
              flapVaultIsVault: resolvedTokenInfo?.flap_vault_is_vault ?? null,
              flapStocksVaultVersion: resolvedTokenInfo?.flap_stocks_vault_version ?? null,
            });
          }
          if (observedExternalPrice) {
            priceUsd = observedExternalPrice.priceUsd;
            resolvedPriceSource = observedExternalPrice.source === 'gmgn' ? 'gmgn' : 'external';
          } else if (preferTokenInfoPrice) {
            priceUsd = tokenInfoPriceUsd;
            resolvedPriceSource = 'site';
          } else {
            priceUsd = await TokenService.getTokenPriceUsdFromRpc({
              chainId,
              tokenAddress,
              tokenInfo: resolvedTokenInfo,
              cacheTtlMs: limitScanIntervalMs,
                allowTokenInfoPriceFallback: chainId === ChainId.SOL || allowTokenInfoPriceFallback,
            });
          }
          console.info('[limitOrder.price.choose]', {
            chainId,
            tokenAddress,
            source: resolvedPriceSource,
            priceUsd,
            observedExternalPriceUsd: observedExternalPrice?.priceUsd ?? null,
            observedExternalPriceSource: observedExternalPrice?.source ?? null,
            tokenInfoPriceUsd,
            preferTokenInfoPrice,
            platform,
            launchpadStatus: Number.isFinite(launchpadStatus) ? launchpadStatus : null,
          });
          if (flapRoute?.isOuter) {
            console.info('[limitOrder.price.result]', {
              chainId,
              tokenAddress,
              priceUsd,
            });
          }
        } catch (e: any) {
          const msg = typeof e?.message === 'string' ? e.message : String(e);
          if (String(resolvedTokenInfo?.launchpad_platform || '').toLowerCase().includes('flap')) {
            console.warn('[limitOrder.price.error]', {
              chainId,
              tokenAddress,
              platform: resolvedTokenInfo?.launchpad_platform ?? null,
              launchpadStatus: resolvedTokenInfo?.launchpad_status ?? null,
              quoteTokenAddress: resolvedTokenInfo?.quote_token_address ?? null,
              error: msg,
            });
          }
          softError = msg;
          continue;
        }
        if (
          (!Number.isFinite(priceUsd) || priceUsd <= 0)
          && String(resolvedTokenInfo?.launchpad_platform || '').toLowerCase().includes('flap')
        ) {
          console.warn('[limitOrder.price.zero]', {
            chainId,
            tokenAddress,
            platform: resolvedTokenInfo?.launchpad_platform ?? null,
            launchpadStatus: resolvedTokenInfo?.launchpad_status ?? null,
            quoteTokenAddress: resolvedTokenInfo?.quote_token_address ?? null,
            poolPair: resolvedTokenInfo?.pool_pair ?? null,
            biggestPoolAddress: resolvedTokenInfo?.biggest_pool_address ?? null,
            tpoolPoolAddress: resolvedTokenInfo?.tpool_pool_address ?? null,
          });
        }
        if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;
        const scanPriceUsd = normalizePriceValue(priceUsd, 4, 6);
        if (!Number.isFinite(scanPriceUsd) || scanPriceUsd <= 0) continue;
        if (upsertDisplayPrice(
          chainId,
          tokenAddress,
          priceUsd,
          observedExternalPrice?.ts ?? Date.now(),
          resolvedPriceSource,
        )) changed = true;

        if (!base) {
          continue;
        }
        if (!walletStatus || walletStatus.locked || !walletStatus.address) continue;

        for (const o of orders) {
          const nowMs = Date.now();
          if (Number.isFinite(o.retryAtMs) && (o.retryAtMs as number) > nowMs) {
            continue;
          }
          const prepared = await applyTrailingStopUpdate(o, priceUsd);
          if (
            prepared.orderType === 'trailing_stop_sell' &&
            (
              prepared.triggerPriceUsd !== o.triggerPriceUsd ||
              prepared.trailingPeakPriceUsd !== o.trailingPeakPriceUsd
            )
          ) {
            changed = true;
          }
          const orderType = normalizeLimitOrderType(prepared.orderType, prepared.side);
          const hit = hitLimitOrder(orderType, priceUsd, prepared.triggerPriceUsd);
          if (!hit) continue;

          await patchLimitOrder(o.id, { status: 'triggered' as const, retryAtMs: undefined });
          changed = true;

          try {
            const txHash = await deps.executeLimitOrder({ ...prepared, status: 'triggered', tokenInfo: resolvedTokenInfo ?? prepared.tokenInfo }, { priceUsd });
            await patchLimitOrder(o.id, { status: 'executed' as const, txHash });
          } catch (e: any) {
            const msg = typeof e?.message === 'string' ? e.message : String(e);
            const retryCount = Number.isFinite(prepared.retryCount) ? Math.max(0, Math.floor(prepared.retryCount as number)) : 0;
            const nextRetryCount = retryCount + 1;
            const canRetry = nextRetryCount <= ORDER_EXECUTE_MAX_RETRY && isRetryableOrderError(msg);
            if (canRetry) {
              await patchLimitOrder(o.id, {
                status: 'open' as const,
                lastError: msg,
                retryCount: nextRetryCount,
                retryAtMs: Date.now() + getRetryDelayMs(retryCount),
              });
            } else {
              await patchLimitOrder(o.id, {
                status: 'failed' as const,
                lastError: msg,
                retryCount: nextRetryCount,
                retryAtMs: undefined,
              });
              deps.onOrderFailed?.({ order: prepared, error: msg });
            }
          }
        }
      }

      if (changed) deps.onStateChanged();
      limitScanLastOk = softError == null;
      limitScanLastError = softError;
    } catch (e: any) {
      const msg = typeof e?.message === 'string' ? e.message : String(e);
      limitScanLastOk = false;
      limitScanLastError = msg;
      throw e;
    } finally {
      limitScanLastAtMs = startedAt;
      limitScanRunning = false;
    }
  };

  const start = () => {
    try {
      (browser as any).alarms?.onAlarm?.addListener((alarm: any) => {
        if (!alarm || alarm.name !== LIMIT_SCAN_ALARM) return;
        scanOnce()
          .catch(() => { })
          .finally(() => {
            scheduleFromStorage().catch(() => { });
          });
      });
      refreshIntervalFromSettings()
        .catch(() => { })
        .finally(() => {
          scheduleFromStorage().catch(() => { });
        });
    } catch {
    }
  };

  const setIntervalMsFromValue = (value: any) => {
    limitScanIntervalMs = normalizeLimitScanIntervalMs(value);
    try {
      (browser as any).alarms?.clear?.(LIMIT_SCAN_ALARM);
    } catch {
    }
    scheduleFromStorage().catch(() => { });
  };

  const getStatus = async (chainId: number): Promise<LimitOrderScanStatus> => {
    let totalOrders = 0;
    let openOrders = 0;
    try {
      const all = await getLimitOrders();
      totalOrders = all.filter((o) => o.chainId === chainId).length;
      openOrders = all.filter((o) => o.chainId === chainId && o.status === 'open').length;
    } catch {
    }

    const pricesByTokenKey: Record<string, { priceUsd: number; ts: number; source?: 'rpc' | 'gmgn' | 'external' | 'site' }> = {};
    for (const [k, v] of limitScanPricesByTokenKey.entries()) {
      if (k.startsWith(`${chainId}:`)) pricesByTokenKey[k] = v;
    }

    return {
      intervalMs: limitScanIntervalMs,
      running: limitScanRunning,
      lastScanAtMs: limitScanLastAtMs,
      lastScanOk: limitScanLastOk,
      lastScanError: limitScanLastError,
      totalOrders,
      openOrders,
      pricesByTokenKey,
    };
  };

  return {
    start,
    scheduleFromStorage,
    setIntervalMsFromValue,
    getStatus,
    refreshNow: async () => {
      await refreshIntervalFromSettings();
      await scanOnce().catch(() => { });
      await scheduleFromStorage().catch(() => { });
    },
    setTrackedToken: async (input: { chainId: number; tokenAddress: string; tokenInfo?: any | null; active: boolean }) => {
      const priceKey = toPriceKey(input.chainId, input.tokenAddress);
      if (input.active) {
        const prev = trackedTokensByKey.get(priceKey);
        trackedTokensByKey.set(priceKey, {
          chainId: input.chainId,
          tokenAddress: input.tokenAddress,
          tokenInfo: input.tokenInfo
            ? {
              ...(prev?.tokenInfo ?? {}),
              ...input.tokenInfo,
              tokenPrice: input.tokenInfo?.tokenPrice ?? prev?.tokenInfo?.tokenPrice,
            }
            : (prev?.tokenInfo ?? null),
        });
      } else {
        trackedTokensByKey.delete(priceKey);
      }
      await scheduleFromStorage().catch(() => { });
    },
    observeExternalPrice: (input: { chainId: number; tokenAddress: string; priceUsd: number; ts?: number; source?: 'gmgn' | 'external' }) => {
      const priceUsd = Number(input.priceUsd);
      if (!Number.isFinite(priceUsd) || priceUsd <= 0) return false;
      const ts = Number.isFinite(input.ts) ? Math.max(0, Number(input.ts)) : Date.now();
      const source = input.source === 'gmgn' ? 'gmgn' : 'external';
      const priceKey = toPriceKey(input.chainId, input.tokenAddress);
      observedExternalPricesByTokenKey.set(priceKey, { priceUsd, ts, source });
      return upsertDisplayPrice(input.chainId, input.tokenAddress, priceUsd, ts, source);
    },
  };
};
