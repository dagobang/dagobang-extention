import type { BgRequest, BgResponse, GmgnTwitterSignal } from '@/types/extention';
import {
  asAddress,
  extractFirstFromObject,
  extractNumber,
  extractText,
  extractTimestampMs,
  extractTokenAddress,
  extractTweetId,
  extractUser,
  isObject,
  toArrayPayload,
} from '@/utils/gmgnWs';

type QuickBuySettings = { quickBuy1Bnb?: string; quickBuy2Bnb?: string };

export type WsSiteMonitor = {
  setQuickBuySettings: (settings: QuickBuySettings) => void;
  emitStatus: () => void;
  dispose: () => void;
};

type WsStatus = {
  connected: boolean;
  lastPacketAt: number;
  lastSignalAt: number;
  latencyMs: number | null;
  packetCount: number;
  signalCount: number;
  logs: Array<{ ts: number; type: 'packet' | 'signal' | 'error'; message: string }>;
};

const buildSignal = (payload: any): GmgnTwitterSignal | null => {
  const text =
    (isObject(payload?.c) && typeof payload.c.t === 'string' ? payload.c.t : null) ??
    (typeof payload?.c === 'string' ? payload.c : null) ??
    extractText(payload);
  const tokenAddress = extractTokenAddress(payload, text);
  if (!tokenAddress) return null;
  const tweetId =
    (typeof payload?.ti === 'string' ? payload.ti : null) ??
    (typeof payload?.si === 'string' ? payload.si : null) ??
    extractTweetId(payload, text);
  const user =
    (isObject(payload?.u) && (typeof payload.u.s === 'string' ? payload.u.s : typeof payload.u.n === 'string' ? payload.u.n : null)) ??
    extractUser(payload);
  const tokenData = isObject(payload?.t) ? payload.t : null;
  const marketCapUsd =
    extractNumber(tokenData, ['mc', 'market_cap', 'marketCap', 'marketCapUsd', 'market_cap_usd']) ??
    extractNumber(payload, ['mc', 'market_cap', 'marketCap', 'marketCapUsd', 'market_cap_usd']);
  const priceUsd =
    extractNumber(tokenData, ['p', 'p1', 'price', 'priceUsd', 'price_usd']) ??
    extractNumber(payload, ['p', 'p1', 'price', 'priceUsd', 'price_usd']);
  const createdAtMs =
    extractTimestampMs(payload) ??
    extractNumber(payload, ['created_at', 'createdAt', 'created_at_ms', 'createdAtMs']);
  const words: string[] = text
    ? Array.from(
        new Set(
          text
            .split(/\s+/)
            .map((w: string) => w.replace(/[^\w$]/g, '').toLowerCase())
            .filter((w: string) => w.length > 0),
        ),
      )
    : [];
  return {
    site: 'gmgn',
    eventId:
      (typeof payload?.i === 'string' ? payload.i : null) ??
      (typeof payload?.ei === 'string' ? payload.ei : null) ??
      extractFirstFromObject(payload, ['eventId', 'event_id']) ??
      undefined,
    tweetId: tweetId ?? undefined,
    user: user ?? undefined,
    text: text ?? undefined,
    keywords: words.length ? words : undefined,
    tokenAddress: tokenAddress.startsWith('0x') ? tokenAddress.toLowerCase() : tokenAddress,
    chain:
      (isObject(tokenData) && typeof tokenData.c === 'string' ? tokenData.c : null) ??
      extractFirstFromObject(payload, ['chain', 'chain_id', 'chainId']) ??
      undefined,
    marketCapUsd: marketCapUsd ?? undefined,
    priceUsd: priceUsd ?? undefined,
    createdAtMs: createdAtMs ?? undefined,
    ts: Date.now(),
  };
};

type TwitterTranslation = {
  eventId: string;
  translatedText?: string;
  translationLang?: string;
  translatedTitle?: string;
  translatedArticle?: string;
  translatedSourceUrl?: string;
  updatedAtMs: number;
};

const extractTranslation = (payload: any, now: number): TwitterTranslation | null => {
  if (!isObject(payload)) return null;
  const eventId =
    (typeof (payload as any).ei === 'string' ? (payload as any).ei : null) ??
    (typeof (payload as any).i === 'string' ? (payload as any).i : null) ??
    extractFirstFromObject(payload, ['eventId', 'event_id', 'ei']) ??
    null;
  if (!eventId) return null;
  const translatedText =
    (typeof (payload as any).c === 'string' ? (payload as any).c : null) ??
    (isObject((payload as any).c) && typeof (payload as any).c.t === 'string' ? (payload as any).c.t : null) ??
    undefined;
  const translationLang = typeof (payload as any).l === 'string' ? (payload as any).l : undefined;
  const translatedTitle = typeof (payload as any).satl === 'string' ? (payload as any).satl : undefined;
  const translatedArticle = typeof (payload as any).sat === 'string' ? (payload as any).sat : undefined;
  const translatedSourceUrl =
    (typeof (payload as any).sc === 'string' ? (payload as any).sc : null) ??
    (isObject((payload as any).sc) && typeof (payload as any).sc.t === 'string' ? (payload as any).sc.t : null) ??
    undefined;
  return {
    eventId,
    translatedText,
    translationLang,
    translatedTitle,
    translatedArticle,
    translatedSourceUrl,
    updatedAtMs: now,
  };
};

const mergeTranslation = (signal: GmgnTwitterSignal, translation: TwitterTranslation): GmgnTwitterSignal => ({
  ...signal,
  translatedText: translation.translatedText ?? signal.translatedText,
  translationLang: translation.translationLang ?? signal.translationLang,
  translatedTitle: translation.translatedTitle ?? signal.translatedTitle,
  translatedArticle: translation.translatedArticle ?? signal.translatedArticle,
  translatedSourceUrl: translation.translatedSourceUrl ?? signal.translatedSourceUrl,
});

const normalizePublicTokenData = (tokenData: any, chain?: string) => {
  const address =
    extractTokenAddress(tokenData) ??
    asAddress(tokenData?.a);
  const createdAtSec = typeof tokenData?.ct === 'number' ? tokenData.ct : null;
  const createdAtMs = createdAtSec ? createdAtSec * 1000 : null;
  const marketCapUsd = typeof tokenData?.mc === 'number' ? tokenData.mc : null;
  const priceUsd = typeof tokenData?.p === 'number' ? tokenData.p : null;
  return {
    tokenAddress: address ?? undefined,
    marketCapUsd: marketCapUsd ?? undefined,
    priceUsd: priceUsd ?? undefined,
    createdAtMs: createdAtMs ?? undefined,
    chain: chain ?? undefined,
    symbol: tokenData?.s ?? undefined,
    name: tokenData?.nm ?? undefined,
    ...(isObject(tokenData) ? tokenData : {}),
  };
};

const normalizeNewPoolTokenData = (pool: any, chain?: string) => {
  const tokenData = isObject(pool?.bti) ? pool.bti : pool;
  const address =
    extractTokenAddress(tokenData) ??
    extractTokenAddress(pool) ??
    asAddress(pool?.a) ??
    asAddress(tokenData?.a);
  const createdAtSec =
    (typeof pool?.ot === 'number' ? pool.ot : null) ??
    (typeof tokenData?.ct === 'number' ? tokenData.ct : null);
  const createdAtMs = createdAtSec ? createdAtSec * 1000 : null;
  const marketCapUsd =
    (typeof tokenData?.mc === 'number' ? tokenData.mc : null) ??
    (typeof pool?.mc === 'number' ? pool.mc : null);
  const liquidityUsd =
    (typeof tokenData?.lqdt === 'number' ? tokenData.lqdt : null) ??
    (typeof pool?.lq === 'number' ? pool.lq : null) ??
    (typeof pool?.lqdt === 'number' ? pool.lqdt : null);
  const priceUsd =
    (typeof tokenData?.p === 'number' ? tokenData.p : null) ??
    (typeof pool?.p === 'number' ? pool.p : null);
  return {
    tokenAddress: address ?? undefined,
    marketCapUsd: marketCapUsd ?? undefined,
    liquidityUsd: liquidityUsd ?? undefined,
    priceUsd: priceUsd ?? undefined,
    createdAtMs: createdAtMs ?? undefined,
    chain: chain ?? undefined,
    symbol: tokenData?.s ?? undefined,
    name: tokenData?.n ?? tokenData?.nm ?? undefined,
    ...(isObject(tokenData) ? tokenData : {}),
    ...(isObject(pool) ? pool : {}),
  };
};

const normalizeTrenchesTokenData = (item: any) => {
  const address =
    extractTokenAddress(item) ??
    asAddress(item?.a);
  const createdAtSec = typeof item?.ct === 'number' ? item.ct : null;
  const createdAtMs = createdAtSec ? createdAtSec * 1000 : null;
  const marketCapUsd = typeof item?.mc === 'number' ? item.mc : null;
  const liquidityUsd = typeof item?.lq === 'number' ? item.lq : null;
  const holders = typeof item?.hd === 'number' ? item.hd : null;
  const priceUsd = typeof item?.p === 'number' ? item.p : null;
  return {
    tokenAddress: address ?? undefined,
    marketCapUsd: marketCapUsd ?? undefined,
    liquidityUsd: liquidityUsd ?? undefined,
    holders: holders ?? undefined,
    priceUsd: priceUsd ?? undefined,
    createdAtMs: createdAtMs ?? undefined,
    devAddress: asAddress(item?.d_ct) ?? undefined,
    devHoldPercent: typeof item?.d_cor === 'number' ? item.d_cor : undefined,
    devHasSold: typeof item?.d_ts === 'string' ? item.d_ts.toLowerCase().includes('sell') : undefined,
    chain: item?.n ?? item?.chain ?? undefined,
    symbol: item?.s ?? undefined,
    name: item?.nm ?? undefined,
    ...(isObject(item) ? item : {}),
  };
};

const extractPublicBroadcastCreates = (payload: any) => {
  const items = toArrayPayload(payload);
  const results: Array<{ tokenData: any; chain?: string }> = [];
  for (const item of items) {
    if (!isObject(item)) continue;
    const ed = (item as any).ed ?? (item as any).data ?? (item as any).d ?? null;
    const sigOp = (isObject(ed) ? (ed as any).sig_op_t : null) ?? (item as any).sig_op_t;
    if (sigOp !== 'create') continue;
    const tokenData = isObject(ed) ? (ed as any).d ?? (ed as any).token ?? (ed as any).data ?? ed : ed;
    const chain = (isObject(ed) ? (ed as any).c : null) ?? (item as any).c ?? (tokenData as any)?.n ?? (tokenData as any)?.c;
    results.push({ tokenData, chain });
  }
  return results;
};

const TWITTER_CACHE_KEY = 'dagobang_twitter_cache_v1';
const TWITTER_CACHE_LIMIT = 50;

const loadTwitterCache = () => {
  try {
    const raw = window.localStorage.getItem(TWITTER_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.list)) return parsed;
  } catch {
  }
  return null;
};

const saveTwitterCache = (list: any[]) => {
  const next = list.slice(-TWITTER_CACHE_LIMIT);
  const payload = { list: next, ts: Date.now() };
  (window as any).__DAGOBANG_TWITTER_CACHE__ = payload;
  try {
    window.localStorage.setItem(TWITTER_CACHE_KEY, JSON.stringify(payload));
  } catch {
  }
};

const emitTwitterEvent = (channel: string, item: any, receivedAtMs: number) => {
  const getCacheKey = (ch: string, it: any) => {
    const key =
      (typeof it?.i === 'string' ? it.i : null) ??
      (typeof it?.ei === 'string' ? it.ei : null) ??
      (typeof it?.ti === 'string' ? it.ti : null) ??
      (typeof it?.si === 'string' ? it.si : null);
    return key ? `${ch}:${key}` : null;
  };
  const payload = { channel, item, receivedAtMs };
  const cache = (window as any).__DAGOBANG_TWITTER_CACHE__ ?? loadTwitterCache();
  if (cache && !(window as any).__DAGOBANG_TWITTER_CACHE__) {
    (window as any).__DAGOBANG_TWITTER_CACHE__ = cache;
  }
  const list = Array.isArray(cache?.list) ? cache.list.slice() : [];
  const key = getCacheKey(channel, item);
  if (key) {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const existedKey = getCacheKey(list[i]?.channel, list[i]?.item);
      if (existedKey === key) list.splice(i, 1);
    }
  }
  list.push(payload);
  saveTwitterCache(list);
  window.dispatchEvent(new CustomEvent('dagobang-gmgn-twitter', { detail: payload }));
};

const emitTrenchesTokenEvent = (tokenData: any, receivedAtMs: number) => {
  window.dispatchEvent(
    new CustomEvent('dagobang-gmgn-trenches-token', {
      detail: {
        tokenData,
        receivedAtMs,
      },
    }),
  );
};

export function initGmgnWsMonitor(options: {
  call: <T extends BgRequest>(req: T) => Promise<BgResponse<T>>;
}): WsSiteMonitor {
  const cached = (window as any).__DAGOBANG_TWITTER_CACHE__ ?? loadTwitterCache();
  if (cached) (window as any).__DAGOBANG_TWITTER_CACHE__ = cached;
  const translationsByEventId = new Map<string, TwitterTranslation>();
  const signalsByEventId = new Map<string, { signal: GmgnTwitterSignal; updatedAtMs: number }>();

  let wsStatus: WsStatus = {
    connected: false,
    lastPacketAt: 0,
    lastSignalAt: 0,
    latencyMs: null,
    packetCount: 0,
    signalCount: 0,
    logs: [],
  };

  const pushLog = (type: 'packet' | 'signal' | 'error', message: string) => {
    const next = wsStatus.logs.concat({ ts: Date.now(), type, message }).slice(-50);
    wsStatus = { ...wsStatus, logs: next };
  };

  const emitStatus = () => {
    const now = Date.now();
    const connected = wsStatus.lastPacketAt > 0 && now - wsStatus.lastPacketAt < 15000;
    const payload = { ...wsStatus, connected };
    (window as any).__DAGOBANG_WS_STATUS__ = payload;
    window.dispatchEvent(new CustomEvent('dagobang-ws-status', { detail: payload }));
  };

  const statusTimer = window.setInterval(() => emitStatus(), 5000);

  const computeLatencyMs = (payload: any, packetTs: number, now: number) => {
    const serverTs = extractTimestampMs(payload);
    const serverLatency = serverTs && Math.abs(now - serverTs) < 5 * 60 * 1000 ? Math.max(0, now - serverTs) : null;
    const localLatency = Math.max(0, now - packetTs);
    return serverLatency ?? (localLatency >= 5 ? localLatency : null);
  };

  const updatePacketStatus = (channel: string, now: number, latencyMs: number | null) => {
    wsStatus = {
      ...wsStatus,
      lastPacketAt: now,
      latencyMs,
      packetCount: wsStatus.packetCount + 1,
    };
    pushLog('packet', channel);
    // emitStatus();
  };

  const normalizeChannel = (channel: unknown): string => (typeof channel === 'string' ? channel.trim() : '');

  const pruneTranslations = (now: number) => {
    if (translationsByEventId.size > 400) {
      let count = 0;
      for (const key of translationsByEventId.keys()) {
        translationsByEventId.delete(key);
        count += 1;
        if (count >= 120) break;
      }
    }
    for (const [key, value] of translationsByEventId) {
      if (now - value.updatedAtMs > 20 * 60 * 1000) translationsByEventId.delete(key);
    }
  };

  const pruneSignals = (now: number) => {
    if (signalsByEventId.size > 400) {
      let count = 0;
      for (const key of signalsByEventId.keys()) {
        signalsByEventId.delete(key);
        count += 1;
        if (count >= 120) break;
      }
    }
    for (const [key, value] of signalsByEventId) {
      if (now - value.updatedAtMs > 20 * 60 * 1000) signalsByEventId.delete(key);
    }
  };

  // Processor: consumes normalized DAGOBANG_WS_PACKET (site=gmgn, direction=receive).
  const handleTwitterChannel = (data: any, channel: string, payload: any, now: number) => {
    const packetTs = typeof data.timestamp === 'number' ? data.timestamp : now;
    const latencyMs = computeLatencyMs(payload, packetTs, now);
    updatePacketStatus(channel, now, latencyMs);
    const items = toArrayPayload(payload);
    const list = items.length ? items : [payload];
    for (const item of list) {
      emitTwitterEvent(channel, item, now);
      if (channel === 'twitter_monitor_translation') {
        const translation = extractTranslation(item, now);
        if (!translation) continue;
        translationsByEventId.set(translation.eventId, translation);
        pruneTranslations(now);
        const existing = signalsByEventId.get(translation.eventId);
        if (!existing) continue;
        const merged = mergeTranslation(existing.signal, translation);
        signalsByEventId.set(translation.eventId, { signal: merged, updatedAtMs: now });
        pruneSignals(now);
        wsStatus = {
          ...wsStatus,
          lastSignalAt: now,
          signalCount: wsStatus.signalCount + 1,
        };
        pushLog('signal', `${merged.tokenAddress}${merged.tweetId ? ` #${merged.tweetId}` : ''} (translated)`);
        emitStatus();
        void options.call({ type: 'gmgn:twitterSignal', payload: merged });
        continue;
      }

      let signal: GmgnTwitterSignal | null = null;
      try {
        signal = buildSignal(item);
      } catch {
        pushLog('error', 'signal_parse_failed');
      }
      if (!signal || !signal.tokenAddress) continue;
      const eventId = signal.eventId;
      if (eventId) {
        const translation = translationsByEventId.get(eventId);
        if (translation) {
          signal = mergeTranslation(signal, translation);
        }
        signalsByEventId.set(eventId, { signal, updatedAtMs: now });
        pruneSignals(now);
      }
      wsStatus = {
        ...wsStatus,
        lastSignalAt: now,
        signalCount: wsStatus.signalCount + 1,
      };
      pushLog('signal', `${signal.tokenAddress}${signal.tweetId ? ` #${signal.tweetId}` : ''}`);
      emitStatus();
      void options.call({ type: 'gmgn:twitterSignal', payload: signal });
    }
    emitStatus();
  };

  const handlePublicBroadcastChannel = (data: any, channel: string, payload: any, now: number) => {
    const packetTs = typeof data.timestamp === 'number' ? data.timestamp : now;
    const latencyMs = computeLatencyMs(payload, packetTs, now);
    updatePacketStatus(channel, now, latencyMs);
    const creates = extractPublicBroadcastCreates(payload);
    if (!creates.length) {
      emitStatus();
      return;
    }
    for (const item of creates) {
      const tokenData = normalizePublicTokenData(item.tokenData, item.chain);
      if (!tokenData.tokenAddress) continue;
      wsStatus = {
        ...wsStatus,
        lastSignalAt: now,
        signalCount: wsStatus.signalCount + 1,
      };
      pushLog('signal', `new > ${tokenData.symbol || tokenData.tokenAddress} ${tokenData.marketCapUsd?.toFixed(2) || ''} ${item.chain ? ` ${item.chain}` : ''}`);
      emitStatus();
      void options.call({
        type: 'autotrade:ws',
        payload: {
          direction: 'receive',
          data: tokenData,
        },
      });
    }
  };

  const handleNewPoolInfoChannel = (data: any, channel: string, payload: any, now: number) => {
    const packetTs = typeof data.timestamp === 'number' ? data.timestamp : now;
    const latencyMs = computeLatencyMs(payload, packetTs, now);
    updatePacketStatus(channel, now, latencyMs);
    const items = toArrayPayload(payload);
    if (!items.length) {
      emitStatus();
      return;
    }
    for (const item of items) {
      const chain = isObject(item) ? ((item as any).c ?? (item as any).chain ?? (item as any).n) : undefined;
      const pools = Array.isArray((item as any)?.p) ? (item as any).p : Array.isArray((item as any)?.pools) ? (item as any).pools : [];
      for (const pool of pools) {
        const tokenData = normalizeNewPoolTokenData(pool, chain);
        if (!tokenData.tokenAddress) continue;
        wsStatus = {
          ...wsStatus,
          lastSignalAt: now,
          signalCount: wsStatus.signalCount + 1,
        };
        pushLog('signal', `new_pool > ${tokenData.symbol || tokenData.tokenAddress} ${tokenData.marketCapUsd?.toFixed(2) || ''} ${chain ? ` ${chain}` : ''}`);
        emitStatus();
        void options.call({
          type: 'autotrade:ws',
          payload: {
            direction: 'receive',
            data: tokenData,
          },
        });
      }
    }
  };

  const handleTrenchesUpdateChannel = (data: any, channel: string, payload: any, now: number) => {
    const packetTs = typeof data.timestamp === 'number' ? data.timestamp : now;
    const latencyMs = computeLatencyMs(payload, packetTs, now);
    updatePacketStatus(channel, now, latencyMs);
    const items = toArrayPayload(payload);
    if (!items.length) {
      emitStatus();
      return;
    }
    for (const item of items) {
      const tokenData = normalizeTrenchesTokenData(item);
      if (!tokenData.tokenAddress) continue;
      emitTrenchesTokenEvent(tokenData, now);
      wsStatus = {
        ...wsStatus,
        lastSignalAt: now,
        signalCount: wsStatus.signalCount + 1,
      };
      pushLog('signal', `trenches > ${tokenData.symbol || tokenData.tokenAddress} ${tokenData.marketCapUsd?.toFixed(2) || ''} ${tokenData.chain ? ` ${tokenData.chain}` : ''}`);
      emitStatus();
      void options.call({
        type: 'autotrade:ws',
        payload: {
          direction: 'receive',
          data: tokenData,
        },
      });
    }
  };

  const handleOtherChannel = (data: any, channel: string, payload: any, now: number) => {
    // updatePacketStatus(channel, now, null);
  };

  const CHANNEL_PROCESSORS: Record<string, (data: any, channel: string, payload: any, now: number) => void> = {
    public_broadcast: handlePublicBroadcastChannel,
    new_pool_info: handleNewPoolInfoChannel,
    trenches_update: handleTrenchesUpdateChannel,
    twitter_user_monitor_basic: (data, channel, payload, now) => {
      handleTwitterChannel(data, channel, payload, now);
    },
    twitter_monitor_translation: (data, channel, payload, now) => {
      handleTwitterChannel(data, channel, payload, now);
    },
  };

  const onMessage = (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = (event as any).data as any;
    if (!data || data.type !== 'DAGOBANG_WS_PACKET') return;
    if (data.site !== 'gmgn' || data.direction !== 'receive') return;
    const channel = normalizeChannel(data.channel);
    const payload = data.payload ?? data.raw ?? data;
    const now = Date.now();
    const processor = CHANNEL_PROCESSORS[channel] ?? handleOtherChannel;
    processor(data, channel, payload, now);
  };

  window.addEventListener('message', onMessage);

  return {
    setQuickBuySettings: (_settings) => {
    },
    emitStatus,
    dispose: () => {
      window.clearInterval(statusTimer);
      window.removeEventListener('message', onMessage);
    },
  };
}
