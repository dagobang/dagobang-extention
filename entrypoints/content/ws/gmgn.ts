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
  const text = extractText(payload);
  const tokenAddress = extractTokenAddress(payload, text);
  if (!tokenAddress) return null;
  const tweetId = extractTweetId(payload, text);
  const user = extractUser(payload);
  const marketCapUsd = extractNumber(payload, ['market_cap', 'marketCap', 'marketCapUsd', 'market_cap_usd']);
  const priceUsd = extractNumber(payload, ['price', 'priceUsd', 'price_usd']);
  const createdAtMs = extractNumber(payload, ['created_at', 'createdAt', 'created_at_ms', 'createdAtMs']);
  const words = text
    ? Array.from(new Set(text.split(/\s+/).map((w) => w.replace(/[^\w$]/g, '').toLowerCase()).filter(Boolean)))
    : [];
  return {
    site: 'gmgn',
    eventId: extractFirstFromObject(payload, ['eventId', 'event_id']) ?? undefined,
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

const createQuickBuyContainer = (tokenAddress: string, settings: QuickBuySettings) => {
  const container = document.createElement('div');
  container.className = 'dagobang-tweet-quickbuy';
  container.style.display = 'inline-flex';
  container.style.alignItems = 'center';
  container.style.gap = '6px';
  container.style.marginLeft = '8px';
  const makeBtn = (amount: string) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = `${amount} BNB`;
    btn.style.padding = '2px 6px';
    btn.style.borderRadius = '6px';
    btn.style.border = '1px solid rgba(125,125,125,0.5)';
    btn.style.background = 'rgba(20,20,20,0.9)';
    btn.style.color = 'white';
    btn.style.fontSize = '12px';
    btn.style.cursor = 'pointer';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      window.dispatchEvent(
        new CustomEvent('dagobang-quickbuy', {
          detail: {
            tokenAddress,
            amountBnb: amount,
          },
        }),
      );
    });
    return btn;
  };
  const quick1 = settings.quickBuy1Bnb;
  const quick2 = settings.quickBuy2Bnb;
  if (quick1 && Number(quick1) > 0) container.appendChild(makeBtn(quick1));
  if (quick2 && Number(quick2) > 0) container.appendChild(makeBtn(quick2));
  return container;
};

const injectQuickBuyForTweet = (tweetId: string, tokenAddress: string, settings: QuickBuySettings) => {
  const selectors = [
    `[data-tweet-id="${tweetId}"]`,
    `[data-id="${tweetId}"]`,
    `a[href*="status/${tweetId}"]`,
  ];
  for (const selector of selectors) {
    const el = document.querySelector(selector) as HTMLElement | null;
    if (!el) continue;
    const host = el.closest('div') || el.parentElement;
    if (!host || host.querySelector('.dagobang-tweet-quickbuy')) return;
    const container = createQuickBuyContainer(tokenAddress, settings);
    host && host.appendChild(container);
    return;
  }
};

export function initGmgnWsMonitor(options: {
  call: <T extends BgRequest>(req: T) => Promise<BgResponse<T>>;
}): WsSiteMonitor {
  const tweetSignals = new Map<string, { tokenAddress: string; updatedAt: number }>();
  let quickBuySettings: QuickBuySettings = {};
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

  const flushQuickBuy = () => {
    for (const [tweetId, info] of tweetSignals.entries()) {
      injectQuickBuyForTweet(tweetId, info.tokenAddress, quickBuySettings);
    }
  };

  const observer = new MutationObserver(() => {
    flushQuickBuy();
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }

  const normalizeChannel = (channel: unknown): string => (typeof channel === 'string' ? channel.trim() : '');

  const handleTwitterChannel = (data: any, channel: string, payload: any, now: number) => {
    const packetTs = typeof data.timestamp === 'number' ? data.timestamp : now;
    const latencyMs = computeLatencyMs(payload, packetTs, now);
    updatePacketStatus(channel, now, latencyMs);
    let signal: GmgnTwitterSignal | null = null;
    try {
      signal = buildSignal(payload);
    } catch {
      pushLog('error', 'signal_parse_failed');
    }
    if (!signal || !signal.tokenAddress) {
      emitStatus();
      return;
    }
    wsStatus = {
      ...wsStatus,
      lastSignalAt: now,
      signalCount: wsStatus.signalCount + 1,
    };
    pushLog('signal', `${signal.tokenAddress}${signal.tweetId ? ` #${signal.tweetId}` : ''}`);
    emitStatus();
    void options.call({ type: 'gmgn:twitterSignal', payload: signal });
    if (signal.tweetId) {
      tweetSignals.set(signal.tweetId, { tokenAddress: signal.tokenAddress, updatedAt: Date.now() });
      injectQuickBuyForTweet(signal.tweetId, signal.tokenAddress, quickBuySettings);
    }
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

  const onMessage = (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = (event as any).data as any;
    if (!data || data.type !== 'DAGOBANG_WS_PACKET') return;
    if (data.site !== 'gmgn' || data.direction !== 'receive') return;
    const channel = normalizeChannel(data.channel);
    const payload = data.payload ?? data.raw ?? data;
    const now = Date.now();
    switch (channel) {
      case 'public_broadcast':
        handlePublicBroadcastChannel(data, channel, payload, now);
        break;
      case 'new_pool_info':
        handleNewPoolInfoChannel(data, channel, payload, now);
        break;
      case 'trenches_update':
        handleTrenchesUpdateChannel(data, channel, payload, now);
        break;
      case 'twitter_user_monitor_basic':
      case 'twitter_monitor_translation':
        // handleTwitterChannel(data, channel, payload, now);
        break;
      default:
        handleOtherChannel(data, channel, payload, now);
        break;
    }
  };

  window.addEventListener('message', onMessage);

  return {
    setQuickBuySettings: (settings) => {
      quickBuySettings = settings;
    },
    emitStatus,
    dispose: () => {
      window.clearInterval(statusTimer);
      observer.disconnect();
      window.removeEventListener('message', onMessage);
    },
  };
}
