import { browser } from 'wxt/browser';
import { WalletService } from '@/services/wallet';
import { SettingsService } from '@/services/settings';
import { TokenService } from '@/services/token';
import { getLimitOrders } from '@/services/storage';
import { applyTrailingStopUpdate, hitLimitOrder, normalizeLimitOrderType, patchLimitOrder } from '@/services/limitOrders/store';
import { normalizePriceValue } from '@/utils/format';
import type { LimitOrder, LimitOrderScanStatus } from '@/types/extention';

const LIMIT_SCAN_ALARM = 'limitOrder:scan';
const LIMIT_SCAN_INTERVAL_DEFAULT_MS = 3000;
const LIMIT_SCAN_INTERVAL_OPTIONS_MS = [1000, 3000, 5000, 10000, 30000, 60000, 120000] as const;
const ORDER_EXECUTE_MAX_RETRY = 2;

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
  executeLimitOrder: (order: LimitOrder, ctx?: { priceUsd?: number }) => Promise<`0x${string}`>;
  onStateChanged: () => void;
  onOrderFailed?: (input: { order: LimitOrder; error: string }) => void;
}) => {
  let limitScanIntervalMs = LIMIT_SCAN_INTERVAL_DEFAULT_MS;
  const limitScanPricesByTokenKey = new Map<string, { priceUsd: number; ts: number }>();
  let limitScanRunning = false;
  let limitScanLastAtMs = 0;
  let limitScanLastOk = true;
  let limitScanLastError: string | null = null;

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
    let hasOpen = false;
    try {
      const all = await getLimitOrders();
      hasOpen = all.some((o) => o.status === 'open');
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
      if (!openOrders.length) return;

      const walletStatus = await WalletService.getStatus();
      if (walletStatus.locked || !walletStatus.address) return;

      let changed = false;
      let softError: string | null = null;

      const byToken = new Map<string, LimitOrder[]>();
      for (const o of openOrders) {
        const k = `${o.chainId}:${o.tokenAddress.toLowerCase()}`;
        const arr = byToken.get(k) ?? [];
        arr.push(o);
        byToken.set(k, arr);
      }

      for (const [, orders] of byToken) {
        const base = orders[0];
        let priceUsd = 0;
        try {
          priceUsd = await TokenService.getTokenPriceUsdFromRpc({
            chainId: base.chainId,
            tokenAddress: base.tokenAddress,
            tokenInfo: base.tokenInfo ?? null,
            cacheTtlMs: limitScanIntervalMs,
            allowTokenInfoPriceFallback: false,
          });
        } catch (e: any) {
          const msg = typeof e?.message === 'string' ? e.message : String(e);
          softError = msg;
          continue;
        }
        if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;

        const scanPriceUsd = normalizePriceValue(priceUsd, 4, 6);
        if (!Number.isFinite(scanPriceUsd) || scanPriceUsd <= 0) continue;
        const priceKey = `${base.chainId}:${base.tokenAddress.toLowerCase()}`;
        const prevPrice = limitScanPricesByTokenKey.get(priceKey);
        if (!prevPrice || prevPrice.priceUsd !== scanPriceUsd) changed = true;
        limitScanPricesByTokenKey.set(priceKey, { priceUsd: scanPriceUsd, ts: Date.now() });

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
            const txHash = await deps.executeLimitOrder({ ...prepared, status: 'triggered' }, { priceUsd });
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
  };
};
