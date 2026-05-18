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
import { WalletService } from '@/services/wallet';
import { extractLaunchpadPlatform } from '@/constants/launchpad';
import { getChainIdByName } from '@/constants/chains';
import { upsertXSniperDecisionSnapshot } from '@/services/xSniper/xSniperDecisionSnapshot';

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
  const resolveSignalTokenChainIdLoose = (input: {
    tokenAddress?: string | null;
    signal?: UnifiedTwitterSignal | null;
  }) => {
    const addr = String(input.tokenAddress || '').trim().toLowerCase();
    if (!addr) return null;
    const tokens = Array.isArray(input.signal?.tokens) ? input.signal.tokens : [];
    const matched = tokens.find((x: any) => String(x?.tokenAddress || '').trim().toLowerCase() === addr);
    const rawChain = String((matched as any)?.chain || '').trim();
    if (!rawChain) return null;
    const chainId = getChainIdByName(rawChain);
    return Number.isFinite(chainId) && chainId > 0 ? chainId : null;
  };
  const resolveSignalTokenChainId = (input: {
    tokenAddress?: string | null;
    signal?: UnifiedTwitterSignal | null;
    fallbackChainId: number;
    settings: any;
  }) => {
    const addr = String(input.tokenAddress || '').trim().toLowerCase();
    if (!addr) return input.fallbackChainId;
    const tokens = Array.isArray(input.signal?.tokens) ? input.signal.tokens : [];
    const matched = tokens.find((x: any) => String(x?.tokenAddress || '').trim().toLowerCase() === addr);
    return resolveTradeChainId((matched as any)?.chain, input.fallbackChainId, input.settings);
  };
  const resolveRecordedTradeChainId = (input: {
    recordedChainId?: number | null;
    tokenAddress?: string | null;
    signal?: UnifiedTwitterSignal | null;
    fallbackChainId: number;
    settings: any;
  }) => {
    const recordedChainId = Number(input.recordedChainId);
    if (Number.isFinite(recordedChainId) && recordedChainId > 0 && input.settings?.chains?.[recordedChainId]) {
      return recordedChainId;
    }
    return resolveSignalTokenChainId({
      tokenAddress: input.tokenAddress,
      signal: input.signal,
      fallbackChainId: input.fallbackChainId,
      settings: input.settings,
    });
  };
  const parseWalletAddress = (input: unknown): `0x${string}` | undefined => {
    const raw = String(input ?? '').trim().toLowerCase();
    if (!raw || !/^0x[a-f0-9]{40}$/.test(raw)) return undefined;
    return raw as `0x${string}`;
  };
  const resolveSignalStableId = (signal?: UnifiedTwitterSignal | null) => {
    const id = typeof signal?.id === 'string' ? signal.id.trim() : '';
    if (id) return id;
    const eventId = typeof signal?.eventId === 'string' ? signal.eventId.trim() : '';
    if (eventId) return eventId;
    const tweetId = typeof signal?.tweetId === 'string' ? signal.tweetId.trim() : '';
    if (tweetId) return tweetId;
    return '';
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
  const manuallyClosedPosKeys = new Map<string, number>();
  const rapidWatchdogRpcAtMs = new Map<string, number>();
  let currentSignalContext: UnifiedTwitterSignal | null = null;
  let latestTwitterSnipeStrategy: any = null;
  let rapidWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  let rapidWatchdogIntervalMs = -1;

  const cleanupPosKey = (posKey: string) => {
    dryRunAutoSellByPosKey.delete(posKey);
    rapidExitByPosKey.delete(posKey);
  };
  const toScopedTokenKey = (chainId: number, tokenAddress: `0x${string}`) => `${chainId}:${tokenAddress.toLowerCase()}`;

  const shouldLogWsConfirmFail = (key: string, nowMs: number) => shouldLogWsConfirmFailFromWs(wsConfirmFailDedupe, key, nowMs);
  const shouldEmitBuyFailureRecord = (input: {
    reason: string;
    chainId: number;
    tokenAddress: `0x${string}`;
    signal?: UnifiedTwitterSignal;
  }) => {
    if (input.reason === 'ws_confirm_failed') return false;
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
    const resolvedChainId = (() => {
      const fromSignal = resolveSignalTokenChainIdLoose({
        tokenAddress: record?.tokenAddress,
        signal: currentSignalContext,
      });
      if (typeof fromSignal === 'number' && fromSignal > 0) return fromSignal;
      const fromRecord = Number(record?.chainId);
      return Number.isFinite(fromRecord) && fromRecord > 0 ? fromRecord : 56;
    })();
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
    const nextRecord: XSniperBuyRecord = {
      ...record,
      chainId: resolvedChainId,
      ...(resolvedLaunchpadPlatform ? { launchpadPlatform: resolvedLaunchpadPlatform } : {}),
    };
    void pushXSniperHistory(nextRecord);
    void broadcastToTabs({ type: 'bg:xsniper:buy', record: nextRecord });
    if (nextRecord.side === 'buy' && !nextRecord.reason) {
      void deps.telegramNotifier?.notifyXSniperOrderCard?.(nextRecord);
    }
  };

  const computeWsConfirm = (chainId: number, tokenAddress: `0x${string}`, nowMs: number, strategy: any) =>
    computeWsConfirmFromWs(wsSnapshotsByAddr, chainId, tokenAddress, nowMs, strategy);

  const getWsDrawdownPctSince = (chainId: number, tokenAddress: `0x${string}`, sinceMs: number) =>
    getWsDrawdownPctSinceFromWs(wsSnapshotsByAddr, chainId, tokenAddress, sinceMs);

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
    const scopedTokens = new Map<string, { chainId: number; tokenAddress: `0x${string}` }>();
    for (const pos of rapidExitByPosKey.values()) {
      const addr = normalizeAddress(pos?.tokenAddress);
      if (!addr) continue;
      scopedTokens.set(toScopedTokenKey(pos.chainId, addr), { chainId: pos.chainId, tokenAddress: addr });
    }
    for (const { chainId, tokenAddress } of scopedTokens.values()) {
      const scopedKey = toScopedTokenKey(chainId, tokenAddress);
      const latestList = wsSnapshotsByAddr.get(scopedKey) ?? [];
      const latest = latestList.length ? latestList[latestList.length - 1] : null;
      const wsAgeMs = latest ? nowMs - latest.atMs : Number.POSITIVE_INFINITY;
      if (wsAgeMs > staleMs) {
        const rpcKey = scopedKey;
        const lastRpcAt = rapidWatchdogRpcAtMs.get(rpcKey) ?? 0;
        if (nowMs - lastRpcAt >= rpcCooldownMs) {
          rapidWatchdogRpcAtMs.set(rpcKey, nowMs);
          try {
            const anyPos = Array.from(rapidExitByPosKey.values()).find(
              (p) => Number(p.chainId) === Number(chainId) && p.tokenAddress.toLowerCase() === tokenAddress.toLowerCase()
            );
            const resolvedChainId = anyPos?.chainId ?? chainId;
            const impliedSupply = Number(anyPos?.impliedSupply);
            const priceUsd = await TokenService.getPriceUsdFromRpc({
              chainId: resolvedChainId,
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
              wsSnapshotsByAddr.set(scopedKey, next);
            }
          } catch {
          }
        }
      }
      void maybeEvaluateRapidExitAutoSellFromMod({
        chainId,
        tokenAddress,
        nowMs,
        strategy,
        wsSnapshotsByAddr,
        rapidExitByPosKey,
        cleanupPosKey,
        isPosMarkedManuallyClosed: (posKey) => manuallyClosedPosKeys.has(posKey),
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

  async function onWsSnapshotUpdated(chainId: number, tokenAddress: `0x${string}`, nowMs: number) {
    const snapshots = wsSnapshotsByAddr.get(toScopedTokenKey(chainId, tokenAddress)) ?? [];
    const cur = snapshots.length ? snapshots[snapshots.length - 1] : null;
    if (cur) {
      void maybeUpdateXSniperHistoryEvaluations({
        chainId,
        tokenAddress,
        nowMs,
        marketCapUsd: cur.marketCapUsd,
        holders: cur.holders,
      });
    }
    void maybeEvaluateDryRunAutoSellFromMod({
      chainId,
      tokenAddress,
      nowMs,
      wsSnapshotsByAddr,
      dryRunAutoSellByPosKey,
      cleanupPosKey,
      emitRecord,
    });
    void maybeEvaluateRapidExitAutoSellFromMod({
      chainId,
      tokenAddress,
      nowMs,
      strategy: latestTwitterSnipeStrategy,
      wsSnapshotsByAddr,
      rapidExitByPosKey,
      cleanupPosKey,
      isPosMarkedManuallyClosed: (posKey) => manuallyClosedPosKeys.has(posKey),
      tryRapidExitSellOnce,
    });
  }

  const markPositionSoldManually = (input: {
    chainId: number;
    tokenAddress: `0x${string}`;
    sellPercent?: number;
    txHash?: string;
  }) => {
    const tokenKey = `${input.chainId}:${input.tokenAddress.toLowerCase()}`;
    const keysToTouch: string[] = [];
    for (const key of rapidExitByPosKey.keys()) {
      if (key.startsWith('dry:')) continue;
      if (key !== tokenKey && !key.startsWith(`${tokenKey}:`)) continue;
      keysToTouch.push(key);
    }
    if (!keysToTouch.length) return false;
    const pctCurrentRaw = Number(input.sellPercent);
    const pctCurrent = Number.isFinite(pctCurrentRaw) ? Math.max(0, Math.min(100, pctCurrentRaw)) : 0;
    if (!(pctCurrent > 0)) return false;
    let soldOriginalTotal = 0;
    let updated = false;
    for (const key of keysToTouch) {
      const pos = rapidExitByPosKey.get(key);
      if (!pos) continue;
      const nowRemaining = Number.isFinite(pos.remainingPercent)
        ? Math.max(0, Math.min(100, Number(pos.remainingPercent)))
        : 100;
      if (!(nowRemaining > 0)) {
        cleanupPosKey(key);
        continue;
      }
      const soldOriginal = Math.max(0, Math.min(nowRemaining, (nowRemaining * pctCurrent) / 100));
      if (!(soldOriginal > 0)) continue;
      soldOriginalTotal += soldOriginal;
      const nextRemaining = Math.max(0, Math.min(100, nowRemaining - soldOriginal));
      if (!(nextRemaining > 0)) {
        manuallyClosedPosKeys.set(key, Date.now());
        cleanupPosKey(key);
      } else {
        pos.remainingPercent = nextRemaining;
        pos.failCount = 0;
        pos.nextRetryAtMs = 0;
        rapidExitByPosKey.set(key, pos);
      }
      updated = true;
    }
    if (!updated) return false;
    let hasRemainingTrackedPos = false;
    for (const key of rapidExitByPosKey.keys()) {
      if (key.startsWith('dry:')) continue;
      if (key !== tokenKey && !key.startsWith(`${tokenKey}:`)) continue;
      hasRemainingTrackedPos = true;
      break;
    }
    const snapshots = wsSnapshotsByAddr.get(input.tokenAddress) ?? [];
    const latest = snapshots.length ? snapshots[snapshots.length - 1] : null;
    const now = Date.now();
    emitRecord({
      id: `${now}-${Math.random().toString(16).slice(2)}`,
      side: 'sell',
      tsMs: now,
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      sellPercent: pctCurrent,
      sellPercentOfOriginal: Math.max(0, Math.min(100, soldOriginalTotal)),
      sellPercentOfCurrent: pctCurrent,
      txHash: input.txHash,
      dryRun: false,
      marketCapUsd: latest?.marketCapUsd,
      reason: hasRemainingTrackedPos ? 'position_reduced_manually' : 'position_closed_manually',
    } as any);
    return true;
  };
  const markPositionClosedManually = (input: {
    chainId: number;
    tokenAddress: `0x${string}`;
    txHash?: string;
  }) =>
    markPositionSoldManually({
      ...input,
      sellPercent: 100,
    });

  const clearRuntimeState = () => {
    dryRunAutoSellByPosKey.clear();
    rapidExitByPosKey.clear();
    manuallyClosedPosKeys.clear();
    rapidWatchdogRpcAtMs.clear();
    wsSnapshotsByAddr.clear();
    buyFailureRecordDedupe.clear();
    wsConfirmFailDedupe.clear();
    buyInFlight.clear();
  };

  const pushWsSnapshot = (chainId: number, tokenAddress: `0x${string}`, metrics: TokenMetrics) => {
    pushWsSnapshotFromWs({
      chainId,
      tokenAddress,
      metrics,
      wsSnapshotsByAddr,
      onUpdated: (_updatedTokenAddress, atMs) => {
        void onWsSnapshotUpdated(chainId, tokenAddress, atMs);
      },
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

  const getKey = (chainId: number, tokenAddress: `0x${string}`, opts?: { dry?: boolean; walletAddress?: `0x${string}` }) => {
    const dry = opts?.dry === true;
    const walletKey = opts?.walletAddress ? String(opts.walletAddress).toLowerCase() : 'all-wallets';
    return `${dry ? 'dry:' : ''}${chainId}:${tokenAddress.toLowerCase()}:${walletKey}:full`;
  };

  const { fetchTokenInfoFresh, buildGenericTokenInfo, getEntryPriceUsd } = createTokenInfoResolvers();

  const tryAutoBuyOnce = async (input: {
    chainId: number;
    tokenAddress: `0x${string}`;
    metrics: TokenMetrics;
    strategy: any;
    signal?: UnifiedTwitterSignal;
    amountNativeOverride?: number;
    onAttemptOutcome?: (outcome: { bought: boolean; attempted: boolean; reason?: string }) => void;
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
      onAttemptOutcome: input.onAttemptOutcome,
    });

  const { tryDeleteTweetSellOnce, tryRapidExitSellOnce } = createSellExecutors({
    cleanupPosKey,
    emitRecord,
    broadcastToActiveTabs,
    fetchTokenInfoFresh,
    buildGenericTokenInfo,
    getLatestMarketCapUsd: (chainId, tokenAddress) => {
      const snaps = wsSnapshotsByAddr.get(toScopedTokenKey(chainId, tokenAddress)) ?? [];
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
    buyAmountNative: number;
    openedAtMs: number;
    tweetAtMs?: number;
    tweetUrl?: string;
    tweetType?: string;
    channel?: string;
    signalId?: string;
    signalEventId?: string;
    signalTweetId?: string;
    entryPriceUsd?: number | null;
    walletAddress?: `0x${string}`;
  }) =>
    (() => {
      manuallyClosedPosKeys.delete(input.posKey);
      registerRapidExitPositionFromMod({
        rapidExitByPosKey,
        ...input,
      });
    })();

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
          const tradeChainId = resolveRecordedTradeChainId({
            recordedChainId: r.chainId,
            tokenAddress: addr,
            signal,
            fallbackChainId: settings.chainId,
            settings,
          });
          const walletKey = normalizeAddress((r as any).walletAddress) || 'all-wallets';
          const dedupe = `${tradeChainId}:${addr.toLowerCase()}:${walletKey}`;
          if (sold.has(dedupe)) continue;
          try {
            await tryDeleteTweetSellOnce({
              chainId: tradeChainId,
              tokenAddress: addr,
              percent,
              signal,
              relatedBuy: r,
              dryRun: r.dryRun === true,
              walletAddress: (r as any).walletAddress,
            });
          } catch {
          }
          sold.add(dedupe);
        }
        for (const p of rapidMatched) {
          const addr = normalizeAddress(p.tokenAddress);
          if (!addr) continue;
          const walletKey = normalizeAddress((p as any).walletAddress) || 'all-wallets';
          const dedupe = `${p.chainId}:${addr.toLowerCase()}:${walletKey}`;
          if (sold.has(dedupe)) continue;
          try {
            await tryDeleteTweetSellOnce({
              chainId: p.chainId,
              tokenAddress: addr,
              percent,
              signal,
              dryRun: p.dryRun,
              walletAddress: (p as any).walletAddress,
            });
          } catch {
          }
          sold.add(dedupe);
        }
        return;
      }
      if (!matchesTwitterFilters(signal, strategy)) return;

      const selection = pickTokensToBuyFromSignal({
        signal,
        strategy,
        pushWsSnapshot,
        computeWsConfirm,
      });
      const picked = selection.picked;
      const decisions = selection.decisions;
      const perTweetMax = Math.max(0, Math.floor(parseNumber(strategy?.buyNewCaCount) ?? 0));
      const dryRun = strategy?.dryRun === true;
      const signalStableId = resolveSignalStableId(signal);
      const strategyWalletAddress = parseWalletAddress(strategy?.walletAddress);
      const walletStatus = !dryRun ? await WalletService.getStatus().catch(() => null) : null;
      const activeWalletAddress = !dryRun ? parseWalletAddress(walletStatus?.address) : undefined;
      const walletAddressResolved = strategyWalletAddress || activeWalletAddress;
      const walletAddressKey = walletAddressResolved || 'all-wallets';
      const walletSource = strategyWalletAddress ? 'strategy' : activeWalletAddress ? 'active' : 'fallback';
      const decisionMapByAddr = new Map<string, (typeof decisions)[number]>();
      for (const d of decisions) {
        const tokenAddress = d.m?.tokenAddress ?? normalizeAddress((d.t as any)?.tokenAddress);
        if (!tokenAddress) continue;
        decisionMapByAddr.set(tokenAddress.toLowerCase(), d);
        const tradeChainId = resolveTradeChainId((d.t as any)?.chain, settings.chainId, settings);
        const finalFailReason = !d.fullPass
          ? (d.fullFailReason || 'buy_filter_rejected')
          : (!d.wsConfirmPass ? (d.wsConfirmReason || 'ws_confirm_failed') : undefined);
        void upsertXSniperDecisionSnapshot({
          signalStableId,
          signalId: signal.id ? String(signal.id) : undefined,
          signalEventId: signal.eventId ? String(signal.eventId) : undefined,
          signalTweetId: signal.tweetId ? String(signal.tweetId) : undefined,
          chainId: tradeChainId,
          tokenAddress,
          walletAddressKey,
          walletAddressResolved,
          walletSource,
          everEligibleInTokenAgeWindow: d.tokenWindowPass,
          everEligibleInTweetAgeWindow: d.tweetWindowPass,
          finalFailReasonInTokenAgeWindow: d.tokenWindowPass ? null : (d.tokenWindowFailReason || null),
          finalFailReasonInTweetAgeWindow: d.tweetWindowPass ? null : (d.tweetWindowFailReason || null),
          finalFailReason: finalFailReason || null,
          buyAttemptResult: finalFailReason ? 'not_attempted' : undefined,
          notAttemptedReason: finalFailReason || null,
        });
      }
      let boughtCount = 0;
      for (let i = 0; i < picked.length; i += 1) {
        const { t, m } = picked[i];
        if (!m?.tokenAddress) continue;
        const tokenAddress = m.tokenAddress;
        const decision = decisionMapByAddr.get(tokenAddress.toLowerCase()) ?? null;
        const tradeChainId = resolveTradeChainId((t as any)?.chain, settings.chainId, settings);
        if (!dryRun && boughtCount >= perTweetMax) {
          for (let j = i; j < picked.length; j += 1) {
            const quotaToken = picked[j]?.m?.tokenAddress;
            if (!quotaToken) continue;
            const quotaDecision = decisionMapByAddr.get(quotaToken.toLowerCase()) ?? null;
            void upsertXSniperDecisionSnapshot({
              signalStableId,
              signalId: signal.id ? String(signal.id) : undefined,
              signalEventId: signal.eventId ? String(signal.eventId) : undefined,
              signalTweetId: signal.tweetId ? String(signal.tweetId) : undefined,
              chainId: resolveTradeChainId((picked[j].t as any)?.chain, settings.chainId, settings),
              tokenAddress: quotaToken,
              walletAddressKey,
              walletAddressResolved,
              walletSource,
              everEligibleInTokenAgeWindow: quotaDecision?.tokenWindowPass === true,
              everEligibleInTweetAgeWindow: quotaDecision?.tweetWindowPass === true,
              finalFailReason: 'buy_skipped_per_tweet_quota_reached',
              buyAttemptResult: 'not_attempted',
              notAttemptedReason: 'buy_skipped_per_tweet_quota_reached',
              windowClosedAtMs: Date.now(),
            });
          }
          break;
        }
        let bought = false;
        let outcome: { bought: boolean; attempted: boolean; reason?: string; detail?: any } = { bought: false, attempted: true };
        try {
          currentSignalContext = signal;
          bought = await tryAutoBuyOnce({
            chainId: tradeChainId,
            tokenAddress: m.tokenAddress,
            metrics: m,
            strategy,
            signal,
            onAttemptOutcome: (o) => {
              outcome = o;
            },
          });
        } catch (e) {
          console.error('XSniperTrade buy attempt failed', {
            tokenAddress: m.tokenAddress,
            signalId: signal.id,
            tweetId: signal.tweetId,
          }, e);
          outcome = { bought: false, attempted: true, reason: 'buy_attempt_exception' };
          continue;
        } finally {
          const resolvedOutcomeReason = bought
            ? null
            : (outcome.reason || (outcome.attempted ? 'buy_failed_without_reason' : 'buy_not_attempted_without_reason'));
          const wsConfirmDetail = resolvedOutcomeReason === 'ws_confirm_failed'
            ? {
              windowMs: Number(outcome.detail?.wsConfirm?.windowMs ?? 0) || undefined,
              failedChecks: Array.isArray(outcome.detail?.wsConfirm?.failedChecks) ? outcome.detail.wsConfirm.failedChecks : undefined,
            }
            : null;
          void upsertXSniperDecisionSnapshot({
            signalStableId,
            signalId: signal.id ? String(signal.id) : undefined,
            signalEventId: signal.eventId ? String(signal.eventId) : undefined,
            signalTweetId: signal.tweetId ? String(signal.tweetId) : undefined,
            chainId: tradeChainId,
            tokenAddress,
            walletAddressKey,
            walletAddressResolved,
            walletSource,
            everEligibleInTokenAgeWindow: decision?.tokenWindowPass === true,
            everEligibleInTweetAgeWindow: decision?.tweetWindowPass === true,
            everAttemptedBuy: outcome.attempted,
            buyAttemptResult: bought
              ? 'success'
              : (outcome.attempted ? 'failed_after_attempt' : 'not_attempted'),
            finalFailReason: resolvedOutcomeReason,
            wsConfirmWindowMs: wsConfirmDetail ? (wsConfirmDetail.windowMs ?? null) : undefined,
            wsConfirmFailedChecks: wsConfirmDetail ? (wsConfirmDetail.failedChecks ?? null) : undefined,
            notAttemptedReason: bought
              ? null
              : (!outcome.attempted ? resolvedOutcomeReason : null),
            windowClosedAtMs: Date.now(),
          });
          currentSignalContext = null;
        }
        if (!dryRun && bought) {
          boughtCount += 1;
        }
      }
    } catch (e) {
      console.error('XSniperTrade twitter signal handler error', e);
    }
  };

  return { handleTwitterSignal, markPositionSoldManually, markPositionClosedManually, clearRuntimeState };
};
