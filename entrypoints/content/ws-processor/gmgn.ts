import type { AutoTradeInteractionType, BgRequest, BgResponse, Settings, UnifiedTwitterSignal } from '@/types/extention';
import {
  asAddress,
  extractFirstFromObject,
  extractGmgnUserFields,
  extractMedia,
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

type TwitterTranslationPatch = {
  eventId: string;
  translatedText?: string;
  translationLang?: string;
  updatedAtMs: number;
};

const buildTranslatedText = (item: any): string | undefined => {
  const main = typeof item?.c === 'string' ? item.c : isObject(item?.c) && typeof item.c.t === 'string' ? item.c.t : undefined;
  const article = typeof item?.sat === 'string' ? item.sat : undefined;
  const title = typeof item?.satl === 'string' ? item.satl : undefined;
  const body = article ?? main;
  if (!body && title) return title;
  if (body && title && !body.startsWith(title)) return `${title}\n${body}`;
  return body ?? undefined;
};

const extractTranslationPatch = (payload: any, now: number): TwitterTranslationPatch | null => {
  if (!isObject(payload)) return null;
  const eventId =
    (typeof (payload as any).ei === 'string' ? (payload as any).ei : null) ??
    (typeof (payload as any).i === 'string' ? (payload as any).i : null) ??
    extractFirstFromObject(payload, ['eventId', 'event_id', 'ei', 'i']) ??
    null;
  if (!eventId) return null;
  const translatedText = buildTranslatedText(payload);
  const translationLang = typeof (payload as any).l === 'string' ? (payload as any).l : undefined;
  return {
    eventId,
    translatedText,
    translationLang,
    updatedAtMs: now,
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
    asAddress(item?.a) ??
    extractTokenAddress(item);
  const createdAtSec = typeof item?.ct === 'number' ? item.ct : null;
  const createdAtMs = createdAtSec ? createdAtSec * 1000 : null;
  const marketCapUsd = extractNumber(item, ['mc']);
  const liquidityUsd = extractNumber(item, ['lq', 'lqdt']);
  const holders = extractNumber(item, ['hd']);
  const priceUsd = extractNumber(item, ['p']);
  const devBuyRatio = extractNumber(item, ['d_br']);
  const top10HoldRatio = extractNumber(item, ['t10']);
  const devTokenStatus = typeof item?.d_ts === 'string' ? item.d_ts.trim() : undefined;
  const tokenLogo = typeof item?.l === 'string' && item.l.trim() ? item.l.trim() : undefined;
  return {
    tokenAddress: address ?? undefined,
    marketCapUsd: marketCapUsd ?? undefined,
    liquidityUsd: liquidityUsd ?? undefined,
    holders: holders ?? undefined,
    priceUsd: priceUsd ?? undefined,
    createdAtMs: createdAtMs ?? undefined,
    devAddress: asAddress(item?.d_ct) ?? undefined,
    devHoldPercent: extractNumber(item, ['d_cor']) ?? undefined,
    devHasSold: typeof item?.d_ts === 'string' ? item.d_ts.toLowerCase().includes('sell') : undefined,
    devBuyRatio: devBuyRatio ?? undefined,
    top10HoldRatio: top10HoldRatio ?? undefined,
    devTokenStatus,
    tokenLogo,
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

const normalizeInteractionType = (raw?: string | null): AutoTradeInteractionType | null => {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v === 'tweet') return 'tweet';
  if (v === 'reply') return 'reply';
  if (v === 'quote') return 'quote';
  if (v === 'retweet' || v === 'repost') return 'retweet';
  if (v === 'follow') return 'follow';
  return null;
};

const getTwitterFilters = () => {
  const settings: Settings | null = (window as any).__DAGOBANG_SETTINGS__ ?? null;
  const targets = (settings?.autoTrade?.twitterSnipe?.targetUsers ?? [])
    .map((x) => x.trim().replace(/^@/, '').toLowerCase())
    .filter(Boolean);
  const interactions = (settings?.autoTrade?.twitterSnipe?.interactionTypes ?? []).map((x) => String(x).toLowerCase());
  return { settings, targets, interactions };
};

const TWITTER_UNIFIED_CACHE_KEY = 'dagobang_unified_twitter_cache_v1';
const TWITTER_UNIFIED_CACHE_LIMIT = 50;

const loadUnifiedTwitterCache = () => {
  try {
    const raw = window.localStorage.getItem(TWITTER_UNIFIED_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.list)) return parsed;
  } catch {
  }
  return null;
};

const saveUnifiedTwitterCache = (list: UnifiedTwitterSignal[]) => {
  const next = list.slice(-TWITTER_UNIFIED_CACHE_LIMIT);
  const payload = { list: next, ts: Date.now() };
  (window as any).__DAGOBANG_UNIFIED_TWITTER_CACHE__ = payload;
  try {
    window.localStorage.setItem(TWITTER_UNIFIED_CACHE_KEY, JSON.stringify(payload));
  } catch {
  }
};

const getSignalUser = (signal: UnifiedTwitterSignal): string | null => {
  const userRaw = signal.userScreen ?? null;
  if (!userRaw) return null;
  return userRaw.trim().replace(/^@/, '').toLowerCase();
};

const getSignalInteraction = (signal: UnifiedTwitterSignal): AutoTradeInteractionType | null => {
  const type = signal.tweetType === 'delete_post' ? (signal.sourceTweetType ?? null) : signal.tweetType;
  if (type === 'repost') return 'retweet';
  if (type === 'tweet') return 'tweet';
  if (type === 'reply') return 'reply';
  if (type === 'quote') return 'quote';
  if (type === 'follow') return 'follow';
  return null;
};

const shouldKeepUnifiedSignal = (signal: UnifiedTwitterSignal) => {
  const { targets, interactions } = getTwitterFilters();
  if (!targets.length && !interactions.length) return true;
  if (targets.length) {
    const user = getSignalUser(signal);
    if (!user) return false;
    if (!targets.includes(user)) return false;
  }
  if (interactions.length) {
    const it = getSignalInteraction(signal);
    if (!it) return false;
    if (!interactions.includes(it)) return false;
  }
  return true;
};

const refreshUnifiedTwitterCache = () => {
  const cache = (window as any).__DAGOBANG_UNIFIED_TWITTER_CACHE__ ?? loadUnifiedTwitterCache();
  if (!cache || !Array.isArray(cache.list)) return;
  const filtered = (cache.list as UnifiedTwitterSignal[]).filter((x) => x && shouldKeepUnifiedSignal(x));
  const list = filtered.slice(-TWITTER_UNIFIED_CACHE_LIMIT);
  saveUnifiedTwitterCache(list);
};

const upsertUnifiedSignal = (signal: UnifiedTwitterSignal, cacheList?: UnifiedTwitterSignal[]) => {
  const cache = cacheList ? { list: cacheList } : (window as any).__DAGOBANG_UNIFIED_TWITTER_CACHE__ ?? loadUnifiedTwitterCache();
  if (!cacheList && cache && !(window as any).__DAGOBANG_UNIFIED_TWITTER_CACHE__) {
    (window as any).__DAGOBANG_UNIFIED_TWITTER_CACHE__ = cache;
  }
  const list = Array.isArray(cache?.list) ? (cache.list as UnifiedTwitterSignal[]).slice() : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const it = list[i];
    if (!it) continue;
    if (it.id === signal.id) list.splice(i, 1);
    else if (signal.eventId && it.site === signal.site && it.eventId === signal.eventId) list.splice(i, 1);
  }
  list.push(signal);
  const next = list.slice(-TWITTER_UNIFIED_CACHE_LIMIT);
  saveUnifiedTwitterCache(next);
  window.dispatchEvent(new CustomEvent('dagobang-twitter-signal', { detail: signal }));
  return next;
};

type TokenSnapshot = {
  tokenAddress: string;
  chain?: string;
  tokenSymbol?: string;
  tokenName?: string;
  tokenLogo?: string;
  marketCapUsd?: number;
  priceUsd?: number;
  liquidityUsd?: number;
  holders?: number;
  devBuyRatio?: number;
  top10HoldRatio?: number;
  devTokenStatus?: string;
  createdAtMs?: number;
  receivedAtMs: number;
};

const pickNonEmptyString = (next: any, prev?: string): string | undefined => {
  const s = typeof next === 'string' ? next.trim() : '';
  return s ? s : prev;
};

const pickFiniteNumber = (next: any, prev?: number): number | undefined => {
  return typeof next === 'number' && Number.isFinite(next) ? next : prev;
};

const mergeTokenSnapshot = (signal: UnifiedTwitterSignal, snapshot: TokenSnapshot | undefined): UnifiedTwitterSignal => {
  if (!snapshot) return signal;
  return {
    ...signal,
    chain: pickNonEmptyString(snapshot.chain, signal.chain),
    tokenSymbol: pickNonEmptyString(snapshot.tokenSymbol, signal.tokenSymbol),
    tokenName: pickNonEmptyString(snapshot.tokenName, signal.tokenName),
    tokenLogo: pickNonEmptyString(snapshot.tokenLogo, signal.tokenLogo),
    marketCapUsd: pickFiniteNumber(snapshot.marketCapUsd, signal.marketCapUsd),
    priceUsd: pickFiniteNumber(snapshot.priceUsd, signal.priceUsd),
    liquidityUsd: pickFiniteNumber(snapshot.liquidityUsd, signal.liquidityUsd),
    holders: pickFiniteNumber(snapshot.holders, signal.holders),
    devBuyRatio: pickFiniteNumber(snapshot.devBuyRatio, signal.devBuyRatio),
    top10HoldRatio: pickFiniteNumber(snapshot.top10HoldRatio, signal.top10HoldRatio),
    devTokenStatus: pickNonEmptyString(snapshot.devTokenStatus, signal.devTokenStatus),
    createdAtMs: pickFiniteNumber(snapshot.createdAtMs, signal.createdAtMs),
  };
};

const convertToUnifiedSignal = (channel: string, item: any, receivedAtMs: number): UnifiedTwitterSignal | null => {
  if (!item || typeof item !== 'object') return null;
  const raw = typeof (item as any).tw === 'string' ? String((item as any).tw).trim().toLowerCase() : '';
  if (!raw) return null;

  const sourceTweetType: UnifiedTwitterSignal['sourceTweetType'] | undefined = (() => {
    const stw = typeof (item as any).stw === 'string' ? String((item as any).stw).trim().toLowerCase() : '';
    if (!stw) return undefined;
    if (stw === 'tweet') return 'tweet';
    if (stw === 'reply') return 'reply';
    if (stw === 'quote') return 'quote';
    if (stw === 'retweet' || stw === 'repost') return 'repost';
    if (stw === 'follow') return 'follow';
    if (stw === 'unfollow') return 'unfollow';
    return undefined;
  })();

  const tweetType: UnifiedTwitterSignal['tweetType'] | null = (() => {
    if (raw === 'tweet') return 'tweet';
    if (raw === 'reply') return 'reply';
    if (raw === 'quote') return 'quote';
    if (raw === 'retweet' || raw === 'repost') return 'repost';
    if (raw === 'follow') return 'follow';
    if (raw === 'unfollow') return 'unfollow';
    if (raw === 'delete' || raw === 'delete_post' || raw === 'deletepost') return 'delete_post';
    return null;
  })();
  if (!tweetType) return null;

  const eventId =
    (typeof (item as any).i === 'string' ? (item as any).i : null) ??
    (typeof (item as any).ei === 'string' ? (item as any).ei : null) ??
    extractFirstFromObject(item, ['eventId', 'event_id', 'ei', 'i']) ??
    undefined;

  const { userScreen, userName, userAvatar, userFollowers } = extractGmgnUserFields(item);
  const tweetId = extractTweetId(item, extractText(item) ?? undefined) ?? undefined;

  const mainText =
    (isObject((item as any).c) && typeof (item as any).c.t === 'string' ? (item as any).c.t : null) ??
    (typeof (item as any).c === 'string' ? (item as any).c : null) ??
    null;
  const sourceTextRaw =
    (isObject((item as any).sc) && typeof (item as any).sc.t === 'string' ? (item as any).sc.t : null) ??
    (typeof (item as any).sc === 'string' ? (item as any).sc : null) ??
    null;
  const sourceText = sourceTextRaw && /^https?:\/\//i.test(sourceTextRaw) ? null : sourceTextRaw;
  const followBio = isObject((item as any)?.f?.f) && typeof (item as any).f.f.d === 'string' ? (item as any).f.f.d : null;
  const text =
    tweetType === 'follow' || tweetType === 'unfollow'
      ? followBio ?? extractText(item)
      : mainText ?? extractText(item);

  const quotedTweetId = typeof (item as any).si === 'string' ? (item as any).si : undefined;
  const sourceUser = (item as any).su;
  const quotedUserScreen = sourceUser && typeof sourceUser.s === 'string' ? sourceUser.s : undefined;
  const quotedUserName = sourceUser && typeof sourceUser.n === 'string' ? sourceUser.n : undefined;
  const quotedUserAvatar = sourceUser && typeof sourceUser.a === 'string' ? sourceUser.a : undefined;
  const quotedText = tweetType === 'quote' || tweetType === 'repost' ? sourceText ?? undefined : undefined;

  const followTarget = (item as any)?.f?.f;
  const followedUserScreen = followTarget && typeof followTarget.s === 'string' ? followTarget.s : undefined;
  const followedUserName = followTarget && typeof followTarget.n === 'string' ? followTarget.n : undefined;
  const followedUserAvatar = followTarget && typeof followTarget.a === 'string' ? followTarget.a : undefined;
  const followedUserBio = followTarget && typeof followTarget.d === 'string' ? followTarget.d : undefined;
  const followedUserFollowers = followTarget && typeof followTarget.f === 'number' ? followTarget.f : undefined;

  const tokenAddressRaw = extractTokenAddress(item, text ?? quotedText ?? null);
  const tokenAddress = tokenAddressRaw?.startsWith('0x') ? (tokenAddressRaw.toLowerCase() as `0x${string}`) : (tokenAddressRaw ?? undefined);
  const media = extractMedia(item);
  const chain =
    (typeof (item as any).c === 'string' ? (item as any).c : null) ??
    (typeof (item as any).n === 'string' ? (item as any).n : null) ??
    (isObject((item as any).t) && typeof (item as any).t.c === 'string' ? (item as any).t.c : null) ??
    extractFirstFromObject(item, ['chain', 'chain_id', 'chainId']) ??
    undefined;
  const marketCapUsd =
    extractNumber((item as any).t, ['mc', 'market_cap', 'marketCap', 'marketCapUsd', 'market_cap_usd']) ??
    extractNumber(item, ['mc', 'market_cap', 'marketCap', 'marketCapUsd', 'market_cap_usd']) ??
    undefined;
  const priceUsd =
    extractNumber((item as any).t, ['p', 'p1', 'price', 'priceUsd', 'price_usd']) ??
    extractNumber(item, ['p', 'p1', 'price', 'priceUsd', 'price_usd']) ??
    undefined;
  const liquidityUsd = extractNumber(item, ['lq', 'lqdt', 'liquidity', 'liquidityUsd', 'liquidity_usd']) ?? undefined;
  const holders = extractNumber(item, ['hd', 'holders', 'holderCount']) ?? undefined;
  const createdAtMs = extractTimestampMs(item) ?? (extractNumber(item, ['created_at', 'createdAt', 'created_at_ms', 'createdAtMs']) ?? undefined);

  const idSeed =
    eventId ??
    tweetId ??
    quotedTweetId ??
    (typeof (item as any).ti === 'string' ? (item as any).ti : null) ??
    String(receivedAtMs);
  const id = `gmgn:${channel}:${idSeed}`;

  return {
    id,
    site: 'gmgn',
    channel,
    tweetType,
    sourceTweetType,
    eventId,
    tweetId,
    userScreen,
    userName,
    userAvatar,
    userFollowers,
    text: text ?? undefined,
    media: media.length ? media : undefined,
    quotedTweetId,
    quotedUserScreen,
    quotedUserName,
    quotedUserAvatar,
    quotedText,
    followedUserScreen,
    followedUserName,
    followedUserAvatar,
    followedUserBio,
    followedUserFollowers,
    tokenAddress,
    chain,
    marketCapUsd,
    priceUsd,
    liquidityUsd,
    holders,
    createdAtMs: createdAtMs ?? undefined,
    receivedAtMs,
    ts: Date.now(),
  };
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
  const cached = (window as any).__DAGOBANG_UNIFIED_TWITTER_CACHE__ ?? loadUnifiedTwitterCache();
  if (cached) (window as any).__DAGOBANG_UNIFIED_TWITTER_CACHE__ = cached;
  refreshUnifiedTwitterCache();
  const translationsByEventId = new Map<string, TwitterTranslationPatch>();
  const signalsByEventId = new Map<string, { signal: UnifiedTwitterSignal; updatedAtMs: number }>();
  const tokenByAddress = new Map<string, TokenSnapshot>();

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
    const cache = (window as any).__DAGOBANG_UNIFIED_TWITTER_CACHE__ ?? loadUnifiedTwitterCache();
    if (cache && !(window as any).__DAGOBANG_UNIFIED_TWITTER_CACHE__) {
      (window as any).__DAGOBANG_UNIFIED_TWITTER_CACHE__ = cache;
    }
    let cacheList = Array.isArray(cache?.list) ? (cache.list as UnifiedTwitterSignal[]).slice() : [];

    const removeFromCache = (eventId?: string, tweetId?: string) => {
      if (!eventId && !tweetId) return;
      const next = cacheList.filter((s) => {
        if (!s) return false;
        if (eventId && s.site === 'gmgn' && s.eventId === eventId) return false;
        if (tweetId && s.site === 'gmgn' && s.tweetId === tweetId) return false;
        return true;
      });
      if (next.length !== cacheList.length) {
        cacheList = next;
        saveUnifiedTwitterCache(cacheList);
      }
    };

    for (const item of list) {
      if (channel === 'twitter_monitor_translation') {
        const patch = extractTranslationPatch(item, now);
        if (!patch) continue;
        translationsByEventId.set(patch.eventId, patch);
        pruneTranslations(now);
        const existing = signalsByEventId.get(patch.eventId);
        if (!existing) continue;
        const merged: UnifiedTwitterSignal = {
          ...existing.signal,
          translatedText: patch.translatedText ?? existing.signal.translatedText,
          translationLang: patch.translationLang ?? existing.signal.translationLang,
          ts: Date.now(),
        };
        signalsByEventId.set(patch.eventId, { signal: merged, updatedAtMs: now });
        pruneSignals(now);
        cacheList = cacheList.map((s) => (s && s.site === 'gmgn' && s.eventId === patch.eventId ? merged : s));
        saveUnifiedTwitterCache(cacheList);
        window.dispatchEvent(new CustomEvent('dagobang-twitter-signal', { detail: merged }));
        wsStatus = { ...wsStatus, lastSignalAt: now, signalCount: wsStatus.signalCount + 1 };
        pushLog('signal', `${merged.tokenAddress ?? ''}${merged.tweetId ? ` #${merged.tweetId}` : ''} (translated)`);
        emitStatus();
        if (merged.tokenAddress && merged.tweetType !== 'delete_post') void options.call({ type: 'gmgn:twitterSignal', payload: merged });
        continue;
      }

      const rawType = typeof (item as any)?.tw === 'string' ? String((item as any).tw).trim().toLowerCase() : '';
      if (rawType === 'delete' || rawType === 'delete_post' || rawType === 'deletepost') {
        let delSignal: UnifiedTwitterSignal | null = null;
        try {
          delSignal = convertToUnifiedSignal(channel, item, now);
        } catch {
        }
        if (delSignal && shouldKeepUnifiedSignal(delSignal)) {
          if (delSignal.eventId) {
            signalsByEventId.set(delSignal.eventId, { signal: delSignal, updatedAtMs: now });
            pruneSignals(now);
          }
          cacheList = upsertUnifiedSignal(delSignal, cacheList) ?? cacheList;
          wsStatus = {
            ...wsStatus,
            lastSignalAt: now,
            signalCount: wsStatus.signalCount + 1,
          };
          pushLog('signal', `delete${delSignal.tweetId ? ` #${delSignal.tweetId}` : ''}`);
          emitStatus();
        }
        continue;
      }

      let signal: UnifiedTwitterSignal | null = null;
      try {
        signal = convertToUnifiedSignal(channel, item, now);
      } catch {
        pushLog('error', 'signal_parse_failed');
      }
      if (!signal) continue;

      if (signal.eventId) {
        const translation = translationsByEventId.get(signal.eventId);
        if (translation) {
          signal = {
            ...signal,
            translatedText: translation.translatedText ?? signal.translatedText,
            translationLang: translation.translationLang ?? signal.translationLang,
          };
        }
      }
      if (signal.tokenAddress) {
        const snap = tokenByAddress.get(String(signal.tokenAddress).toLowerCase());
        signal = mergeTokenSnapshot(signal, snap);
      }
      if (!shouldKeepUnifiedSignal(signal)) continue;

      if (signal.eventId) {
        signalsByEventId.set(signal.eventId, { signal, updatedAtMs: now });
        pruneSignals(now);
      }
      cacheList = upsertUnifiedSignal(signal, cacheList) ?? cacheList;
      wsStatus = {
        ...wsStatus,
        lastSignalAt: now,
        signalCount: wsStatus.signalCount + 1,
      };
      pushLog('signal', `${signal.tokenAddress ?? ''}${signal.tweetId ? ` #${signal.tweetId}` : ''}`);
      emitStatus();
      if (signal.tokenAddress && signal.tweetType !== 'delete_post') void options.call({ type: 'gmgn:twitterSignal', payload: signal });
    }
    emitStatus();
  };

  const updateTokenSnapshot = (tokenData: any, receivedAtMs: number) => {
    const addrRaw = typeof tokenData?.tokenAddress === 'string' ? tokenData.tokenAddress : null;
    if (!addrRaw) return;
    const addr = addrRaw.toLowerCase();
    const prev = tokenByAddress.get(addr);
    const tokenSymbol = pickNonEmptyString(tokenData?.tokenSymbol ?? tokenData?.symbol ?? tokenData?.s, prev?.tokenSymbol);
    const tokenName = pickNonEmptyString(tokenData?.tokenName ?? tokenData?.name ?? tokenData?.nm ?? tokenData?.n, prev?.tokenName);
    const tokenLogo = pickNonEmptyString(tokenData?.tokenLogo ?? tokenData?.l ?? tokenData?.logo, prev?.tokenLogo);
    const devTokenStatus = pickNonEmptyString(tokenData?.devTokenStatus ?? tokenData?.d_ts, prev?.devTokenStatus);
    const devBuyRatio = pickFiniteNumber(
      typeof tokenData?.devBuyRatio === 'number' ? tokenData.devBuyRatio : extractNumber(tokenData, ['d_br']),
      prev?.devBuyRatio,
    );
    const top10HoldRatio = pickFiniteNumber(
      typeof tokenData?.top10HoldRatio === 'number' ? tokenData.top10HoldRatio : extractNumber(tokenData, ['t10']),
      prev?.top10HoldRatio,
    );
    const next: TokenSnapshot = {
      tokenAddress: addr,
      chain: pickNonEmptyString(tokenData?.chain, prev?.chain),
      tokenSymbol,
      tokenName,
      tokenLogo,
      marketCapUsd: typeof tokenData?.marketCapUsd === 'number' ? tokenData.marketCapUsd : prev?.marketCapUsd,
      priceUsd: typeof tokenData?.priceUsd === 'number' ? tokenData.priceUsd : prev?.priceUsd,
      liquidityUsd: typeof tokenData?.liquidityUsd === 'number' ? tokenData.liquidityUsd : prev?.liquidityUsd,
      holders: typeof tokenData?.holders === 'number' ? tokenData.holders : prev?.holders,
      devBuyRatio,
      top10HoldRatio,
      devTokenStatus,
      createdAtMs: typeof tokenData?.createdAtMs === 'number' ? tokenData.createdAtMs : prev?.createdAtMs,
      receivedAtMs,
    };
    tokenByAddress.set(addr, next);

    const cache = (window as any).__DAGOBANG_UNIFIED_TWITTER_CACHE__ ?? loadUnifiedTwitterCache();
    const list = Array.isArray(cache?.list) ? (cache.list as UnifiedTwitterSignal[]).slice() : [];
    if (!list.length) return;
    let changed = false;
    const updated = list.map((s) => {
      if (!s || !s.tokenAddress) return s;
      if (String(s.tokenAddress).toLowerCase() !== addr) return s;
      const merged = mergeTokenSnapshot(s, next);
      if (
        merged.chain !== s.chain ||
        merged.tokenSymbol !== s.tokenSymbol ||
        merged.tokenName !== s.tokenName ||
        merged.tokenLogo !== s.tokenLogo ||
        merged.marketCapUsd !== s.marketCapUsd ||
        merged.priceUsd !== s.priceUsd ||
        merged.liquidityUsd !== s.liquidityUsd ||
        merged.holders !== s.holders ||
        merged.devBuyRatio !== s.devBuyRatio ||
        merged.top10HoldRatio !== s.top10HoldRatio ||
        merged.devTokenStatus !== s.devTokenStatus ||
        merged.createdAtMs !== s.createdAtMs
      ) {
        changed = true;
        return { ...merged, ts: Date.now() };
      }
      return s;
    });
    if (!changed) return;
    saveUnifiedTwitterCache(updated);
    for (const s of updated) {
      if (!s?.tokenAddress) continue;
      if (String(s.tokenAddress).toLowerCase() !== addr) continue;
      window.dispatchEvent(new CustomEvent('dagobang-twitter-signal', { detail: s }));
      if (s.tweetType !== 'delete_post') void options.call({ type: 'gmgn:twitterSignal', payload: s });
    }
  };

  const extractTweetIdsFromMx = (mx: unknown): string[] => {
    if (typeof mx !== 'string') return [];
    const text = mx.trim();
    if (!text) return [];
    const ids = new Set<string>();
    for (const m of text.matchAll(/status\/(\d{6,})/gi)) {
      if (m[1]) ids.add(m[1]);
    }
    for (const m of text.matchAll(/\b(\d{10,})\b/g)) {
      if (m[1]) ids.add(m[1]);
    }
    return Array.from(ids);
  };

  const linkTokenToCachedSignalsByMx = (tokenData: any, mx: unknown, now: number) => {
    const addrRaw = typeof tokenData?.tokenAddress === 'string' ? tokenData.tokenAddress : null;
    if (!addrRaw) return;
    const addr = addrRaw.toLowerCase();
    const snap = tokenByAddress.get(addr);
    if (!snap) return;
    if (typeof mx !== 'string' || !mx.trim()) return;

    const ids = extractTweetIdsFromMx(mx);
    const cache = (window as any).__DAGOBANG_UNIFIED_TWITTER_CACHE__ ?? loadUnifiedTwitterCache();
    const list = Array.isArray(cache?.list) ? (cache.list as UnifiedTwitterSignal[]).slice() : [];
    if (!list.length) return;

    let changed = false;
    const updated = list.map((s) => {
      if (!s) return s;
      const hit =
        (s.tweetId && (mx.includes(s.tweetId) || ids.includes(s.tweetId))) ||
        (s.quotedTweetId && (mx.includes(s.quotedTweetId) || ids.includes(s.quotedTweetId)));
      if (!hit) return s;

      const merged = mergeTokenSnapshot({ ...s, tokenAddress: addr }, snap);
      if (
        merged.tokenAddress !== s.tokenAddress ||
        merged.chain !== s.chain ||
        merged.tokenSymbol !== s.tokenSymbol ||
        merged.tokenName !== s.tokenName ||
        merged.tokenLogo !== s.tokenLogo ||
        merged.marketCapUsd !== s.marketCapUsd ||
        merged.priceUsd !== s.priceUsd ||
        merged.liquidityUsd !== s.liquidityUsd ||
        merged.holders !== s.holders ||
        merged.devBuyRatio !== s.devBuyRatio ||
        merged.top10HoldRatio !== s.top10HoldRatio ||
        merged.devTokenStatus !== s.devTokenStatus ||
        merged.createdAtMs !== s.createdAtMs
      ) {
        changed = true;
        const next = { ...merged, ts: now };
        if (next.eventId) signalsByEventId.set(next.eventId, { signal: next, updatedAtMs: now });
        return next;
      }
      return s;
    });

    if (!changed) return;
    saveUnifiedTwitterCache(updated);
    for (const s of updated) {
      if (!s) continue;
      const hit =
        (s.tweetId && (mx.includes(s.tweetId) || ids.includes(s.tweetId))) ||
        (s.quotedTweetId && (mx.includes(s.quotedTweetId) || ids.includes(s.quotedTweetId)));
      if (!hit) continue;
      window.dispatchEvent(new CustomEvent('dagobang-twitter-signal', { detail: s }));
      if (s.tokenAddress && s.tweetType !== 'delete_post') void options.call({ type: 'gmgn:twitterSignal', payload: s });
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
      updateTokenSnapshot(tokenData, now);
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
        updateTokenSnapshot(tokenData, now);
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
    const inner =
      isObject(payload) && !('_v_ch' in payload) && (payload as any).data != null ? (payload as any).data : payload;
    const items = toArrayPayload(inner);
    const list = items.length ? items : [inner];
    for (const item of list) {
      const tokenData = normalizeTrenchesTokenData(item);
      if (!tokenData.tokenAddress) continue;
      const updateType = typeof (item as any)?._v_ch === 'string' ? String((item as any)._v_ch).trim().toLowerCase() : '';
      emitTrenchesTokenEvent(tokenData, now);
      updateTokenSnapshot(tokenData, now);
      if (updateType === 'social') {
        linkTokenToCachedSignalsByMx(tokenData, (item as any)?.m_x, now);
      }
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
    twitter_monitor_basic: (data, channel, payload, now) => {
      handleTwitterChannel(data, channel, payload, now);
    },
    twitter_monitor_token: (data, channel, payload, now) => {
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
