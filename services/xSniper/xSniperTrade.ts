import { browser } from 'wxt/browser';
import { SettingsService } from '@/services/settings';
import { defaultSettings } from '@/utils/defaults';
import type { UnifiedTwitterSignal, XSniperBuyRecord } from '@/types/extention';
import { loadXSniperHistory, pushXSniperHistory } from '@/services/xSniper/xSniperHistory';
import { type TokenMetrics, normalizeAddress, parseNumber } from '@/services/xSniper/engine/metrics';
import { computeWsConfirm as computeWsConfirmFromWs, getWsDrawdownPctSince as getWsDrawdownPctSinceFromWs, pushWsSnapshot as pushWsSnapshotFromWs, shouldLogWsConfirmFail as shouldLogWsConfirmFailFromWs, type WsSnapshot } from '@/services/xSniper/engine/wsSnapshots';
import { maybeEvaluateDryRunAutoSell as maybeEvaluateDryRunAutoSellFromMod, type DryRunAutoSellPos } from '@/services/xSniper/engine/dryRunAutoSell';
import { maybeEvaluateRapidExitAutoSell as maybeEvaluateRapidExitAutoSellFromMod, registerRapidExitPosition as registerRapidExitPositionFromMod, type RapidExitPosition } from '@/services/xSniper/engine/rapidExitAutoSell';
import { matchesTwitterFilters, pickTokensToBuyFromSignal } from '@/services/xSniper/engine/signalSelection';
import { createSellExecutors } from '@/services/xSniper/engine/sellExecutors';
import { tryAutoBuyOnce as tryAutoBuyOnceFromMod } from '@/services/xSniper/engine/buyExecutor';
import { createTokenInfoResolvers } from '@/services/xSniper/engine/tokenInfoResolver';
import { maybeUpdateXSniperHistoryEvaluations } from '@/services/xSniper/xSniperHistory';
import { TokenService } from '@/services/token';
import { extractLaunchpadPlatform } from '@/constants/launchpad';
import { getChainIdByName } from '@/constants/chains';

export const createXSniperTrade = (deps: {
  onStateChanged: () => void;
  telegramNotifier?: {
    notifyXSniperOrderCard?: (record: XSniperBuyRecord) => Promise<any>;
  };
}) => {
  const resolveTradeChainId = (rawChain: unknown, fallbackChainId: number, settings: any) => {
    const chainName = typeof rawChain === 'string' ? rawChain.trim() : '';
    if (!chainName) return fallbackChainId;
    const chainIdFromToken = getChainIdByName(chainName);
    if (!Number.isFinite(chainIdFromToken) || chainIdFromToken <= 0) return fallbackChainId;
    if (!settings?.chains?.[chainIdFromToken]) return fallbackChainId;
    return chainIdFromToken;
  };

  const BOUGHT_ONCE_TTL_MS = 6 * 60 * 60 * 1000;
  const BOUGHT_ONCE_STORAGE_KEY = 'dagobang_xsniper_bought_once_v1';

  let boughtOnceLastSyncMs = 0;
  const boughtOnceAtMs = new Map<string, number>();
  const buyInFlight = new Set<string>();
  const wsConfirmFailDedupe = new Map<string, number>();
  const buyFailureRecordDedupe = new Map<string, number>();
  const wsSnapshotsByAddr = new Map<string, WsSnapshot[]>();
  const dryRunAutoSellByPosKey = new Map<string, DryRunAutoSellPos>();
  const rapidExitByPosKey = new Map<string, RapidExitPosition>();
  const rapidWatchdogRpcAtMs = new Map<string, number>();
  let currentSignalContext: UnifiedTwitterSignal | null = null;
  let latestTwitterSnipeStrategy: any = null;
  let rapidWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  let rapidWatchdogIntervalMs = -1;

  const cleanupPosKey = (posKey: string) => {
    dryRunAutoSellByPosKey.delete(posKey);
    rapidExitByPosKey.delete(posKey);
  };

  const shouldLogWsConfirmFail = (key: string, nowMs: number) => shouldLogWsConfirmFailFromWs(wsConfirmFailDedupe, key, nowMs);
  const shouldEmitBuyFailureRecord = (input: {
    reason: string;
    chainId: number;
    tokenAddress: `0x${string}`;
    signal?: UnifiedTwitterSignal;
  }) => {
    const now = Date.now();
    const signalStableId = (() => {
      const id = typeof input.signal?.id === 'string' ? input.signal.id.trim() : '';
      if (id) return id;
      const ev = typeof input.signal?.eventId === 'string' ? input.signal.eventId.trim() : '';
      if (ev) return ev;
      const tw = typeof input.signal?.tweetId === 'string' ? input.signal.tweetId.trim() : '';
      if (tw) return tw;
      return '';
    })();
    const key = `${input.reason}:${input.chainId}:${input.tokenAddress.toLowerCase()}:${signalStableId || 'no-signal'}`;
    const ttlMs =
      input.reason === 'buy_skipped_recently_bought' || input.reason === 'buy_skipped_in_flight'
        ? 60_000
        : 10_000;
    const prev = buyFailureRecordDedupe.get(key);
    if (typeof prev === 'number' && now - prev < ttlMs) return false;
    buyFailureRecordDedupe.set(key, now);
    if (buyFailureRecordDedupe.size > 3000) {
      for (const [k, ts] of buyFailureRecordDedupe) {
        if (now - ts > 10 * 60_000) buyFailureRecordDedupe.delete(k);
      }
      if (buyFailureRecordDedupe.size > 3500) buyFailureRecordDedupe.clear();
    }
    return true;
  };

  const emitRecord = (record: XSniperBuyRecord) => {
    const resolvedLaunchpadPlatform = (() => {
      const fromRecord = extractLaunchpadPlatform(record as any);
      if (fromRecord) return fromRecord;
      const signal = currentSignalContext;
      const addr = String(record?.tokenAddress || '').trim().toLowerCase();
      if (!signal || !addr) return undefined;
      const tokens = Array.isArray(signal.tokens) ? signal.tokens : [];
      const matched = tokens.find((x: any) => String(x?.tokenAddress || '').trim().toLowerCase() === addr);
      return extractLaunchpadPlatform(matched as any);
    })();
    const nextRecord: XSniperBuyRecord = resolvedLaunchpadPlatform
      ? { ...record, launchpadPlatform: resolvedLaunchpadPlatform }
      : record;
    void pushXSniperHistory(nextRecord);
    void broadcastToTabs({ type: 'bg:xsniper:buy', record: nextRecord });
    if (nextRecord.side === 'buy' && !nextRecord.reason) {
      void deps.telegramNotifier?.notifyXSniperOrderCard?.(nextRecord);
    }
  };

  const computeWsConfirm = (tokenAddress: `0x${string}`, nowMs: number, strategy: any) =>
    computeWsConfirmFromWs(wsSnapshotsByAddr, tokenAddress, nowMs, strategy);

  const getWsDrawdownPctSince = (tokenAddress: `0x${string}`, sinceMs: number) =>
    getWsDrawdownPctSinceFromWs(wsSnapshotsByAddr, tokenAddress, sinceMs);

  const readRapidWatchdogIntervalMs = (strategy: any) => {
    const secRaw = parseNumber(strategy?.rapidWatchdogSec);
    const sec = Number.isFinite(secRaw) ? Math.floor(Number(secRaw)) : 1;
    const clampedSec = Math.max(0, Math.min(10, sec));
    return clampedSec * 1000;
  };

  const runRapidWatchdogTick = async () => {
    const strategy = latestTwitterSnipeStrategy;
    if (!strategy || strategy.rapidExitEnabled === false) return;
    if (!rapidExitByPosKey.size) return;
    const nowMs = Date.now();
    const staleMs = 3000;
    const rpcCooldownMs = 3000;
    const addrs = new Set<`0x${string}`>();
    for (const pos of rapidExitByPosKey.values()) {
      const addr = normalizeAddress(pos?.tokenAddress);
      if (!addr) continue;
      addrs.add(addr);
    }
    for (const tokenAddress of addrs) {
      const latestList = wsSnapshotsByAddr.get(tokenAddress) ?? [];
      const latest = latestList.length ? latestList[latestList.length - 1] : null;
      const wsAgeMs = latest ? nowMs - latest.atMs : Number.POSITIVE_INFINITY;
      if (wsAgeMs > staleMs) {
        const rpcKey = tokenAddress.toLowerCase();
        const lastRpcAt = rapidWatchdogRpcAtMs.get(rpcKey) ?? 0;
        if (nowMs - lastRpcAt >= rpcCooldownMs) {
          rapidWatchdogRpcAtMs.set(rpcKey, nowMs);
          try {
            const anyPos = Array.from(rapidExitByPosKey.values()).find((p) => p.tokenAddress.toLowerCase() === rpcKey);
            const chainId = anyPos?.chainId ?? 56;
            const impliedSupply = Number(anyPos?.impliedSupply);
            const priceUsd = await TokenService.getPriceUsdFromRpc({
              chainId,
              tokenAddress,
              cacheTtlMs: 0,
              allowTokenInfoPriceFallback: false,
            });
            const mcap = Number.isFinite(impliedSupply) && impliedSupply > 0 && Number.isFinite(priceUsd) && priceUsd > 0
              ? priceUsd * impliedSupply
              : NaN;
            if (Number.isFinite(mcap) && mcap > 0) {
              const merged: WsSnapshot = {
                atMs: nowMs,
                marketCapUsd: mcap,
                holders: latest?.holders,
                vol24hUsd: latest?.vol24hUsd,
                netBuy24hUsd: latest?.netBuy24hUsd,
                buyTx24h: latest?.buyTx24h,
                sellTx24h: latest?.sellTx24h,
                smartMoney: latest?.smartMoney,
              };
              const next = latestList.concat(merged).slice(-80);
              wsSnapshotsByAddr.set(tokenAddress, next);
            }
          } catch {
          }
        }
      }
      void maybeEvaluateRapidExitAutoSellFromMod({
        tokenAddress,
        nowMs,
        strategy,
        wsSnapshotsByAddr,
        rapidExitByPosKey,
        cleanupPosKey,
        tryRapidExitSellOnce,
      });
    }
  };

  const stopRapidWatchdog = () => {
    if (rapidWatchdogTimer) clearInterval(rapidWatchdogTimer);
    rapidWatchdogTimer = null;
    rapidWatchdogIntervalMs = -1;
  };

  const ensureRapidWatchdog = (strategy: any) => {
    const nextIntervalMs = readRapidWatchdogIntervalMs(strategy);
    const enabled = strategy?.rapidExitEnabled !== false;
    if (!enabled || nextIntervalMs <= 0) {
      stopRapidWatchdog();
      return;
    }
    if (rapidWatchdogTimer && rapidWatchdogIntervalMs === nextIntervalMs) return;
    stopRapidWatchdog();
    rapidWatchdogIntervalMs = nextIntervalMs;
    rapidWatchdogTimer = setInterval(() => {
      void runRapidWatchdogTick();
    }, nextIntervalMs);
  };

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
    void maybeEvaluateRapidExitAutoSellFromMod({
      tokenAddress,
      nowMs,
      strategy: latestTwitterSnipeStrategy,
      wsSnapshotsByAddr,
      rapidExitByPosKey,
      cleanupPosKey,
      tryRapidExitSellOnce,
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

  const loadBoughtOnceIfNeeded = async () => {
    const now = Date.now();
    if (now - boughtOnceLastSyncMs < 3000) return;
    boughtOnceLastSyncMs = now;
    try {
      const res = await browser.storage.local.get(BOUGHT_ONCE_STORAGE_KEY);
      const raw = (res as any)?.[BOUGHT_ONCE_STORAGE_KEY];
      const next = new Map<string, number>();
      if (!raw || typeof raw !== 'object') {
        boughtOnceAtMs.clear();
        return;
      }
      for (const [key, ts] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof key !== 'string') continue;
        const n = typeof ts === 'number' ? ts : Number(ts);
        if (!Number.isFinite(n)) continue;
        if (now - n > BOUGHT_ONCE_TTL_MS) continue;
        next.set(key, n);
      }
      boughtOnceAtMs.clear();
      for (const [key, ts] of next) boughtOnceAtMs.set(key, ts);
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

  const getKey = (chainId: number, tokenAddress: `0x${string}`, opts?: { dry?: boolean }) => {
    const dry = opts?.dry === true;
    return `${dry ? 'dry:' : ''}${chainId}:${tokenAddress.toLowerCase()}:full`;
  };

  const { fetchTokenInfoFresh, buildGenericTokenInfo, getEntryPriceUsd } = createTokenInfoResolvers();

  const tryAutoBuyOnce = async (input: {
    chainId: number;
    tokenAddress: `0x${string}`;
    metrics: TokenMetrics;
    strategy: any;
    signal?: UnifiedTwitterSignal;
    amountBnbOverride?: number;
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
      shouldEmitBuyFailureRecord,
      emitRecord,
      broadcastToActiveTabs,
      fetchTokenInfoFresh,
      buildGenericTokenInfo,
      getEntryPriceUsd,
      registerRapidExitPosition,
      dryRunAutoSellByPosKey,
    });

  const { tryDeleteTweetSellOnce, tryRapidExitSellOnce } = createSellExecutors({
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

  const registerRapidExitPosition = (input: {
    strategy: any;
    posKey: string;
    chainId: number;
    tokenAddress: `0x${string}`;
    dryRun: boolean;
    entryMcapUsd: number | null;
    buyAmountBnb: number;
    openedAtMs: number;
    tweetAtMs?: number;
    tweetUrl?: string;
    tweetType?: string;
    channel?: string;
    signalId?: string;
    signalEventId?: string;
    signalTweetId?: string;
    entryPriceUsd?: number | null;
  }) =>
    registerRapidExitPositionFromMod({
      rapidExitByPosKey,
      ...input,
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
      latestTwitterSnipeStrategy = strategy;
      ensureRapidWatchdog(strategy);

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
        const rapidMatched = Array.from(rapidExitByPosKey.values()).filter((p) => {
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
        for (const p of rapidMatched) {
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
      const perTweetMax = Math.max(0, Math.floor(parseNumber(strategy?.buyNewCaCount) ?? 0));
      const dryRun = strategy?.dryRun === true;
      let boughtCount = 0;
      for (const { t, m } of picked) {
        if (!m?.tokenAddress) continue;
        const tradeChainId = resolveTradeChainId((t as any)?.chain, settings.chainId, settings);
        let bought = false;
        try {
          currentSignalContext = signal;
          bought = await tryAutoBuyOnce({ chainId: tradeChainId, tokenAddress: m.tokenAddress, metrics: m, strategy, signal });
        } catch (e) {
          console.error('XSniperTrade buy attempt failed', {
            tokenAddress: m.tokenAddress,
            signalId: signal.id,
            tweetId: signal.tweetId,
          }, e);
          continue;
        } finally {
          currentSignalContext = null;
        }
        if (!dryRun && bought) {
          boughtCount += 1;
          if (boughtCount >= perTweetMax) break;
        }
      }
    } catch (e) {
      console.error('XSniperTrade twitter signal handler error', e);
    }
  };

  return { handleTwitterSignal };
};
