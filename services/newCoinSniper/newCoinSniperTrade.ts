import { browser } from 'wxt/browser';
import { SettingsService } from '@/services/settings';
import { defaultSettings } from '@/utils/defaults';
import type { NewCoinXmodeSnipeTask, UnifiedMarketSignal, UnifiedSignalToken, UnifiedTwitterSignal } from '@/types/extention';
import { createTokenInfoResolvers } from '@/services/xSniper/engine/tokenInfoResolver';
import { maybeEvaluateDryRunAutoSell as maybeEvaluateDryRunAutoSellFromMod, type DryRunAutoSellPos } from '@/services/xSniper/engine/dryRunAutoSell';
import { maybeEvaluateRapidExitAutoSell as maybeEvaluateRapidExitAutoSellFromMod, registerRapidExitPosition as registerRapidExitPositionFromMod, type RapidExitPosition } from '@/services/xSniper/engine/rapidExitAutoSell';
import { createSellExecutors } from '@/services/xSniper/engine/sellExecutors';
import { type TokenMetrics, normalizeAddress, parseNumber, shouldBuyByConfig } from '@/services/xSniper/engine/metrics';
import { extractLaunchpadPlatform } from '@/constants/launchpad';
import { computeWsConfirm as computeWsConfirmFromWs, pushWsSnapshot as pushWsSnapshotFromWs, shouldLogWsConfirmFail as shouldLogWsConfirmFailFromWs, type WsSnapshot } from '@/services/xSniper/engine/wsSnapshots';
import { metricsFromUnifiedToken } from '@/services/xSniper/engine/signalSelection';
import { tryAutoBuyOnce as tryAutoBuyOnceFromMod } from '@/services/xSniper/engine/buyExecutor';
import { maybeUpdateNewCoinSniperHistoryEvaluations, pushNewCoinSniperHistory } from '@/services/newCoinSniper/newCoinSniperHistory';
import { TokenService } from '@/services/token';
import { getChainIdByName } from '@/constants/chains';

export const createNewCoinSniperTrade = (deps: {
  onStateChanged: () => void;
}) => {
  const resolveTradeChainId = (input: {
    tokenChain?: string;
    signalChain?: string;
    fallbackChainId: number;
    settings: any;
  }) => {
    const candidates = [input.tokenChain, input.signalChain];
    for (const raw of candidates) {
      const name = typeof raw === 'string' ? raw.trim() : '';
      if (!name) continue;
      const chainId = getChainIdByName(name);
      if (!Number.isFinite(chainId) || chainId <= 0) continue;
      if (!input.settings?.chains?.[chainId]) continue;
      return chainId;
    }
    return input.fallbackChainId;
  };

  const DEFAULT_PLATFORM_FILTERS = ['fourmeme', 'fourmeme_agent', 'xmode', 'xmode_agent'] as const;
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
  const rapidWatchdogRpcAtMs = new Map<string, number>();
  const latestModeMetaByToken = new Map<string, { strategyMode: 'auto_filter' | 'xmode_task'; taskId?: string; taskName?: string; matchKeywords?: string[]; matchText?: string }>();
  let currentSignalContext: UnifiedMarketSignal | null = null;
  let currentStrategyMode: 'auto_filter' | 'xmode_task' = 'auto_filter';
  let currentTaskContext: { taskId?: string; taskName?: string; matchKeywords?: string[]; matchText?: string } | null = null;
  let latestNewCoinSnipeStrategy: any = null;
  let rapidWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  let rapidWatchdogIntervalMs = -1;

  const cleanupPosKey = (posKey: string) => {
    dryRunAutoSellByPosKey.delete(posKey);
    rapidExitByPosKey.delete(posKey);
  };

  const { fetchTokenInfoFresh, buildGenericTokenInfo, getEntryPriceUsd } = createTokenInfoResolvers();

  const shouldLogWsConfirmFail = (key: string, nowMs: number) => shouldLogWsConfirmFailFromWs(wsConfirmFailDedupe, key, nowMs);
  const computeWsConfirm = (tokenAddress: `0x${string}`, nowMs: number, strategy: any) =>
    computeWsConfirmFromWs(wsSnapshotsByAddr, tokenAddress, nowMs, strategy);

  const readRapidWatchdogIntervalMs = (strategy: any) => {
    const secRaw = parseNumber(strategy?.rapidWatchdogSec);
    const sec = Number.isFinite(secRaw) ? Math.floor(Number(secRaw)) : 1;
    const clampedSec = Math.max(0, Math.min(10, sec));
    return clampedSec * 1000;
  };

  const runRapidWatchdogTick = async () => {
    const strategy = latestNewCoinSnipeStrategy;
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
    const modeTag = currentStrategyMode === 'xmode_task'
      ? `xmode_task:${currentTaskContext?.taskId || 'no-task'}`
      : 'auto_filter';
    const key = `${input.reason}:${input.chainId}:${input.tokenAddress.toLowerCase()}:${signalStableId}:${modeTag}`;
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

  const buildPseudoSignalFromMarketSignal = (signal: UnifiedMarketSignal): UnifiedTwitterSignal => ({
    id: signal.id,
    site: signal.site,
    channel: signal.channel,
    tweetType: 'tweet',
    userScreen: signal.source,
    userName: signal.source,
    tokens: signal.tokens,
    receivedAtMs: signal.receivedAtMs,
    ts: signal.ts,
  });

  const emitRecord = (record: any) => {
    const signal = currentSignalContext;
    const signalSourceTag = signal?.source ? String(signal.source) : undefined;
    const tokenAddrLower = String(record?.tokenAddress || '').trim().toLowerCase();
    const fallbackModeMeta = (() => {
      if (currentStrategyMode === 'xmode_task') {
        return {
          strategyMode: 'xmode_task' as const,
          taskId: currentTaskContext?.taskId,
          taskName: currentTaskContext?.taskName,
          matchKeywords: currentTaskContext?.matchKeywords,
          matchText: currentTaskContext?.matchText,
        };
      }
      if (record?.side === 'sell' && tokenAddrLower) {
        return latestModeMetaByToken.get(tokenAddrLower) ?? { strategyMode: 'auto_filter' as const };
      }
      return { strategyMode: 'auto_filter' as const };
    })();
    const resolvedModeMeta = {
      strategyMode: (record?.strategyMode === 'xmode_task' ? 'xmode_task' : record?.strategyMode === 'auto_filter' ? 'auto_filter' : fallbackModeMeta.strategyMode),
      taskId: record?.taskId ?? fallbackModeMeta.taskId,
      taskName: record?.taskName ?? fallbackModeMeta.taskName,
      matchKeywords: Array.isArray(record?.matchKeywords) ? record.matchKeywords : fallbackModeMeta.matchKeywords,
      matchText: record?.matchText ?? fallbackModeMeta.matchText,
    };
    if (tokenAddrLower && resolvedModeMeta.strategyMode) {
      latestModeMetaByToken.set(tokenAddrLower, resolvedModeMeta);
    }
    const resolvedLaunchpadPlatform = (() => {
      const fromRecord = extractLaunchpadPlatform(record as any);
      if (fromRecord) return fromRecord;
      const addr = String(record?.tokenAddress || '').trim().toLowerCase();
      if (!addr) return undefined;
      const tokens = Array.isArray(signal?.tokens) ? (signal?.tokens as UnifiedSignalToken[]) : [];
      const matched = tokens.find((x) => String((x as any)?.tokenAddress || '').trim().toLowerCase() === addr);
      return extractLaunchpadPlatform(matched as any);
    })();
    void pushNewCoinSniperHistory({
      id: record.id,
      tsMs: record.tsMs,
      buySubmittedAtMs: record.buySubmittedAtMs,
      side: record.side,
      reason: record.reason,
      tweetAtMs: record.tweetAtMs,
      tweetUrl: record.tweetUrl,
      chainId: record.chainId,
      tokenAddress: record.tokenAddress,
      tokenSymbol: record.tokenSymbol,
      tokenName: record.tokenName,
      buyAmountNative: record.buyAmountNative,
      sellPercent: record.sellPercent,
      sellPercentOfOriginal: record.sellPercentOfOriginal,
      sellPercentOfCurrent: record.sellPercentOfCurrent,
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
      userScreen: record.userScreen ?? signalSourceTag,
      userName: record.userName ?? signalSourceTag,
      tweetType: record.tweetType,
      source: signal?.source,
      signalId: record.signalId ?? signal?.id,
      signalEventId: record.signalEventId,
      signalTweetId: record.signalTweetId,
      channel: record.channel ?? signal?.channel,
      strategyMode: resolvedModeMeta.strategyMode,
      taskId: resolvedModeMeta.taskId,
      taskName: resolvedModeMeta.taskName,
      matchKeywords: resolvedModeMeta.matchKeywords,
      matchText: resolvedModeMeta.matchText,
      triggerSource: signal?.source,
      ...(resolvedLaunchpadPlatform ? { launchpadPlatform: resolvedLaunchpadPlatform } : {}),
    });
    void broadcastToTabs({
      type: 'bg:newCoinSniper:order',
      record: {
        ...record,
        userScreen: record.userScreen ?? signalSourceTag,
        userName: record.userName ?? signalSourceTag,
        source: signal?.source,
        signalId: record.signalId ?? signal?.id,
        signalEventId: record.signalEventId,
        signalTweetId: record.signalTweetId,
        channel: record.channel ?? signal?.channel,
        strategyMode: resolvedModeMeta.strategyMode,
        taskId: resolvedModeMeta.taskId,
        taskName: resolvedModeMeta.taskName,
        matchKeywords: resolvedModeMeta.matchKeywords,
        matchText: resolvedModeMeta.matchText,
        triggerSource: signal?.source,
        ...(resolvedLaunchpadPlatform ? { launchpadPlatform: resolvedLaunchpadPlatform } : {}),
      },
    });
  };

  const normalizeSignalTokens = (signal: UnifiedMarketSignal): UnifiedSignalToken[] =>
    Array.isArray(signal.tokens)
      ? (signal.tokens as UnifiedSignalToken[]).filter((t) => t && typeof t.tokenAddress === 'string' && t.tokenAddress.trim())
      : [];

  const normalizePlatformFilters = (input: unknown): string[] => {
    const raw = Array.isArray(input) ? input : [];
    const list = raw
      .map((x) => String(x).trim().toLowerCase())
      .filter(Boolean);
    return list.length ? Array.from(new Set(list)) : [...DEFAULT_PLATFORM_FILTERS];
  };

  const normalizeKeywords = (input: unknown): string[] => {
    if (!Array.isArray(input)) return [];
    return Array.from(
      new Set(
        input
          .map((x) => String(x ?? '').trim().toLowerCase())
          .filter(Boolean),
      ),
    );
  };

  const normalizeAutoTaskPlatforms = (input: unknown): string[] => {
    const raw = Array.isArray(input) ? input : [];
    const list = raw
      .map((x) => String(x ?? '').trim().toLowerCase())
      .filter(Boolean);
    return list.length ? Array.from(new Set(list)) : ['fourmeme', 'fourmeme_agent'];
  };

  const readDefaultTaskBuyAmountNative = (strategy: any): string => {
    const raw = String(strategy?.buyAmountNative ?? '').trim();
    const n = parseNumber(raw);
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) return raw;
    const fallback = String((defaultSettings().autoTrade as any)?.newCoinSnipe?.buyAmountNative ?? '').trim();
    const f = parseNumber(fallback);
    if (typeof f === 'number' && Number.isFinite(f) && f > 0) return fallback;
    return '0.006';
  };

  const parsePositiveInt = (input: unknown, fallback: number, min: number, max: number) => {
    const raw = parseNumber(typeof input === 'string' || typeof input === 'number' ? String(input) : '');
    const n = Number.isFinite(raw) ? Math.floor(Number(raw)) : fallback;
    return Math.max(min, Math.min(max, n));
  };

  const parseRangeBound = (input: unknown): number | null => {
    const raw = parseNumber(typeof input === 'string' || typeof input === 'number' ? String(input) : '');
    return Number.isFinite(raw) ? Number(raw) : null;
  };

  const inRange = (value: number | null, minRaw: unknown, maxRaw: unknown) => {
    const min = parseRangeBound(minRaw);
    const max = parseRangeBound(maxRaw);
    if (min == null && max == null) return true;
    if (value == null || !Number.isFinite(value)) return false;
    if (min != null && value < min) return false;
    if (max != null && value > max) return false;
    return true;
  };

  const passAutoTaskRangeFilters = (metrics: TokenMetrics, strategy: any, nowMs: number) => {
    const marketCapUsd =
      typeof metrics.marketCapUsd === 'number' && Number.isFinite(metrics.marketCapUsd) ? metrics.marketCapUsd : null;
    if (!inRange(marketCapUsd, strategy?.autoTaskMinMarketCapUsd, strategy?.autoTaskMaxMarketCapUsd)) return false;
    const holders = typeof metrics.holders === 'number' && Number.isFinite(metrics.holders) ? metrics.holders : null;
    if (!inRange(holders, strategy?.autoTaskMinHolders, strategy?.autoTaskMaxHolders)) return false;
    const kol = typeof metrics.kol === 'number' && Number.isFinite(metrics.kol) ? metrics.kol : null;
    if (!inRange(kol, strategy?.autoTaskMinKol, strategy?.autoTaskMaxKol)) return false;
    const tokenAtMs = (() => {
      const firstSeen = typeof metrics.firstSeenAtMs === 'number' ? metrics.firstSeenAtMs : null;
      const createdAt = typeof metrics.createdAtMs === 'number' ? metrics.createdAtMs : null;
      if (firstSeen != null && firstSeen > 0) return firstSeen;
      if (createdAt != null && createdAt > 0) return createdAt;
      return null;
    })();
    const tokenAgeSec =
      tokenAtMs != null && nowMs >= tokenAtMs ? Math.floor((nowMs - tokenAtMs) / 1000) : null;
    if (!inRange(tokenAgeSec, strategy?.autoTaskMinTokenAgeSeconds, strategy?.autoTaskMaxTokenAgeSeconds)) return false;
    return true;
  };

  const getWsAthMarketCapUsd = (tokenAddress: `0x${string}`): number => {
    const snapshots = wsSnapshotsByAddr.get(tokenAddress) ?? [];
    let ath = 0;
    for (const snap of snapshots) {
      const mcap = Number(snap?.marketCapUsd);
      if (!Number.isFinite(mcap) || mcap <= 0) continue;
      if (mcap > ath) ath = mcap;
    }
    return ath;
  };

  const buildTaskKeywordKey = (keywords: string[]) => normalizeKeywords(keywords).slice().sort().join('|');

  const ensureAutoTasksFromSignal = async (input: {
    settings: any;
    strategy: any;
    signal: UnifiedMarketSignal;
  }): Promise<{
    strategy: any;
    updated: boolean;
    addedCount: number;
  }> => {
    const taskModeEnabled = input.strategy?.taskModeEnabled === true;
    const autoTaskEnabled = input.strategy?.autoTaskFromWsEnabled === true;
    if (!taskModeEnabled || !autoTaskEnabled) return { strategy: input.strategy, updated: false, addedCount: 0 };
    const allowedPlatforms = normalizeAutoTaskPlatforms(input.strategy?.autoTaskPlatforms);
    if (!allowedPlatforms.length) return { strategy: input.strategy, updated: false, addedCount: 0 };
    const athThresholdRaw = parseRangeBound(input.strategy?.autoTaskAthMcapUsd);
    const athThresholdUsd = athThresholdRaw == null
      ? null
      : Math.max(100, Math.min(50_000_000, athThresholdRaw));
    const maxPerSignal = parsePositiveInt(input.strategy?.autoTaskMaxPerSignal, 5, 1, 50);
    const tasks = normalizeXmodeTasks(input.strategy?.xmodeTasks);
    const defaultTaskBuyAmountNative = readDefaultTaskBuyAmountNative(input.strategy);
    const existingKeywordKeySet = new Set(tasks.map((t) => buildTaskKeywordKey(t.keywords)));
    const tokens = normalizeSignalTokens(input.signal);
    const additions: NewCoinXmodeSnipeTask[] = [];
    const now = Date.now();
    for (const token of tokens) {
      if (additions.length >= maxPerSignal) break;
      const metrics = metricsFromUnifiedToken(token);
      if (!metrics?.tokenAddress) continue;
      pushWsSnapshot(metrics.tokenAddress, metrics);
      const platform = extractTokenPlatform(token);
      if (!platform || !allowedPlatforms.includes(platform)) continue;
      if (!passAutoTaskRangeFilters(metrics, input.strategy, now)) continue;
      const athMcapUsd = getWsAthMarketCapUsd(metrics.tokenAddress);
      if (athThresholdUsd != null && (!Number.isFinite(athMcapUsd) || athMcapUsd < athThresholdUsd)) continue;
      const symbol = String(token.tokenSymbol || '').trim();
      const name = String(token.tokenName || '').trim();
      const keywords = normalizeKeywords([name, symbol]);
      if (!keywords.length) continue;
      const keywordKey = buildTaskKeywordKey(keywords);
      if (!keywordKey || existingKeywordKeySet.has(keywordKey)) continue;
      existingKeywordKeySet.add(keywordKey);
      additions.push({
        id: `auto_ws_${now}_${additions.length}_${Math.floor(Math.random() * 1000)}`,
        enabled: true,
        taskName: name || symbol || `AUTO ${metrics.tokenAddress.slice(0, 8)}`,
        tokenAddress: metrics.tokenAddress,
        keywords,
        matchMode: 'any',
        maxTokenAgeSeconds: String(parsePositiveInt(input.strategy?.maxTokenAgeSeconds, 600, 1, 3600)),
        buyAmountNative: defaultTaskBuyAmountNative,
        buyGasGwei: '',
        buyBribeBnb: '',
        autoSellEnabled: input.strategy?.autoSellEnabled !== false,
        createdAt: now,
      });
    }
    if (!additions.length) return { strategy: input.strategy, updated: false, addedCount: 0 };
    try {
      const latestSettings = await SettingsService.get();
      const latestConfig = normalizeAutoTrade((latestSettings as any).autoTrade);
      const latestStrategy = (latestConfig as any)?.newCoinSnipe ?? input.strategy;
      const latestTasks = normalizeXmodeTasks(latestStrategy?.xmodeTasks);
      const latestKeywordKeys = new Set(latestTasks.map((t) => buildTaskKeywordKey(t.keywords)));
      const mergedAdditions = additions.filter((t) => {
        const key = buildTaskKeywordKey(t.keywords);
        if (!key || latestKeywordKeys.has(key)) return false;
        latestKeywordKeys.add(key);
        return true;
      });
      if (!mergedAdditions.length) return { strategy: latestStrategy, updated: false, addedCount: 0 };
      const nextTasks = latestTasks.concat(mergedAdditions);
      const nextStrategy = {
        ...latestStrategy,
        xmodeTasks: nextTasks,
      };
      const nextAutoTrade = {
        ...latestSettings.autoTrade,
        newCoinSnipe: nextStrategy,
      };
      await SettingsService.update({ autoTrade: nextAutoTrade } as any);
      return { strategy: nextStrategy, updated: true, addedCount: mergedAdditions.length };
    } catch (e) {
      console.error('auto task persist failed', e);
      return { strategy: input.strategy, updated: false, addedCount: 0 };
    }
  };

  const normalizeXmodeTasks = (input: unknown): NewCoinXmodeSnipeTask[] => {
    const raw = Array.isArray(input) ? input : [];
    const tasks: NewCoinXmodeSnipeTask[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const id = String((item as any).id || '').trim();
      const keywords = normalizeKeywords((item as any).keywords);
      if (!id || !keywords.length) continue;
      tasks.push({
        id,
        enabled: (item as any).enabled !== false,
        taskName: String((item as any).taskName || '').trim() || undefined,
        tokenAddress: normalizeAddress((item as any).tokenAddress) ?? undefined,
        keywords,
        matchMode: (item as any).matchMode === 'all' ? 'all' : 'any',
        maxTokenAgeSeconds: typeof (item as any).maxTokenAgeSeconds === 'string' ? String((item as any).maxTokenAgeSeconds).trim() : '600',
        buyAmountNative: typeof (item as any).buyAmountNative === 'string' ? String((item as any).buyAmountNative).trim() : '',
        buyGasGwei: typeof (item as any).buyGasGwei === 'string' ? String((item as any).buyGasGwei).trim() : '',
        buyBribeBnb: typeof (item as any).buyBribeBnb === 'string' ? String((item as any).buyBribeBnb).trim() : '',
        autoSellEnabled: (item as any).autoSellEnabled !== false,
        createdAt: Number((item as any).createdAt) > 0 ? Number((item as any).createdAt) : Date.now(),
      });
    }
    return tasks;
  };

  const buildTokenMatchText = (token: UnifiedSignalToken) => {
    const parts = [
      String(token.tokenSymbol || '').trim().toLowerCase(),
      String(token.tokenName || '').trim().toLowerCase(),
    ].filter(Boolean);
    return parts.join(' ');
  };

  const parseMaxTokenAgeSec = (task: NewCoinXmodeSnipeTask) => {
    const n = parseNumber(task.maxTokenAgeSeconds);
    const sec = Number.isFinite(n) ? Math.floor(Number(n)) : 600;
    return Math.max(1, Math.min(3600, sec));
  };

  const matchTaskKeywords = (task: NewCoinXmodeSnipeTask, matchText: string) => {
    const keywords = normalizeKeywords(task.keywords);
    if (!keywords.length) return { pass: false, matched: [] as string[] };
    const matched = keywords.filter((kw) => matchText.includes(kw));
    const pass = task.matchMode === 'all' ? matched.length === keywords.length : matched.length > 0;
    return { pass, matched };
  };

  const extractTokenPlatform = (token: UnifiedSignalToken): string => {
    return extractLaunchpadPlatform(token as any) ?? '';
  };

  const pickCandidates = (signal: UnifiedMarketSignal, strategy: any) => {
    const now = Date.now();
    const signalAtMs = typeof signal.ts === 'number' ? signal.ts : now;
    const allowedPlatforms = normalizePlatformFilters(strategy?.platforms);
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
        return { t, m };
      })
      .filter((x) => {
        const metrics = x.m;
        const tokenAddress = x.m?.tokenAddress;
        const tokenPlatform = extractTokenPlatform(x.t);
        if (!tokenAddress) return false;
        if (!tokenPlatform || !allowedPlatforms.includes(tokenPlatform)) return false;
        if (!metrics) return false;
        const configPass = shouldBuyByConfig(metrics, strategy, signalAtMs, now, {
          skipTweetAgeWindowCheck: true,
          tokenAgeMode: 'now_age',
        });
        if (!configPass) return false;
        const confirm = computeWsConfirm(tokenAddress, now, strategy);
        if (!confirm.pass) return false;
        return true;
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

  const pickTaskCandidates = (signal: UnifiedMarketSignal, strategy: any, task: NewCoinXmodeSnipeTask) => {
    const now = Date.now();
    const signalAtMs = typeof signal.ts === 'number' ? signal.ts : now;
    const allowedPlatforms = normalizePlatformFilters(strategy?.platforms);
    const maxAgeSec = parseMaxTokenAgeSec(task);
    const strategyForTask = {
      ...strategy,
      maxTokenAgeSeconds: String(maxAgeSec),
      minTokenAgeSeconds: '0',
    };
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
        return { t, m };
      })
      .filter((x) => {
        const tokenAddress = x.m?.tokenAddress;
        if (!tokenAddress || !x.m) return false;
        const tokenPlatform = extractTokenPlatform(x.t);
        if (!tokenPlatform || !allowedPlatforms.includes(tokenPlatform)) return false;
        const matchText = buildTokenMatchText(x.t);
        const match = matchTaskKeywords(task, matchText);
        if (!match.pass) return false;
        const configPass = shouldBuyByConfig(x.m, strategyForTask, signalAtMs, now, {
          skipTweetAgeWindowCheck: true,
          tokenAgeMode: 'now_age',
        });
        if (!configPass) return false;
        const confirm = computeWsConfirm(tokenAddress, now, strategyForTask);
        if (!confirm.pass) return false;
        return true;
      });
    candidates.sort((a, b) => {
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

  const executeXmodeTaskBuys = async (input: {
    signal: UnifiedMarketSignal;
    strategy: any;
    chainId: number;
    settings: any;
  }) => {
    const tasks = normalizeXmodeTasks(input.strategy?.xmodeTasks).filter((x) => x.enabled !== false);
    if (!tasks.length) return;
    const pseudoSignal = buildPseudoSignalFromMarketSignal(input.signal);
    const dryRun = input.strategy?.dryRun === true;
    for (const task of tasks) {
      const candidates = pickTaskCandidates(input.signal, input.strategy, task);
      if (!candidates.length) continue;
      for (const { t, m } of candidates) {
        if (!m?.tokenAddress) continue;
        const tokenAddress = m.tokenAddress;
        const matchText = buildTokenMatchText(t);
        const match = matchTaskKeywords(task, matchText);
        if (!match.pass) continue;
        const tradeChainId = resolveTradeChainId({
          tokenChain: (t as any)?.chain,
          signalChain: input.signal?.chain,
          fallbackChainId: input.chainId,
          settings: input.settings,
        });
        currentSignalContext = input.signal;
        currentStrategyMode = 'xmode_task';
        currentTaskContext = {
          taskId: task.id,
          taskName: task.taskName,
          matchKeywords: match.matched,
          matchText,
        };
        let bought = false;
        try {
          const amountOverride = parseNumber(task.buyAmountNative);
          const gasPriceGweiOverride = String(task.buyGasGwei ?? '').trim() || undefined;
          const priorityFeeBnbOverride = String(task.buyBribeBnb ?? '').trim() || undefined;
          bought = await tryAutoBuyOnce({
            chainId: tradeChainId,
            tokenAddress,
            metrics: m,
            strategy: task.autoSellEnabled === false ? { ...input.strategy, autoSellEnabled: false } : input.strategy,
            signal: pseudoSignal,
            amountNativeOverride: typeof amountOverride === 'number' && Number.isFinite(amountOverride) && amountOverride > 0
              ? amountOverride
              : undefined,
            gasPriceGweiOverride,
            priorityFeeBnbOverride,
          });
        } catch {
        } finally {
          currentSignalContext = null;
          currentTaskContext = null;
          currentStrategyMode = 'auto_filter';
        }
        if (bought && !dryRun) break;
      }
    }
  };

  const tryAutoBuyOnce = async (input: {
    chainId: number;
    tokenAddress: `0x${string}`;
    metrics: TokenMetrics;
    strategy: any;
    signal?: UnifiedTwitterSignal;
    amountNativeOverride?: number;
    gasPriceGweiOverride?: string;
    priorityFeeBnbOverride?: string;
  }) =>
    tryAutoBuyOnceFromMod({
      ...input,
      tokenAgeMode: 'now_age',
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
      let strategy = (config as any).newCoinSnipe;
      if (!strategy) return;
      const autoTaskRes = await ensureAutoTasksFromSignal({
        settings,
        strategy,
        signal,
      });
      if (autoTaskRes.updated) {
        strategy = autoTaskRes.strategy;
      }
      latestNewCoinSnipeStrategy = strategy;
      ensureRapidWatchdog(strategy);
      if (!isSourceEnabled(signal, strategy)) return;
      const autoModeEnabled = strategy.enabled === true;
      const taskModeEnabled = strategy.taskModeEnabled !== false;
      const effectiveTaskModeEnabled = taskModeEnabled;
      const effectiveAutoModeEnabled = autoModeEnabled && !taskModeEnabled;
      if (!effectiveAutoModeEnabled && !effectiveTaskModeEnabled) return;
      if (effectiveTaskModeEnabled) {
        await executeXmodeTaskBuys({
          signal,
          strategy,
          chainId: settings.chainId,
          settings,
        });
      }
      if (!effectiveAutoModeEnabled) return;

      const perSignalMax = Math.max(0, Math.floor(parseNumber(strategy?.buyNewCaCount) ?? 0));
      if (perSignalMax <= 0) return;

      const picked = pickCandidates(signal, strategy);
      let boughtCount = 0;
      const dryRun = strategy?.dryRun === true;
      for (const { t, m } of picked) {
        if (!m?.tokenAddress) continue;
        const tradeChainId = resolveTradeChainId({
          tokenChain: (t as any)?.chain,
          signalChain: signal?.chain,
          fallbackChainId: settings.chainId,
          settings,
        });
        const pseudoSignal = buildPseudoSignalFromMarketSignal(signal);
        currentSignalContext = signal;
        currentStrategyMode = 'auto_filter';
        currentTaskContext = null;
        let bought = false;
        try {
          const gasPriceGweiOverride = String(strategy?.buyGasGwei ?? '').trim() || undefined;
          const priorityFeeBnbOverride = String(strategy?.buyBribeBnb ?? '').trim() || undefined;
          bought = await tryAutoBuyOnce({
            chainId: tradeChainId,
            tokenAddress: m.tokenAddress,
            metrics: m,
            strategy,
            signal: pseudoSignal,
            gasPriceGweiOverride,
            priorityFeeBnbOverride,
          });
        } catch {
        } finally {
          currentSignalContext = null;
          currentTaskContext = null;
          currentStrategyMode = 'auto_filter';
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
