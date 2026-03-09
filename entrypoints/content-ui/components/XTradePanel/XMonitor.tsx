import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import type { Settings, UnifiedTwitterSignal } from '@/types/extention';
import { normalizeLocale, t, type Locale } from '@/utils/i18n';

type XMonitorPanelProps = {
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  settings: Settings | null;
};

type XMonitorContentProps = {
  active: boolean;
  settings: Settings | null;
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

const extractReplyHandle = (text?: string) => {
  if (!text) return null;
  const match = text.match(/@([A-Za-z0-9_]{1,30})/);
  return match?.[1] ?? null;
};

const stripTrailingPunctuation = (value: string): { core: string; trailing: string } => {
  const match = value.match(/^(.+?)([)\].,!?;:'"]+)$/);
  if (!match) return { core: value, trailing: '' };
  return { core: match[1], trailing: match[2] };
};

const renderLinkified = (text: string, keyPrefix: string, className?: string): ReactNode => {
  const re = /https?:\/\/[^\s]+|@[A-Za-z0-9_]{1,30}/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null = null;
  let part = 0;
  while ((m = re.exec(text))) {
    const start = m.index;
    const raw = m[0];
    if (start > lastIndex) {
      nodes.push(<span key={`${keyPrefix}:t:${part++}`} className={className}>{text.slice(lastIndex, start)}</span>);
    }
    if (raw.startsWith('http')) {
      const { core, trailing } = stripTrailingPunctuation(raw);
      nodes.push(
        <a
          key={`${keyPrefix}:u:${part++}`}
          className={`text-sky-400 hover:text-sky-300 underline underline-offset-2 ${className ?? ''}`}
          href={core}
          target="_blank"
          rel="noreferrer"
        >
          {core}
        </a>,
      );
      if (trailing) nodes.push(<span key={`${keyPrefix}:p:${part++}`} className={className}>{trailing}</span>);
    } else if (raw.startsWith('@')) {
      const handle = raw.slice(1);
      nodes.push(
        <a
          key={`${keyPrefix}:h:${part++}`}
          className={`text-sky-400 hover:text-sky-300 underline underline-offset-2 ${className ?? ''}`}
          href={`https://x.com/${handle}`}
          target="_blank"
          rel="noreferrer"
        >
          {raw}
        </a>,
      );
    } else {
      nodes.push(<span key={`${keyPrefix}:x:${part++}`} className={className}>{raw}</span>);
    }
    lastIndex = start + raw.length;
  }
  if (lastIndex < text.length) {
    nodes.push(<span key={`${keyPrefix}:t:${part++}`} className={className}>{text.slice(lastIndex)}</span>);
  }
  return nodes;
};

const renderRichText = (text?: string | null, keyPrefix = 'rt'): ReactNode => {
  if (!text) return null;
  const s = String(text);
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let seg = 0;

  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch !== '"' && ch !== "'") continue;
    const end = s.indexOf(ch, i + 1);
    if (end <= i + 1) continue;

    const before = s.slice(cursor, i);
    if (before) {
      nodes.push(<span key={`${keyPrefix}:n:${seg++}`}>{renderLinkified(before, `${keyPrefix}:n:${seg}`)}</span>);
    }
    const quoted = s.slice(i, end + 1);
    nodes.push(
      <span key={`${keyPrefix}:q:${seg++}`} className="text-emerald-300">
        {renderLinkified(quoted, `${keyPrefix}:q:${seg}`, 'text-emerald-300')}
      </span>,
    );
    cursor = end + 1;
    i = end;
  }

  const tail = s.slice(cursor);
  if (tail) nodes.push(<span key={`${keyPrefix}:tail`}>{renderLinkified(tail, `${keyPrefix}:tail`)}</span>);
  return nodes;
};

const getTypeMeta = (type?: UnifiedTwitterSignal['tweetType']) => {
  const key = type;
  switch (key) {
    case 'tweet':
      return { label: '发推', className: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200' };
    case 'repost':
      return { label: '转发', className: 'border-sky-500/40 bg-sky-500/15 text-sky-200' };
    case 'quote':
      return { label: '引用', className: 'border-amber-500/40 bg-amber-500/15 text-amber-200' };
    case 'reply':
      return { label: '回复', className: 'border-purple-500/40 bg-purple-500/15 text-purple-200' };
    case 'delete_post':
      return { label: '删除推文', className: 'border-red-500/40 bg-red-500/15 text-red-200' };
    case 'follow':
      return { label: '关注', className: 'border-rose-500/40 bg-rose-500/15 text-rose-200' };
    case 'unfollow':
      return { label: '取消关注', className: 'border-zinc-600 bg-zinc-800/70 text-zinc-300' };
    default:
      return key ? { label: key, className: 'border-zinc-700 bg-zinc-900 text-zinc-400' } : null;
  }
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
    if (mc < minMcK) return false;
  }
  if (maxMcK != null) {
    if (mc == null) return false;
    if (mc > maxMcK) return false;
  }
  if (minHoldersK != null) {
    if (holders == null) return false;
    if (holders < minHoldersK) return false;
  }
  if (maxHoldersK != null) {
    if (holders == null) return false;
    if (holders > maxHoldersK) return false;
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
  const resolvedSettings = useMemo<Settings | null>(() => {
    if (settings) return settings;
    return (window as any).__DAGOBANG_SETTINGS__ ?? null;
  }, [settings]);
  const locale: Locale = normalizeLocale(resolvedSettings?.locale ?? 'zh_CN');
  const tt = (key: string, subs?: Array<string | number>) => t(key, locale, subs);

  const signalsRef = useRef<Map<string, UnifiedTwitterSignal>>(new Map());
  const [signalIds, setSignalIds] = useState<string[]>([]);
  const [onlyWithTokens, setOnlyWithTokens] = useState(false);

  const listRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(520);
  const rowHeightsRef = useRef<Map<string, number>>(new Map());
  const [rowVersion, setRowVersion] = useState(0);

  useEffect(() => {
    const loadFromStorage = () => {
      try {
        const raw = window.localStorage.getItem('dagobang_unified_twitter_cache_v1');
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.list)) return parsed;
      } catch {
      }
      return null;
    };

    const cached = (window as any).__DAGOBANG_UNIFIED_TWITTER_CACHE__ ?? loadFromStorage();
    if (cached && !(window as any).__DAGOBANG_UNIFIED_TWITTER_CACHE__) {
      (window as any).__DAGOBANG_UNIFIED_TWITTER_CACHE__ = cached;
    }
    const list = Array.isArray(cached?.list) ? cached.list : [];
    if (!list.length) return;

    const map = signalsRef.current;
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const id = typeof (entry as any).id === 'string' ? (entry as any).id : null;
      if (!id) continue;
      map.set(id, entry as UnifiedTwitterSignal);
    }
    const nextIds = Array.from(map.values())
      .sort((a, b) => (b.receivedAtMs ?? b.ts) - (a.receivedAtMs ?? a.ts))
      .slice(0, 50)
      .map((x) => x.id);
    setSignalIds(nextIds);
  }, []);

  useEffect(() => {
    const onSignal = (e: Event) => {
      const signal = (e as CustomEvent<any>).detail as UnifiedTwitterSignal | null;
      if (!signal || typeof signal !== 'object') return;
      if (typeof (signal as any).id !== 'string') return;
      const map = signalsRef.current;
      map.set(signal.id, signal);
      const nextIds = Array.from(map.values())
        .sort((a, b) => (b.receivedAtMs ?? b.ts) - (a.receivedAtMs ?? a.ts))
        .slice(0, 50)
        .map((x) => x.id);
      setSignalIds(nextIds);
    };
    window.addEventListener('dagobang-twitter-signal' as any, onSignal as any);
    return () => window.removeEventListener('dagobang-twitter-signal' as any, onSignal as any);
  }, []);

  const signalList = useMemo(() => {
    const map = signalsRef.current;
    return signalIds.map((id) => map.get(id)).filter(Boolean) as UnifiedTwitterSignal[];
  }, [signalIds]);

  const visibleSignals = useMemo(() => {
    if (!onlyWithTokens) return signalList;
    return signalList.filter((s) => !!s.tokenAddress && tokenPassesFilters(s, resolvedSettings));
  }, [signalList, onlyWithTokens, resolvedSettings]);

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
    const ro = new ResizeObserver(() => setViewportHeight(node.clientHeight));
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
    const total = visibleSignals.length;
    if (!total) return { start: 0, end: 0, top: 0, bottom: 0 };
    const overscan = 6;
    const start = Math.max(0, Math.floor(scrollTop / avgRowHeight) - overscan);
    const end = Math.min(total, Math.ceil((scrollTop + viewportHeight) / avgRowHeight) + overscan);
    const top = start * avgRowHeight;
    const bottom = Math.max(0, total * avgRowHeight - end * avgRowHeight);
    return { start, end, top, bottom };
  }, [visibleSignals.length, scrollTop, viewportHeight, avgRowHeight]);

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

        {!resolvedSettings ? (
          <div className="text-[11px] text-zinc-500">{tt('contentUi.autoTradeStrategy.statusSettingsNotLoaded')}</div>
        ) : null}
      </div>

      <div ref={listRef} className="max-h-[62vh] overflow-y-auto p-3">
        {visibleSignals.length === 0 ? (
          <div className="px-2 py-8 text-center text-[12px] text-zinc-500">暂无推文</div>
        ) : (
          <div>
            {virtualRange.top > 0 ? <div style={{ height: virtualRange.top }} /> : null}
            {visibleSignals.slice(virtualRange.start, virtualRange.end).map((signal) => {
              const timeText = formatAgeShort(signal.receivedAtMs ?? signal.ts);
              const displayName = signal.userName || signal.userScreen || 'Unknown';
              const handle = signal.userScreen ? `@${signal.userScreen}` : null;
              const followerText = formatCountShort(signal.userFollowers);
              const typeMeta = getTypeMeta(signal.tweetType);
              const avatarFallback = displayName ? displayName.trim().charAt(0).toUpperCase() : '?';

              const tweetLink = signal.tweetId
                ? signal.userScreen
                  ? `https://x.com/${signal.userScreen}/status/${signal.tweetId}`
                  : `https://x.com/i/web/status/${signal.tweetId}`
                : null;
              const quotedLink =
                signal.quotedTweetId && signal.quotedUserScreen
                  ? `https://x.com/${signal.quotedUserScreen}/status/${signal.quotedTweetId}`
                  : signal.quotedTweetId
                    ? `https://x.com/i/web/status/${signal.quotedTweetId}`
                    : null;
              const link = signal.tweetType === 'repost' ? quotedLink ?? tweetLink : tweetLink ?? quotedLink;

              const replyHandle = signal.tweetType === 'reply' ? extractReplyHandle(signal.text) : null;

              const quoteDisplayName = signal.quotedUserName || signal.quotedUserScreen || null;
              const quoteHandle = signal.quotedUserScreen ? `@${signal.quotedUserScreen}` : null;

              const followDisplayName = signal.followedUserName || signal.followedUserScreen || null;
              const followHandle = signal.followedUserScreen ? `@${signal.followedUserScreen}` : null;
              const followFollowers = formatCountShort(signal.followedUserFollowers);

              const tokenAddr = typeof signal.tokenAddress === 'string' ? signal.tokenAddress : null;
              const mc = typeof signal.marketCapUsd === 'number' ? signal.marketCapUsd : null;
              const holders = typeof signal.holders === 'number' ? signal.holders : null;

              return (
                <div
                  key={signal.id}
                  ref={setRowRef(signal.id)}
                  className="rounded-xl border border-zinc-800 bg-zinc-950/30 p-3 mb-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-zinc-800 text-[12px] font-semibold text-zinc-300">
                        {signal.userAvatar ? (
                          <img
                            src={signal.userAvatar}
                            alt=""
                            className="h-9 w-9 object-cover"
                            loading="lazy"
                            referrerPolicy="no-referrer"
                          />
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
                          <div
                            className={`mt-1 inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] ${typeMeta.className}`}
                          >
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
                    <div className="mt-2 text-[12px] text-amber-300">↩ 回复 @{replyHandle}</div>
                  ) : null}

                  {followDisplayName && (signal.tweetType === 'follow' || signal.tweetType === 'unfollow') ? (
                    <div className="mt-2 rounded-lg border border-l-2 border-emerald-500/60 border-zinc-800 bg-zinc-900/50 px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-zinc-800 text-[10px] font-semibold text-zinc-300">
                            {signal.followedUserAvatar ? (
                              <img
                                src={signal.followedUserAvatar}
                                alt=""
                                className="h-8 w-8 object-cover"
                                loading="lazy"
                                referrerPolicy="no-referrer"
                              />
                            ) : (
                              <span>{followDisplayName.trim().charAt(0).toUpperCase()}</span>
                            )}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <div className="truncate text-[12px] font-semibold text-zinc-100">{followDisplayName}</div>
                              {followHandle ? <div className="truncate text-[11px] text-zinc-400">{followHandle}</div> : null}
                              {followFollowers ? <div className="text-[11px] text-zinc-500">{followFollowers}</div> : null}
                            </div>
                            <div className="text-[11px] text-zinc-500">
                              {signal.tweetType === 'follow' ? '被关注账号' : '被取消关注账号'}
                            </div>
                          </div>
                        </div>
                        {followHandle ? (
                          <button
                            type="button"
                            className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
                            onClick={() => window.open(`https://x.com/${followHandle.replace('@', '')}`, '_blank')}
                          >
                            ↗
                          </button>
                        ) : null}
                      </div>
                      {signal.followedUserBio ? (
                        <div className="mt-2 text-[12px] text-zinc-300 whitespace-pre-wrap break-words">
                          {renderRichText(signal.followedUserBio, `${signal.id}:followBio`)}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {signal.tweetType === 'quote' && (quoteDisplayName || quotedLink) ? (
                    <div className="mt-2 rounded-lg border border-l-2 border-amber-500/60 border-zinc-800 bg-zinc-900/50 px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-zinc-800 text-[10px] font-semibold text-zinc-300">
                            {signal.quotedUserAvatar ? (
                              <img
                                src={signal.quotedUserAvatar}
                                alt=""
                                className="h-7 w-7 object-cover"
                                loading="lazy"
                                referrerPolicy="no-referrer"
                              />
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
                        {quotedLink ? (
                          <button
                            type="button"
                            className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
                            onClick={() => window.open(quotedLink, '_blank')}
                          >
                            ↗
                          </button>
                        ) : null}
                      </div>
                      {signal.quotedText ? (
                        <div className="mt-2 whitespace-pre-wrap break-words text-[12px] text-zinc-200">
                          {renderRichText(signal.quotedText, `${signal.id}:quotedText:quote`)}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {signal.tweetType === 'repost' && (quoteDisplayName || quotedLink) ? (
                    <div className="mt-2 rounded-lg border border-l-2 border-sky-500/60 border-zinc-800 bg-zinc-900/50 px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-zinc-800 text-[10px] font-semibold text-zinc-300">
                            {signal.quotedUserAvatar ? (
                              <img
                                src={signal.quotedUserAvatar}
                                alt=""
                                className="h-7 w-7 object-cover"
                                loading="lazy"
                                referrerPolicy="no-referrer"
                              />
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
                            <div className="text-[11px] text-zinc-500">被转发推文</div>
                          </div>
                        </div>
                        {quotedLink ? (
                          <button
                            type="button"
                            className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
                            onClick={() => window.open(quotedLink, '_blank')}
                          >
                            ↗
                          </button>
                        ) : null}
                      </div>
                      {signal.quotedText ? (
                        <div className="mt-2 whitespace-pre-wrap break-words text-[12px] text-zinc-200">
                          {renderRichText(signal.quotedText, `${signal.id}:quotedText:repost`)}
                        </div>
                      ) : null}
                      {signal.translatedText ? (
                        <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
                          <div className="text-[10px] text-zinc-500">翻译</div>
                          <div className="mt-1 whitespace-pre-wrap break-words text-[12px] text-zinc-200">
                            {renderRichText(signal.translatedText, `${signal.id}:translated:repost`)}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {signal.text && signal.tweetType !== 'repost' ? (
                    <div className="mt-2">
                      <div className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-zinc-100">
                        {renderRichText(signal.text, `${signal.id}:text`)}
                      </div>
                    </div>
                  ) : null}

                  {Array.isArray(signal.media) && signal.media.length ? (
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      {signal.media.slice(0, 6).map((m, idx) => {
                        const url = typeof (m as any)?.url === 'string' ? (m as any).url : null;
                        const type = typeof (m as any)?.type === 'string' ? String((m as any).type).toLowerCase() : 'unknown';
                        if (!url) return null;
                        if (type === 'video') {
                          return (
                            <video
                              key={`${signal.id}:m:${idx}`}
                              className="w-full rounded-lg border border-zinc-800 bg-zinc-900/40"
                              src={url}
                              controls
                              preload="none"
                            />
                          );
                        }
                        return (
                          <button
                            key={`${signal.id}:m:${idx}`}
                            type="button"
                            className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/40 hover:bg-zinc-900/70"
                            onClick={() => window.open(url, '_blank')}
                            title={url}
                          >
                            <img
                              src={url}
                              alt=""
                              className="h-28 w-full object-cover"
                              loading="lazy"
                              referrerPolicy="no-referrer"
                            />
                          </button>
                        );
                      })}
                    </div>
                  ) : null}

                  {signal.translatedText && signal.tweetType !== 'repost' ? (
                    <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
                      <div className="text-[10px] text-zinc-500">翻译</div>
                      <div className="mt-1 whitespace-pre-wrap break-words text-[12px] text-zinc-200">
                        {renderRichText(signal.translatedText, `${signal.id}:translated`)}
                      </div>
                    </div>
                  ) : null}

                  {tokenAddr ? (
                    <div className="mt-3 flex items-center justify-between gap-2">
                      <div className="text-[11px] text-zinc-500">
                        {holders != null ? `Holders ${formatCountShort(holders)}` : 'Holders --'}
                        {mc != null ? ` · MC $${Math.round(mc).toLocaleString()}` : ''}
                      </div>
                      <button
                        type="button"
                        className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
                        onClick={() => window.open(`https://gmgn.ai/token/${tokenAddr}`, '_blank')}
                        title={tokenAddr}
                      >
                        {tokenAddr.slice(0, 6)}...{tokenAddr.slice(-4)} ↗
                      </button>
                    </div>
                  ) : null}
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
