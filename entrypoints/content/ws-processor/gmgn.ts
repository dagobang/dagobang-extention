import type { BgRequest, BgResponse, Settings, UnifiedMarketSignal, UnifiedSignalToken, UnifiedTwitterSignal } from '@/types/extention';
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
  sourceTranslatedText?: string;
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

const buildTranslatedSourceText = (item: any): string | undefined => {
  const source = (payload: any): string | undefined => {
    if (typeof payload?.sc === 'string') return payload.sc;
    if (isObject(payload?.sc) && typeof payload.sc.t === 'string') return payload.sc.t;
    return undefined;
  };
  return source(item);
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
  const sourceTranslatedText = buildTranslatedSourceText(payload);
  const translationLang = typeof (payload as any).l === 'string' ? (payload as any).l : undefined;
  return {
    eventId,
    translatedText,
    sourceTranslatedText,
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
  const vol24hUsd = extractNumber(item, ['v24h']);
  const netBuy24hUsd = extractNumber(item, ['nba_24h']);
  const buyTx24h = extractNumber(item, ['b24h']);
  const sellTx24h = extractNumber(item, ['s24h']);
  const smartMoney = extractNumber(item, ['smt']);
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
    vol24hUsd: vol24hUsd ?? undefined,
    netBuy24hUsd: netBuy24hUsd ?? undefined,
    buyTx24h: buyTx24h ?? undefined,
    sellTx24h: sellTx24h ?? undefined,
    smartMoney: smartMoney ?? undefined,
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

const isWsMonitorEnabled = (): boolean => {
  const settings: Settings | null = (window as any).__DAGOBANG_SETTINGS__ ?? null;
  const enabled = (settings as any)?.autoTrade?.wsMonitorEnabled;
  if (typeof enabled === 'boolean') return enabled;
  return true;
};

const TWITTER_UNIFIED_CACHE_KEY = 'dagobang_unified_twitter_cache_v1';
const TWITTER_UNIFIED_CACHE_LIMIT = 50;
const TWITTER_UNIFIED_CACHE_PERSIST_DEBOUNCE_MS = 5000;
let pendingUnifiedTwitterCachePayload: { list: UnifiedTwitterSignal[]; ts: number } | null = null;
let pendingUnifiedTwitterCacheTimer: number | null = null;

const mergeUnifiedTwitterCacheList = (base: UnifiedTwitterSignal[], incoming: UnifiedTwitterSignal[]): UnifiedTwitterSignal[] => {
  const toOrderTs = (signal: UnifiedTwitterSignal): number => {
    const ts = typeof signal.ts === 'number' && Number.isFinite(signal.ts) ? signal.ts : 0;
    const recv = typeof signal.receivedAtMs === 'number' && Number.isFinite(signal.receivedAtMs) ? signal.receivedAtMs : 0;
    return Math.max(ts, recv);
  };
  const all = [...base, ...incoming];
  const byId = new Map<string, UnifiedTwitterSignal>();
  for (const s of all) {
    if (!s || typeof s.id !== 'string') continue;
    const prev = byId.get(s.id);
    if (!prev || toOrderTs(s) >= toOrderTs(prev)) byId.set(s.id, s);
  }
  const byEvent = new Map<string, UnifiedTwitterSignal>();
  for (const s of byId.values()) {
    const key = s.eventId ? `${s.site}:${s.eventId}` : `id:${s.id}`;
    const prev = byEvent.get(key);
    if (!prev || toOrderTs(s) >= toOrderTs(prev)) byEvent.set(key, s);
  }
  return Array.from(byEvent.values())
    .sort((a, b) => toOrderTs(a) - toOrderTs(b))
    .slice(-TWITTER_UNIFIED_CACHE_LIMIT);
};

const flushUnifiedTwitterCachePersist = () => {
  const payload = pendingUnifiedTwitterCachePayload;
  if (!payload) return;
  pendingUnifiedTwitterCachePayload = null;
  try {
    let persistedList: UnifiedTwitterSignal[] = [];
    try {
      const raw = window.localStorage.getItem(TWITTER_UNIFIED_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.list)) {
          persistedList = (parsed.list as UnifiedTwitterSignal[]).filter((x) => x && typeof (x as any).id === 'string');
        }
      }
    } catch {
    }
    const mergedList = mergeUnifiedTwitterCacheList(persistedList, payload.list);
    const mergedPayload = { list: mergedList, ts: Date.now() };
    (window as any).__DAGOBANG_UNIFIED_TWITTER_CACHE__ = mergedPayload;
    window.localStorage.setItem(TWITTER_UNIFIED_CACHE_KEY, JSON.stringify(mergedPayload));
  } catch {
  }
};

const scheduleUnifiedTwitterCachePersist = () => {
  if (pendingUnifiedTwitterCacheTimer != null) return;
  pendingUnifiedTwitterCacheTimer = window.setTimeout(() => {
    pendingUnifiedTwitterCacheTimer = null;
    flushUnifiedTwitterCachePersist();
  }, TWITTER_UNIFIED_CACHE_PERSIST_DEBOUNCE_MS);
};

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
  pendingUnifiedTwitterCachePayload = payload;
  scheduleUnifiedTwitterCachePersist();
};

const shouldKeepUnifiedSignal = (signal: UnifiedTwitterSignal) => {
  return Boolean(signal && typeof signal.id === 'string' && signal.id.trim());
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
  vol24hUsd?: number;
  netBuy24hUsd?: number;
  buyTx24h?: number;
  sellTx24h?: number;
  smartMoney?: number;
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
      vol24hUsd: (t as any).vol24hUsd,
      netBuy24hUsd: (t as any).netBuy24hUsd,
      buyTx24h: (t as any).buyTx24h,
      sellTx24h: (t as any).sellTx24h,
      smartMoney: (t as any).smartMoney,
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
    vol24hUsd: pickFiniteNumber((next as any).vol24hUsd, (prev as any).vol24hUsd),
    netBuy24hUsd: pickFiniteNumber((next as any).netBuy24hUsd, (prev as any).netBuy24hUsd),
    buyTx24h: pickFiniteNumber((next as any).buyTx24h, (prev as any).buyTx24h),
    sellTx24h: pickFiniteNumber((next as any).sellTx24h, (prev as any).sellTx24h),
    smartMoney: pickFiniteNumber((next as any).smartMoney, (prev as any).smartMoney),
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
    (mergedWithTimes as any).vol24hUsd === (prev as any).vol24hUsd &&
    (mergedWithTimes as any).netBuy24hUsd === (prev as any).netBuy24hUsd &&
    (mergedWithTimes as any).buyTx24h === (prev as any).buyTx24h &&
    (mergedWithTimes as any).sellTx24h === (prev as any).sellTx24h &&
    (mergedWithTimes as any).smartMoney === (prev as any).smartMoney &&
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
    vol24hUsd: snapshot.vol24hUsd,
    netBuy24hUsd: snapshot.netBuy24hUsd,
    buyTx24h: snapshot.buyTx24h,
    sellTx24h: snapshot.sellTx24h,
    smartMoney: snapshot.smartMoney,
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

const shouldForwardTwitterSignal = (signal: UnifiedTwitterSignal): boolean => signal.tweetType !== 'delete_post';

const snapshotToUnifiedToken = (snapshot: TokenSnapshot, now: number): UnifiedSignalToken => ({
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
  vol24hUsd: snapshot.vol24hUsd,
  netBuy24hUsd: snapshot.netBuy24hUsd,
  buyTx24h: snapshot.buyTx24h,
  sellTx24h: snapshot.sellTx24h,
  smartMoney: snapshot.smartMoney,
  devAddress: snapshot.devAddress,
  devHoldPercent: snapshot.devHoldPercent,
  devHasSold: snapshot.devHasSold,
  devBuyRatio: snapshot.devBuyRatio,
  top10HoldRatio: snapshot.top10HoldRatio,
  devTokenStatus: snapshot.devTokenStatus,
  createdAtMs: snapshot.createdAtMs,
  firstSeenAtMs: typeof snapshot.createdAtMs === 'number' && snapshot.createdAtMs > 0 ? snapshot.createdAtMs : snapshot.receivedAtMs,
  updatedAtMs: now,
});

const convertToUnifiedSignal = (channel: string, item: any, receivedAtMs: number): UnifiedTwitterSignal | null => {
  if (!item || typeof item !== 'object') return null;
  const extractedAtMs = extractTimestampMs(item);
  const actionAtMs = (() => {
    if (extractedAtMs == null || !Number.isFinite(extractedAtMs)) return receivedAtMs;
    const delta = Math.abs(receivedAtMs - extractedAtMs);
    return delta <= 2 * 60 * 1000 ? extractedAtMs : receivedAtMs;
  })();
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
  const sourceText = typeof sourceTextRaw === 'string' && sourceTextRaw.trim() ? sourceTextRaw : null;
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
  const hasSourceTweet = tweetType === 'quote' || tweetType === 'repost' || tweetType === 'reply';
  const quotedText = hasSourceTweet ? sourceText ?? undefined : undefined;
  const sourceMedia = extractMedia((item as any).sc);
  const quotedMedia = hasSourceTweet && sourceMedia.length ? sourceMedia : undefined;

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

  const legacyIdSeed =
    tweetId ??
    quotedTweetId ??
    (typeof (item as any).ti === 'string' ? (item as any).ti : null) ??
    null;
  const idSeed = (() => {
    if (eventId) return eventId;
    if (tweetType === 'tweet' && legacyIdSeed) return legacyIdSeed;
    return `${legacyIdSeed ?? 'event'}:${actionAtMs}`;
  })();
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
    quotedMedia,
    followedUserScreen,
    followedUserName,
    followedUserAvatar,
    followedUserBio,
    followedUserFollowers,
    tokens,
    receivedAtMs: actionAtMs,
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
  const SIGNAL_FORWARD_WINDOW_MS = 80;
  const MARKET_SIGNAL_FORWARD_WINDOW_MS = 80;
  const SIGNAL_FORWARD_FAST_WINDOW_MS = 0;
  const SIGNAL_FORWARD_PROBE_WINDOW_MS = 3000;
  type SignalForwardDedupeMode = 'strict' | 'balanced' | 'aggressive';
  type SignalForwardProbeWindow = {
    windowStartAt: number;
    received: number;
    dedupeOverwrite: number;
    enqueued: number;
    flushedSignals: number;
    flushes: number;
    callOk: number;
    callFail: number;
    callTotalMs: number;
    callMaxMs: number;
  };
  const cached = (window as any).__DAGOBANG_UNIFIED_TWITTER_CACHE__ ?? loadUnifiedTwitterCache();
  if (cached) (window as any).__DAGOBANG_UNIFIED_TWITTER_CACHE__ = cached;
  refreshUnifiedTwitterCache();
  const translationsByEventId = new Map<string, TwitterTranslationPatch>();
  const signalsByEventId = new Map<string, { signal: UnifiedTwitterSignal; updatedAtMs: number }>();
  const tokenByAddress = new Map<string, TokenSnapshot>();
  const pendingForwardByChannel = new Map<string, Map<string, UnifiedTwitterSignal>>();
  const forwardTimerByChannel = new Map<string, number>();
  const forwardQueueByChannel = new Map<string, Promise<void>>();
  const pendingMarketForwardByChannel = new Map<string, Map<string, UnifiedMarketSignal>>();
  const marketForwardTimerByChannel = new Map<string, number>();
  const marketForwardQueueByChannel = new Map<string, Promise<void>>();
  const createSignalForwardProbeWindow = (now: number): SignalForwardProbeWindow => ({
    windowStartAt: now,
    received: 0,
    dedupeOverwrite: 0,
    enqueued: 0,
    flushedSignals: 0,
    flushes: 0,
    callOk: 0,
    callFail: 0,
    callTotalMs: 0,
    callMaxMs: 0,
  });
  let signalForwardProbeWindow = createSignalForwardProbeWindow(Date.now());

  const resolveSignalForwardDedupeMode = (): SignalForwardDedupeMode => {
    const settingsRaw = ((window as any).__DAGOBANG_SETTINGS__ ?? null) as any;
    const settingsMode = typeof settingsRaw?.autoTrade?.signalForwardDedupeMode === 'string'
      ? settingsRaw.autoTrade.signalForwardDedupeMode.trim().toLowerCase()
      : '';
    const localOverride = (() => {
      try {
        const raw = window.localStorage.getItem('dagobang_signal_forward_dedupe_mode_v1');
        return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
      } catch {
        return '';
      }
    })();
    const mode = localOverride || settingsMode;
    if (mode === 'strict') return 'strict';
    if (mode === 'aggressive') return 'aggressive';
    return 'balanced';
  };

  const flushSignalForwardProbe = (now: number, dedupeMode: SignalForwardDedupeMode) => {
    const durationMs = now - signalForwardProbeWindow.windowStartAt;
    if (durationMs < SIGNAL_FORWARD_PROBE_WINDOW_MS) return;
    const output = {
      ...signalForwardProbeWindow,
      durationMs,
      dedupeMode,
      dedupeRate: signalForwardProbeWindow.received > 0
        ? signalForwardProbeWindow.dedupeOverwrite / signalForwardProbeWindow.received
        : 0,
      forwardRate: signalForwardProbeWindow.received > 0
        ? signalForwardProbeWindow.flushedSignals / signalForwardProbeWindow.received
        : 0,
      avgCallMs: signalForwardProbeWindow.callOk + signalForwardProbeWindow.callFail > 0
        ? signalForwardProbeWindow.callTotalMs / (signalForwardProbeWindow.callOk + signalForwardProbeWindow.callFail)
        : 0,
    };
    (window as any).__DAGOBANG_SIGNAL_FORWARD_PROBE__ = output;
    window.postMessage({ type: 'DAGOBANG_SIGNAL_FORWARD_PROBE', payload: output }, '*');
    signalForwardProbeWindow = createSignalForwardProbeWindow(now);
  };

  const resolveSignalForwardWindowMs = (channel: string): number => {
    const settingsRaw = ((window as any).__DAGOBANG_SETTINGS__ ?? null) as any;
    const cfg = Number((settingsRaw as any)?.autoTrade?.signalForwardWindowMs);
    if (Number.isFinite(cfg) && cfg >= 0) return Math.floor(cfg);
    const normalizedChannel = typeof channel === 'string' ? channel.trim() : '';
    if (normalizedChannel === 'twitter_monitor' || normalizedChannel === 'twitter_monitor_translation' || normalizedChannel === 'twitter_monitor_token') {
      return SIGNAL_FORWARD_FAST_WINDOW_MS;
    }
    return SIGNAL_FORWARD_WINDOW_MS;
  };

  const getSignalForwardKey = (signal: UnifiedTwitterSignal, dedupeMode: SignalForwardDedupeMode): string => {
    const values = [signal.id, signal.eventId, signal.tweetId, signal.quotedTweetId]
      .map((x) => (typeof x === 'string' ? x.trim() : ''))
      .filter(Boolean);
    if (values.length) return `${dedupeMode}:id:${values[0]}`;
    const tokenKey = Array.isArray(signal.tokens)
      ? signal.tokens
        .map((t) => (typeof t?.tokenAddress === 'string' ? t.tokenAddress.trim().toLowerCase() : ''))
        .find(Boolean) ?? ''
      : '';
    const userKey = typeof signal.userScreen === 'string' ? signal.userScreen.trim().toLowerCase() : '';
    const typeKey = typeof signal.tweetType === 'string' ? signal.tweetType.trim().toLowerCase() : '';
    const tsKey = typeof signal.ts === 'number' && Number.isFinite(signal.ts) ? String(signal.ts) : '';
    if (dedupeMode === 'strict') return `strict:fallback:${tokenKey}:${userKey}:${typeKey}:${tsKey}`;
    if (dedupeMode === 'aggressive') return `aggressive:fallback:${tokenKey}:${userKey}:${typeKey}`;
    const tsBucket = tsKey ? String(Math.floor(Number(tsKey) / SIGNAL_FORWARD_WINDOW_MS)) : '';
    return `balanced:fallback:${tokenKey}:${userKey}:${typeKey}:${tsBucket}`;
  };

  const flushForwardChannel = (channel: string) => {
    const map = pendingForwardByChannel.get(channel);
    if (!map || !map.size) return;
    const batch = Array.from(map.values());
    pendingForwardByChannel.delete(channel);
    signalForwardProbeWindow.flushes += 1;
    signalForwardProbeWindow.flushedSignals += batch.length;
    const prevQueue = forwardQueueByChannel.get(channel) ?? Promise.resolve();
    const nextQueue = prevQueue
      .then(async () => {
        for (const signal of batch) {
          const startedAt = performance.now();
          let ok = true;
          await options.call({ type: 'twitter:signal', payload: signal }).catch(() => {
            ok = false;
          });
          const elapsed = performance.now() - startedAt;
          signalForwardProbeWindow.callTotalMs += elapsed;
          if (elapsed > signalForwardProbeWindow.callMaxMs) signalForwardProbeWindow.callMaxMs = elapsed;
          if (ok) signalForwardProbeWindow.callOk += 1;
          else signalForwardProbeWindow.callFail += 1;
        }
      })
      .catch(() => { });
    forwardQueueByChannel.set(channel, nextQueue);
  };

  const enqueueSignalForward = (channel: string, signal: UnifiedTwitterSignal) => {
    const dedupeMode = resolveSignalForwardDedupeMode();
    const now = Date.now();
    const normalizedChannel = channel || 'twitter_monitor_basic';
    let map = pendingForwardByChannel.get(normalizedChannel);
    if (!map) {
      map = new Map<string, UnifiedTwitterSignal>();
      pendingForwardByChannel.set(normalizedChannel, map);
    }
    const key = getSignalForwardKey(signal, dedupeMode);
    signalForwardProbeWindow.received += 1;
    if (map.has(key)) signalForwardProbeWindow.dedupeOverwrite += 1;
    else signalForwardProbeWindow.enqueued += 1;
    map.set(key, signal);
    flushSignalForwardProbe(now, dedupeMode);
    if (forwardTimerByChannel.has(normalizedChannel)) return;
    const windowMs = resolveSignalForwardWindowMs(normalizedChannel);
    if (windowMs <= 0) {
      flushForwardChannel(normalizedChannel);
      flushSignalForwardProbe(Date.now(), resolveSignalForwardDedupeMode());
      return;
    }
    const timer = window.setTimeout(() => {
      forwardTimerByChannel.delete(normalizedChannel);
      flushForwardChannel(normalizedChannel);
      flushSignalForwardProbe(Date.now(), resolveSignalForwardDedupeMode());
    }, windowMs);
    forwardTimerByChannel.set(normalizedChannel, timer);
  };

  const getMarketForwardKey = (signal: UnifiedMarketSignal): string => {
    const firstAddr = Array.isArray(signal.tokens)
      ? signal.tokens.map((t) => (typeof t?.tokenAddress === 'string' ? t.tokenAddress.trim().toLowerCase() : '')).find(Boolean) ?? ''
      : '';
    const tsBucket = typeof signal.ts === 'number' && Number.isFinite(signal.ts)
      ? Math.floor(signal.ts / MARKET_SIGNAL_FORWARD_WINDOW_MS)
      : 0;
    return `${signal.source}:${firstAddr}:${tsBucket}`;
  };

  const flushMarketForwardChannel = (channel: string) => {
    const map = pendingMarketForwardByChannel.get(channel);
    if (!map || !map.size) return;
    const batch = Array.from(map.values());
    pendingMarketForwardByChannel.delete(channel);
    const prevQueue = marketForwardQueueByChannel.get(channel) ?? Promise.resolve();
    const nextQueue = prevQueue
      .then(async () => {
        for (const signal of batch) {
          await options.call({ type: 'market:signal', payload: signal }).catch(() => { });
        }
      })
      .catch(() => { });
    marketForwardQueueByChannel.set(channel, nextQueue);
  };

  const enqueueMarketSignalForward = (channel: string, signal: UnifiedMarketSignal) => {
    const normalizedChannel = channel || 'market_monitor';
    let map = pendingMarketForwardByChannel.get(normalizedChannel);
    if (!map) {
      map = new Map<string, UnifiedMarketSignal>();
      pendingMarketForwardByChannel.set(normalizedChannel, map);
    }
    map.set(getMarketForwardKey(signal), signal);
    if (marketForwardTimerByChannel.has(normalizedChannel)) return;
    const timer = window.setTimeout(() => {
      marketForwardTimerByChannel.delete(normalizedChannel);
      flushMarketForwardChannel(normalizedChannel);
    }, MARKET_SIGNAL_FORWARD_WINDOW_MS);
    marketForwardTimerByChannel.set(normalizedChannel, timer);
  };

  const emitMarketSignal = (input: {
    source: UnifiedMarketSignal['source'];
    channel: string;
    tokenAddress: string;
    chain?: string;
    receivedAtMs: number;
  }) => {
    const addr = normalizeTokenKey(input.tokenAddress);
    const snapshot = tokenByAddress.get(addr);
    if (!snapshot) return;
    const token = snapshotToUnifiedToken(snapshot, input.receivedAtMs);
    const signal: UnifiedMarketSignal = {
      id: `gmgn:${input.source}:${input.channel}:${addr}:${Math.floor(input.receivedAtMs / 1000)}`,
      site: 'gmgn',
      channel: input.channel,
      source: input.source,
      chain: input.chain ?? snapshot.chain,
      tokens: [token],
      receivedAtMs: input.receivedAtMs,
      ts: Date.now(),
    };
    enqueueMarketSignalForward(input.channel, signal);
  };

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
          quotedText: existing.signal.quotedText ?? patch.sourceTranslatedText ?? undefined,
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
        if (shouldForwardTwitterSignal(merged)) {
          enqueueSignalForward(channel, merged);
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
            quotedText: signal.quotedText ?? translation.sourceTranslatedText ?? undefined,
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
      if (shouldForwardTwitterSignal(signal)) {
        enqueueSignalForward(channel, signal);
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
    const vol24hUsd = pickFiniteNumber(
      typeof tokenData?.vol24hUsd === 'number'
        ? tokenData.vol24hUsd
        : preferDevMetrics
          ? extractNumber(tokenData, ['v24h'])
          : undefined,
      prev?.vol24hUsd,
    );
    const netBuy24hUsd = pickFiniteNumber(
      typeof tokenData?.netBuy24hUsd === 'number'
        ? tokenData.netBuy24hUsd
        : preferDevMetrics
          ? extractNumber(tokenData, ['nba_24h'])
          : undefined,
      prev?.netBuy24hUsd,
    );
    const buyTx24h = pickFiniteNumber(
      typeof tokenData?.buyTx24h === 'number'
        ? tokenData.buyTx24h
        : preferDevMetrics
          ? extractNumber(tokenData, ['b24h'])
          : undefined,
      prev?.buyTx24h,
    );
    const sellTx24h = pickFiniteNumber(
      typeof tokenData?.sellTx24h === 'number'
        ? tokenData.sellTx24h
        : preferDevMetrics
          ? extractNumber(tokenData, ['s24h'])
          : undefined,
      prev?.sellTx24h,
    );
    const smartMoney = pickFiniteNumber(
      typeof tokenData?.smartMoney === 'number'
        ? tokenData.smartMoney
        : preferDevMetrics
          ? extractNumber(tokenData, ['smt'])
          : undefined,
      prev?.smartMoney,
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
      vol24hUsd,
      netBuy24hUsd,
      buyTx24h,
      sellTx24h,
      smartMoney,
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
        if (shouldForwardTwitterSignal(s)) enqueueSignalForward('twitter_monitor_token', s);
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
    for (const s of updated) {
      if (!s) continue;
      const hit =
        (s.tweetId && (mx.includes(s.tweetId) || ids.includes(s.tweetId))) ||
        (s.quotedTweetId && (mx.includes(s.quotedTweetId) || ids.includes(s.quotedTweetId)));
      if (!hit) continue;
      if (isWsMonitorEnabled()) {
        window.dispatchEvent(new CustomEvent('dagobang-twitter-signal', { detail: s }));
        if (shouldForwardTwitterSignal(s)) enqueueSignalForward('twitter_monitor_token', s);
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
        emitMarketSignal({
          source: 'new_pool',
          channel,
          tokenAddress: tokenData.tokenAddress,
          chain: chain ? String(chain) : undefined,
          receivedAtMs: now,
        });
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
      emitMarketSignal({
        source: 'token_update',
        channel,
        tokenAddress: tokenData.tokenAddress,
        chain: tokenData.chain ? String(tokenData.chain) : undefined,
        receivedAtMs: now,
      });
      emitStatus();
    }
  };

  const handleOtherChannel = (_data: any, _channel: string, _payload: any, _now: number) => {
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
    const payload = data.payload ?? data;
    const now = Date.now();
    const processor = CHANNEL_PROCESSORS[channel] ?? handleOtherChannel;
    processor(data, channel, payload, now);
  };

  window.addEventListener('message', onMessage);
  const onPageHide = () => {
    if (pendingUnifiedTwitterCacheTimer != null) {
      window.clearTimeout(pendingUnifiedTwitterCacheTimer);
      pendingUnifiedTwitterCacheTimer = null;
    }
    flushUnifiedTwitterCachePersist();
  };
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('beforeunload', onPageHide);

  return {
    setQuickBuySettings: (_settings) => {
    },
    emitStatus,
    dispose: () => {
      window.clearInterval(statusTimer);
      for (const timer of forwardTimerByChannel.values()) {
        window.clearTimeout(timer);
      }
      forwardTimerByChannel.clear();
      for (const timer of marketForwardTimerByChannel.values()) {
        window.clearTimeout(timer);
      }
      marketForwardTimerByChannel.clear();
      for (const channel of pendingForwardByChannel.keys()) {
        flushForwardChannel(channel);
      }
      for (const channel of pendingMarketForwardByChannel.keys()) {
        flushMarketForwardChannel(channel);
      }
      flushSignalForwardProbe(Date.now(), resolveSignalForwardDedupeMode());
      window.removeEventListener('message', onMessage);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onPageHide);
      onPageHide();
    },
  };
}
