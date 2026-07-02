import { browser } from 'wxt/browser';
import { ChainId } from '@/constants/chains/chainId';
import { SettingsService } from '@/services/settings';
import { TokenService } from '@/services/token';
import { getLimitOrders } from '@/services/storage';
import { applyTrailingStopUpdate, hitLimitOrder, normalizeLimitOrderType, patchLimitOrder } from '@/services/limitOrders/store';
import { getWalletAdapter } from '@/services/chain/registry';
import { normalizePriceValue } from '@/utils/format';
import type { LimitOrder, LimitOrderScanStatus } from '@/types/extention';

const LIMIT_SCAN_ALARM = 'limitOrder:scan';
const LIMIT_SCAN_INTERVAL_DEFAULT_MS = 3000;
const LIMIT_SCAN_INTERVAL_OPTIONS_MS = [1000, 3000, 5000, 10000, 30000, 60000, 120000] as const;
const ORDER_EXECUTE_MAX_RETRY = 2;
const SOL_FRONTEND_PRICE_TTL_MS = 2000;

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
}) => {
  let limitScanIntervalMs = LIMIT_SCAN_INTERVAL_DEFAULT_MS;
  const limitScanPricesByTokenKey = new Map<string, { priceUsd: number; ts: number }>();
  const observedExternalPricesByTokenKey = new Map<string, { priceUsd: number; ts: number }>();
  const trackedTokensByKey = new Map<string, { chainId: number; tokenAddress: string; tokenInfo: any | null }>();
  let limitScanRunning = false;
  let limitScanLastAtMs = 0;
  let limitScanLastOk = true;
  let limitScanLastError: string | null = null;

  const toPriceKey = (chainId: number, tokenAddress: string) => `${chainId}:${tokenAddress.toLowerCase()}`;

  const upsertDisplayPrice = (chainId: number, tokenAddress: string, priceUsd: number, ts = Date.now()) => {
    const scanPriceUsd = normalizePriceValue(priceUsd, 4, 6);
    if (!Number.isFinite(scanPriceUsd) || scanPriceUsd <= 0) return false;
    const priceKey = toPriceKey(chainId, tokenAddress);
    const prevPrice = limitScanPricesByTokenKey.get(priceKey);
    limitScanPricesByTokenKey.set(priceKey, { priceUsd: scanPriceUsd, ts });
    return !prevPrice || prevPrice.priceUsd !== scanPriceUsd || prevPrice.ts !== ts;
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
        if (resolvedTokenInfo && JSON.stringify(tokenInfo ?? null) !== JSON.stringify(resolvedTokenInfo)) {
          entry.tokenInfo = resolvedTokenInfo;
          for (const order of orders) {
            if (JSON.stringify(order.tokenInfo ?? null) === JSON.stringify(resolvedTokenInfo)) continue;
            await patchLimitOrder(order.id, { tokenInfo: resolvedTokenInfo });
            changed = true;
          }
        }
        let priceUsd = 0;
        const observedExternalPrice = (() => {
          if (chainId !== ChainId.SOL) return null;
          const observed = observedExternalPricesByTokenKey.get(priceKey);
          if (!observed) return null;
          const ageMs = Date.now() - observed.ts;
          if (ageMs > SOL_FRONTEND_PRICE_TTL_MS) return null;
          return observed;
        })();
        try {
          if (observedExternalPrice) {
            priceUsd = observedExternalPrice.priceUsd;
          } else {
            priceUsd = await TokenService.getTokenPriceUsdFromRpc({
              chainId,
              tokenAddress,
              tokenInfo: resolvedTokenInfo,
              cacheTtlMs: limitScanIntervalMs,
              allowTokenInfoPriceFallback: chainId === ChainId.SOL,
            });
          }
        } catch (e: any) {
          const msg = typeof e?.message === 'string' ? e.message : String(e);
          softError = msg;
          continue;
        }
        if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;
        const scanPriceUsd = normalizePriceValue(priceUsd, 4, 6);
        if (!Number.isFinite(scanPriceUsd) || scanPriceUsd <= 0) continue;
        if (upsertDisplayPrice(chainId, tokenAddress, priceUsd, Date.now())) changed = true;

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

    const pricesByTokenKey: Record<string, { priceUsd: number; ts: number }> = {};
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
        trackedTokensByKey.set(priceKey, {
          chainId: input.chainId,
          tokenAddress: input.tokenAddress,
          tokenInfo: input.tokenInfo ?? null,
        });
      } else {
        trackedTokensByKey.delete(priceKey);
      }
      await scheduleFromStorage().catch(() => { });
    },
    observeExternalPrice: (input: { chainId: number; tokenAddress: string; priceUsd: number; ts?: number }) => {
      const priceUsd = Number(input.priceUsd);
      if (!Number.isFinite(priceUsd) || priceUsd <= 0) return false;
      const ts = Number.isFinite(input.ts) ? Math.max(0, Number(input.ts)) : Date.now();
      const priceKey = toPriceKey(input.chainId, input.tokenAddress);
      observedExternalPricesByTokenKey.set(priceKey, { priceUsd, ts });
      return upsertDisplayPrice(input.chainId, input.tokenAddress, priceUsd, ts);
    },
  };
};
