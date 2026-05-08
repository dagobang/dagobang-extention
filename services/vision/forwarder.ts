import { browser } from 'wxt/browser';
import type { UnifiedMarketSignal, UnifiedSignalToken, UnifiedTwitterSignal } from '@/types/extention';
import { SETTINGS_STORAGE_KEY } from '@/services/storage';
import { DEFAULT_VISION_BASE, VISION_STATUS_STORAGE_KEY } from '@/services/vision/constants';

const VISION_BASE_STORAGE_KEY = 'dagobang_vision_base_url';
const MAX_ROWS_PER_SIGNAL = 80;
const WS_FLUSH_INTERVAL_MS = 200;
const WS_RECONNECT_BASE_MS = 1200;
const WS_MAX_QUEUE = 1000;

export type VisionForwardStatus = {
  enabled: boolean;
  baseUrl: string;
  lastSendAtMs?: number;
  lastSuccessAtMs?: number;
  lastErrorAtMs?: number;
  lastError?: string;
  successCount: number;
  failCount: number;
  lastPath?: string;
};

type VisionBatchPacket = {
  type: 'batch';
  id: string;
  sentAtMs: number;
  tokenMetrics?: any[];
  signalContexts?: any[];
  bridges?: any[];
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
const queue: VisionBatchPacket[] = [];

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
    void refreshVisionConfig();
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

const updateStatus = async (patch: Partial<VisionForwardStatus>) => {
  try {
    const res = await browser.storage.local.get(VISION_STATUS_STORAGE_KEY);
    const prev = (res as any)?.[VISION_STATUS_STORAGE_KEY] as VisionForwardStatus | undefined;
    const cfg = await getVisionConfig();
    const next: VisionForwardStatus = {
      enabled: cfg.enabled,
      baseUrl: cfg.baseUrl,
      successCount: prev?.successCount ?? 0,
      failCount: prev?.failCount ?? 0,
      ...prev,
      ...patch,
    };
    await browser.storage.local.set({ [VISION_STATUS_STORAGE_KEY]: next });
  } catch {
  }
};

const bumpStatusCounter = async (
  kind: 'success' | 'fail',
  base: { enabled: boolean; baseUrl: string; path: string; error?: string },
) => {
  try {
    const cur = await browser.storage.local.get(VISION_STATUS_STORAGE_KEY);
    const st = (cur as any)?.[VISION_STATUS_STORAGE_KEY] as VisionForwardStatus | undefined;
    const now = Date.now();
    const next: VisionForwardStatus = {
      enabled: base.enabled,
      baseUrl: base.baseUrl,
      successCount: Math.max(0, Number(st?.successCount) || 0),
      failCount: Math.max(0, Number(st?.failCount) || 0),
      ...st,
      lastPath: base.path,
    };
    if (kind === 'success') {
      next.successCount += 1;
      next.lastSuccessAtMs = now;
      next.lastError = undefined;
    } else {
      next.failCount += 1;
      next.lastErrorAtMs = now;
      next.lastError = base.error || 'forward_failed';
    }
    await browser.storage.local.set({ [VISION_STATUS_STORAGE_KEY]: next });
  } catch {
  }
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

const scheduleFlush = () => {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushQueue();
  }, WS_FLUSH_INTERVAL_MS);
};

const scheduleReconnect = async () => {
  if (reconnectTimer) return;
  const wait = Math.min(15_000, WS_RECONNECT_BASE_MS * Math.max(1, reconnectAttempt + 1));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void ensureWSConnected();
  }, wait);
};

const attachWSListeners = (ws: WebSocket) => {
  ws.onopen = () => {
    wsConnected = true;
    reconnectAttempt = 0;
    void updateStatus({ lastPath: 'ws:open', lastSuccessAtMs: Date.now() });
    scheduleFlush();
  };

  ws.onclose = () => {
    wsConnected = false;
    reconnectAttempt += 1;
    void updateStatus({ lastErrorAtMs: Date.now(), lastError: 'ws_closed', lastPath: 'ws:close' });
    void scheduleReconnect();
  };

  ws.onerror = () => {
    wsConnected = false;
    reconnectAttempt += 1;
    void bumpStatusCounter('fail', {
      enabled: true,
      baseUrl: cfgCache?.baseUrl || DEFAULT_VISION_BASE,
      path: 'ws:error',
      error: 'ws_error',
    });
  };

  ws.onmessage = (ev) => {
    try {
      const data = JSON.parse(String(ev.data ?? '{}'));
      if (data?.type === 'ack') {
        if (data?.ok === true) {
          void bumpStatusCounter('success', {
            enabled: true,
            baseUrl: cfgCache?.baseUrl || DEFAULT_VISION_BASE,
            path: 'ws:ack',
          });
        } else {
          void bumpStatusCounter('fail', {
            enabled: true,
            baseUrl: cfgCache?.baseUrl || DEFAULT_VISION_BASE,
            path: 'ws:ack',
            error: String(data?.error || 'ack_error'),
          });
        }
      }
    } catch {
    }
  };
};

const ensureWSConnected = async () => {
  const cfg = await getVisionConfig();
  if (!cfg.enabled) {
    wsConnected = false;
    try {
      wsClient?.close();
    } catch {
    }
    wsClient = null;
    wsUrlCached = '';
    await updateStatus({ enabled: false, baseUrl: cfg.baseUrl, lastPath: 'ws:disabled' });
    return;
  }
  const wsURL = makeWSUrl(cfg.baseUrl);
  if (wsClient && wsConnected && wsUrlCached === wsURL) {
    return;
  }
  try {
    wsClient?.close();
  } catch {
  }
  wsClient = null;
  wsConnected = false;
  wsUrlCached = wsURL;
  try {
    const ws = new WebSocket(wsURL);
    wsClient = ws;
    attachWSListeners(ws);
    await updateStatus({ enabled: true, baseUrl: cfg.baseUrl, lastPath: 'ws:connecting' });
  } catch (e: any) {
    reconnectAttempt += 1;
    await bumpStatusCounter('fail', {
      enabled: true,
      baseUrl: cfg.baseUrl,
      path: 'ws:connect',
      error: e?.message ? String(e.message) : 'ws_connect_failed',
    });
    await scheduleReconnect();
  }
};

const flushQueue = async () => {
  await ensureWSConnected();
  if (!wsClient || !wsConnected) {
    scheduleFlush();
    return;
  }
  const ws = wsClient;
  while (queue.length > 0 && ws.readyState === WebSocket.OPEN) {
    const pkt = queue.shift();
    if (!pkt) break;
    try {
      ws.send(JSON.stringify(pkt));
      await updateStatus({ enabled: true, baseUrl: cfgCache?.baseUrl || DEFAULT_VISION_BASE, lastSendAtMs: Date.now(), lastPath: 'ws:batch' });
    } catch (e: any) {
      queue.unshift(pkt);
      wsConnected = false;
      await bumpStatusCounter('fail', {
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
  if (queue.length > 0) scheduleFlush();
};

const enqueuePacket = async (packet: VisionBatchPacket) => {
  queue.push(packet);
  while (queue.length > WS_MAX_QUEUE) {
    queue.shift();
  }
  scheduleFlush();
};

const buildMetricsRows = (input: {
  site?: string;
  channel?: string;
  chain?: string;
  tokens?: UnifiedSignalToken[];
  signalTs?: number;
}) => {
  const rows: any[] = [];
  for (const t of safeSliceTokens(input.tokens)) {
    const addr = normalizeAddress((t as any)?.tokenAddress);
    if (!addr) continue;
    rows.push({
      tsMs: normalizeEpochMs((t as any).updatedAtMs ?? input.signalTs ?? Date.now()),
      chain: resolveChain((t as any).chain, input.chain, input.site, input.channel),
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
      sourceSite: String(input.site ?? 'unknown'),
      sourceChannel: String(input.channel ?? 'unknown'),
    });
  }
  return rows;
};

const buildContextAndBridgeRows = (input: {
  signal: UnifiedTwitterSignal | UnifiedMarketSignal;
  sourceType: 'twitter' | 'market_ws';
}) => {
  const signal = input.signal as any;
  const signalId = stableSignalId(signal);
  const contexts: any[] = [];
  const bridges: any[] = [];
  for (const t of safeSliceTokens(signal.tokens)) {
    const addr = normalizeAddress((t as any).tokenAddress);
    if (!addr) continue;
    const updatedAtMs = normalizeEpochMs((t as any).updatedAtMs ?? signal.receivedAtMs ?? signal.ts ?? Date.now());
    contexts.push({
      contextId: `${signalId}:${addr}:${updatedAtMs}`,
      updatedAtMs,
      chain: resolveChain((t as any).chain, signal.chain, signal.site, signal.channel),
      tokenAddress: addr,
      tokenSymbol: typeof (t as any).tokenSymbol === 'string' ? String((t as any).tokenSymbol) : undefined,
      tokenName: typeof (t as any).tokenName === 'string' ? String((t as any).tokenName) : undefined,
      launchpadPlatform: typeof (t as any).launchpadPlatform === 'string' ? String((t as any).launchpadPlatform) : undefined,
      createdAtMs: toInt((t as any).createdAtMs),
      sourceType: input.sourceType,
      sourceSite: String(signal.site ?? 'unknown'),
      sourceChannel: String(signal.channel ?? 'unknown'),
      signalId,
      eventId: typeof signal.eventId === 'string' ? String(signal.eventId) : undefined,
      tweetId: typeof signal.tweetId === 'string' ? String(signal.tweetId) : undefined,
      tweetType: typeof signal.tweetType === 'string' ? String(signal.tweetType) : undefined,
      userScreen: typeof signal.userScreen === 'string' ? String(signal.userScreen) : undefined,
      userName: typeof signal.userName === 'string' ? String(signal.userName) : undefined,
      userFollowers: toInt(signal.userFollowers),
      signalReceivedAtMs: toInt(signal.receivedAtMs),
      devAddress: normalizeAddress((t as any).devAddress) ?? undefined,
      devHoldPercent: toNum((t as any).devHoldPercent),
      devMaxBuyPercent: toNum((t as any).devMaxBuyPercent),
      devHasSold: typeof (t as any).devHasSold === 'boolean' ? (t as any).devHasSold : undefined,
      devCreatedTokenCount: toInt((t as any).devCreatedTokenCount),
      holders: toInt((t as any).holders),
      top10HoldRatio: toNum((t as any).top10HoldRatio),
      smartMoney: toInt((t as any).smartMoney),
      viewerCount: toInt((t as any).viewerCount),
    });
    bridges.push({
      linkedAtMs: normalizeEpochMs(signal.receivedAtMs ?? signal.ts ?? Date.now()),
      chain: resolveChain((t as any).chain, signal.chain, signal.site, signal.channel),
      tokenAddress: addr,
      signalId,
      eventId: typeof signal.eventId === 'string' ? String(signal.eventId) : undefined,
      tweetId: typeof signal.tweetId === 'string' ? String(signal.tweetId) : undefined,
      sourceSite: String(signal.site ?? 'unknown'),
      sourceChannel: String(signal.channel ?? 'unknown'),
    });
  }
  return { contexts, bridges };
};

export const forwardTwitterSignalToVision = async (signal: UnifiedTwitterSignal) => {
  const cfg = await getVisionConfig();
  if (!cfg.enabled) {
    await updateStatus({ enabled: false, baseUrl: cfg.baseUrl, lastPath: 'ws:disabled' });
    return;
  }
  const metrics = buildMetricsRows({
    site: signal.site,
    channel: signal.channel,
    tokens: signal.tokens,
    signalTs: signal.receivedAtMs || signal.ts,
  });
  const { contexts, bridges } = buildContextAndBridgeRows({ signal, sourceType: 'twitter' });
  await enqueuePacket({
    type: 'batch',
    id: `tw:${stableSignalId(signal)}:${Date.now()}`,
    sentAtMs: Date.now(),
    tokenMetrics: metrics,
    signalContexts: contexts,
    bridges,
  });
};

export const forwardMarketSignalToVision = async (signal: UnifiedMarketSignal) => {
  const cfg = await getVisionConfig();
  if (!cfg.enabled) {
    await updateStatus({ enabled: false, baseUrl: cfg.baseUrl, lastPath: 'ws:disabled' });
    return;
  }
  const metrics = buildMetricsRows({
    site: signal.site,
    channel: signal.channel,
    chain: signal.chain,
    tokens: signal.tokens,
    signalTs: signal.receivedAtMs || signal.ts,
  });
  const { contexts, bridges } = buildContextAndBridgeRows({ signal, sourceType: 'market_ws' });
  await enqueuePacket({
    type: 'batch',
    id: `mk:${stableSignalId(signal as any)}:${Date.now()}`,
    sentAtMs: Date.now(),
    tokenMetrics: metrics,
    signalContexts: contexts,
    bridges,
  });
};
