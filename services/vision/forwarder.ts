import { browser } from 'wxt/browser';
import type { UnifiedMarketSignal, UnifiedSignalToken, UnifiedTwitterSignal } from '@/types/extention';
import { SETTINGS_STORAGE_KEY } from '@/services/storage';
import { DEFAULT_VISION_BASE, VISION_STATUS_STORAGE_KEY } from '@/services/vision/constants';

const VISION_BASE_STORAGE_KEY = 'dagobang_vision_base_url';
const MAX_ROWS_PER_SIGNAL = 80;
const VISION_AGG_WINDOW_MS = 1000;
const MAX_ROWS_PER_BATCH_PACKET = 120;
const MAX_AGG_ROWS_PER_KIND = 1500;
const WS_FLUSH_INTERVAL_MS = 200;
const WS_BACKPRESSURE_POLL_MS = 500;
const WS_RECONNECT_BASE_MS = 1200;
const WS_MAX_QUEUE = 120;
const WS_MAX_BUFFERED_AMOUNT = 512 * 1024;
const WS_MAX_IN_FLIGHT_PACKETS = 2;
const WS_ACK_TIMEOUT_MS = 4000;
const STATUS_FLUSH_INTERVAL_MS = 2000;
const WS_FAILURE_STREAK_FOR_COOLDOWN = 12;
const WS_FAILURE_COOLDOWN_MS = 10_000;
const CONTEXT_CACHE_TTL_MS = 60 * 60 * 1000;
const CONTEXT_CACHE_MAX = 5_000;
const BRIDGE_CACHE_TTL_MS = 60 * 60 * 1000;
const BRIDGE_CACHE_MAX = 15_000;
const LOW_FREQUENCY_CACHE_PRUNE_INTERVAL_MS = 60_000;
const MARKET_CONTEXT_RECHECK_INTERVAL_MS = 30_000;
const MARKET_SIGNAL_RATE_LIMIT_TOKEN_UPDATE_MS = 3000;
const MARKET_SIGNAL_RATE_LIMIT_STAGE_MS = 1200;
const MARKET_SIGNAL_RATE_LIMIT_CACHE_MAX = 20_000;

export type VisionForwardStatus = {
  enabled: boolean;
  baseUrl: string;
  lastSendAtMs?: number;
  lastAckAtMs?: number;
  lastSuccessAtMs?: number;
  lastErrorAtMs?: number;
  lastError?: string;
  successCount: number;
  failCount: number;
  lastPath?: string;
  droppedPackets?: number;
  droppedAggregateRows?: number;
  backpressureCount?: number;
  ackTimeoutCount?: number;
  currentQueueSize?: number;
  currentInFlightPackets?: number;
};

type VisionBatchPacket = {
  type: 'batch';
  id: string;
  sentAtMs: number;
  tokenMetrics?: any[];
  signalContexts?: any[];
  bridges?: any[];
};

type VisionAggregateWindow = {
  windowStartMs: number;
  tokenMetrics: Map<string, any>;
  signalContexts: Map<string, any>;
  bridges: Map<string, any>;
};

type VisionInFlightPacket = {
  packet: VisionBatchPacket;
  sentAtMs: number;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
};

type VisionContextCacheEntry = {
  fingerprint: string;
  lastTouchedMs: number;
};

const normalizeAddress = (v: unknown): `0x${string}` | null => {
  const s = String(v ?? '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(s)) return null;
  return s as `0x${string}`;
};

const toNum = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const toInt = (v: unknown): number | undefined => {
  const n = toNum(v);
  if (n == null) return undefined;
  return Math.floor(n);
};

const canonicalChain = (v: unknown): string | undefined => {
  const raw = String(v ?? '').trim().toLowerCase();
  if (!raw || raw === 'unknown' || raw === 'null' || raw === 'undefined' || raw === '-') return undefined;
  if (raw === 'bsc' || raw === 'bnb' || raw === 'binance' || raw === 'binance-smart-chain') return 'bsc';
  if (raw === 'eth' || raw === 'ethereum' || raw === 'erc20') return 'eth';
  if (raw === 'sol' || raw === 'solana') return 'sol';
  if (raw === 'base' || raw === 'base-mainnet') return 'base';
  if (raw === 'arb' || raw === 'arbitrum' || raw === 'arbitrum-one') return 'arb';
  if (raw === 'op' || raw === 'optimism') return 'op';
  if (raw === 'polygon' || raw === 'matic') return 'polygon';
  if (raw === 'avax' || raw === 'avalanche') return 'avax';
  return raw;
};

const inferChainFromSource = (site: unknown, channel: unknown): string | undefined => {
  const text = `${String(site ?? '').toLowerCase()} ${String(channel ?? '').toLowerCase()}`;
  if (!text.trim()) return undefined;
  if (text.includes('sol') || text.includes('solana')) return 'sol';
  if (text.includes('bsc') || text.includes('bnb')) return 'bsc';
  if (text.includes('eth') || text.includes('ethereum')) return 'eth';
  if (text.includes('base')) return 'base';
  if (text.includes('arb') || text.includes('arbitrum')) return 'arb';
  if (text.includes('optimism') || /\bop\b/.test(text)) return 'op';
  if (text.includes('polygon') || text.includes('matic')) return 'polygon';
  if (text.includes('avax') || text.includes('avalanche')) return 'avax';
  return undefined;
};

const resolveChain = (primary: unknown, fallback: unknown, site: unknown, channel: unknown): string | undefined => {
  return canonicalChain(primary) ?? canonicalChain(fallback) ?? inferChainFromSource(site, channel);
};

const normalizeEpochMs = (v: unknown): number => {
  const n = toNum(v);
  if (!(n != null && n > 0)) return Date.now();
  if (n >= 1e14) return Math.floor(n / 1000);
  if (n < 1e11) return Math.floor(n * 1000);
  return Math.floor(n);
};

const safeSliceTokens = (tokens: UnifiedSignalToken[] | undefined) =>
  (Array.isArray(tokens) ? tokens : []).slice(0, MAX_ROWS_PER_SIGNAL);

const stableSignalId = (signal: Partial<UnifiedTwitterSignal> & { site?: string; channel?: string }) => {
  const id = String(signal.id ?? '').trim();
  if (id) return id;
  const ev = String(signal.eventId ?? '').trim();
  if (ev) return `${String(signal.site ?? 'unknown')}:${String(signal.channel ?? 'unknown')}:${ev}`;
  const tw = String(signal.tweetId ?? '').trim();
  if (tw) return `${String(signal.site ?? 'unknown')}:${String(signal.channel ?? 'unknown')}:${tw}`;
  return `${String(signal.site ?? 'unknown')}:${String(signal.channel ?? 'unknown')}:${Date.now()}`;
};

const getStableSignalIdentity = (signal: Partial<UnifiedTwitterSignal> & { site?: string; channel?: string }) => {
  const id = String(signal.id ?? '').trim();
  if (id) return id;
  const ev = String(signal.eventId ?? '').trim();
  if (ev) return `${String(signal.site ?? 'unknown')}:${String(signal.channel ?? 'unknown')}:${ev}`;
  const tw = String(signal.tweetId ?? '').trim();
  if (tw) return `${String(signal.site ?? 'unknown')}:${String(signal.channel ?? 'unknown')}:${tw}`;
  return '';
};

type VisionRuntimeConfig = { enabled: boolean; baseUrl: string };

let cfgCache: VisionRuntimeConfig | null = null;
let cfgLoadPromise: Promise<VisionRuntimeConfig> | null = null;
let cfgWatcherInited = false;
let wsClient: WebSocket | null = null;
let wsUrlCached = '';
let wsConnected = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let wsFailureStreak = 0;
let wsCooldownUntilMs = 0;
let wsConnectPromise: Promise<void> | null = null;
let statusCache: VisionForwardStatus | null = null;
let statusLoadPromise: Promise<VisionForwardStatus> | null = null;
let statusFlushTimer: ReturnType<typeof setTimeout> | null = null;
let aggregateWindow: VisionAggregateWindow | null = null;
let aggregateFlushTimer: ReturnType<typeof setTimeout> | null = null;
const queue: VisionBatchPacket[] = [];
let queueHead = 0;
const inFlightPackets = new Map<string, VisionInFlightPacket>();
const contextSnapshotCache = new Map<string, VisionContextCacheEntry>();
const bridgeSeenCache = new Map<string, number>();
const marketSignalLastStagedAt = new Map<string, number>();
let lowFrequencyCacheLastPrunedAtMs = 0;

const isWsOpen = (ws: WebSocket | null) => ws?.readyState === WebSocket.OPEN;
const isWsConnecting = (ws: WebSocket | null) => ws?.readyState === WebSocket.CONNECTING;
const isWsCoolingDown = () => wsCooldownUntilMs > Date.now();
const getWsCooldownRemainingMs = () => Math.max(0, wsCooldownUntilMs - Date.now());
const getAggregateWindowStartMs = (atMs: number) => Math.floor(atMs / VISION_AGG_WINDOW_MS) * VISION_AGG_WINDOW_MS;
const getQueueSize = () => Math.max(0, queue.length - queueHead);

const compactQueueIfNeeded = () => {
  if (queueHead <= 0) return;
  if (queueHead < 64 && queueHead * 2 < queue.length) return;
  queue.splice(0, queueHead);
  queueHead = 0;
};

const shiftQueuePacket = () => {
  if (queueHead >= queue.length) {
    queue.length = 0;
    queueHead = 0;
    return undefined;
  }
  const packet = queue[queueHead];
  queue[queueHead] = undefined as any;
  queueHead += 1;
  compactQueueIfNeeded();
  return packet;
};

const pushQueuePacket = (packet: VisionBatchPacket) => {
  queue.push(packet);
};

const requeuePacketAtFront = (packet: VisionBatchPacket) => {
  if (queueHead > 0) {
    queueHead -= 1;
    queue[queueHead] = packet;
    return;
  }
  queue.unshift(packet);
};

const clearQueue = () => {
  queue.length = 0;
  queueHead = 0;
};

const parseVisionConfig = (raw: any): VisionRuntimeConfig => {
  const settings = (raw as any)?.[SETTINGS_STORAGE_KEY] ?? {};
  const vr = settings?.visionReport ?? {};
  const enabled = typeof vr.enabled === 'boolean' ? vr.enabled : true;
  const fromSettings = typeof vr.baseUrl === 'string' ? vr.baseUrl.trim() : '';
  const fromLegacy = typeof (raw as any)?.[VISION_BASE_STORAGE_KEY] === 'string'
    ? String((raw as any)[VISION_BASE_STORAGE_KEY]).trim()
    : '';
  const baseUrl = (fromSettings || fromLegacy || DEFAULT_VISION_BASE).replace(/\/+$/, '');
  return { enabled, baseUrl };
};

const loadVisionConfigFromStorage = async (): Promise<VisionRuntimeConfig> => {
  try {
    const res = await browser.storage.local.get([SETTINGS_STORAGE_KEY, VISION_BASE_STORAGE_KEY]);
    return parseVisionConfig(res);
  } catch {
    return { enabled: true, baseUrl: DEFAULT_VISION_BASE };
  }
};

const refreshVisionConfig = async () => {
  const next = await loadVisionConfigFromStorage();
  cfgCache = next;
  return next;
};

const initVisionConfigWatcher = () => {
  if (cfgWatcherInited) return;
  cfgWatcherInited = true;
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (!changes[SETTINGS_STORAGE_KEY] && !changes[VISION_BASE_STORAGE_KEY]) return;
    void (async () => {
      const next = await refreshVisionConfig();
      await updateStatus({
        enabled: next.enabled,
        baseUrl: next.baseUrl,
        lastPath: 'ws:config_changed',
      });
    })();
  });
};

const getVisionConfig = async () => {
  initVisionConfigWatcher();
  if (cfgCache) return cfgCache;
  if (cfgLoadPromise) return cfgLoadPromise;
  cfgLoadPromise = refreshVisionConfig().finally(() => {
    cfgLoadPromise = null;
  });
  return cfgLoadPromise;
};

const getVisionConfigSnapshot = (): VisionRuntimeConfig => {
  initVisionConfigWatcher();
  if (!cfgCache && !cfgLoadPromise) {
    cfgLoadPromise = refreshVisionConfig().finally(() => {
      cfgLoadPromise = null;
    });
  }
  return cfgCache ?? { enabled: true, baseUrl: DEFAULT_VISION_BASE };
};

const loadVisionStatusFromStorage = async (): Promise<VisionForwardStatus> => {
  const cfg = await getVisionConfig();
  try {
    const res = await browser.storage.local.get(VISION_STATUS_STORAGE_KEY);
    const prev = (res as any)?.[VISION_STATUS_STORAGE_KEY] as VisionForwardStatus | undefined;
    return {
      enabled: cfg.enabled,
      baseUrl: cfg.baseUrl,
      successCount: prev?.successCount ?? 0,
      failCount: prev?.failCount ?? 0,
      ...prev,
    };
  } catch {
    return {
      enabled: cfg.enabled,
      baseUrl: cfg.baseUrl,
      successCount: 0,
      failCount: 0,
    };
  }
};

const getVisionStatusCache = async (): Promise<VisionForwardStatus> => {
  if (statusCache) return statusCache;
  if (statusLoadPromise) return statusLoadPromise;
  statusLoadPromise = loadVisionStatusFromStorage()
    .then((next) => {
      statusCache = next;
      return next;
    })
    .finally(() => {
      statusLoadPromise = null;
    });
  return statusLoadPromise;
};

const flushVisionStatus = async () => {
  if (!statusCache) return;
  try {
    await browser.storage.local.set({ [VISION_STATUS_STORAGE_KEY]: statusCache });
  } catch {
  }
};

const scheduleVisionStatusFlush = (immediate = false) => {
  if (immediate) {
    if (statusFlushTimer) {
      clearTimeout(statusFlushTimer);
      statusFlushTimer = null;
    }
    void flushVisionStatus();
    return;
  }
  if (statusFlushTimer) return;
  statusFlushTimer = setTimeout(() => {
    statusFlushTimer = null;
    void flushVisionStatus();
  }, STATUS_FLUSH_INTERVAL_MS);
};

const syncRuntimeStatus = (patch?: Partial<VisionForwardStatus>) => {
  const cfg = getVisionConfigSnapshot();
  const prev = statusCache ?? {
    enabled: cfg.enabled,
    baseUrl: cfg.baseUrl,
    successCount: 0,
    failCount: 0,
  };
  statusCache = {
    ...prev,
    enabled: cfg.enabled,
    baseUrl: cfg.baseUrl,
    currentQueueSize: getQueueSize(),
    currentInFlightPackets: inFlightPackets.size,
    ...patch,
  };
  scheduleVisionStatusFlush();
};

const updateStatus = async (patch: Partial<VisionForwardStatus>, options?: { immediate?: boolean }) => {
  const cfg = await getVisionConfig();
  const prev = await getVisionStatusCache();
  statusCache = {
    ...prev,
    enabled: cfg.enabled,
    baseUrl: cfg.baseUrl,
    currentQueueSize: getQueueSize(),
    currentInFlightPackets: inFlightPackets.size,
    ...patch,
  };
  scheduleVisionStatusFlush(options?.immediate === true);
};

const bumpStatusCounter = (
  kind: 'success' | 'fail',
  base: { enabled: boolean; baseUrl: string; path: string; error?: string },
) => {
  const st = statusCache ?? {
    enabled: base.enabled,
    baseUrl: base.baseUrl,
    successCount: 0,
    failCount: 0,
  };
  const now = Date.now();
  statusCache = {
    ...st,
    enabled: base.enabled,
    baseUrl: base.baseUrl,
    successCount: Math.max(0, Number(st.successCount) || 0),
    failCount: Math.max(0, Number(st.failCount) || 0),
    currentQueueSize: getQueueSize(),
    currentInFlightPackets: inFlightPackets.size,
    lastPath: base.path,
  };
  if (!statusCache) return;
  if (kind === 'success') {
    statusCache.successCount += 1;
    statusCache.lastAckAtMs = now;
    statusCache.lastSuccessAtMs = now;
    statusCache.lastError = undefined;
  } else {
    statusCache.failCount += 1;
    statusCache.lastErrorAtMs = now;
    statusCache.lastError = base.error || 'forward_failed';
  }
  scheduleVisionStatusFlush();
};

const bumpStatusMetric = (
  patch: Partial<Pick<VisionForwardStatus, 'droppedPackets' | 'droppedAggregateRows' | 'backpressureCount' | 'ackTimeoutCount'>> & { path?: string; error?: string },
) => {
  const cfg = getVisionConfigSnapshot();
  const st = statusCache ?? {
    enabled: cfg.enabled,
    baseUrl: cfg.baseUrl,
    successCount: 0,
    failCount: 0,
  };
  statusCache = {
    ...st,
    enabled: cfg.enabled,
    baseUrl: cfg.baseUrl,
    successCount: Math.max(0, Number(st.successCount) || 0),
    failCount: Math.max(0, Number(st.failCount) || 0),
    droppedPackets: Math.max(0, Number(st.droppedPackets) || 0) + Math.max(0, Number(patch.droppedPackets) || 0),
    droppedAggregateRows: Math.max(0, Number(st.droppedAggregateRows) || 0) + Math.max(0, Number(patch.droppedAggregateRows) || 0),
    backpressureCount: Math.max(0, Number(st.backpressureCount) || 0) + Math.max(0, Number(patch.backpressureCount) || 0),
    ackTimeoutCount: Math.max(0, Number(st.ackTimeoutCount) || 0) + Math.max(0, Number(patch.ackTimeoutCount) || 0),
    currentQueueSize: getQueueSize(),
    currentInFlightPackets: inFlightPackets.size,
    ...(patch.path ? { lastPath: patch.path } : {}),
    ...(patch.error ? { lastError: patch.error, lastErrorAtMs: Date.now() } : {}),
  };
  scheduleVisionStatusFlush();
};

const makeWSUrl = (baseUrl: string) => {
  const normalized = baseUrl.replace(/\/+$/, '');
  if (/^https?:\/\//i.test(normalized)) {
    const u = new URL(normalized);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/ingest/ws';
    u.search = '';
    u.hash = '';
    return u.toString();
  }
  return normalized.replace(/^ws:/i, 'ws:').replace(/^wss:/i, 'wss:').replace(/\/+$/, '') + '/ingest/ws';
};

const scheduleFlush = (delayMs = WS_FLUSH_INTERVAL_MS) => {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushQueue();
  }, Math.max(0, delayMs));
};

const createAggregateWindow = (windowStartMs: number): VisionAggregateWindow => ({
  windowStartMs,
  tokenMetrics: new Map(),
  signalContexts: new Map(),
  bridges: new Map(),
});

const shouldUseIncomingValue = (value: unknown) => {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0;
  return true;
};

const mergeVisionRow = <T extends Record<string, any>>(prev: T | undefined, next: T): T => {
  if (!prev) return { ...next };
  const merged: Record<string, any> = { ...prev };
  for (const [key, value] of Object.entries(next)) {
    if (!shouldUseIncomingValue(value)) continue;
    merged[key] = value;
  }
  return merged as T;
};

const normalizeAggregateTokenAddress = (value: unknown) =>
  normalizeAddress(value) ?? String(value ?? '').trim().toLowerCase();

const getMetricRowKey = (row: any) => [
  String(row?.sourceSite ?? 'unknown'),
  String(row?.sourceChannel ?? 'unknown'),
  String(row?.chain ?? ''),
  normalizeAggregateTokenAddress(row?.tokenAddress),
].join('|');

const pruneTimedCache = <T>(map: Map<string, T>, nowMs: number, ttlMs: number, maxEntries: number, getTouchedAtMs: (value: T) => number) => {
  for (const [key, value] of map) {
    if (nowMs - getTouchedAtMs(value) > ttlMs) {
      map.delete(key);
    }
  }
  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;
    if (!oldestKey) break;
    map.delete(oldestKey);
  }
};

const touchLowFrequencyCaches = (nowMs: number) => {
  if (nowMs - lowFrequencyCacheLastPrunedAtMs < LOW_FREQUENCY_CACHE_PRUNE_INTERVAL_MS) return;
  lowFrequencyCacheLastPrunedAtMs = nowMs;
  pruneTimedCache(contextSnapshotCache, nowMs, CONTEXT_CACHE_TTL_MS, CONTEXT_CACHE_MAX, (value) => value.lastTouchedMs);
  pruneTimedCache(bridgeSeenCache, nowMs, BRIDGE_CACHE_TTL_MS, BRIDGE_CACHE_MAX, (value) => value);
  pruneTimedCache(marketSignalLastStagedAt, nowMs, BRIDGE_CACHE_TTL_MS, MARKET_SIGNAL_RATE_LIMIT_CACHE_MAX, (value) => value);
};

const shouldStageMarketSignalToken = (signal: UnifiedMarketSignal, tokenAddress: string, nowMs: number) => {
  const source = typeof signal.source === 'string' ? signal.source : '';
  const minIntervalMs = source === 'token_update'
    ? MARKET_SIGNAL_RATE_LIMIT_TOKEN_UPDATE_MS
    : MARKET_SIGNAL_RATE_LIMIT_STAGE_MS;
  const key = [
    String(signal.site ?? 'unknown'),
    String(signal.channel ?? 'unknown'),
    source,
    String(signal.chain ?? ''),
    tokenAddress,
  ].join('|');
  const prevAt = marketSignalLastStagedAt.get(key) ?? 0;
  if (nowMs - prevAt < minIntervalMs) return false;
  marketSignalLastStagedAt.set(key, nowMs);
  return true;
};

const shouldRecheckMarketContext = (contextKey: string, nowMs: number) => {
  const prev = contextSnapshotCache.get(contextKey);
  if (!prev) return true;
  if (nowMs - prev.lastTouchedMs >= MARKET_CONTEXT_RECHECK_INTERVAL_MS) return true;
  prev.lastTouchedMs = nowMs;
  return false;
};

const fingerprintPart = (value: unknown) => {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
};

const buildContextFingerprint = (row: any) => [
  fingerprintPart(row.chain),
  fingerprintPart(row.tokenAddress),
  fingerprintPart(row.tokenSymbol),
  fingerprintPart(row.tokenName),
  fingerprintPart(row.launchpadPlatform),
  fingerprintPart(row.sourceType),
  fingerprintPart(row.sourceSite),
  fingerprintPart(row.sourceChannel),
  fingerprintPart(row.devAddress),
  fingerprintPart(row.devMaxBuyPercent),
  fingerprintPart(row.devHasSold),
  fingerprintPart(row.devCreatedTokenCount),
].join('\x1f');

const getContextCacheKey = (row: any) => [
  String(row?.sourceType ?? 'unknown'),
  String(row?.sourceSite ?? 'unknown'),
  String(row?.sourceChannel ?? 'unknown'),
  String(row?.chain ?? ''),
  normalizeAggregateTokenAddress(row?.tokenAddress),
].join('|');

const getBridgeCacheKey = (row: any) => [
  String(row?.chain ?? ''),
  normalizeAggregateTokenAddress(row?.tokenAddress),
  String(row?.signalId ?? ''),
].join('|');

const shouldStageContextForToken = (signal: any, token: any) => {
  return typeof token?.tokenSymbol === 'string'
    || typeof token?.tokenName === 'string'
    || typeof token?.launchpadPlatform === 'string'
    || toInt(token?.createdAtMs) != null
    || normalizeAddress(token?.devAddress) != null
    || toNum(token?.devMaxBuyPercent) != null
    || typeof token?.devHasSold === 'boolean'
    || toInt(token?.devCreatedTokenCount) != null
    || typeof signal?.userName === 'string'
    || typeof signal?.userScreen === 'string'
    || typeof signal?.tweetId === 'string'
    || typeof signal?.eventId === 'string';
};

const upsertAggregateRow = (
  map: Map<string, any>,
  key: string,
  row: any,
  droppedCounter: { count: number },
) => {
  if (!key) return;
  if (!map.has(key) && map.size >= MAX_AGG_ROWS_PER_KIND) {
    const oldestKey = map.keys().next().value;
    if (oldestKey) {
      map.delete(oldestKey);
      droppedCounter.count += 1;
    }
  }
  map.set(key, mergeVisionRow(map.get(key), row));
};

const clearAggregateFlushTimer = () => {
  if (!aggregateFlushTimer) return;
  clearTimeout(aggregateFlushTimer);
  aggregateFlushTimer = null;
};

const resetAggregateWindow = () => {
  clearAggregateFlushTimer();
  aggregateWindow = null;
};

const scheduleAggregateFlush = () => {
  if (aggregateFlushTimer || !aggregateWindow) return;
  const delay = Math.max(0, aggregateWindow.windowStartMs + VISION_AGG_WINDOW_MS - Date.now());
  aggregateFlushTimer = setTimeout(() => {
    aggregateFlushTimer = null;
    const activeWindowStartMs = aggregateWindow?.windowStartMs;
    if (activeWindowStartMs == null) return;
    flushAggregateWindow(activeWindowStartMs);
  }, delay);
};

const enqueueAggregatedWindow = (windowState: VisionAggregateWindow) => {
  const takeChunk = (iterator: IterableIterator<any>) => {
    const chunk: any[] = [];
    while (chunk.length < MAX_ROWS_PER_BATCH_PACKET) {
      const next = iterator.next();
      if (next.done) break;
      chunk.push(next.value);
    }
    return chunk;
  };
  const tokenIter = windowState.tokenMetrics.values();
  const contextIter = windowState.signalContexts.values();
  const bridgeIter = windowState.bridges.values();
  for (let i = 0; ; i += 1) {
    const tokenMetrics = takeChunk(tokenIter);
    const signalContexts = takeChunk(contextIter);
    const bridges = takeChunk(bridgeIter);
    if (!tokenMetrics.length && !signalContexts.length && !bridges.length) break;
    enqueuePacket({
      type: 'batch',
      id: `agg:${windowState.windowStartMs}:${i}`,
      sentAtMs: Date.now(),
      tokenMetrics,
      signalContexts,
      bridges,
    });
  }
};

const flushAggregateWindow = (expectedWindowStartMs?: number) => {
  const current = aggregateWindow;
  if (!current) return;
  if (expectedWindowStartMs != null && current.windowStartMs !== expectedWindowStartMs) return;
  clearAggregateFlushTimer();
  aggregateWindow = null;
  enqueueAggregatedWindow(current);
};

const getActiveAggregateWindow = (nowMs: number) => {
  const nextWindowStartMs = getAggregateWindowStartMs(nowMs);
  if (!aggregateWindow) {
    aggregateWindow = createAggregateWindow(nextWindowStartMs);
    scheduleAggregateFlush();
    return aggregateWindow;
  }
  if (aggregateWindow.windowStartMs !== nextWindowStartMs) {
    const prev = aggregateWindow;
    aggregateWindow = createAggregateWindow(nextWindowStartMs);
    clearAggregateFlushTimer();
    scheduleAggregateFlush();
    enqueueAggregatedWindow(prev);
  }
  return aggregateWindow;
};

const stageSignalIntoWindow = (input: {
  signal: UnifiedTwitterSignal | UnifiedMarketSignal;
  sourceType: 'twitter' | 'market_ws';
}) => {
  const nowMs = Date.now();
  const signal = input.signal as any;
  const windowState = getActiveAggregateWindow(nowMs);
  const droppedCounter = { count: 0 };
  const stableSignalRef = getStableSignalIdentity(signal);
  const bridgeSignalId = stableSignalRef || stableSignalId(signal);
  touchLowFrequencyCaches(nowMs);

  for (const t of safeSliceTokens(signal.tokens)) {
    const addr = normalizeAddress((t as any)?.tokenAddress);
    if (!addr) continue;
    if (input.sourceType === 'market_ws' && !shouldStageMarketSignalToken(signal as UnifiedMarketSignal, addr, nowMs)) {
      continue;
    }
    const metricRow = {
      tsMs: normalizeEpochMs((t as any).updatedAtMs ?? signal.receivedAtMs ?? signal.ts ?? nowMs),
      chain: resolveChain((t as any).chain, signal.chain, signal.site, signal.channel),
      tokenAddress: addr,
      tokenSymbol: typeof (t as any).tokenSymbol === 'string' ? String((t as any).tokenSymbol) : undefined,
      launchpadPlatform: typeof (t as any).launchpadPlatform === 'string' ? String((t as any).launchpadPlatform) : undefined,
      marketCapUsd: toNum((t as any).marketCapUsd),
      holders: toInt((t as any).holders),
      kol: toInt((t as any).kol),
      smartMoney: toInt((t as any).smartMoney),
      vol24hUsd: toNum((t as any).vol24hUsd),
      netBuy24hUsd: toNum((t as any).netBuy24hUsd),
      buyTx24h: toInt((t as any).buyTx24h),
      sellTx24h: toInt((t as any).sellTx24h),
      viewerCount: toInt((t as any).viewerCount),
      devHoldPercent: toNum((t as any).devHoldPercent),
      sourceSite: String(signal.site ?? 'unknown'),
      sourceChannel: String(signal.channel ?? 'unknown'),
    };
    upsertAggregateRow(windowState.tokenMetrics, getMetricRowKey(metricRow), metricRow, droppedCounter);

    if (shouldStageContextForToken(signal, t)) {
      const updatedAtMs = normalizeEpochMs((t as any).updatedAtMs ?? signal.receivedAtMs ?? signal.ts ?? nowMs);
      const contextRow = {
        contextId: '',
        updatedAtMs,
        chain: metricRow.chain,
        tokenAddress: addr,
        tokenSymbol: metricRow.tokenSymbol,
        tokenName: typeof (t as any).tokenName === 'string' ? String((t as any).tokenName) : undefined,
        launchpadPlatform: metricRow.launchpadPlatform,
        createdAtMs: toInt((t as any).createdAtMs),
        sourceType: input.sourceType,
        sourceSite: String(signal.site ?? 'unknown'),
        sourceChannel: String(signal.channel ?? 'unknown'),
        signalId: stableSignalRef || undefined,
        eventId: typeof signal.eventId === 'string' ? String(signal.eventId) : undefined,
        tweetId: typeof signal.tweetId === 'string' ? String(signal.tweetId) : undefined,
        tweetType: typeof signal.tweetType === 'string' ? String(signal.tweetType) : undefined,
        userScreen: typeof signal.userScreen === 'string' ? String(signal.userScreen) : undefined,
        userName: typeof signal.userName === 'string' ? String(signal.userName) : undefined,
        userFollowers: toInt(signal.userFollowers),
        signalReceivedAtMs: toInt(signal.receivedAtMs),
        devAddress: normalizeAddress((t as any).devAddress) ?? undefined,
        devMaxBuyPercent: toNum((t as any).devMaxBuyPercent),
        devHasSold: typeof (t as any).devHasSold === 'boolean' ? (t as any).devHasSold : undefined,
        devCreatedTokenCount: toInt((t as any).devCreatedTokenCount),
      };
      const contextKey = getContextCacheKey(contextRow);
    const shouldCheckContext = input.sourceType !== 'market_ws' || shouldRecheckMarketContext(contextKey, nowMs);
    if (shouldCheckContext) {
      const fingerprint = buildContextFingerprint(contextRow);
      const prevContext = contextSnapshotCache.get(contextKey);
      if (!prevContext || prevContext.fingerprint !== fingerprint) {
        contextRow.contextId = `${contextKey}:${updatedAtMs}`;
        upsertAggregateRow(windowState.signalContexts, contextKey, contextRow, droppedCounter);
        contextSnapshotCache.set(contextKey, { fingerprint, lastTouchedMs: updatedAtMs });
      } else {
        prevContext.lastTouchedMs = updatedAtMs;
      }
      }
    }

    if (!stableSignalRef) continue;
    const bridgeRow = {
      linkedAtMs: normalizeEpochMs(signal.receivedAtMs ?? signal.ts ?? nowMs),
      chain: metricRow.chain,
      tokenAddress: addr,
      signalId: bridgeSignalId,
      eventId: typeof signal.eventId === 'string' ? String(signal.eventId) : undefined,
      tweetId: typeof signal.tweetId === 'string' ? String(signal.tweetId) : undefined,
      sourceSite: String(signal.site ?? 'unknown'),
      sourceChannel: String(signal.channel ?? 'unknown'),
    };
    const bridgeKey = getBridgeCacheKey(bridgeRow);
    if (!bridgeSeenCache.has(bridgeKey)) {
      upsertAggregateRow(windowState.bridges, bridgeKey, bridgeRow, droppedCounter);
      bridgeSeenCache.set(bridgeKey, bridgeRow.linkedAtMs);
    } else {
      bridgeSeenCache.set(bridgeKey, bridgeRow.linkedAtMs);
    }
  }

  if (droppedCounter.count > 0) {
    void bumpStatusMetric({
      droppedAggregateRows: droppedCounter.count,
      path: 'ws:aggregate_cap',
      error: `aggregate_rows_dropped_${droppedCounter.count}`,
    });
  }
  scheduleAggregateFlush();
};

const scheduleReconnect = async () => {
  if (reconnectTimer) return;
  if (isWsCoolingDown()) {
    const wait = getWsCooldownRemainingMs();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void ensureWSConnected();
    }, wait);
    return;
  }
  const wait = Math.min(15_000, WS_RECONNECT_BASE_MS * Math.max(1, reconnectAttempt + 1));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void ensureWSConnected();
  }, wait);
};

const clearInFlightPacketTimer = (entry: VisionInFlightPacket | undefined) => {
  if (!entry?.timeoutTimer) return;
  clearTimeout(entry.timeoutTimer);
  entry.timeoutTimer = null;
};

const clearInFlightPackets = () => {
  for (const entry of inFlightPackets.values()) {
    clearInFlightPacketTimer(entry);
  }
  inFlightPackets.clear();
  syncRuntimeStatus();
};

const registerInFlightPacket = (ws: WebSocket, packet: VisionBatchPacket) => {
  const prev = inFlightPackets.get(packet.id);
  if (prev) {
    clearInFlightPacketTimer(prev);
  }
  const entry: VisionInFlightPacket = {
    packet,
    sentAtMs: Date.now(),
    timeoutTimer: null,
  };
  entry.timeoutTimer = setTimeout(() => {
    const active = inFlightPackets.get(packet.id);
    if (!active) return;
    clearInFlightPacketTimer(active);
    inFlightPackets.delete(packet.id);
    wsConnected = false;
    void bumpStatusCounter('fail', {
      enabled: true,
      baseUrl: cfgCache?.baseUrl || DEFAULT_VISION_BASE,
      path: 'ws:ack_timeout',
      error: `ack_timeout_${packet.id}`,
    });
    void bumpStatusMetric({
      ackTimeoutCount: 1,
      path: 'ws:ack_timeout',
      error: `ack_timeout_${packet.id}`,
    });
    void updateStatus({
      enabled: true,
      baseUrl: cfgCache?.baseUrl || DEFAULT_VISION_BASE,
      lastPath: 'ws:ack_timeout',
      lastError: `ack_timeout_${packet.id}`,
    });
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    } catch {
    }
    void scheduleReconnect();
    scheduleFlush();
  }, WS_ACK_TIMEOUT_MS);
  inFlightPackets.set(packet.id, entry);
  syncRuntimeStatus();
};

const readWSMessageText = async (data: unknown): Promise<string> => {
  if (typeof data === 'string') return data;
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return data.text();
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  return String(data ?? '');
};

const handleWSMessage = async (data: unknown, ws: WebSocket) => {
  try {
    const text = await readWSMessageText(data);
    const payload = JSON.parse(text || '{}');
    if (payload?.type === 'hello') {
      await updateStatus({ lastPath: 'ws:hello' });
      scheduleFlush();
      return;
    }
    if (payload?.type !== 'ack') return;
    const ackId = typeof payload?.id === 'string' ? String(payload.id) : '';
    if (ackId) {
      const entry = inFlightPackets.get(ackId);
      if (entry) {
        clearInFlightPacketTimer(entry);
        inFlightPackets.delete(ackId);
          syncRuntimeStatus();
      }
    }
    if (payload?.ok === true) {
      bumpStatusCounter('success', {
        enabled: true,
        baseUrl: cfgCache?.baseUrl || DEFAULT_VISION_BASE,
        path: 'ws:ack',
      });
    } else {
      bumpStatusCounter('fail', {
        enabled: true,
        baseUrl: cfgCache?.baseUrl || DEFAULT_VISION_BASE,
        path: 'ws:ack',
        error: String(payload?.error || 'ack_error'),
      });
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      } catch {
      }
      await scheduleReconnect();
    }
    scheduleFlush();
  } catch {
  }
};

const attachWSListeners = (ws: WebSocket) => {
  ws.onopen = () => {
    wsConnected = true;
    reconnectAttempt = 0;
    wsFailureStreak = 0;
    wsCooldownUntilMs = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    void updateStatus({ lastPath: 'ws:open' });
    scheduleFlush();
  };

  ws.onclose = () => {
    wsConnected = false;
    clearInFlightPackets();
    reconnectAttempt += 1;
    wsFailureStreak += 1;
    if (wsFailureStreak >= WS_FAILURE_STREAK_FOR_COOLDOWN) {
      wsCooldownUntilMs = Date.now() + WS_FAILURE_COOLDOWN_MS;
      wsFailureStreak = 0;
    }
    void updateStatus({ lastErrorAtMs: Date.now(), lastError: 'ws_closed', lastPath: 'ws:close' });
    void scheduleReconnect();
  };

  ws.onerror = () => {
    wsConnected = false;
    clearInFlightPackets();
    reconnectAttempt += 1;
    wsFailureStreak += 1;
    if (wsFailureStreak >= WS_FAILURE_STREAK_FOR_COOLDOWN) {
      wsCooldownUntilMs = Date.now() + WS_FAILURE_COOLDOWN_MS;
      wsFailureStreak = 0;
    }
    bumpStatusCounter('fail', {
      enabled: true,
      baseUrl: cfgCache?.baseUrl || DEFAULT_VISION_BASE,
      path: 'ws:error',
      error: 'ws_error',
    });
    void scheduleReconnect();
  };

  ws.onmessage = (ev) => {
    void handleWSMessage(ev.data, ws);
  };
};

const doEnsureWSConnected = async () => {
  const cfg = await getVisionConfig();
  if (!cfg.enabled) {
    wsConnected = false;
    wsFailureStreak = 0;
    wsCooldownUntilMs = 0;
    clearInFlightPackets();
    resetAggregateWindow();
    clearQueue();
    try {
      wsClient?.close();
    } catch {
    }
    wsClient = null;
    wsUrlCached = '';
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    await updateStatus({ enabled: false, baseUrl: cfg.baseUrl, lastPath: 'ws:disabled' });
    return;
  }
  if (isWsCoolingDown()) {
    await updateStatus({
      enabled: true,
      baseUrl: cfg.baseUrl,
      lastPath: 'ws:cooldown',
      lastError: `ws_cooldown_${getWsCooldownRemainingMs()}ms`,
    });
    await scheduleReconnect();
    return;
  }
  const wsURL = makeWSUrl(cfg.baseUrl);
  if (reconnectTimer && wsUrlCached === wsURL && !isWsOpen(wsClient) && !isWsConnecting(wsClient)) {
    return;
  }
  if (wsClient && wsUrlCached === wsURL) {
    if (isWsOpen(wsClient)) {
      wsConnected = true;
      return;
    }
    if (isWsConnecting(wsClient)) {
      return;
    }
  }
  if (wsClient && wsUrlCached && wsUrlCached !== wsURL) {
    clearInFlightPackets();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    try {
      wsClient.close();
    } catch {
    }
    wsClient = null;
    wsConnected = false;
  } else if (wsClient) {
    if (wsClient.readyState === WebSocket.CLOSING) return;
    if (wsClient.readyState === WebSocket.CLOSED) {
      wsClient = null;
      wsConnected = false;
    } else if (wsClient.readyState === WebSocket.OPEN) {
      wsConnected = true;
      return;
    }
  }
  wsUrlCached = wsURL;
  try {
    const ws = new WebSocket(wsURL);
    wsClient = ws;
    attachWSListeners(ws);
    await updateStatus({ enabled: true, baseUrl: cfg.baseUrl, lastPath: 'ws:connecting' });
  } catch (e: any) {
    reconnectAttempt += 1;
    wsFailureStreak += 1;
    if (wsFailureStreak >= WS_FAILURE_STREAK_FOR_COOLDOWN) {
      wsCooldownUntilMs = Date.now() + WS_FAILURE_COOLDOWN_MS;
      wsFailureStreak = 0;
    }
    bumpStatusCounter('fail', {
      enabled: true,
      baseUrl: cfg.baseUrl,
      path: 'ws:connect',
      error: e?.message ? String(e.message) : 'ws_connect_failed',
    });
    await scheduleReconnect();
  }
};

const ensureWSConnected = async () => {
  if (wsConnectPromise) return wsConnectPromise;
  wsConnectPromise = doEnsureWSConnected().finally(() => {
    wsConnectPromise = null;
  });
  return wsConnectPromise;
};

const flushQueue = async () => {
  await ensureWSConnected();
  if (!wsClient || !wsConnected) {
    scheduleFlush();
    return;
  }
  const ws = wsClient;
  while (getQueueSize() > 0 && ws.readyState === WebSocket.OPEN && inFlightPackets.size < WS_MAX_IN_FLIGHT_PACKETS) {
    if (ws.bufferedAmount > WS_MAX_BUFFERED_AMOUNT) {
      bumpStatusMetric({
        backpressureCount: 1,
        path: 'ws:backpressure',
        error: `ws_buffered_${ws.bufferedAmount}`,
      });
      await updateStatus({
        enabled: true,
        baseUrl: cfgCache?.baseUrl || DEFAULT_VISION_BASE,
        lastPath: 'ws:backpressure',
        lastError: `ws_buffered_${ws.bufferedAmount}`,
      });
      scheduleFlush(WS_BACKPRESSURE_POLL_MS);
      break;
    }
    const pkt = shiftQueuePacket();
    if (!pkt) break;
    try {
      ws.send(JSON.stringify(pkt));
      registerInFlightPacket(ws, pkt);
      syncRuntimeStatus({ enabled: true, baseUrl: cfgCache?.baseUrl || DEFAULT_VISION_BASE, lastSendAtMs: Date.now(), lastPath: 'ws:batch' });
    } catch (e: any) {
      requeuePacketAtFront(pkt);
      wsConnected = false;
      wsFailureStreak += 1;
      if (wsFailureStreak >= WS_FAILURE_STREAK_FOR_COOLDOWN) {
        wsCooldownUntilMs = Date.now() + WS_FAILURE_COOLDOWN_MS;
        wsFailureStreak = 0;
      }
      bumpStatusCounter('fail', {
        enabled: true,
        baseUrl: cfgCache?.baseUrl || DEFAULT_VISION_BASE,
        path: 'ws:send',
        error: e?.message ? String(e.message) : 'ws_send_failed',
      });
      try {
        ws.close();
      } catch {
      }
      await scheduleReconnect();
      break;
    }
  }
  if (getQueueSize() > 0 && inFlightPackets.size < WS_MAX_IN_FLIGHT_PACKETS) scheduleFlush();
};

const enqueuePacket = (packet: VisionBatchPacket) => {
  pushQueuePacket(packet);
  let droppedPackets = 0;
  while (getQueueSize() > WS_MAX_QUEUE) {
    shiftQueuePacket();
    droppedPackets += 1;
  }
  if (droppedPackets > 0) {
    void bumpStatusMetric({
      droppedPackets,
      path: 'ws:queue_trim',
      error: `queue_packets_dropped_${droppedPackets}`,
    });
  }
  syncRuntimeStatus();
  scheduleFlush();
};

export const forwardTwitterSignalToVision = async (signal: UnifiedTwitterSignal) => {
  const cfg = getVisionConfigSnapshot();
  if (!cfg.enabled) {
    resetAggregateWindow();
    void updateStatus({ enabled: false, baseUrl: cfg.baseUrl, lastPath: 'ws:disabled' });
    return;
  }
  stageSignalIntoWindow({ signal, sourceType: 'twitter' });
};

export const forwardMarketSignalToVision = async (signal: UnifiedMarketSignal) => {
  const cfg = getVisionConfigSnapshot();
  if (!cfg.enabled) {
    resetAggregateWindow();
    void updateStatus({ enabled: false, baseUrl: cfg.baseUrl, lastPath: 'ws:disabled' });
    return;
  }
  stageSignalIntoWindow({ signal, sourceType: 'market_ws' });
};
