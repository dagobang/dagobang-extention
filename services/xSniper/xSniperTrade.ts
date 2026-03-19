import { browser } from 'wxt/browser';
import { SettingsService } from '@/services/settings';
import { defaultSettings } from '@/utils/defaults';
import type { UnifiedTwitterSignal, XSniperBuyRecord } from '@/types/extention';
import { loadXSniperHistory, pushXSniperHistory } from '@/services/xSniper/xSniperHistory';
import { type TokenMetrics, normalizeAddress, parseNumber } from '@/services/xSniper/engine/metrics';
import { computeWsConfirm as computeWsConfirmFromWs, getWsDrawdownPctSince as getWsDrawdownPctSinceFromWs, pushWsSnapshot as pushWsSnapshotFromWs, shouldLogWsConfirmFail as shouldLogWsConfirmFailFromWs, type WsSnapshot } from '@/services/xSniper/engine/wsSnapshots';
import { maybeEvaluateDryRunAutoSell as maybeEvaluateDryRunAutoSellFromMod, type DryRunAutoSellPos } from '@/services/xSniper/engine/dryRunAutoSell';
import { scheduleStagedAddIfEnabled as scheduleStagedAddIfEnabledFromMod, scheduleTimeStopIfEnabled as scheduleTimeStopIfEnabledFromMod, type StagedPosition } from '@/services/xSniper/engine/stagedEntrySchedulers';
import { matchesTwitterFilters, pickTokensToBuyFromSignal } from '@/services/xSniper/engine/signalSelection';
import { createSellExecutors } from '@/services/xSniper/engine/sellExecutors';
import { tryAutoBuyOnce as tryAutoBuyOnceFromMod } from '@/services/xSniper/engine/buyExecutor';
import { createTokenInfoResolvers } from '@/services/xSniper/engine/tokenInfoResolver';
import { maybeUpdateXSniperHistoryEvaluations } from '@/services/xSniper/xSniperHistory';

export const createXSniperTrade = (deps: { onStateChanged: () => void }) => {
  const BOUGHT_ONCE_TTL_MS = 6 * 60 * 60 * 1000;
  const BOUGHT_ONCE_STORAGE_KEY = 'dagobang_xsniper_bought_once_v1';

  let boughtOnceLoaded = false;
  const boughtOnceAtMs = new Map<string, number>();
  const buyInFlight = new Set<string>();
  const wsConfirmFailDedupe = new Map<string, number>();
  const wsSnapshotsByAddr = new Map<string, WsSnapshot[]>();
  const dryRunAutoSellByPosKey = new Map<string, DryRunAutoSellPos>();
  const stagedPositions = new Map<string, StagedPosition>();
  const stagedAddTimers = new Map<string, number>();
  const timeStopTimers = new Map<string, number>();

  const cleanupPosKey = (posKey: string) => {
    stagedPositions.delete(posKey);
    const tid = stagedAddTimers.get(posKey);
    if (tid) clearInterval(tid as any);
    stagedAddTimers.delete(posKey);
    const t2 = timeStopTimers.get(posKey);
    if (t2) clearTimeout(t2 as any);
    timeStopTimers.delete(posKey);
    dryRunAutoSellByPosKey.delete(posKey);
  };

  const shouldLogWsConfirmFail = (key: string, nowMs: number) => shouldLogWsConfirmFailFromWs(wsConfirmFailDedupe, key, nowMs);

  const emitRecord = (record: XSniperBuyRecord) => {
    void pushXSniperHistory(record);
    void broadcastToTabs({ type: 'bg:xsniper:buy', record });
  };

  const computeWsConfirm = (tokenAddress: `0x${string}`, nowMs: number, strategy: any) =>
    computeWsConfirmFromWs(wsSnapshotsByAddr, tokenAddress, nowMs, strategy);

  const getWsDrawdownPctSince = (tokenAddress: `0x${string}`, sinceMs: number) =>
    getWsDrawdownPctSinceFromWs(wsSnapshotsByAddr, tokenAddress, sinceMs);

  async function onWsSnapshotUpdated(tokenAddress: `0x${string}`, nowMs: number) {
    const snapshots = wsSnapshotsByAddr.get(tokenAddress) ?? [];
    const cur = snapshots.length ? snapshots[snapshots.length - 1] : null;
    if (cur) {
      void maybeUpdateXSniperHistoryEvaluations({
        tokenAddress,
        nowMs,
        marketCapUsd: cur.marketCapUsd,
        holders: cur.holders,
      });
    }
    void maybeEvaluateDryRunAutoSellFromMod({
      tokenAddress,
      nowMs,
      wsSnapshotsByAddr,
      dryRunAutoSellByPosKey,
      cleanupPosKey,
      emitRecord,
    });
  }

  const pushWsSnapshot = (tokenAddress: `0x${string}`, metrics: TokenMetrics) => {
    pushWsSnapshotFromWs({
      tokenAddress,
      metrics,
      wsSnapshotsByAddr,
      onUpdated: onWsSnapshotUpdated,
    });
  };

  const scheduleTimeStopIfEnabled = (posKey: string, strategy: any) => {
    scheduleTimeStopIfEnabledFromMod({
      posKey,
      strategy,
      stagedPositions,
      timeStopTimers,
      wsSnapshotsByAddr,
      tryTimeStopSellOnce,
    });
  };

  const scheduleStagedAddIfEnabled = (posKey: string, strategy: any) => {
    scheduleStagedAddIfEnabledFromMod({
      posKey,
      strategy,
      stagedPositions,
      stagedAddTimers,
      computeWsConfirm,
      getWsDrawdownPctSince,
      tryAutoBuyOnce,
      tryTimeStopSellOnce,
      emitRecord,
    });
  };

  const loadBoughtOnceIfNeeded = async () => {
    if (boughtOnceLoaded) return;
    boughtOnceLoaded = true;
    try {
      const res = await browser.storage.local.get(BOUGHT_ONCE_STORAGE_KEY);
      const raw = (res as any)?.[BOUGHT_ONCE_STORAGE_KEY];
      if (!raw || typeof raw !== 'object') return;
      const now = Date.now();
      for (const [key, ts] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof key !== 'string') continue;
        const n = typeof ts === 'number' ? ts : Number(ts);
        if (!Number.isFinite(n)) continue;
        if (now - n > BOUGHT_ONCE_TTL_MS) continue;
        boughtOnceAtMs.set(key, n);
      }
    } catch {
    }
  };

  const persistBoughtOnce = async () => {
    try {
      const now = Date.now();
      const obj: Record<string, number> = {};
      for (const [k, ts] of boughtOnceAtMs) {
        if (now - ts > BOUGHT_ONCE_TTL_MS) continue;
        obj[k] = ts;
      }
      await browser.storage.local.set({ [BOUGHT_ONCE_STORAGE_KEY]: obj } as any);
    } catch {
    }
  };

  const broadcastToTabs = async (message: any) => {
    try {
      const tabs = await browser.tabs.query({});
      for (const tab of tabs) {
        if (!tab.id) continue;
        browser.tabs.sendMessage(tab.id, message).catch(() => { });
      }
    } catch {
    }
  };

  const broadcastToActiveTabs = async (message: any) => {
    try {
      const tabs = await browser.tabs.query({ active: true });
      for (const tab of tabs) {
        if (!tab.id) continue;
        browser.tabs.sendMessage(tab.id, message).catch(() => { });
      }
    } catch {
    }
  };

  const normalizeAutoTrade = (input: any) => {
    const defaults = defaultSettings().autoTrade;
    const merged = !input ? defaults : {
      ...defaults,
      ...input,
      triggerSound: {
        ...defaults.triggerSound,
        ...(input as any).triggerSound,
      },
      twitterSnipe: {
        ...defaults.twitterSnipe,
        ...(input as any).twitterSnipe,
      },
    };
    const s = (merged as any).twitterSnipe ?? {};
    const presets = Array.isArray(s.presets) ? s.presets : [];
    const activeId = typeof s.activePresetId === 'string' ? s.activePresetId.trim() : '';
    const active = presets.find((p: any) => p && typeof p.id === 'string' && p.id === activeId);
    if (!active || !active.strategy || typeof active.strategy !== 'object') return merged;
    return {
      ...merged,
      twitterSnipe: {
        ...s,
        ...active.strategy,
        presets,
        activePresetId: activeId,
      },
    };
  };

  const getKey = (chainId: number, tokenAddress: `0x${string}`, opts?: { dry?: boolean; stage?: 'full' | 'scout' | 'add' }) => {
    const dry = opts?.dry === true;
    const stage = opts?.stage ?? 'full';
    return `${dry ? 'dry:' : ''}${chainId}:${tokenAddress.toLowerCase()}:${stage}`;
  };

  const { fetchTokenInfoFresh, buildGenericTokenInfo, getEntryPriceUsd } = createTokenInfoResolvers();

  const tryAutoBuyOnce = async (input: {
    chainId: number;
    tokenAddress: `0x${string}`;
    metrics: TokenMetrics;
    strategy: any;
    signal?: UnifiedTwitterSignal;
    stage?: 'full' | 'scout' | 'add';
    amountBnbOverride?: number;
    stagedPlan?: { scoutAmountBnb: number; addAmountBnb: number; openedAtMs: number };
  }) =>
    tryAutoBuyOnceFromMod({
      ...input,
      onStateChanged: deps.onStateChanged,
      loadBoughtOnceIfNeeded,
      persistBoughtOnce,
      getKey,
      boughtOnceAtMs,
      buyInFlight,
      computeWsConfirm,
      shouldLogWsConfirmFail,
      emitRecord,
      broadcastToActiveTabs,
      fetchTokenInfoFresh,
      buildGenericTokenInfo,
      getEntryPriceUsd,
      scheduleStagedAddIfEnabled,
      scheduleTimeStopIfEnabled,
      stagedPositions,
      dryRunAutoSellByPosKey,
    });

  const { tryTimeStopSellOnce, tryDeleteTweetSellOnce } = createSellExecutors({
    cleanupPosKey,
    emitRecord,
    broadcastToActiveTabs,
    fetchTokenInfoFresh,
    buildGenericTokenInfo,
    getLatestMarketCapUsd: (tokenAddress) => {
      const snaps = wsSnapshotsByAddr.get(tokenAddress) ?? [];
      const latest = snaps.length ? snaps[snaps.length - 1] : null;
      const mcap = latest?.marketCapUsd;
      return typeof mcap === 'number' && Number.isFinite(mcap) && mcap > 0 ? mcap : null;
    },
  });

  const handleTwitterSignal = async (signal: UnifiedTwitterSignal) => {
    try {
      const settings = await SettingsService.get();
      const config = normalizeAutoTrade((settings as any).autoTrade);
      if (!config) return;
      if (config.wsMonitorEnabled === false) return;
      const strategy = config.twitterSnipe;
      if (!strategy) return;
      if (strategy.enabled === false) return;

      if (signal.tweetType === 'delete_post') {
        const pct = parseNumber(strategy.deleteTweetSellPercent) ?? 0;
        const percent = Math.max(0, Math.min(100, pct));
        if (!(percent > 0)) return;

        const delEventId = String(signal.eventId ?? '').trim();
        const delTweetId = String(signal.tweetId ?? '').trim();
        if (!delEventId && !delTweetId) return;

        const history = await loadXSniperHistory();
        const matchedBuys = history.filter((r) => {
          if (!r) return false;
          if (r.side && r.side !== 'buy') return false;
          const ev = typeof r.signalEventId === 'string' ? r.signalEventId.trim() : '';
          const tw = typeof r.signalTweetId === 'string' ? r.signalTweetId.trim() : '';
          if (delEventId && ev && ev === delEventId) return true;
          if (delTweetId && tw && tw === delTweetId) return true;
          return false;
        });
        const stagedMatched = Array.from(stagedPositions.values()).filter((p) => {
          if (!p) return false;
          const ev = typeof p.signalEventId === 'string' ? p.signalEventId.trim() : '';
          const tw = typeof p.signalTweetId === 'string' ? p.signalTweetId.trim() : '';
          if (delEventId && ev && ev === delEventId) return true;
          if (delTweetId && tw && tw === delTweetId) return true;
          return false;
        });
        const sold = new Set<string>();
        for (const r of matchedBuys) {
          const addr = normalizeAddress(r.tokenAddress);
          if (!addr) continue;
          const dedupe = `${r.chainId ?? settings.chainId}:${addr.toLowerCase()}`;
          if (sold.has(dedupe)) continue;
          try {
            await tryDeleteTweetSellOnce({
              chainId: r.chainId ?? settings.chainId,
              tokenAddress: addr,
              percent,
              signal,
              relatedBuy: r,
              dryRun: r.dryRun === true,
            });
          } catch {
          }
          sold.add(dedupe);
        }
        for (const p of stagedMatched) {
          const addr = normalizeAddress(p.tokenAddress);
          if (!addr) continue;
          const dedupe = `${p.chainId}:${addr.toLowerCase()}`;
          if (sold.has(dedupe)) continue;
          try {
            await tryDeleteTweetSellOnce({
              chainId: p.chainId,
              tokenAddress: addr,
              percent,
              signal,
              dryRun: p.dryRun,
            });
          } catch {
          }
          sold.add(dedupe);
        }
        return;
      }
      if (!matchesTwitterFilters(signal, strategy)) return;

      const picked = pickTokensToBuyFromSignal({
        signal,
        strategy,
        pushWsSnapshot,
        computeWsConfirm,
      });
      for (const { m } of picked) {
        if (!m?.tokenAddress) continue;
        if (strategy?.stagedEntryEnabled === true) {
          const total = parseNumber(strategy?.buyAmountBnb) ?? 0;
          const scoutPct = Math.max(1, Math.min(99, parseNumber(strategy?.stagedEntryScoutPercent) ?? 25));
          const scoutAmount = total > 0 ? (total * scoutPct) / 100 : 0;
          const addAmount = total > 0 ? Math.max(0, total - scoutAmount) : 0;
          const openedAtMs = Date.now();
          if (scoutAmount > 0 && addAmount > 0) {
            await tryAutoBuyOnce({
              chainId: settings.chainId,
              tokenAddress: m.tokenAddress,
              metrics: m,
              strategy,
              signal,
              stage: 'scout',
              amountBnbOverride: scoutAmount,
              stagedPlan: { scoutAmountBnb: scoutAmount, addAmountBnb: addAmount, openedAtMs },
            });
          } else {
            await tryAutoBuyOnce({ chainId: settings.chainId, tokenAddress: m.tokenAddress, metrics: m, strategy, signal });
          }
        } else {
          await tryAutoBuyOnce({ chainId: settings.chainId, tokenAddress: m.tokenAddress, metrics: m, strategy, signal });
        }
      }
    } catch (e) {
      console.error('XSniperTrade twitter signal handler error', e);
    }
  };

  return { handleTwitterSignal };
};
