import { browser } from 'wxt/browser';
import { SettingsService } from '@/services/settings';
import { defaultSettings } from '@/utils/defaults';
import type { UnifiedMarketSignal, UnifiedSignalToken } from '@/types/extention';
import { createTokenInfoResolvers } from '@/services/xSniper/engine/tokenInfoResolver';
import { maybeEvaluateDryRunAutoSell as maybeEvaluateDryRunAutoSellFromMod, type DryRunAutoSellPos } from '@/services/xSniper/engine/dryRunAutoSell';
import { maybeEvaluateRapidExitAutoSell as maybeEvaluateRapidExitAutoSellFromMod, registerRapidExitPosition as registerRapidExitPositionFromMod, type RapidExitPosition } from '@/services/xSniper/engine/rapidExitAutoSell';
import { createSellExecutors } from '@/services/xSniper/engine/sellExecutors';
import { type TokenMetrics, parseNumber, shouldBuyByConfig } from '@/services/xSniper/engine/metrics';
import { computeWsConfirm as computeWsConfirmFromWs, pushWsSnapshot as pushWsSnapshotFromWs, shouldLogWsConfirmFail as shouldLogWsConfirmFailFromWs, type WsSnapshot } from '@/services/xSniper/engine/wsSnapshots';
import { metricsFromUnifiedToken } from '@/services/xSniper/engine/signalSelection';
import { tryAutoBuyOnce as tryAutoBuyOnceFromMod } from '@/services/xSniper/engine/buyExecutor';
import { maybeUpdateNewCoinSniperHistoryEvaluations, pushNewCoinSniperHistory } from '@/services/newCoinSniper/newCoinSniperHistory';

export const createNewCoinSniperTrade = (deps: {
  onStateChanged: () => void;
}) => {
  const BOUGHT_ONCE_TTL_MS = 6 * 60 * 60 * 1000;
  const BOUGHT_ONCE_STORAGE_KEY = 'dagobang_new_coin_sniper_bought_once_v1';

  let boughtOnceLastSyncMs = 0;
  const boughtOnceAtMs = new Map<string, number>();
  const buyInFlight = new Set<string>();
  const wsConfirmFailDedupe = new Map<string, number>();
  const buyFailureRecordDedupe = new Map<string, number>();
  const wsSnapshotsByAddr = new Map<string, WsSnapshot[]>();
  const dryRunAutoSellByPosKey = new Map<string, DryRunAutoSellPos>();
  const rapidExitByPosKey = new Map<string, RapidExitPosition>();
  let currentSignalContext: UnifiedMarketSignal | null = null;
  let latestNewCoinSnipeStrategy: any = null;

  const cleanupPosKey = (posKey: string) => {
    dryRunAutoSellByPosKey.delete(posKey);
    rapidExitByPosKey.delete(posKey);
  };

  const { fetchTokenInfoFresh, buildGenericTokenInfo, getEntryPriceUsd } = createTokenInfoResolvers();

  const shouldLogWsConfirmFail = (key: string, nowMs: number) => shouldLogWsConfirmFailFromWs(wsConfirmFailDedupe, key, nowMs);
  const computeWsConfirm = (tokenAddress: `0x${string}`, nowMs: number, strategy: any) =>
    computeWsConfirmFromWs(wsSnapshotsByAddr, tokenAddress, nowMs, strategy);

  const pushWsSnapshot = (tokenAddress: `0x${string}`, metrics: TokenMetrics) => {
    pushWsSnapshotFromWs({
      tokenAddress,
      metrics,
      wsSnapshotsByAddr,
      onUpdated: () => {
        const nowMs = Date.now();
        void onWsSnapshotUpdated(tokenAddress, nowMs);
      },
    });
  };

  async function onWsSnapshotUpdated(tokenAddress: `0x${string}`, nowMs: number) {
    const snapshots = wsSnapshotsByAddr.get(tokenAddress) ?? [];
    const cur = snapshots.length ? snapshots[snapshots.length - 1] : null;
    if (cur) {
      void maybeUpdateNewCoinSniperHistoryEvaluations({
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
      strategy: latestNewCoinSnipeStrategy,
      wsSnapshotsByAddr,
      rapidExitByPosKey,
      cleanupPosKey,
      tryRapidExitSellOnce,
    });
  }

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
      newCoinSnipe: {
        ...(defaults as any).newCoinSnipe,
        ...(input as any).newCoinSnipe,
      },
    };
    return merged;
  };

  const getKey = (chainId: number, tokenAddress: `0x${string}`, opts?: { dry?: boolean }) => {
    const dry = opts?.dry === true;
    return `${dry ? 'dry:' : ''}${chainId}:${tokenAddress.toLowerCase()}:new-coin`;
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

  const shouldEmitBuyFailureRecord = (input: {
    reason: string;
    chainId: number;
    tokenAddress: `0x${string}`;
  }) => {
    const now = Date.now();
    const signalStableId = currentSignalContext?.id || 'no-signal';
    const key = `${input.reason}:${input.chainId}:${input.tokenAddress.toLowerCase()}:${signalStableId}`;
    const ttlMs =
      input.reason === 'buy_skipped_recently_bought' || input.reason === 'buy_skipped_in_flight'
        ? 60_000
        : 10_000;
    const prev = buyFailureRecordDedupe.get(key);
    if (typeof prev === 'number' && now - prev < ttlMs) return false;
    buyFailureRecordDedupe.set(key, now);
    if (buyFailureRecordDedupe.size > 3000) buyFailureRecordDedupe.clear();
    return true;
  };

  const emitRecord = (record: any) => {
    const signal = currentSignalContext;
    void pushNewCoinSniperHistory({
      id: record.id,
      tsMs: record.tsMs,
      side: record.side,
      reason: record.reason,
      chainId: record.chainId,
      tokenAddress: record.tokenAddress,
      tokenSymbol: record.tokenSymbol,
      tokenName: record.tokenName,
      buyAmountBnb: record.buyAmountBnb,
      sellPercent: record.sellPercent,
      sellTokenAmountWei: record.sellTokenAmountWei,
      txHash: record.txHash,
      entryPriceUsd: record.entryPriceUsd,
      marketCapUsd: record.marketCapUsd,
      athMarketCapUsd: record.athMarketCapUsd,
      holders: record.holders,
      liquidityUsd: record.liquidityUsd,
      kol: record.kol,
      vol24hUsd: record.vol24hUsd,
      netBuy24hUsd: record.netBuy24hUsd,
      buyTx24h: record.buyTx24h,
      sellTx24h: record.sellTx24h,
      smartMoney: record.smartMoney,
      createdAtMs: record.createdAtMs,
      devAddress: record.devAddress,
      devHoldPercent: record.devHoldPercent,
      devHasSold: record.devHasSold,
      confirmWindowMs: record.confirmWindowMs,
      confirmMcapChangePct: record.confirmMcapChangePct,
      confirmHoldersDelta: record.confirmHoldersDelta,
      confirmBuySellRatio: record.confirmBuySellRatio,
      eval3s: record.eval3s,
      eval5s: record.eval5s,
      eval8s: record.eval8s,
      eval10s: record.eval10s,
      eval15s: record.eval15s,
      eval20s: record.eval20s,
      eval25s: record.eval25s,
      eval30s: record.eval30s,
      eval60s: record.eval60s,
      dryRun: record.dryRun,
      source: signal?.source,
      signalId: signal?.id,
      channel: signal?.channel,
    });
    void broadcastToTabs({
      type: 'bg:newCoinSniper:order',
      record: {
        ...record,
        source: signal?.source,
        signalId: signal?.id,
        channel: signal?.channel,
      },
    });
  };

  const normalizeSignalTokens = (signal: UnifiedMarketSignal): UnifiedSignalToken[] =>
    Array.isArray(signal.tokens)
      ? (signal.tokens as UnifiedSignalToken[]).filter((t) => t && typeof t.tokenAddress === 'string' && t.tokenAddress.trim())
      : [];

  const pickCandidates = (signal: UnifiedMarketSignal, strategy: any) => {
    const now = Date.now();
    const signalAtMs = typeof signal.ts === 'number' ? signal.ts : now;
    const tokens = normalizeSignalTokens(signal);
    const unique: UnifiedSignalToken[] = [];
    const seen = new Set<string>();
    for (const t of tokens) {
      const addr = String(t.tokenAddress || '').trim().toLowerCase();
      if (!addr || seen.has(addr)) continue;
      seen.add(addr);
      unique.push(t);
      if (unique.length >= 500) break;
    }
    const candidates = unique
      .map((t) => {
        const m = metricsFromUnifiedToken(t);
        if (m?.tokenAddress) pushWsSnapshot(m.tokenAddress, m);
        return { m };
      })
      .filter((x) => {
        if (!x.m?.tokenAddress) return false;
        if (!shouldBuyByConfig(x.m, strategy, signalAtMs, now)) return false;
        const confirm = computeWsConfirm(x.m.tokenAddress, now, strategy);
        return confirm.pass;
      });
    candidates.sort((a, b) => {
      const ma = typeof a.m?.marketCapUsd === 'number' ? a.m.marketCapUsd : 0;
      const mb = typeof b.m?.marketCapUsd === 'number' ? b.m.marketCapUsd : 0;
      if (mb !== ma) return mb - ma;
      const ta = typeof a.m?.firstSeenAtMs === 'number' ? a.m.firstSeenAtMs : 0;
      const tb = typeof b.m?.firstSeenAtMs === 'number' ? b.m.firstSeenAtMs : 0;
      return ta - tb;
    });
    return candidates;
  };

  const isSourceEnabled = (signal: UnifiedMarketSignal, strategy: any) => {
    const list = Array.isArray(strategy?.signalSources) ? strategy.signalSources.map((x: any) => String(x).trim()) : [];
    if (!list.length) return true;
    return list.includes(signal.source);
  };

  const tryAutoBuyOnce = async (input: {
    chainId: number;
    tokenAddress: `0x${string}`;
    metrics: TokenMetrics;
    strategy: any;
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

  const { tryRapidExitSellOnce } = createSellExecutors({
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

  const handleMarketSignal = async (signal: UnifiedMarketSignal) => {
    try {
      const settings = await SettingsService.get();
      const config = normalizeAutoTrade((settings as any).autoTrade);
      if (!config) return;
      if (config.wsMonitorEnabled === false) return;
      const strategy = (config as any).newCoinSnipe;
      if (!strategy || strategy.enabled === false) return;
      latestNewCoinSnipeStrategy = strategy;
      if (!isSourceEnabled(signal, strategy)) return;

      const perSignalMax = Math.max(0, Math.floor(parseNumber(strategy?.buyNewCaCount) ?? 0));
      if (perSignalMax <= 0) return;

      const picked = pickCandidates(signal, strategy);
      let boughtCount = 0;
      const dryRun = strategy?.dryRun === true;
      for (const { m } of picked) {
        if (!m?.tokenAddress) continue;
        currentSignalContext = signal;
        let bought = false;
        try {
          bought = await tryAutoBuyOnce({
            chainId: settings.chainId,
            tokenAddress: m.tokenAddress,
            metrics: m,
            strategy,
          });
        } catch {
        } finally {
          currentSignalContext = null;
        }
        if (!dryRun && bought) {
          boughtCount += 1;
          if (boughtCount >= perSignalMax) break;
        }
      }
    } catch (e) {
      console.error('NewCoinSniper market signal handler error', e);
    }
  };

  return { handleMarketSignal };
};
