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
  const text = typeof payload?.c === 'string' ? payload.c : extractText(payload);
  const tokenAddress = extractTokenAddress(payload, text);
  if (!tokenAddress) return null;
  const tweetId = typeof payload?.ti === 'string' ? payload.ti : extractTweetId(payload, text);
  const user =
    (isObject(payload?.u) && (typeof payload.u.s === 'string' ? payload.u.s : typeof payload.u.n === 'string' ? payload.u.n : null)) ??
    extractUser(payload);
  const marketCapUsd = extractNumber(payload, ['market_cap', 'marketCap', 'marketCapUsd', 'market_cap_usd']);
  const priceUsd = extractNumber(payload, ['price', 'priceUsd', 'price_usd']);
  const createdAtMs = extractNumber(payload, ['created_at', 'createdAt', 'created_at_ms', 'createdAtMs']);
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
    tokenAddress: tokenAddress.toLowerCase(),
    chain: extractFirstFromObject(payload, ['chain', 'chain_id']) ?? undefined,
    marketCapUsd: marketCapUsd ?? undefined,
    priceUsd: priceUsd ?? undefined,
    createdAtMs: createdAtMs ?? undefined,
    ts: Date.now(),
  };
};

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

const emitTwitterEvent = (channel: string, item: any, receivedAtMs: number) => {
  window.dispatchEvent(
    new CustomEvent('dagobang-gmgn-twitter', {
      detail: {
        channel,
        item,
        receivedAtMs,
      },
    }),
  );
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

  // Processor: consumes normalized DAGOBANG_WS_PACKET (site=gmgn, direction=receive).
  const handleTwitterChannel = (data: any, channel: string, payload: any, now: number) => {
    const packetTs = typeof data.timestamp === 'number' ? data.timestamp : now;
    const latencyMs = computeLatencyMs(payload, packetTs, now);
    updatePacketStatus(channel, now, latencyMs);
    const items = toArrayPayload(payload);
    const list = items.length ? items : [payload];
    for (const item of list) {
      emitTwitterEvent(channel, item, now);
      let signal: GmgnTwitterSignal | null = null;
      try {
        signal = buildSignal(item);
      } catch {
        pushLog('error', 'signal_parse_failed');
      }
      if (!signal || !signal.tokenAddress) continue;
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
