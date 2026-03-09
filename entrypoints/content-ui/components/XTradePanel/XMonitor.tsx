import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Settings } from '@/types/extention';
import { normalizeLocale, t, type Locale } from '@/utils/i18n';
import { extractGmgnTweetText, extractGmgnUserFields } from '@/utils/gmgnWs';

type XMonitorPanelProps = {
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  settings: Settings | null;
};

type XMonitorContentProps = {
  active: boolean;
  settings: Settings | null;
};

type TweetEntry = {
  key: string;
  channel: string;
  eventId?: string;
  tweetId?: string;
  tsMs?: number;
  type?: string;
  userScreen?: string;
  userName?: string;
  userAvatar?: string;
  userFollowers?: number;
  followTargetScreen?: string;
  followTargetName?: string;
  followTargetAvatar?: string;
  followTargetBio?: string;
  followTargetFollowers?: number;
  quoteUserScreen?: string;
  quoteUserName?: string;
  quoteUserAvatar?: string;
  quoteTweetId?: string;
  quoteLink?: string;
  text?: string;
  translatedText?: string;
  sourceUrl?: string;
  matchKey?: string;
  updatedAtMs: number;
};

const parseNum = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
};

const formatAgeShort = (ts?: number) => {
  if (!ts) return '--';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
};

const formatCountShort = (value?: number) => {
  if (!value || !Number.isFinite(value)) return null;
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(value % 1_000_000_000 === 0 ? 0 : 1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}K`;
  return `${value}`;
};

const extractTweetIdFromUrl = (url?: string): string | undefined => {
  if (!url) return undefined;
  const match = url.match(/(?:status|statuses|i\/web\/status|i\/article)\/(\d+)/);
  if (match?.[1]) return match[1];
  const match2 = url.match(/\/(\d{10,})/);
  return match2?.[1];
};

const buildTranslatedText = (item: any): string | undefined => {
  const main =
    typeof item?.c === 'string'
      ? item.c
      : typeof item?.sat === 'string'
        ? item.sat
        : undefined;
  const title = typeof item?.satl === 'string' ? item.satl : undefined;
  if (!main && title) return title;
  if (main && title && !main.startsWith(title)) return `${title}\n${main}`;
  return main ?? undefined;
};

const extractReplyHandle = (text?: string) => {
  if (!text) return null;
  const match = text.match(/@([A-Za-z0-9_]{1,30})/);
  return match?.[1] ?? null;
};

const extractQuoteFields = (item: any) => {
  const sourceUser = item?.su;
  const quoteUserScreen = sourceUser && typeof sourceUser.s === 'string' ? sourceUser.s : undefined;
  const quoteUserName = sourceUser && typeof sourceUser.n === 'string' ? sourceUser.n : undefined;
  const quoteUserAvatar = sourceUser && typeof sourceUser.a === 'string' ? sourceUser.a : undefined;
  const quoteTweetId = typeof item?.si === 'string' ? item.si : undefined;
  const quoteLink =
    typeof item?.sc === 'string'
      ? item.sc
      : item?.sc && typeof item.sc.t === 'string'
        ? item.sc.t
        : quoteTweetId && quoteUserScreen
          ? `https://x.com/${quoteUserScreen}/status/${quoteTweetId}`
          : undefined;
  return { quoteUserScreen, quoteUserName, quoteUserAvatar, quoteTweetId, quoteLink };
};

const extractFollowTargetFields = (item: any) => {
  const target = item?.f?.f;
  if (!target || typeof target !== 'object') return {};
  const followTargetScreen = typeof target.s === 'string' ? target.s : undefined;
  const followTargetName = typeof target.n === 'string' ? target.n : undefined;
  const followTargetAvatar = typeof target.a === 'string' ? target.a : undefined;
  const followTargetBio = typeof target.d === 'string' ? target.d : undefined;
  const followTargetFollowers = typeof target.f === 'number' ? target.f : undefined;
  return { followTargetScreen, followTargetName, followTargetAvatar, followTargetBio, followTargetFollowers };
};

const getTypeMeta = (type?: string) => {
  const key = type?.toLowerCase();
  switch (key) {
    case 'tweet':
      return { label: '发推', className: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200' };
    case 'repost':
    case 'retweet':
      return { label: '转发', className: 'border-sky-500/40 bg-sky-500/15 text-sky-200' };
    case 'quote':
      return { label: '引用', className: 'border-amber-500/40 bg-amber-500/15 text-amber-200' };
    case 'reply':
      return { label: '回复', className: 'border-purple-500/40 bg-purple-500/15 text-purple-200' };
    case 'follow':
      return { label: '关注', className: 'border-rose-500/40 bg-rose-500/15 text-rose-200' };
    case 'unfollow':
      return { label: '取消关注', className: 'border-zinc-600 bg-zinc-800/70 text-zinc-300' };
    case 'like':
    case 'favorite':
      return { label: '点赞', className: 'border-pink-500/40 bg-pink-500/15 text-pink-200' };
    default:
      return key ? { label: key, className: 'border-zinc-700 bg-zinc-900 text-zinc-400' } : null;
  }
};

const normalizeTwitterItem = (channel: string, item: any): { key: string; patch: Partial<TweetEntry>; deleted: boolean } | null => {
  if (!item || typeof item !== 'object') return null;
  const eventId = typeof item.i === 'string' ? item.i : typeof item.ei === 'string' ? item.ei : undefined;
  const sourceUrl =
    typeof (item as any).sc === 'string'
      ? (item as any).sc
      : (item as any).sc && typeof (item as any).sc.t === 'string'
        ? (item as any).sc.t
        : undefined;
  const tweetId = typeof item.ti === 'string' ? item.ti : extractTweetIdFromUrl(sourceUrl);
  const key = eventId || tweetId;
  if (!key) return null;
  const twType = typeof item.tw === 'string' ? item.tw : undefined;
  const deleted = twType === 'delete_post' || twType === 'delete';
  const tsMs = (() => {
    const raw = parseNum(item.ts);
    if (raw == null) return undefined;
    return raw < 1e12 ? raw * 1000 : raw;
  })();
  const { userScreen, userName, userAvatar, userFollowers } = extractGmgnUserFields(item);
  const { followTargetScreen, followTargetName, followTargetAvatar, followTargetBio, followTargetFollowers } =
    extractFollowTargetFields(item);
  const { quoteUserScreen, quoteUserName, quoteUserAvatar, quoteTweetId, quoteLink } = extractQuoteFields(item);
  const matchKey = (() => {
    const sc = (item as any).sc;
    if (sc && typeof sc === 'object' && typeof (sc as any).t === 'string') return (sc as any).t;
    const sc2 = (item as any).sc_t;
    return typeof sc2 === 'string' ? sc2 : undefined;
  })();
  if (channel === 'twitter_monitor_translation') {
    const translatedText = buildTranslatedText(item);
    return {
      key,
      deleted,
      patch: {
        channel,
        eventId,
        tweetId,
        tsMs,
        translatedText,
        sourceUrl,
        updatedAtMs: Date.now(),
      },
    };
  }
  const text = extractGmgnTweetText(item) ?? undefined;
  return {
    key,
    deleted,
    patch: {
      channel,
      eventId,
      tweetId,
      tsMs,
      type: twType,
      userScreen,
      userName,
      userAvatar,
      userFollowers,
      followTargetScreen,
      followTargetName,
      followTargetAvatar,
      followTargetBio,
      followTargetFollowers,
      quoteUserScreen,
      quoteUserName,
      quoteUserAvatar,
      quoteTweetId,
      quoteLink,
      text,
      sourceUrl,
      matchKey,
      updatedAtMs: Date.now(),
    },
  };
};

const parseFilterNumber = (value: string | undefined | null): number | null => {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const tokenPassesFilters = (token: any, settings: Settings | null): boolean => {
  const filters = settings?.autoTrade?.twitterSnipe;
  if (!filters) return true;
  const mc = typeof token?.marketCapUsd === 'number' ? token.marketCapUsd : null;
  const holders = typeof token?.holders === 'number' ? token.holders : null;
  const createdAtMs = typeof token?.createdAtMs === 'number' ? token.createdAtMs : null;
  const devHold = typeof token?.devHoldPercent === 'number' ? token.devHoldPercent : null;
  const devHasSold = typeof token?.devHasSold === 'boolean' ? token.devHasSold : null;

  const minMcK = parseFilterNumber(filters.minMarketCapUsd);
  const maxMcK = parseFilterNumber(filters.maxMarketCapUsd);
  const minHoldersK = parseFilterNumber(filters.minHolders);
  const maxHoldersK = parseFilterNumber(filters.maxHolders);
  const minAge = parseFilterNumber(filters.minTokenAgeMinutes);
  const maxAge = parseFilterNumber(filters.maxTokenAgeMinutes);
  const minDev = parseFilterNumber(filters.minDevHoldPercent);
  const maxDev = parseFilterNumber(filters.maxDevHoldPercent);

  if (filters.blockIfDevSell && devHasSold === true) return false;

  if (minMcK != null) {
    if (mc == null) return false;
    if (mc < minMcK * 1000) return false;
  }
  if (maxMcK != null) {
    if (mc == null) return false;
    if (mc > maxMcK * 1000) return false;
  }
  if (minHoldersK != null) {
    if (holders == null) return false;
    if (holders < minHoldersK * 1000) return false;
  }
  if (maxHoldersK != null) {
    if (holders == null) return false;
    if (holders > maxHoldersK * 1000) return false;
  }
  if (minDev != null) {
    if (devHold == null) return false;
    if (devHold < minDev) return false;
  }
  if (maxDev != null) {
    if (devHold == null) return false;
    if (devHold > maxDev) return false;
  }
  const ageMinutes = createdAtMs != null ? (Date.now() - createdAtMs) / 60000 : null;
  if (minAge != null) {
    if (ageMinutes == null) return false;
    if (ageMinutes < minAge) return false;
  }
  if (maxAge != null) {
    if (ageMinutes == null) return false;
    if (ageMinutes > maxAge) return false;
  }
  return true;
};

export function XMonitorContent({
  active,
  settings,
}: XMonitorContentProps) {
  const locale: Locale = normalizeLocale(settings?.locale ?? 'zh_CN');
  const tt = (key: string, subs?: Array<string | number>) => t(key, locale, subs);

  const tweetsRef = useRef<Map<string, TweetEntry>>(new Map());
  const [tweetKeys, setTweetKeys] = useState<string[]>([]);
  const [tokensVersion, setTokensVersion] = useState(0);
  const [lastTokenAt, setLastTokenAt] = useState(0);
  const tokensByMatchKeyRef = useRef<Map<string, Map<string, any>>>(new Map());

  const [onlyWithTokens, setOnlyWithTokens] = useState(false);
  const [expandedTweets, setExpandedTweets] = useState<Record<string, boolean>>({});
  const listRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(520);
  const rowHeightsRef = useRef<Map<string, number>>(new Map());
  const [rowVersion, setRowVersion] = useState(0);

  useEffect(() => {
    const loadFromStorage = () => {
      try {
        const raw = window.localStorage.getItem('dagobang_twitter_cache_v1');
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.list)) return parsed;
      } catch {
      }
      return null;
    };
    const cached = (window as any).__DAGOBANG_TWITTER_CACHE__ ?? loadFromStorage();
    if (cached && !(window as any).__DAGOBANG_TWITTER_CACHE__) {
      (window as any).__DAGOBANG_TWITTER_CACHE__ = cached;
    }
    const list = Array.isArray(cached?.list) ? cached.list : [];
    if (!list.length) return;
    const map = tweetsRef.current;
    for (const entry of list) {
      const channel = typeof entry?.channel === 'string' ? entry.channel : '';
      if (
        channel !== 'twitter_user_monitor_basic' &&
        channel !== 'twitter_monitor_basic' &&
        channel !== 'twitter_monitor_translation'
      )
        continue;
      const normalized = normalizeTwitterItem(channel, entry.item);
      if (!normalized) continue;
      if (normalized.deleted) {
        map.delete(normalized.key);
      } else {
        const prev = map.get(normalized.key);
        const next: TweetEntry = {
          key: normalized.key,
          channel,
          updatedAtMs: Date.now(),
          ...(prev ?? ({} as any)),
          ...(normalized.patch as any),
        };
        map.set(normalized.key, next);
      }
    }
    const nextKeys = Array.from(map.values())
      .sort((a, b) => (b.tsMs ?? b.updatedAtMs) - (a.tsMs ?? a.updatedAtMs))
      .slice(0, 50)
      .map((x) => x.key);
    setTweetKeys(nextKeys);
  }, []);

  useEffect(() => {
    const onTwitter = (e: Event) => {
      const detail = (e as CustomEvent<any>).detail;
      if (!detail) return;
      const channel = typeof detail.channel === 'string' ? detail.channel : '';
      if (
        channel !== 'twitter_user_monitor_basic' &&
        channel !== 'twitter_monitor_basic' &&
        channel !== 'twitter_monitor_translation'
      )
        return;
      const normalized = normalizeTwitterItem(channel, detail.item);
      if (!normalized) return;
      const map = tweetsRef.current;
      if (normalized.deleted) {
        map.delete(normalized.key);
      } else {
        const prev = map.get(normalized.key);
        const next: TweetEntry = {
          key: normalized.key,
          channel,
          updatedAtMs: Date.now(),
          ...(prev ?? ({} as any)),
          ...(normalized.patch as any),
        };
        map.set(normalized.key, next);
      }
      const nextKeys = Array.from(map.values())
        .sort((a, b) => (b.tsMs ?? b.updatedAtMs) - (a.tsMs ?? a.updatedAtMs))
        .slice(0, 50)
        .map((x) => x.key);
      setTweetKeys(nextKeys);
    };
    window.addEventListener('dagobang-gmgn-twitter' as any, onTwitter as any);
    return () => {
      window.removeEventListener('dagobang-gmgn-twitter' as any, onTwitter as any);
    };
  }, []);

  useEffect(() => {
    const onToken = (e: Event) => {
      const detail = (e as CustomEvent<any>).detail;
      if (!detail) return;
      const token = detail.tokenData;
      if (!token || typeof token !== 'object') return;
      const matchKey = typeof (token as any).m_x === 'string' ? (token as any).m_x : null;
      const addr = typeof (token as any).tokenAddress === 'string' ? (token as any).tokenAddress : null;
      if (!matchKey || !addr) return;
      const map = tokensByMatchKeyRef.current;
      const bucket = map.get(matchKey) ?? new Map<string, any>();
      bucket.set(addr.toLowerCase(), token);
      map.set(matchKey, bucket);
      setTokensVersion((v) => v + 1);
      setLastTokenAt(Date.now());
    };
    window.addEventListener('dagobang-gmgn-trenches-token' as any, onToken as any);
    return () => {
      window.removeEventListener('dagobang-gmgn-trenches-token' as any, onToken as any);
    };
  }, []);

  const tweetList = useMemo(() => {
    const map = tweetsRef.current;
    return tweetKeys.map((k) => map.get(k)).filter(Boolean) as TweetEntry[];
  }, [tweetKeys]);

  const getAssociatedTokens = (tweet: TweetEntry) => {
    const tokens: any[] = [];
    if (tweet.matchKey) {
      const bucket = tokensByMatchKeyRef.current.get(tweet.matchKey);
      if (bucket) tokens.push(...Array.from(bucket.values()));
    }
    const caFromText = tweet.text?.match(/0x[a-fA-F0-9]{40}/g) ?? [];
    for (const addr of caFromText) {
      if (tokens.some((t) => String(t?.tokenAddress || '').toLowerCase() === addr.toLowerCase())) continue;
      tokens.push({ tokenAddress: addr.toLowerCase() });
    }
    const filtered = tokens.filter((t) => tokenPassesFilters(t, settings));
    const sorted = filtered.slice().sort((a, b) => {
      const amc = typeof a?.marketCapUsd === 'number' ? a.marketCapUsd : -1;
      const bmc = typeof b?.marketCapUsd === 'number' ? b.marketCapUsd : -1;
      return bmc - amc;
    });
    return sorted;
  };

  const visibleTweets = useMemo(() => {
    let list = tweetList.slice();
    const targets = (settings?.autoTrade?.twitterSnipe?.targetUsers ?? [])
      .map((x) => x.trim().replace(/^@/, '').toLowerCase())
      .filter(Boolean);
    if (targets.length) {
      list = list.filter((t) => {
        const screen = t.userScreen?.trim().replace(/^@/, '').toLowerCase();
        if (!screen) return false;
        return targets.includes(screen);
      });
    }
    if (!onlyWithTokens) return list;
    return list.filter((t) => getAssociatedTokens(t).length > 0);
  }, [tweetList, onlyWithTokens, settings, tokensVersion]);

  useEffect(() => {
    if (!listRef.current) return;
    const node = listRef.current;
    const onScroll = () => setScrollTop(node.scrollTop);
    onScroll();
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!listRef.current) return;
    const node = listRef.current;
    const ro = new ResizeObserver(() => {
      setViewportHeight(node.clientHeight);
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  const avgRowHeight = useMemo(() => {
    const values = Array.from(rowHeightsRef.current.values());
    if (!values.length) return 140;
    const sum = values.reduce((acc, v) => acc + v, 0);
    return Math.max(90, Math.round(sum / values.length));
  }, [rowVersion]);

  const virtualRange = useMemo(() => {
    const total = visibleTweets.length;
    if (!total) return { start: 0, end: 0, top: 0, bottom: 0 };
    const overscan = 6;
    const start = Math.max(0, Math.floor(scrollTop / avgRowHeight) - overscan);
    const end = Math.min(total, Math.ceil((scrollTop + viewportHeight) / avgRowHeight) + overscan);
    const top = start * avgRowHeight;
    const bottom = Math.max(0, total * avgRowHeight - end * avgRowHeight);
    return { start, end, top, bottom };
  }, [visibleTweets.length, scrollTop, viewportHeight, avgRowHeight]);

  const setRowRef = useCallback((key: string) => {
    return (node: HTMLDivElement | null) => {
      if (!node) return;
      const h = node.getBoundingClientRect().height;
      const prev = rowHeightsRef.current.get(key);
      if (prev !== h) {
        rowHeightsRef.current.set(key, h);
        setRowVersion((v) => v + 1);
      }
    };
  }, []);

  if (!active) return null;

  return (
    <>
      <div className="px-4 py-2 border-b border-zinc-800/60 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-[12px] text-zinc-300">
            <input
              type="checkbox"
              className="h-3 w-3 accent-emerald-500"
              checked={onlyWithTokens}
              onChange={(e) => setOnlyWithTokens(e.target.checked)}
            />
            只看有代币
          </label>
        </div>

        {!settings ? (
          <div className="text-[11px] text-zinc-500">{tt('contentUi.autoTradeStrategy.statusSettingsNotLoaded')}</div>
        ) : null}
        <div className="text-[11px] text-zinc-500">
          Token事件 {tokensVersion} / 最近 {formatAgeShort(lastTokenAt)}
        </div>
      </div>

      <div ref={listRef} className="max-h-[62vh] overflow-y-auto p-3">
        {visibleTweets.length === 0 ? (
          <div className="px-2 py-8 text-center text-[12px] text-zinc-500">暂无推文</div>
        ) : (
          <div>
            {virtualRange.top > 0 ? <div style={{ height: virtualRange.top }} /> : null}
            {visibleTweets.slice(virtualRange.start, virtualRange.end).map((tweet) => {
            const tokens = getAssociatedTokens(tweet);
            const expanded = !!expandedTweets[tweet.key];
            const shownTokens = expanded ? tokens : tokens.slice(0, 3);
            const timeText = formatAgeShort(tweet.tsMs ?? tweet.updatedAtMs);
            const displayName = tweet.userName || tweet.userScreen || 'Unknown';
            const handle = tweet.userScreen ? `@${tweet.userScreen}` : null;
            const followerText = formatCountShort(tweet.userFollowers);
            const typeMeta = getTypeMeta(tweet.type);
            const avatarFallback = displayName ? displayName.trim().charAt(0).toUpperCase() : '?';
            const link = tweet.sourceUrl
              ? tweet.sourceUrl
              : tweet.tweetId && tweet.userScreen
                ? `https://x.com/${tweet.userScreen}/status/${tweet.tweetId}`
                : tweet.tweetId
                  ? `https://x.com/i/web/status/${tweet.tweetId}`
                  : null;
            const replyHandle = tweet.type === 'reply' ? extractReplyHandle(tweet.text) : null;
            const quoteDisplayName = tweet.quoteUserName || tweet.quoteUserScreen || null;
            const quoteHandle = tweet.quoteUserScreen ? `@${tweet.quoteUserScreen}` : null;
            const quoteLink =
              tweet.quoteLink ??
              (tweet.quoteTweetId && tweet.quoteUserScreen
                ? `https://x.com/${tweet.quoteUserScreen}/status/${tweet.quoteTweetId}`
                : null);
            const quoteText = tweet.type === 'quote' ? tweet.text : null;
            const quoteTranslatedText = tweet.type === 'quote' ? tweet.translatedText : null;
            const followDisplayName = tweet.followTargetName || tweet.followTargetScreen || null;
            const followHandle = tweet.followTargetScreen ? `@${tweet.followTargetScreen}` : null;
            const followFollowers = formatCountShort(tweet.followTargetFollowers);
            return (
              <div key={tweet.key} ref={setRowRef(tweet.key)} className="rounded-xl border border-zinc-800 bg-zinc-950/30 p-3 mb-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-zinc-800 text-[12px] font-semibold text-zinc-300">
                      {tweet.userAvatar ? (
                        <img src={tweet.userAvatar} alt="" className="h-9 w-9 object-cover" loading="lazy" referrerPolicy="no-referrer" />
                      ) : (
                        <span>{avatarFallback}</span>
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <div className="truncate text-[13px] font-semibold text-zinc-100">{displayName}</div>
                        {handle ? <div className="truncate text-[12px] text-zinc-400">{handle}</div> : null}
                        {followerText ? <div className="text-[11px] text-zinc-500">{followerText}</div> : null}
                      </div>
                      {typeMeta ? (
                        <div className={`mt-1 inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] ${typeMeta.className}`}>
                          {typeMeta.label}
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-zinc-500">
                    <div>{timeText}</div>
                    {link ? (
                      <button
                        type="button"
                        className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
                        onClick={() => window.open(link, '_blank')}
                      >
                        ↗
                      </button>
                    ) : null}
                  </div>
                </div>

                {replyHandle ? (
                  <div className="mt-2 text-[12px] text-amber-300">
                    ↩ 回复 @{replyHandle}
                  </div>
                ) : null}

                {(tweet.type === 'follow' || tweet.type === 'unfollow') && (followDisplayName || tweet.followTargetBio) ? (
                  <div className="mt-2 rounded-lg border border-l-2 border-emerald-500/60 border-zinc-800 bg-zinc-900/50 px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-zinc-800 text-[10px] font-semibold text-zinc-300">
                          {tweet.followTargetAvatar ? (
                            <img src={tweet.followTargetAvatar} alt="" className="h-8 w-8 object-cover" loading="lazy" referrerPolicy="no-referrer" />
                          ) : (
                            <span>{followDisplayName ? followDisplayName.trim().charAt(0).toUpperCase() : '?'}</span>
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            {followDisplayName ? (
                              <div className="truncate text-[12px] font-semibold text-zinc-100">{followDisplayName}</div>
                            ) : null}
                            {followHandle ? <div className="truncate text-[11px] text-zinc-400">{followHandle}</div> : null}
                            {followFollowers ? <div className="text-[11px] text-zinc-500">{followFollowers}</div> : null}
                          </div>
                          <div className="text-[11px] text-zinc-500">{tweet.type === 'follow' ? '被关注账号' : '被取消关注账号'}</div>
                        </div>
                      </div>
                    </div>
                    {tweet.followTargetBio ? (
                      <div className="mt-2 text-[12px] text-zinc-300 whitespace-pre-wrap break-words">
                        {tweet.followTargetBio}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {tweet.type === 'quote' && (quoteDisplayName || quoteLink) ? (
                  <div className="mt-2 rounded-lg border border-l-2 border-amber-500/60 border-zinc-800 bg-zinc-900/50 px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-zinc-800 text-[10px] font-semibold text-zinc-300">
                          {tweet.quoteUserAvatar ? (
                            <img src={tweet.quoteUserAvatar} alt="" className="h-7 w-7 object-cover" loading="lazy" referrerPolicy="no-referrer" />
                          ) : (
                            <span>{quoteDisplayName ? quoteDisplayName.trim().charAt(0).toUpperCase() : '?'}</span>
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            {quoteDisplayName ? (
                              <div className="truncate text-[12px] font-semibold text-zinc-100">{quoteDisplayName}</div>
                            ) : null}
                            {quoteHandle ? <div className="truncate text-[11px] text-zinc-400">{quoteHandle}</div> : null}
                          </div>
                          <div className="text-[11px] text-zinc-500">引用推文</div>
                        </div>
                      </div>
                      {quoteLink ? (
                        <button
                          type="button"
                          className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
                          onClick={() => window.open(quoteLink, '_blank')}
                        >
                          ↗
                        </button>
                      ) : null}
                    </div>
                    {quoteText ? (
                      <div className="mt-2 whitespace-pre-wrap break-words text-[12px] text-zinc-200">
                        {quoteText}
                      </div>
                    ) : null}
                    {quoteTranslatedText ? (
                      <div className="mt-2 rounded-md border border-zinc-800 bg-zinc-950/40 px-2 py-1">
                        <div className="text-[10px] text-zinc-500">翻译</div>
                        <div className="mt-1 whitespace-pre-wrap break-words text-[11px] text-zinc-200">
                          {quoteTranslatedText}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {tweet.text && tweet.type !== 'quote' ? (
                  <div className="mt-2">
                    {link ? (
                      <button
                        type="button"
                        className="text-[11px] text-sky-400 hover:text-sky-300"
                        onClick={() => window.open(link, '_blank')}
                      >
                        原文
                      </button>
                    ) : (
                      <div className="text-[11px] text-sky-400">原文</div>
                    )}
                    <div className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-zinc-100">
                      {tweet.text}
                    </div>
                  </div>
                ) : null}

                {tweet.translatedText && tweet.type !== 'quote' ? (
                  <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
                    <div className="text-[10px] text-zinc-500">翻译</div>
                    <div className="mt-1 whitespace-pre-wrap break-words text-[12px] text-zinc-200">
                      {tweet.translatedText}
                    </div>
                  </div>
                ) : null}

                <div className="mt-3 flex items-center justify-between gap-2">
                  <div className="text-[11px] text-zinc-500">关联代币：{tokens.length}</div>
                  {tokens.length > 3 ? (
                    <button
                      type="button"
                      className="text-[11px] text-zinc-400 hover:text-zinc-200"
                      onClick={() => setExpandedTweets((prev) => ({ ...prev, [tweet.key]: !prev[tweet.key] }))}
                    >
                      {expanded ? '收起' : '更多'}
                    </button>
                  ) : null}
                </div>

                {shownTokens.length ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {shownTokens.map((tok) => {
                      const addr = typeof tok?.tokenAddress === 'string' ? tok.tokenAddress : '';
                      const sym = typeof tok?.symbol === 'string' ? tok.symbol : null;
                      const mc = typeof tok?.marketCapUsd === 'number' ? tok.marketCapUsd : null;
                      const mcText = mc != null ? `$${Math.round(mc).toLocaleString()}` : '--';
                      const label = sym ? `${sym} ${mcText}` : `${addr.slice(0, 6)}...${addr.slice(-4)} ${mcText}`;
                      return (
                        <button
                          key={`${tweet.key}:${addr}`}
                          type="button"
                          className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-800"
                          onClick={() => {
                            if (!addr) return;
                            window.open(`https://gmgn.ai/token/${addr}`, '_blank');
                          }}
                          title={addr}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="mt-2 text-[11px] text-zinc-600">无匹配代币</div>
                )}
              </div>
            );
          })}
            {virtualRange.bottom > 0 ? <div style={{ height: virtualRange.bottom }} /> : null}
          </div>
        )}
      </div>
    </>
  );
}

export function XMonitorPanel({
  visible,
  onVisibleChange,
  settings,
}: XMonitorPanelProps) {
  if (!visible) return null;

  return (
    <div
      className="fixed right-4 top-32 z-[2147483647] w-[360px] select-none rounded-xl border border-zinc-800 bg-[#0F0F11] text-zinc-100 shadow-xl shadow-emerald-500/20 font-sans"
    >
      <div
        className="flex items-center justify-between gap-3 px-4 py-3 border-b border-zinc-800/60"
      >
        <div className="text-xs font-semibold text-emerald-300">推特监控</div>
        <button className="text-zinc-400 hover:text-zinc-200" onClick={() => onVisibleChange(false)}>
          <X size={16} />
        </button>
      </div>
      <XMonitorContent
        active={visible}
        settings={settings}
      />
    </div>
  );
}
