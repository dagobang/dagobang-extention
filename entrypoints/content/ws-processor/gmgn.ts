import type { AutoTradeInteractionType, BgRequest, BgResponse, Settings, UnifiedSignalToken, UnifiedTwitterSignal } from '@/types/extention';
import {
  asAddress,
  extractFirstFromObject,
  extractGmgnUserFields,
  extractMedia,
  extractNumber,
  extractText,
  extractTimestampMs,
  extractTokenAddress,
  extractTokenAddresses,
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
  const kol = extractNumber(item, ['kol']);
  const priceUsd = extractNumber(item, ['p']);
  const devHoldRatio = extractNumber(item, ['d_br']);
  const top10HoldRatio = extractNumber(item, ['t10']);
  const devTokenStatus = typeof item?.d_ts === 'string' ? item.d_ts.trim() : undefined;
  const tokenLogo = typeof item?.l === 'string' && item.l.trim() ? item.l.trim() : undefined;
  return {
    tokenAddress: address ?? undefined,
    marketCapUsd: marketCapUsd ?? undefined,
    liquidityUsd: liquidityUsd ?? undefined,
    holders: holders ?? undefined,
    kol: kol ?? undefined,
    priceUsd: priceUsd ?? undefined,
    createdAtMs: createdAtMs ?? undefined,
    devAddress: asAddress(item?.d_ct) ?? undefined,
    devHoldPercent: normalizePercentValue(devHoldRatio ?? null),
    devHasSold: typeof item?.d_ts === 'string' ? item.d_ts.toLowerCase().includes('sell') : undefined,
    devBuyRatio: devHoldRatio ?? undefined,
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

const isWsMonitorEnabled = (): boolean => {
  const settings: Settings | null = (window as any).__DAGOBANG_SETTINGS__ ?? null;
  const enabled = (settings as any)?.autoTrade?.wsMonitorEnabled;
  if (typeof enabled === 'boolean') return enabled;
  return true;
};

const getTwitterFilters = () => {
  const settings: Settings | null = (window as any).__DAGOBANG_SETTINGS__ ?? null;
  const enabled = isWsMonitorEnabled() && (settings?.autoTrade?.twitterSnipe?.enabled ?? true);
  const targets = (settings?.autoTrade?.twitterSnipe?.targetUsers ?? [])
    .map((x) => x.trim().replace(/^@/, '').toLowerCase())
    .filter(Boolean);
  const interactions = (settings?.autoTrade?.twitterSnipe?.interactionTypes ?? []).map((x) => String(x).toLowerCase());
  return { settings, enabled, targets, interactions };
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
  let nextSignal = signal;
  const cache = cacheList ? { list: cacheList } : (window as any).__DAGOBANG_UNIFIED_TWITTER_CACHE__ ?? loadUnifiedTwitterCache();
  if (!cacheList && cache && !(window as any).__DAGOBANG_UNIFIED_TWITTER_CACHE__) {
    (window as any).__DAGOBANG_UNIFIED_TWITTER_CACHE__ = cache;
  }
  const list = Array.isArray(cache?.list) ? (cache.list as UnifiedTwitterSignal[]).slice() : [];
  let minReceivedAtMs: number | null = null;
  const minTokenFirstSeenByAddr = new Map<string, number>();
  const recordExisting = (existing: UnifiedTwitterSignal) => {
    const recv = typeof (existing as any).receivedAtMs === 'number' ? (existing as any).receivedAtMs : null;
    const ts = typeof (existing as any).ts === 'number' ? (existing as any).ts : null;
    const base = recv ?? ts;
    if (base != null && Number.isFinite(base)) {
      minReceivedAtMs = minReceivedAtMs == null ? base : Math.min(minReceivedAtMs, base);
    }
    const tokens = Array.isArray((existing as any).tokens) ? ((existing as any).tokens as any[]) : [];
    for (const t of tokens) {
      const addrRaw = typeof t?.tokenAddress === 'string' ? String(t.tokenAddress).trim() : '';
      if (!addrRaw) continue;
      const key = addrRaw.toLowerCase();
      const firstSeen = typeof t?.firstSeenAtMs === 'number' && Number.isFinite(t.firstSeenAtMs) ? t.firstSeenAtMs : null;
      if (firstSeen == null || firstSeen <= 0) continue;
      const prev = minTokenFirstSeenByAddr.get(key);
      minTokenFirstSeenByAddr.set(key, prev != null ? Math.min(prev, firstSeen) : firstSeen);
    }
  };
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const it = list[i];
    if (!it) continue;
    if (it.id === nextSignal.id) {
      recordExisting(it);
      list.splice(i, 1);
    } else if (nextSignal.eventId && it.site === nextSignal.site && it.eventId === nextSignal.eventId) {
      recordExisting(it);
      list.splice(i, 1);
    }
  }
  if (minReceivedAtMs != null && Number.isFinite(minReceivedAtMs)) {
    const nextRecv = Math.min(nextSignal.receivedAtMs, minReceivedAtMs);
    if (nextRecv !== nextSignal.receivedAtMs) nextSignal = { ...nextSignal, receivedAtMs: nextRecv };
  }
  if (minTokenFirstSeenByAddr.size && Array.isArray(nextSignal.tokens) && nextSignal.tokens.length) {
    const nextTokens = (nextSignal.tokens as any[]).map((t) => {
      const addrRaw = typeof t?.tokenAddress === 'string' ? String(t.tokenAddress).trim() : '';
      if (!addrRaw) return t;
      const key = addrRaw.toLowerCase();
      const prevFirstSeen = minTokenFirstSeenByAddr.get(key);
      if (prevFirstSeen == null) return t;
      const curFirstSeen = typeof t?.firstSeenAtMs === 'number' && Number.isFinite(t.firstSeenAtMs) ? t.firstSeenAtMs : null;
      if (curFirstSeen == null || curFirstSeen <= 0) return { ...t, firstSeenAtMs: prevFirstSeen };
      const mergedFirstSeen = Math.min(prevFirstSeen, curFirstSeen);
      return mergedFirstSeen === curFirstSeen ? t : { ...t, firstSeenAtMs: mergedFirstSeen };
    });
    nextSignal = { ...nextSignal, tokens: nextTokens as any };
  }
  list.push(nextSignal);
  const next = list.slice(-TWITTER_UNIFIED_CACHE_LIMIT);
  saveUnifiedTwitterCache(next);
  if (isWsMonitorEnabled()) {
    window.dispatchEvent(new CustomEvent('dagobang-twitter-signal', { detail: nextSignal }));
  }
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
  kol?: number;
  devAddress?: string;
  devHoldPercent?: number;
  devHasSold?: boolean;
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

const normalizePercentValue = (v: number | null | undefined): number | undefined => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  if (v >= 0 && v <= 1) return v * 100;
  return v;
};

const normalizeTokenKey = (addr: string) => addr.trim().toLowerCase();

const normalizeSignalTokens = (signal: UnifiedTwitterSignal): UnifiedSignalToken[] => {
  const fromList = Array.isArray(signal.tokens)
    ? (signal.tokens as UnifiedSignalToken[]).filter((t) => t && typeof (t as any).tokenAddress === 'string' && (t as any).tokenAddress.trim())
    : [];
  if (fromList.length) {
    return fromList.map((t) => ({
      tokenAddress: String(t.tokenAddress),
      chain: t.chain,
      tokenSymbol: t.tokenSymbol,
      tokenName: t.tokenName,
      tokenLogo: t.tokenLogo,
      marketCapUsd: t.marketCapUsd,
      priceUsd: t.priceUsd,
      liquidityUsd: t.liquidityUsd,
      holders: t.holders,
      kol: (t as any).kol,
      devAddress: (t as any).devAddress,
      devHoldPercent: (t as any).devHoldPercent,
      devHasSold: (t as any).devHasSold,
      devBuyRatio: t.devBuyRatio,
      top10HoldRatio: t.top10HoldRatio,
      devTokenStatus: t.devTokenStatus,
      createdAtMs: t.createdAtMs,
      firstSeenAtMs: typeof (t as any).firstSeenAtMs === 'number' && (t as any).firstSeenAtMs > 0 ? (t as any).firstSeenAtMs : 0,
      updatedAtMs: typeof (t as any).updatedAtMs === 'number' ? (t as any).updatedAtMs : signal.ts,
    }));
  }
  return [];
};

const mergeTokenFields = (prev: UnifiedSignalToken, next: Partial<UnifiedSignalToken>, updatedAtMs: number): UnifiedSignalToken => {
  return {
    ...prev,
    chain: pickNonEmptyString(next.chain, prev.chain),
    tokenSymbol: pickNonEmptyString(next.tokenSymbol, prev.tokenSymbol),
    tokenName: pickNonEmptyString(next.tokenName, prev.tokenName),
    tokenLogo: pickNonEmptyString(next.tokenLogo, prev.tokenLogo),
    marketCapUsd: pickFiniteNumber(next.marketCapUsd, prev.marketCapUsd),
    priceUsd: pickFiniteNumber(next.priceUsd, prev.priceUsd),
    liquidityUsd: pickFiniteNumber(next.liquidityUsd, prev.liquidityUsd),
    holders: pickFiniteNumber(next.holders, prev.holders),
    kol: pickFiniteNumber((next as any).kol, (prev as any).kol),
    devAddress: pickNonEmptyString(next.devAddress, prev.devAddress),
    devHoldPercent: pickFiniteNumber(next.devHoldPercent, prev.devHoldPercent),
    devHasSold: typeof next.devHasSold === 'boolean' ? next.devHasSold : prev.devHasSold,
    devBuyRatio: pickFiniteNumber(next.devBuyRatio, prev.devBuyRatio),
    top10HoldRatio: pickFiniteNumber(next.top10HoldRatio, prev.top10HoldRatio),
    devTokenStatus: pickNonEmptyString(next.devTokenStatus, prev.devTokenStatus),
    createdAtMs: pickFiniteNumber(next.createdAtMs, prev.createdAtMs),
    updatedAtMs,
  };
};

const upsertSignalToken = (
  signal: UnifiedTwitterSignal,
  token: UnifiedSignalToken,
  updatedAtMs: number,
): { signal: UnifiedTwitterSignal; changed: boolean } => {
  const prevTokens = normalizeSignalTokens(signal);
  const key = normalizeTokenKey(token.tokenAddress);
  const idx = prevTokens.findIndex((t) => normalizeTokenKey(t.tokenAddress) === key);
  if (idx < 0) {
    const nextTokens = prevTokens.concat(token);
    const nextSignal: UnifiedTwitterSignal = { ...signal, tokens: nextTokens };
    return { signal: nextSignal, changed: true };
  }

  const prev = prevTokens[idx];
  const merged = mergeTokenFields(prev, token, updatedAtMs);
  const prevFirst = typeof prev.firstSeenAtMs === 'number' ? prev.firstSeenAtMs : 0;
  const nextFirst = typeof token.firstSeenAtMs === 'number' ? token.firstSeenAtMs : 0;
  const prevOk = prevFirst > 0;
  const nextOk = nextFirst > 0;
  const firstSeenAtMs = prevOk && nextOk ? Math.min(prevFirst, nextFirst) : prevOk ? prevFirst : nextOk ? nextFirst : 0;
  const mergedWithTimes: UnifiedSignalToken = { ...merged, firstSeenAtMs };

  const same =
    mergedWithTimes.chain === prev.chain &&
    mergedWithTimes.tokenSymbol === prev.tokenSymbol &&
    mergedWithTimes.tokenName === prev.tokenName &&
    mergedWithTimes.tokenLogo === prev.tokenLogo &&
    mergedWithTimes.marketCapUsd === prev.marketCapUsd &&
    mergedWithTimes.priceUsd === prev.priceUsd &&
    mergedWithTimes.liquidityUsd === prev.liquidityUsd &&
    mergedWithTimes.holders === prev.holders &&
    (mergedWithTimes as any).kol === (prev as any).kol &&
    mergedWithTimes.devAddress === (prev as any).devAddress &&
    mergedWithTimes.devHoldPercent === (prev as any).devHoldPercent &&
    mergedWithTimes.devHasSold === (prev as any).devHasSold &&
    mergedWithTimes.devBuyRatio === prev.devBuyRatio &&
    mergedWithTimes.top10HoldRatio === prev.top10HoldRatio &&
    mergedWithTimes.devTokenStatus === prev.devTokenStatus &&
    mergedWithTimes.createdAtMs === prev.createdAtMs &&
    mergedWithTimes.firstSeenAtMs === prev.firstSeenAtMs;
  if (same) return { signal, changed: false };

  const nextTokens = prevTokens.slice();
  nextTokens[idx] = mergedWithTimes;
  const nextSignal: UnifiedTwitterSignal = { ...signal, tokens: nextTokens };
  return { signal: nextSignal, changed: true };
};

const applySnapshotToSignal = (signal: UnifiedTwitterSignal, snapshot: TokenSnapshot, now: number): { signal: UnifiedTwitterSignal; changed: boolean } => {
  const baseToken: UnifiedSignalToken = {
    tokenAddress: snapshot.tokenAddress,
    chain: snapshot.chain,
    tokenSymbol: snapshot.tokenSymbol,
    tokenName: snapshot.tokenName,
    tokenLogo: snapshot.tokenLogo,
    marketCapUsd: snapshot.marketCapUsd,
    priceUsd: snapshot.priceUsd,
    liquidityUsd: snapshot.liquidityUsd,
    holders: snapshot.holders,
    kol: snapshot.kol,
    devAddress: snapshot.devAddress,
    devHoldPercent: snapshot.devHoldPercent,
    devHasSold: snapshot.devHasSold,
    devBuyRatio: snapshot.devBuyRatio,
    top10HoldRatio: snapshot.top10HoldRatio,
    devTokenStatus: snapshot.devTokenStatus,
    createdAtMs: snapshot.createdAtMs,
    firstSeenAtMs: typeof snapshot.createdAtMs === 'number' && snapshot.createdAtMs > 0 ? snapshot.createdAtMs : now,
    updatedAtMs: now,
  };
  return upsertSignalToken(signal, baseToken, now);
};

const applyKnownSnapshotsToSignal = (signal: UnifiedTwitterSignal, tokenByAddress: Map<string, TokenSnapshot>, now: number): UnifiedTwitterSignal => {
  let next = signal;
  for (const token of normalizeSignalTokens(signal)) {
    const addr = normalizeTokenKey(token.tokenAddress);
    const snap = tokenByAddress.get(addr);
    if (!snap) continue;
    const merged = applySnapshotToSignal(next, snap, now);
    next = merged.signal;
  }
  return next;
};

const summarizeTokensForLog = (signal: UnifiedTwitterSignal): string => {
  const tokens = normalizeSignalTokens(signal);
  if (!tokens.length) return '';
  const first = tokens[0]?.tokenAddress ?? '';
  if (tokens.length === 1) return first;
  return `${first}+${tokens.length - 1}`;
};

const signalHasTokens = (signal: UnifiedTwitterSignal): boolean => normalizeSignalTokens(signal).length > 0;

const convertToUnifiedSignal = (channel: string, item: any, receivedAtMs: number): UnifiedTwitterSignal | null => {
  if (!item || typeof item !== 'object') return null;
  const tweetAtMs = extractTimestampMs(item) ?? receivedAtMs;
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

  const tokenAddressesRaw = extractTokenAddresses(item, text ?? quotedText ?? null);
  const tokenAddresses = tokenAddressesRaw
    .map((addr) => (addr?.startsWith('0x') ? addr.toLowerCase() : addr))
    .filter((addr) => typeof addr === 'string' && addr.trim())
    .map((addr) => String(addr).trim());
  let tokens: UnifiedSignalToken[] | undefined = tokenAddresses.length
    ? tokenAddresses.map((addr) => ({ tokenAddress: addr, firstSeenAtMs: 0, updatedAtMs: receivedAtMs }))
    : undefined;
  const media = extractMedia(item);
  const tokenMeta = isObject((item as any).t) ? (item as any).t : null;
  const tokenMetaAddressRaw = tokenMeta ? extractTokenAddress(tokenMeta) ?? asAddress(tokenMeta?.a) : null;
  const tokenMetaAddress =
    tokenMetaAddressRaw && tokenMetaAddressRaw.startsWith('0x') ? tokenMetaAddressRaw.toLowerCase() : tokenMetaAddressRaw;

  if (!tokens?.length && tokenMetaAddress) {
    tokens = [{ tokenAddress: tokenMetaAddress, firstSeenAtMs: 0, updatedAtMs: receivedAtMs }];
  }

  if (tokens?.length) {
    const chain =
      (typeof (item as any).c === 'string' ? (item as any).c : null) ??
      (typeof (item as any).n === 'string' ? (item as any).n : null) ??
      (tokenMeta && typeof tokenMeta.c === 'string' ? tokenMeta.c : null) ??
      extractFirstFromObject(item, ['chain', 'chain_id', 'chainId']) ??
      undefined;
    const tokenSymbol = tokenMeta && typeof tokenMeta.s === 'string' ? tokenMeta.s : undefined;
    const tokenName = tokenMeta && typeof tokenMeta.nm === 'string' ? tokenMeta.nm : undefined;
    const tokenLogo = tokenMeta && typeof tokenMeta.l === 'string' ? tokenMeta.l : undefined;
    const marketCapUsd =
      extractNumber(tokenMeta, ['mc', 'market_cap', 'marketCap', 'marketCapUsd', 'market_cap_usd']) ??
      extractNumber(item, ['mc', 'market_cap', 'marketCap', 'marketCapUsd', 'market_cap_usd']) ??
      undefined;
    const priceUsd =
      extractNumber(tokenMeta, ['p', 'p1', 'price', 'priceUsd', 'price_usd']) ??
      extractNumber(item, ['p', 'p1', 'price', 'priceUsd', 'price_usd']) ??
      undefined;
    const liquidityUsd = extractNumber(item, ['lq', 'lqdt', 'liquidity', 'liquidityUsd', 'liquidity_usd']) ?? undefined;
    const holders = extractNumber(item, ['hd', 'holders', 'holderCount']) ?? undefined;
    const kol = extractNumber(item, ['kol']) ?? undefined;
    const createdAtMs = tokenMeta ? extractTimestampMs(tokenMeta) ?? undefined : undefined;

    const attach = (idx: number) => {
      tokens![idx] = {
        ...tokens![idx],
        chain,
        tokenSymbol,
        tokenName,
        tokenLogo,
        marketCapUsd,
        priceUsd,
        liquidityUsd,
        holders,
        kol,
        createdAtMs: createdAtMs ?? undefined,
        firstSeenAtMs:
          (typeof tokens![idx].firstSeenAtMs === 'number' && tokens![idx].firstSeenAtMs > 0) || createdAtMs == null
            ? tokens![idx].firstSeenAtMs
            : createdAtMs,
      };
    };

    if (tokenMetaAddress) {
      const key = normalizeTokenKey(tokenMetaAddress);
      const idx = tokens.findIndex((t) => normalizeTokenKey(t.tokenAddress) === key);
      if (idx >= 0) attach(idx);
      else if (tokens.length === 1) attach(0);
    } else if (tokens.length === 1) {
      attach(0);
    }
  }

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
    tokens,
    receivedAtMs: tweetAtMs,
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
    if (!isWsMonitorEnabled()) return;
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
        if (isWsMonitorEnabled()) {
          window.dispatchEvent(new CustomEvent('dagobang-twitter-signal', { detail: merged }));
        }
        wsStatus = { ...wsStatus, lastSignalAt: now, signalCount: wsStatus.signalCount + 1 };
        pushLog('signal', `${summarizeTokensForLog(merged)}${merged.tweetId ? ` #${merged.tweetId}` : ''} (translated)`);
        emitStatus();
        if (signalHasTokens(merged) && merged.tweetType !== 'delete_post') {
          void options.call({ type: 'twitter:signal', payload: merged }).catch(() => {});
        }
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
      signal = applyKnownSnapshotsToSignal(signal, tokenByAddress, now);
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
      pushLog('signal', `${summarizeTokensForLog(signal)}${signal.tweetId ? ` #${signal.tweetId}` : ''}`);
      emitStatus();
      if (signalHasTokens(signal) && signal.tweetType !== 'delete_post') {
        void options.call({ type: 'twitter:signal', payload: signal }).catch(() => {});
      }
    }
    emitStatus();
  };

  const updateTokenSnapshot = (tokenData: any, receivedAtMs: number) => {
    const addrRaw = typeof tokenData?.tokenAddress === 'string' ? tokenData.tokenAddress : null;
    if (!addrRaw) return;
    const addr = addrRaw.toLowerCase();
    const prev = tokenByAddress.get(addr);
    const vch = typeof tokenData?._v_ch === 'string' ? String(tokenData._v_ch).trim().toLowerCase() : '';
    const preferDevMetrics = vch === 'social' || vch === 'stat';
    const tokenSymbol = pickNonEmptyString(tokenData?.tokenSymbol ?? tokenData?.symbol ?? tokenData?.s, prev?.tokenSymbol);
    const tokenName = pickNonEmptyString(tokenData?.tokenName ?? tokenData?.name ?? tokenData?.nm ?? tokenData?.n, prev?.tokenName);
    const tokenLogo = pickNonEmptyString(tokenData?.tokenLogo ?? tokenData?.l ?? tokenData?.logo, prev?.tokenLogo);
    const devTokenStatus = pickNonEmptyString(tokenData?.devTokenStatus ?? tokenData?.d_ts, prev?.devTokenStatus);
    const devHoldPercent = (() => {
      const raw =
        typeof tokenData?.devHoldPercent === 'number'
          ? tokenData.devHoldPercent
          : preferDevMetrics
            ? extractNumber(tokenData, ['d_br'])
            : undefined;
      const next = normalizePercentValue(raw ?? null);
      return pickFiniteNumber(next, prev?.devHoldPercent);
    })();
    const devBuyRatio = pickFiniteNumber(
      typeof tokenData?.devBuyRatio === 'number'
        ? tokenData.devBuyRatio
        : preferDevMetrics
          ? extractNumber(tokenData, ['d_br'])
          : undefined,
      prev?.devBuyRatio,
    );
    const top10HoldRatio = pickFiniteNumber(
      typeof tokenData?.top10HoldRatio === 'number'
        ? tokenData.top10HoldRatio
        : preferDevMetrics
          ? extractNumber(tokenData, ['t10'])
          : undefined,
      prev?.top10HoldRatio,
    );
    const devHasSold =
      typeof tokenData?.devHasSold === 'boolean'
        ? tokenData.devHasSold
        : typeof devTokenStatus === 'string'
          ? devTokenStatus.toLowerCase().includes('sell') || devTokenStatus.toLowerCase().includes('close')
          : prev?.devHasSold;
    const next: TokenSnapshot = {
      tokenAddress: addr,
      chain: pickNonEmptyString(tokenData?.chain, prev?.chain),
      tokenSymbol,
      tokenName,
      tokenLogo,
      marketCapUsd: (() => {
        const v =
          typeof tokenData?.marketCapUsd === 'number'
            ? tokenData.marketCapUsd
            : typeof tokenData?.mc === 'number'
              ? tokenData.mc
              : null;
        if (v != null && Number.isFinite(v) && v >= 3000) return v;
        const p = typeof prev?.marketCapUsd === 'number' ? prev.marketCapUsd : null;
        return p != null && Number.isFinite(p) && p >= 3000 ? p : undefined;
      })(),
      priceUsd:
        typeof tokenData?.priceUsd === 'number'
          ? tokenData.priceUsd
          : typeof tokenData?.p === 'number'
            ? tokenData.p
            : prev?.priceUsd,
      liquidityUsd:
        typeof tokenData?.liquidityUsd === 'number'
          ? tokenData.liquidityUsd
          : typeof tokenData?.lqdt === 'number'
            ? tokenData.lqdt
            : prev?.liquidityUsd,
      holders: (() => {
        const next = typeof tokenData?.holders === 'number' ? tokenData.holders : prev?.holders;
        if (preferDevMetrics) return next;
        const prevH = typeof prev?.holders === 'number' ? prev.holders : null;
        return next === 0 && prevH != null && prevH > 0 ? prevH : next;
      })(),
      kol: (() => {
        const next = pickFiniteNumber(typeof tokenData?.kol === 'number' ? tokenData.kol : extractNumber(tokenData, ['kol']), prev?.kol);
        if (preferDevMetrics) return next;
        const prevK = typeof prev?.kol === 'number' ? prev.kol : null;
        return next === 0 && prevK != null && prevK > 0 ? prevK : next;
      })(),
      devAddress: pickNonEmptyString(tokenData?.devAddress ?? tokenData?.d_ct, prev?.devAddress),
      devHoldPercent,
      devHasSold,
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
      if (!s) return s;
      const has =
        Array.isArray((s as any).tokens) &&
        (s as any).tokens.some((t: any) => t && typeof t.tokenAddress === 'string' && normalizeTokenKey(t.tokenAddress) === addr);
      if (!has) return s;
      const merged = applySnapshotToSignal(s, next, receivedAtMs);
      if (!merged.changed) return s;
      changed = true;
      return { ...merged.signal, ts: Date.now() };
    });
    if (!changed) return;
    saveUnifiedTwitterCache(updated);
    for (const s of updated) {
      if (!s) continue;
      const has =
        Array.isArray((s as any).tokens) &&
        (s as any).tokens.some((t: any) => t && typeof t.tokenAddress === 'string' && normalizeTokenKey(t.tokenAddress) === addr);
      if (!has) continue;
      if (isWsMonitorEnabled()) {
        window.dispatchEvent(new CustomEvent('dagobang-twitter-signal', { detail: s }));
        if (signalHasTokens(s) && s.tweetType !== 'delete_post') void options.call({ type: 'twitter:signal', payload: s });
      }
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

      const merged = applySnapshotToSignal(s, snap, now);
      if (!merged.changed) return s;
      changed = true;
      const nextOut = { ...merged.signal, ts: now };
      if (nextOut.eventId) signalsByEventId.set(nextOut.eventId, { signal: nextOut, updatedAtMs: now });
      return nextOut;
    });

    if (!changed) return;
    saveUnifiedTwitterCache(updated);
    const { enabled } = getTwitterFilters();
    for (const s of updated) {
      if (!s) continue;
      const hit =
        (s.tweetId && (mx.includes(s.tweetId) || ids.includes(s.tweetId))) ||
        (s.quotedTweetId && (mx.includes(s.quotedTweetId) || ids.includes(s.quotedTweetId)));
      if (!hit) continue;
      if (isWsMonitorEnabled()) {
        window.dispatchEvent(new CustomEvent('dagobang-twitter-signal', { detail: s }));
        if (enabled && signalHasTokens(s) && s.tweetType !== 'delete_post') void options.call({ type: 'twitter:signal', payload: s });
      }
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
      }
    }
  };

  const handleTrenchesUpdateChannel = (data: any, channel: string, payload: any, now: number) => {
    const packetTs = typeof data.timestamp === 'number' ? data.timestamp : now;
    const latencyMs = computeLatencyMs(payload, packetTs, now);
    updatePacketStatus(channel, now, latencyMs);
    const wrapper = isObject(payload) ? (payload as any) : null;
    const wrapperUpdateTypeRaw = wrapper && typeof wrapper._v_ch === 'string' ? wrapper._v_ch : '';
    const wrapperUpdateType = typeof wrapperUpdateTypeRaw === 'string' ? String(wrapperUpdateTypeRaw).trim().toLowerCase() : '';
    const inner = wrapper && wrapper.data != null ? wrapper.data : payload;
    const items = toArrayPayload(inner);
    const list = items.length ? items : [inner];
    for (const item of list) {
      const tokenData = normalizeTrenchesTokenData(item);
      if (!tokenData.tokenAddress) continue;
      const updateTypeRaw = typeof (item as any)?._v_ch === 'string' ? (item as any)._v_ch : wrapperUpdateTypeRaw;
      const updateType = typeof updateTypeRaw === 'string' ? String(updateTypeRaw).trim().toLowerCase() : '';
      emitTrenchesTokenEvent(tokenData, now);
      updateTokenSnapshot(tokenData, now);
      const mx = (item as any)?.m_x ?? wrapper?.m_x;
      if (
        (typeof mx === 'string' && /status\/\d{6,}/i.test(mx)) ||
        (typeof mx === 'string' && mx.trim() && updateType.includes('social'))
      ) {
        linkTokenToCachedSignalsByMx(tokenData, mx, now);
      }
      wsStatus = {
        ...wsStatus,
        lastSignalAt: now,
        signalCount: wsStatus.signalCount + 1,
      };
      pushLog('signal', `trenches > ${tokenData.symbol || tokenData.tokenAddress} ${tokenData.marketCapUsd?.toFixed(2) || ''} ${tokenData.chain ? ` ${tokenData.chain}` : ''}`);
      emitStatus();
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
    if (!isWsMonitorEnabled()) return;
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
