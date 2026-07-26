import { browser } from 'wxt/browser';
import { SettingsService } from '@/services/settings';
import { defaultSettings } from '@/utils/defaults';
import type { UnifiedMarketSignal, UnifiedSignalToken, UnifiedTwitterSignal, XSniperBuyRecord } from '@/types/extention';
import { loadXSniperHistory, pushXSniperHistory } from '@/services/xSniper/xSniperHistory';
import { buildScopedTokenKey, type TokenMetrics, normalizeAddress, normalizeAddressKey, normalizeWalletAddressKey, parseNumber } from '@/services/xSniper/engine/metrics';
import { computeWsConfirm as computeWsConfirmFromWs, pushWsSnapshot as pushWsSnapshotFromWs, shouldLogWsConfirmFail as shouldLogWsConfirmFailFromWs, type WsSnapshot } from '@/services/xSniper/engine/wsSnapshots';
import { maybeEvaluateRapidExitAutoSell as maybeEvaluateRapidExitAutoSellFromMod, registerRapidExitPosition as registerRapidExitPositionFromMod, type RapidExitPosition } from '@/services/xSniper/engine/rapidExitAutoSell';
import { matchesTwitterFilters, metricsFromUnifiedToken, pickTokensToBuyFromSignal } from '@/services/xSniper/engine/signalSelection';
import { createSellExecutors } from '@/services/xSniper/engine/sellExecutors';
import { tryAutoBuyOnce as tryAutoBuyOnceFromMod } from '@/services/xSniper/engine/buyExecutor';
import { createTokenInfoResolvers } from '@/services/xSniper/engine/tokenInfoResolver';
import { maybeUpdateXSniperHistoryEvaluations } from '@/services/xSniper/xSniperHistory';
import { TokenService } from '@/services/token';
import { WalletService } from '@/services/wallet';
import { extractLaunchpadPlatform } from '@/constants/launchpad';
import { getChainIdByName } from '@/constants/chains';
import { type UpsertDecisionSnapshotInput, upsertXSniperDecisionSnapshotBatch } from '@/services/xSniper/xSniperDecisionSnapshot';

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
    const addr = normalizeAddressKey(input.tokenAddress);
    if (!addr) return null;
    const tokens = Array.isArray(input.signal?.tokens) ? input.signal.tokens : [];
    const matched = tokens.find((x: any) => normalizeAddressKey(x?.tokenAddress) === addr);
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
    const addr = normalizeAddressKey(input.tokenAddress);
    if (!addr) return input.fallbackChainId;
    const tokens = Array.isArray(input.signal?.tokens) ? input.signal.tokens : [];
    const matched = tokens.find((x: any) => normalizeAddressKey(x?.tokenAddress) === addr);
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
  const parseWalletAddress = (input: unknown): string | undefined => normalizeAddress(typeof input === 'string' ? input : String(input ?? '')) ?? undefined;
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
  const SESSION_REEVALUATE_DEBOUNCE_MS = 120;
  const SESSION_IDLE_TTL_MS = 15 * 60 * 1000;

  type XSniperSignalSession = {
    id: string;
    signalStableId: string;
    signal: UnifiedTwitterSignal;
    watchedTokenKeys: Set<string>;
    lastTouchedAtMs: number;
    lastEvaluatedAtMs: number;
    evaluating: boolean;
    queued: boolean;
    pendingTimer: ReturnType<typeof setTimeout> | null;
  };

  let boughtOnceLastSyncMs = 0;
  const boughtOnceAtMs = new Map<string, number>();
  const buyInFlight = new Set<string>();
  const wsConfirmFailDedupe = new Map<string, number>();
  const buyFailureRecordDedupe = new Map<string, number>();
  const wsSnapshotsByAddr = new Map<string, WsSnapshot[]>();
  const rapidExitByPosKey = new Map<string, RapidExitPosition>();
  const manuallyClosedPosKeys = new Map<string, number>();
  const rapidWatchdogRpcAtMs = new Map<string, number>();
  const sessionsById = new Map<string, XSniperSignalSession>();
  const sessionIdsByScopedTokenKey = new Map<string, Set<string>>();
  let currentSignalContext: UnifiedTwitterSignal | null = null;
  let latestTwitterSnipeStrategy: any = null;
  let rapidWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  let rapidWatchdogIntervalMs = -1;

  const cleanupPosKey = (posKey: string) => {
    rapidExitByPosKey.delete(posKey);
  };
  const toScopedTokenKey = (chainId: number, tokenAddress: string) => buildScopedTokenKey(chainId, tokenAddress);

  const shouldLogWsConfirmFail = (key: string, nowMs: number) => shouldLogWsConfirmFailFromWs(wsConfirmFailDedupe, key, nowMs);
  const shouldEmitBuyFailureRecord = (input: {
    reason: string;
    chainId: number;
    tokenAddress: string;
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
    const key = `${input.reason}:${input.chainId}:${normalizeAddressKey(input.tokenAddress)}:${signalStableId || 'no-signal'}`;
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

  const getSessionTokenScopedKeys = (signal: UnifiedTwitterSignal) => {
    const keys = new Set<string>();
    const tokens = Array.isArray(signal.tokens) ? signal.tokens : [];
    for (const token of tokens) {
      const addr = normalizeAddress(typeof token?.tokenAddress === 'string' ? token.tokenAddress : '');
      if (!addr) continue;
      const chainId = getChainIdByName(String((token as any)?.chain || '').trim());
      if (!Number.isFinite(chainId) || chainId <= 0) continue;
      keys.add(toScopedTokenKey(chainId, addr));
    }
    return keys;
  };

  const mergeSignalTokens = (baseTokens: UnifiedSignalToken[] | undefined, incomingTokens: UnifiedSignalToken[] | undefined) => {
    const byAddr = new Map<string, UnifiedSignalToken>();
    for (const token of Array.isArray(baseTokens) ? baseTokens : []) {
      const key = normalizeAddressKey(token?.tokenAddress);
      if (!key) continue;
      byAddr.set(key, token);
    }
    for (const token of Array.isArray(incomingTokens) ? incomingTokens : []) {
      const key = normalizeAddressKey(token?.tokenAddress);
      if (!key) continue;
      const prev = byAddr.get(key);
      byAddr.set(key, prev ? ({ ...prev, ...token } as UnifiedSignalToken) : token);
    }
    return Array.from(byAddr.values());
  };

  const mergeSignals = (prev: UnifiedTwitterSignal, next: UnifiedTwitterSignal): UnifiedTwitterSignal => {
    const merged: Record<string, any> = { ...prev };
    for (const [key, value] of Object.entries(next as Record<string, any>)) {
      if (value === undefined) continue;
      merged[key] = value;
    }
    merged.receivedAtMs = (() => {
      const a = typeof prev.receivedAtMs === 'number' ? prev.receivedAtMs : Number.POSITIVE_INFINITY;
      const b = typeof next.receivedAtMs === 'number' ? next.receivedAtMs : Number.POSITIVE_INFINITY;
      return Math.min(a, b);
    })();
    merged.ts = Math.max(
      typeof prev.ts === 'number' ? prev.ts : 0,
      typeof next.ts === 'number' ? next.ts : 0,
    );
    merged.tokens = mergeSignalTokens(prev.tokens, next.tokens);
    return merged as UnifiedTwitterSignal;
  };

  const unregisterSessionWatchers = (session: XSniperSignalSession) => {
    for (const scopedKey of session.watchedTokenKeys) {
      const set = sessionIdsByScopedTokenKey.get(scopedKey);
      if (!set) continue;
      set.delete(session.id);
      if (!set.size) sessionIdsByScopedTokenKey.delete(scopedKey);
    }
    session.watchedTokenKeys.clear();
  };

  const registerSessionWatchers = (session: XSniperSignalSession) => {
    unregisterSessionWatchers(session);
    const scopedKeys = getSessionTokenScopedKeys(session.signal);
    session.watchedTokenKeys = scopedKeys;
    for (const scopedKey of scopedKeys) {
      const set = sessionIdsByScopedTokenKey.get(scopedKey) ?? new Set<string>();
      set.add(session.id);
      sessionIdsByScopedTokenKey.set(scopedKey, set);
    }
  };

  const closeSession = (sessionId: string) => {
    const session = sessionsById.get(sessionId);
    if (!session) return;
    if (session.pendingTimer) clearTimeout(session.pendingTimer);
    unregisterSessionWatchers(session);
    sessionsById.delete(sessionId);
  };

  const pruneIdleSessions = (nowMs: number) => {
    for (const [sessionId, session] of sessionsById.entries()) {
      if (nowMs - session.lastTouchedAtMs <= SESSION_IDLE_TTL_MS) continue;
      closeSession(sessionId);
    }
  };

  const upsertSignalSession = (signal: UnifiedTwitterSignal) => {
    const signalStableId = resolveSignalStableId(signal);
    if (!signalStableId) return null;
    const nowMs = Date.now();
    pruneIdleSessions(nowMs);
    const existing = sessionsById.get(signalStableId);
    if (existing) {
      existing.signal = mergeSignals(existing.signal, signal);
      existing.lastTouchedAtMs = nowMs;
      registerSessionWatchers(existing);
      return existing;
    }
    const session: XSniperSignalSession = {
      id: signalStableId,
      signalStableId,
      signal,
      watchedTokenKeys: new Set<string>(),
      lastTouchedAtMs: nowMs,
      lastEvaluatedAtMs: 0,
      evaluating: false,
      queued: false,
      pendingTimer: null,
    };
    sessionsById.set(signalStableId, session);
    registerSessionWatchers(session);
    return session;
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
      const addr = normalizeAddressKey(record?.tokenAddress);
      if (!signal || !addr) return undefined;
      const tokens = Array.isArray(signal.tokens) ? signal.tokens : [];
      const matched = tokens.find((x: any) => normalizeAddressKey(x?.tokenAddress) === addr);
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

  const computeWsConfirm = (chainId: number, tokenAddress: string, nowMs: number, strategy: any) =>
    computeWsConfirmFromWs(wsSnapshotsByAddr, chainId, tokenAddress, nowMs, strategy);

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
    const scopedTokens = new Map<string, { chainId: number; tokenAddress: string }>();
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
              (p) => Number(p.chainId) === Number(chainId) && normalizeAddressKey(p.tokenAddress) === normalizeAddressKey(tokenAddress)
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

  async function onWsSnapshotUpdated(chainId: number, tokenAddress: string, nowMs: number) {
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
    tokenAddress: string;
    sellPercent?: number;
    txHash?: string;
  }) => {
    const tokenKey = toScopedTokenKey(input.chainId, input.tokenAddress);
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
    const snapshots = wsSnapshotsByAddr.get(tokenKey) ?? [];
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
    tokenAddress: string;
    txHash?: string;
  }) =>
    markPositionSoldManually({
      ...input,
      sellPercent: 100,
    });

  const clearRuntimeState = () => {
    rapidExitByPosKey.clear();
    manuallyClosedPosKeys.clear();
    rapidWatchdogRpcAtMs.clear();
    wsSnapshotsByAddr.clear();
    buyFailureRecordDedupe.clear();
    wsConfirmFailDedupe.clear();
    buyInFlight.clear();
    for (const sessionId of Array.from(sessionsById.keys())) closeSession(sessionId);
  };

  const pushWsSnapshot = (chainId: number, tokenAddress: string, metrics: TokenMetrics) => {
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

  const getKey = (chainId: number, tokenAddress: string, opts?: { dry?: boolean; walletAddress?: string }) => {
    const dry = opts?.dry === true;
    return `${dry ? 'dry:' : ''}${toScopedTokenKey(chainId, tokenAddress)}:${normalizeWalletAddressKey(opts?.walletAddress)}:full`;
  };

  const buildTweetScopeKey = (input: { chainId: number; walletAddressKey: string; tweetId: string; dryRun: boolean }) => {
    const tweetId = String(input.tweetId || '').trim();
    const walletAddressKey = String(input.walletAddressKey || '').trim() || 'all-wallets';
    return `${input.dryRun ? 'dry:' : ''}${input.chainId}:${walletAddressKey}:${tweetId}`;
  };

  const { fetchTokenInfoFresh, buildGenericTokenInfo, getEntryPriceUsd } = createTokenInfoResolvers();

  const tryAutoBuyOnce = async (input: {
    chainId: number;
    tokenAddress: string;
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
    tokenAddress: string;
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
    walletAddress?: string;
  }) =>
    (() => {
      manuallyClosedPosKeys.delete(input.posKey);
      registerRapidExitPositionFromMod({
        rapidExitByPosKey,
        ...input,
      });
    })();

  const queueSessionEvaluation = (sessionId: string, delayMs = SESSION_REEVALUATE_DEBOUNCE_MS) => {
    const session = sessionsById.get(sessionId);
    if (!session) return;
    session.lastTouchedAtMs = Date.now();
    if (session.pendingTimer != null) return;
    session.pendingTimer = setTimeout(() => {
      const next = sessionsById.get(sessionId);
      if (next) next.pendingTimer = null;
      void evaluateSignalSession(sessionId);
    }, Math.max(0, delayMs));
  };

  const handleDeletePostSignal = async (signal: UnifiedTwitterSignal, strategy: any, settings: any) => {
    closeSession(resolveSignalStableId(signal));
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
      const walletKey = normalizeWalletAddressKey((r as any).walletAddress);
      const dedupe = `${toScopedTokenKey(tradeChainId, addr)}:${walletKey}`;
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
      const walletKey = normalizeWalletAddressKey((p as any).walletAddress);
      const dedupe = `${toScopedTokenKey(p.chainId, addr)}:${walletKey}`;
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
  };

  const evaluateSignalSession = async (sessionId: string) => {
    const session = sessionsById.get(sessionId);
    if (!session) return;
    if (session.evaluating) {
      session.queued = true;
      return;
    }
    session.evaluating = true;
    try {
      const signal = session.signal;
      const settings = await SettingsService.get();
      const config = normalizeAutoTrade((settings as any).autoTrade);
      if (!config || config.wsMonitorEnabled === false) {
        closeSession(sessionId);
        return;
      }
      const strategy = config.twitterSnipe;
      if (!strategy || strategy.enabled === false) {
        closeSession(sessionId);
        return;
      }
      latestTwitterSnipeStrategy = strategy;
      ensureRapidWatchdog(strategy);

      if (!matchesTwitterFilters(signal, strategy)) {
        closeSession(sessionId);
        return;
      }

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
      const signalStableId = session.signalStableId;
      const strategyWalletAddress = parseWalletAddress(strategy?.walletAddress);
      const walletStatus = !dryRun ? await WalletService.getStatus().catch(() => null) : null;
      const activeWalletAddress = !dryRun ? parseWalletAddress(walletStatus?.address) : undefined;
      const walletAddressResolved = strategyWalletAddress || activeWalletAddress;
      const walletAddressKey = normalizeWalletAddressKey(walletAddressResolved);
      const walletSource = strategyWalletAddress ? 'strategy' : activeWalletAddress ? 'active' : 'fallback';
      const decisionUpdates: UpsertDecisionSnapshotInput[] = [];
      const decisionMapByAddr = new Map<string, (typeof decisions)[number]>();
      for (const d of decisions) {
        const tokenAddress = d.m?.tokenAddress ?? normalizeAddress((d.t as any)?.tokenAddress);
        if (!tokenAddress) continue;
        decisionMapByAddr.set(normalizeAddressKey(tokenAddress), d);
        const tradeChainId = resolveTradeChainId((d.t as any)?.chain, settings.chainId, settings);
        const finalFailReason = !d.fullPass
          ? (d.fullFailReason || 'buy_filter_rejected')
          : (!d.wsConfirmPass ? (d.wsConfirmReason || 'ws_confirm_failed') : undefined);
        decisionUpdates.push({
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

      const tweetId = typeof signal.tweetId === 'string' ? signal.tweetId.trim() : '';
      const boughtTokenKeysByTweetScope = new Map<string, Set<string>>();
      if (perTweetMax > 0 && tweetId) {
        const history = await loadXSniperHistory().catch(() => []);
        for (const r of history as any[]) {
          if (!r) continue;
          if (r.side && r.side !== 'buy') continue;
          if ((r as any).dryRun === true !== dryRun) continue;
          const tw = typeof (r as any).signalTweetId === 'string' ? (r as any).signalTweetId.trim() : '';
          if (!tw || tw !== tweetId) continue;
          const addr = normalizeAddress((r as any).tokenAddress);
          if (!addr) continue;
          const tradeChainId = resolveRecordedTradeChainId({
            recordedChainId: (r as any).chainId,
            tokenAddress: addr,
            signal,
            fallbackChainId: settings.chainId,
            settings,
          });
          const scopeKey = buildTweetScopeKey({
            chainId: tradeChainId,
            walletAddressKey: normalizeWalletAddressKey((r as any).walletAddress) || walletAddressKey,
            tweetId,
            dryRun,
          });
          const tokenKey = normalizeAddressKey(addr);
          if (!tokenKey) continue;
          const set = boughtTokenKeysByTweetScope.get(scopeKey) ?? new Set<string>();
          set.add(tokenKey);
          boughtTokenKeysByTweetScope.set(scopeKey, set);
        }
      }

      for (let i = 0; i < picked.length; i += 1) {
        const { t, m } = picked[i];
        if (!m?.tokenAddress) continue;
        const tokenAddress = m.tokenAddress;
        const decision = decisionMapByAddr.get(normalizeAddressKey(tokenAddress)) ?? null;
        const tradeChainId = resolveTradeChainId((t as any)?.chain, settings.chainId, settings);
        const tweetScopeKey = perTweetMax > 0 && tweetId
          ? buildTweetScopeKey({ chainId: tradeChainId, walletAddressKey, tweetId, dryRun })
          : '';
        const boughtTokenKeysInTweet = tweetScopeKey ? (boughtTokenKeysByTweetScope.get(tweetScopeKey) ?? new Set<string>()) : null;
        if (boughtTokenKeysInTweet && boughtTokenKeysInTweet.has(normalizeAddressKey(tokenAddress))) {
          decisionUpdates.push({
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
            finalFailReason: 'buy_skipped_already_bought_in_tweet',
            buyAttemptResult: 'not_attempted',
            notAttemptedReason: 'buy_skipped_already_bought_in_tweet',
            windowClosedAtMs: Date.now(),
          });
          continue;
        }
        const boughtCount = boughtTokenKeysInTweet ? boughtTokenKeysInTweet.size : 0;
        if (boughtCount >= perTweetMax) {
          decisionUpdates.push({
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
            finalFailReason: 'buy_skipped_per_tweet_quota_reached',
            buyAttemptResult: 'not_attempted',
            notAttemptedReason: 'buy_skipped_per_tweet_quota_reached',
            windowClosedAtMs: Date.now(),
          });
          continue;
        }
        let bought = false;
        let outcome: { bought: boolean; attempted: boolean; reason?: string; detail?: any } = { bought: false, attempted: true };
        try {
          currentSignalContext = signal;
          bought = (await tryAutoBuyOnce({
            chainId: tradeChainId,
            tokenAddress: m.tokenAddress,
            metrics: m,
            strategy,
            signal,
            onAttemptOutcome: (o) => {
              outcome = o;
            },
          })) === true;
        } catch (e) {
          console.error('XSniperTrade buy attempt failed', {
            tokenAddress: m.tokenAddress,
            signalId: signal.id,
            tweetId: signal.tweetId,
          }, e);
          outcome = { bought: false, attempted: true, reason: 'buy_attempt_exception' };
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
          decisionUpdates.push({
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
        if (boughtTokenKeysInTweet && tweetScopeKey && bought) {
          const tokenKey = normalizeAddressKey(tokenAddress);
          if (tokenKey) {
            boughtTokenKeysInTweet.add(tokenKey);
            boughtTokenKeysByTweetScope.set(tweetScopeKey, boughtTokenKeysInTweet);
          }
        }
      }

      if (decisionUpdates.length) {
        await upsertXSniperDecisionSnapshotBatch(decisionUpdates);
      }
      session.lastEvaluatedAtMs = Date.now();
      session.lastTouchedAtMs = Date.now();
      const tweetWindowOpen = decisions.some((d) => d.tweetWindowPass === true);
      if (!tweetWindowOpen) {
        closeSession(sessionId);
        return;
      }
      if (perTweetMax > 0 && tweetId) {
        const quotaReached = Array.from(boughtTokenKeysByTweetScope.values()).some((set) => set.size >= perTweetMax);
        if (quotaReached) closeSession(sessionId);
      }
    } catch (e) {
      console.error('XSniperTrade session evaluation error', { sessionId }, e);
    } finally {
      const next = sessionsById.get(sessionId);
      if (!next) return;
      next.evaluating = false;
      if (next.queued) {
        next.queued = false;
        queueSessionEvaluation(sessionId, 0);
      }
    }
  };

  const handleMarketSignal = async (signal: UnifiedMarketSignal) => {
    try {
      if (!sessionsById.size && !rapidExitByPosKey.size) return;
      const affectedSessionIds = new Set<string>();
      for (const token of Array.isArray(signal.tokens) ? signal.tokens : []) {
        const tokenAddress = normalizeAddress(typeof token?.tokenAddress === 'string' ? token.tokenAddress : '');
        if (!tokenAddress) continue;
        const chainId = getChainIdByName(String((token as any)?.chain || signal.chain || '').trim());
        if (Number.isFinite(chainId) && chainId > 0) {
          const metrics = metricsFromUnifiedToken(token as any);
          if (!metrics) continue;
          pushWsSnapshot(chainId, tokenAddress, metrics);
          const scopedKey = toScopedTokenKey(chainId, tokenAddress);
          const matchedSessionIds = sessionIdsByScopedTokenKey.get(scopedKey);
          for (const sessionId of matchedSessionIds ?? []) {
            const session = sessionsById.get(sessionId);
            if (!session) continue;
            session.signal = {
              ...session.signal,
              tokens: mergeSignalTokens(session.signal.tokens, [token as UnifiedSignalToken]),
            };
            session.lastTouchedAtMs = Date.now();
            affectedSessionIds.add(sessionId);
          }
        }
      }
      for (const sessionId of affectedSessionIds) {
        queueSessionEvaluation(sessionId);
      }
    } catch (e) {
      console.error('XSniperTrade market signal handler error', e);
    }
  };

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
        await handleDeletePostSignal(signal, strategy, settings);
        return;
      }
      const session = upsertSignalSession(signal);
      if (!session) return;
      queueSessionEvaluation(session.id, 0);
    } catch (e) {
      console.error('XSniperTrade twitter signal handler error', e);
    }
  };

  return { handleTwitterSignal, handleMarketSignal, markPositionSoldManually, markPositionClosedManually, clearRuntimeState };
};
