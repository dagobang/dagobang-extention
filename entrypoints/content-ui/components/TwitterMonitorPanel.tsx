import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Settings } from '@/types/extention';
import { normalizeLocale, t, type Locale } from '@/utils/i18n';

type TwitterMonitorPanelProps = {
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
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

const clampPos = (pos: { x: number; y: number }, panelWidth: number) => {
  const width = window.innerWidth || 0;
  const height = window.innerHeight || 0;
  const clampedX = Math.min(Math.max(0, pos.x), Math.max(0, width - panelWidth));
  const clampedY = Math.min(Math.max(0, pos.y), Math.max(0, height - 80));
  return { x: clampedX, y: clampedY };
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

const normalizeTwitterItem = (channel: string, item: any): { key: string; patch: Partial<TweetEntry>; deleted: boolean } | null => {
  if (!item || typeof item !== 'object') return null;
  const eventId = typeof item.i === 'string' ? item.i : typeof item.ei === 'string' ? item.ei : undefined;
  const tweetId = typeof item.ti === 'string' ? item.ti : undefined;
  const key = eventId || tweetId;
  if (!key) return null;
  const twType = typeof item.tw === 'string' ? item.tw : undefined;
  const deleted = twType === 'delete_post' || twType === 'delete';
  const tsMs = (() => {
    const raw = parseNum(item.ts);
    if (raw == null) return undefined;
    return raw < 1e12 ? raw * 1000 : raw;
  })();
  const userObj = item.u && typeof item.u === 'object' ? item.u : null;
  const userScreen = userObj && typeof (userObj as any).s === 'string' ? (userObj as any).s : undefined;
  const userName = userObj && typeof (userObj as any).n === 'string' ? (userObj as any).n : undefined;
  const userAvatar = userObj && typeof (userObj as any).a === 'string' ? (userObj as any).a : undefined;
  const matchKey = (() => {
    const sc = (item as any).sc;
    if (sc && typeof sc === 'object' && typeof (sc as any).t === 'string') return (sc as any).t;
    const sc2 = (item as any).sc_t;
    return typeof sc2 === 'string' ? sc2 : undefined;
  })();
  if (channel === 'twitter_monitor_translation') {
    const sourceUrl = typeof (item as any).sc === 'string' ? (item as any).sc : undefined;
    const translatedText =
      typeof (item as any).c === 'string'
        ? (item as any).c
        : typeof (item as any).sat === 'string'
          ? (item as any).sat
          : undefined;
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
  const text = typeof (item as any).c === 'string' ? (item as any).c : undefined;
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
      text,
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

export function TwitterMonitorPanel({ visible, onVisibleChange, settings }: TwitterMonitorPanelProps) {
  const panelWidth = 420;
  const locale: Locale = normalizeLocale(settings?.locale ?? 'zh_CN');
  const tt = (key: string, subs?: Array<string | number>) => t(key, locale, subs);

  const [pos, setPos] = useState(() => {
    const width = window.innerWidth || 0;
    const defaultX = Math.max(0, width - panelWidth - 20);
    const defaultY = 140;
    return { x: defaultX, y: defaultY };
  });
  const posRef = useRef(pos);
  const dragging = useRef<null | { startX: number; startY: number; baseX: number; baseY: number }>(null);

  const tweetsRef = useRef<Map<string, TweetEntry>>(new Map());
  const [tweetKeys, setTweetKeys] = useState<string[]>([]);
  const [tokensVersion, setTokensVersion] = useState(0);
  const tokensByMatchKeyRef = useRef<Map<string, Map<string, any>>>(new Map());

  const [onlyWithTokens, setOnlyWithTokens] = useState(true);
  const [sortKey, setSortKey] = useState<'marketCap' | 'newest'>('marketCap');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');
  const [expandedTweets, setExpandedTweets] = useState<Record<string, boolean>>({});

  useEffect(() => {
    posRef.current = pos;
  }, [pos]);

  useEffect(() => {
    try {
      const key = 'dagobang_twitter_monitor_panel_pos';
      const stored = window.localStorage.getItem(key);
      if (!stored) return;
      const parsed = JSON.parse(stored);
      if (!parsed || typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return;
      setPos(clampPos(parsed, panelWidth));
    } catch {
    }
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - dragging.current.startX;
      const dy = e.clientY - dragging.current.startY;
      const nextX = dragging.current.baseX + dx;
      const nextY = dragging.current.baseY + dy;
      setPos({ x: nextX, y: nextY });
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = null;
      try {
        const key = 'dagobang_twitter_monitor_panel_pos';
        window.localStorage.setItem(key, JSON.stringify(posRef.current));
      } catch {
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  useEffect(() => {
    const onTwitter = (e: Event) => {
      const detail = (e as CustomEvent<any>).detail;
      if (!detail) return;
      const channel = typeof detail.channel === 'string' ? detail.channel : '';
      if (channel !== 'twitter_user_monitor_basic' && channel !== 'twitter_monitor_translation') return;
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
        .slice(0, 200)
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
      if (sortKey === 'newest') {
        const at = typeof a?.createdAtMs === 'number' ? a.createdAtMs : 0;
        const bt = typeof b?.createdAtMs === 'number' ? b.createdAtMs : 0;
        return sortDir === 'asc' ? at - bt : bt - at;
      }
      const amc = typeof a?.marketCapUsd === 'number' ? a.marketCapUsd : -1;
      const bmc = typeof b?.marketCapUsd === 'number' ? b.marketCapUsd : -1;
      return sortDir === 'asc' ? amc - bmc : bmc - amc;
    });
    return sorted;
  };

  const visibleTweets = useMemo(() => {
    const list = tweetList.slice();
    if (!onlyWithTokens) return list;
    return list.filter((t) => getAssociatedTokens(t).length > 0);
  }, [tweetList, onlyWithTokens, settings, sortKey, sortDir, tokensVersion]);

  if (!visible) return null;

  return (
    <div
      className="fixed z-[2147483647] w-[420px] select-none rounded-xl border border-zinc-800 bg-[#0F0F11] text-zinc-100 shadow-xl shadow-emerald-500/20 font-sans"
      style={{ left: pos.x, top: pos.y }}
    >
      <div
        className="flex items-center justify-between gap-3 px-4 py-3 border-b border-zinc-800/60 cursor-grab"
        onPointerDown={(e) => {
          dragging.current = {
            startX: e.clientX,
            startY: e.clientY,
            baseX: posRef.current.x,
            baseY: posRef.current.y,
          };
        }}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="text-xs font-semibold text-emerald-300">推特监控</div>
          <div className="text-[11px] text-zinc-500 truncate">
            {visibleTweets.length} / {tweetList.length}
          </div>
        </div>
        <button className="text-zinc-400 hover:text-zinc-200" onClick={() => onVisibleChange(false)}>
          <X size={16} />
        </button>
      </div>

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
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={
                sortKey === 'marketCap'
                  ? 'rounded-md border border-emerald-700 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-300'
                  : 'rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800'
              }
              onClick={() => {
                if (sortKey !== 'marketCap') {
                  setSortKey('marketCap');
                  setSortDir('desc');
                  return;
                }
                setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
              }}
            >
              市值{sortKey === 'marketCap' ? (sortDir === 'desc' ? '↓' : '↑') : ''}
            </button>
            <button
              type="button"
              className={
                sortKey === 'newest'
                  ? 'rounded-md border border-emerald-700 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-300'
                  : 'rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800'
              }
              onClick={() => {
                if (sortKey !== 'newest') {
                  setSortKey('newest');
                  setSortDir('desc');
                  return;
                }
                setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
              }}
            >
              新旧{sortKey === 'newest' ? (sortDir === 'desc' ? '↓' : '↑') : ''}
            </button>
          </div>
        </div>

        {!settings ? (
          <div className="text-[11px] text-zinc-500">{tt('contentUi.autoTradeStrategy.statusSettingsNotLoaded')}</div>
        ) : null}
      </div>

      <div className="max-h-[62vh] overflow-y-auto p-3 space-y-2">
        {visibleTweets.length === 0 ? (
          <div className="px-2 py-8 text-center text-[12px] text-zinc-500">暂无推文</div>
        ) : (
          visibleTweets.map((tweet) => {
            const tokens = getAssociatedTokens(tweet);
            const expanded = !!expandedTweets[tweet.key];
            const shownTokens = expanded ? tokens : tokens.slice(0, 3);
            const timeText = formatAgeShort(tweet.tsMs ?? tweet.updatedAtMs);
            const title = tweet.userScreen ? `@${tweet.userScreen}` : tweet.userName || 'Unknown';
            const link = tweet.sourceUrl
              ? tweet.sourceUrl
              : tweet.tweetId && tweet.userScreen
                ? `https://x.com/${tweet.userScreen}/status/${tweet.tweetId}`
                : tweet.tweetId
                  ? `https://x.com/i/web/status/${tweet.tweetId}`
                  : null;
            return (
              <div key={tweet.key} className="rounded-lg border border-zinc-800 bg-zinc-950/30 p-3">
                <div className="flex items-start gap-3">
                  <div className="h-8 w-8 overflow-hidden rounded-full bg-zinc-800 flex-shrink-0">
                    {tweet.userAvatar ? <img src={tweet.userAvatar} alt="" className="h-8 w-8 object-cover" /> : null}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex items-center gap-2">
                        <div className="truncate text-[12px] font-semibold text-zinc-200">{title}</div>
                        {tweet.type ? (
                          <div className="rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-400">{tweet.type}</div>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-zinc-500">
                        <div>{timeText}</div>
                        {link ? (
                          <button
                            type="button"
                            className="text-[11px] text-emerald-300 hover:text-emerald-200"
                            onClick={() => window.open(link, '_blank')}
                          >
                            打开
                          </button>
                        ) : null}
                      </div>
                    </div>
                    {tweet.text ? <div className="mt-2 whitespace-pre-wrap break-words text-[12px] text-zinc-200">{tweet.text}</div> : null}
                    {tweet.translatedText ? (
                      <div className="mt-2 whitespace-pre-wrap break-words rounded-md border border-zinc-800 bg-black/20 px-2 py-1 text-[12px] text-zinc-300">
                        {tweet.translatedText}
                      </div>
                    ) : null}
                  </div>
                </div>

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
          })
        )}
      </div>
    </div>
  );
}
