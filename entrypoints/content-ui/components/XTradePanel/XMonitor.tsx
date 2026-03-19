import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlarmClockCheck, Trophy, ChefHat, Users, X, UserStar } from 'lucide-react';
import type { Settings, UnifiedSignalToken, UnifiedTwitterSignal } from '@/types/extention';
import { normalizeLocale, t, type Locale } from '@/utils/i18n';
import { formatAgeShort, formatCompactNumber, formatCountShort } from '@/utils/format';
import { call } from '@/utils/messaging';
import { navigateToUrl, parsePlatformTokenLink, type SiteInfo } from '@/utils/sites';
import { browser } from 'wxt/browser';

type TTFunc = (key: string, subs?: Array<string | number>) => string;

type XMonitorPanelProps = {
  siteInfo: SiteInfo | null;
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  settings: Settings | null;
};

type XMonitorContentProps = {
  siteInfo: SiteInfo | null;
  active: boolean;
  settings: Settings | null;
};

type XSniperBuyRecordLite = {
  side?: 'buy' | 'sell';
  tokenAddress: string;
  tsMs: number;
  dryRun?: boolean;
};

const HISTORY_STORAGE_KEY = 'dagobang_xsniper_order_history_v1';

const parseNumber = (v: any) => {
  if (v == null) return null;
  const s = typeof v === 'string' ? v.trim() : String(v).trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return n;
};

const parseKNumber = (v: any) => {
  const n = parseNumber(v);
  if (n == null) return null;
  return n * 1000;
};

const normalizeEpochMs = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e14) return Math.floor(n / 1000);
  if (n < 1e11) return Math.floor(n * 1000);
  return Math.floor(n);
};

const getSignalAtMs = (signal: UnifiedTwitterSignal) => {
  const received = normalizeEpochMs((signal as any).receivedAtMs);
  if (received != null) return received;
  const ts = normalizeEpochMs((signal as any).ts);
  if (ts != null) return ts;
  return Date.now();
};

const getSignalInteraction = (signal: UnifiedTwitterSignal) => {
  const type = signal.tweetType === 'delete_post' ? ((signal as any).sourceTweetType ?? null) : signal.tweetType;
  if (type === 'repost') return 'retweet';
  if (type === 'tweet') return 'tweet';
  if (type === 'reply') return 'reply';
  if (type === 'quote') return 'quote';
  if (type === 'follow') return 'follow';
  return null;
};

const matchesTwitterFilters = (signal: UnifiedTwitterSignal, strategy: any) => {
  const allowedTypes = Array.isArray(strategy?.interactionTypes) ? strategy.interactionTypes.map((x: any) => String(x).toLowerCase()) : [];
  const it = getSignalInteraction(signal);
  if (allowedTypes.length && (!it || !allowedTypes.includes(it))) return false;

  const targetUsers = Array.isArray(strategy?.targetUsers) ? strategy.targetUsers.map((x: any) => String(x).toLowerCase()).filter(Boolean) : [];
  if (!targetUsers.length) return true;

  const screen = String((signal as any).userScreen ?? '').replace(/^@/, '').toLowerCase();
  const name = String((signal as any).userName ?? '').toLowerCase();
  return targetUsers.some((u: string) => u === screen || u === name);
};

const getDevHasSold = (token: UnifiedSignalToken) => {
  const v = (token as any).devHasSold;
  if (typeof v === 'boolean') return v;
  const status = (token as any).devTokenStatus;
  if (typeof status === 'string') return status.toLowerCase().includes('sell');
  return null;
};

const resolveTwitterSnipeByActivePreset = (twitterSnipe: any) => {
  const source = twitterSnipe ?? {};
  const presets = Array.isArray(source.presets) ? source.presets : [];
  const activePresetId = typeof source.activePresetId === 'string' ? source.activePresetId.trim() : '';
  const active = presets.find((item: any) => item && typeof item.id === 'string' && item.id === activePresetId);
  if (!active || !active.strategy || typeof active.strategy !== 'object') return source;
  return {
    ...source,
    ...active.strategy,
    presets,
    activePresetId,
  };
};

const buildNotBoughtReason = (input: {
  tt: TTFunc;
  wsMonitorEnabled: boolean;
  strategy: any;
  signal: UnifiedTwitterSignal;
  token: UnifiedSignalToken;
}) => {
  if (!input.wsMonitorEnabled) return input.tt('contentUi.xMonitor.notBought.reason.wsMonitorDisabled');
  if (!input.strategy?.enabled) return input.tt('contentUi.xMonitor.notBought.reason.sniperDisabled');
  if (!matchesTwitterFilters(input.signal, input.strategy)) return input.tt('contentUi.xMonitor.notBought.reason.filterMismatch');

  const perTweetMax = Math.max(0, Math.floor(parseNumber(input.strategy?.buyNewCaCount) ?? 0));
  if (perTweetMax <= 0) return input.tt('contentUi.xMonitor.notBought.reason.buyNewCaCountZero');
  const amount = parseNumber(input.strategy?.buyAmountBnb) ?? 0;
  if (amount <= 0) return input.tt('contentUi.xMonitor.notBought.reason.buyAmountZero');

  const token = input.token as any;
  const mcRaw = typeof token.marketCapUsd === 'number' ? token.marketCapUsd : null;
  const mc = mcRaw != null && Number.isFinite(mcRaw) && mcRaw >= 3000 ? mcRaw : null;
  const holders = typeof token.holders === 'number' ? token.holders : null;
  const symbol = typeof token.tokenSymbol === 'string' ? token.tokenSymbol.trim() : '';
  const createdAtMs = normalizeEpochMs(token.createdAtMs);
  const firstSeenAtMs = normalizeEpochMs(token.firstSeenAtMs);
  const signalAtMs = getSignalAtMs(input.signal);
  const now = Date.now();
  const devHoldPctRaw = typeof token.devHoldPercent === 'number' && Number.isFinite(token.devHoldPercent) ? token.devHoldPercent : null;
  const tokenAgeMsForDev = now - (firstSeenAtMs ?? createdAtMs ?? signalAtMs);
  const devHoldPct = devHoldPctRaw == null && tokenAgeMsForDev > 3000 ? 0 : devHoldPctRaw;
  const devHasSold = getDevHasSold(input.token);

  const minMcap = parseKNumber(input.strategy?.minMarketCapUsd);
  const maxMcap = parseKNumber(input.strategy?.maxMarketCapUsd);
  if ((minMcap != null || maxMcap != null) && mcRaw != null && mc == null) return input.tt('contentUi.xMonitor.notBought.reason.marketCapInvalid');
  if (minMcap != null && mc == null) return input.tt('contentUi.xMonitor.notBought.reason.marketCapMissing');
  if (maxMcap != null && mc == null) return input.tt('contentUi.xMonitor.notBought.reason.marketCapMissing');
  if (minMcap != null && mc != null && mc < minMcap) return input.tt('contentUi.xMonitor.notBought.reason.marketCapTooLow', [Math.round(mc), Math.round(minMcap)]);
  if (maxMcap != null && mc != null && mc > maxMcap) return input.tt('contentUi.xMonitor.notBought.reason.marketCapTooHigh', [Math.round(mc), Math.round(maxMcap)]);

  const minHolders = parseNumber(input.strategy?.minHolders);
  const maxHolders = parseNumber(input.strategy?.maxHolders);
  if (minHolders != null && holders == null) return input.tt('contentUi.xMonitor.notBought.reason.holdersMissing');
  if (maxHolders != null && holders == null) return input.tt('contentUi.xMonitor.notBought.reason.holdersMissing');
  if (minHolders != null && holders != null && holders < minHolders) return input.tt('contentUi.xMonitor.notBought.reason.holdersTooLow', [holders, Math.floor(minHolders)]);
  if (maxHolders != null && holders != null && holders > maxHolders) return input.tt('contentUi.xMonitor.notBought.reason.holdersTooHigh', [holders, Math.floor(maxHolders)]);

  const minTickerLenRaw = parseNumber(input.strategy?.minTickerLen);
  const maxTickerLenRaw = parseNumber(input.strategy?.maxTickerLen);
  const minTickerLen = minTickerLenRaw != null ? Math.max(0, Math.floor(minTickerLenRaw)) : null;
  const maxTickerLen = maxTickerLenRaw != null ? Math.max(0, Math.floor(maxTickerLenRaw)) : null;
  if (minTickerLen != null || maxTickerLen != null) {
    if (!symbol) return input.tt('contentUi.xMonitor.notBought.reason.tickerMissing');
    const len = computeTickerLen(symbol);
    if (minTickerLen != null && len < minTickerLen) return input.tt('contentUi.xMonitor.notBought.reason.tickerLenTooShort', [len, minTickerLen]);
    if (maxTickerLen != null && len > maxTickerLen) return input.tt('contentUi.xMonitor.notBought.reason.tickerLenTooLong', [len, maxTickerLen]);
  }

  const minAgeSecRaw = parseNumber(input.strategy?.minTokenAgeSeconds);
  const maxAgeSec = parseNumber(input.strategy?.maxTokenAgeSeconds);
  const minAgeSec = minAgeSecRaw ?? (maxAgeSec != null ? 0 : null);
  const tokenAtMs = createdAtMs ?? firstSeenAtMs;
  if ((minAgeSec != null || maxAgeSec != null) && tokenAtMs == null) return input.tt('contentUi.xMonitor.notBought.reason.createdAtMissing');
  if (tokenAtMs != null) {
    const tokenAgeAtSignalMs = signalAtMs - tokenAtMs;
    if (tokenAgeAtSignalMs < -10_000) return input.tt('contentUi.xMonitor.notBought.reason.tokenCreatedAfterTweet');
    if (minAgeSec != null && tokenAgeAtSignalMs < minAgeSec * 1000)
      return input.tt('contentUi.xMonitor.notBought.reason.ageTooYoung', [Math.floor(tokenAgeAtSignalMs / 1000), Math.floor(minAgeSec)]);
    if (maxAgeSec != null && tokenAgeAtSignalMs > maxAgeSec * 1000)
      return input.tt('contentUi.xMonitor.notBought.reason.ageTooOld', [Math.floor(tokenAgeAtSignalMs / 1000), Math.floor(maxAgeSec)]);
  }

  const minTweetAgeSecRaw = parseNumber((input.strategy as any)?.minTweetAgeSeconds);
  const maxTweetAgeSec = parseNumber((input.strategy as any)?.maxTweetAgeSeconds);
  const minTweetAgeSec = minTweetAgeSecRaw ?? (maxTweetAgeSec != null ? 0 : null);
  if (minTweetAgeSec != null || maxTweetAgeSec != null) {
    const tweetAgeMs = now - signalAtMs;
    if (tweetAgeMs < 0) return input.tt('contentUi.xMonitor.notBought.reason.orderWindowExpired', ['0', String(Math.floor(maxTweetAgeSec ?? 0))]);
    if (minTweetAgeSec != null && tweetAgeMs < minTweetAgeSec * 1000)
      return input.tt('contentUi.xMonitor.notBought.reason.orderWindowTooEarly', [Math.floor(tweetAgeMs / 1000), Math.floor(minTweetAgeSec)]);
    if (maxTweetAgeSec != null && tweetAgeMs > maxTweetAgeSec * 1000)
      return input.tt('contentUi.xMonitor.notBought.reason.orderWindowExpired', [Math.floor(tweetAgeMs / 1000), Math.floor(maxTweetAgeSec)]);
  }

  const minDevPct = parseNumber(input.strategy?.minDevHoldPercent);
  const maxDevPct = parseNumber(input.strategy?.maxDevHoldPercent);
  if (minDevPct != null && devHoldPct == null) return input.tt('contentUi.xMonitor.notBought.reason.devHoldMissing');
  if (maxDevPct != null && devHoldPct == null) return input.tt('contentUi.xMonitor.notBought.reason.devHoldMissing');
  if (minDevPct != null && devHoldPct < minDevPct) return input.tt('contentUi.xMonitor.notBought.reason.devHoldTooLow', [devHoldPct.toFixed(2), minDevPct]);
  if (maxDevPct != null && devHoldPct > maxDevPct) return input.tt('contentUi.xMonitor.notBought.reason.devHoldTooHigh', [devHoldPct.toFixed(2), maxDevPct]);
  if (input.strategy?.blockIfDevSell && devHasSold === true) return input.tt('contentUi.xMonitor.notBought.reason.devHasSold');

  if (input.strategy?.dryRun === true) return input.tt('contentUi.xMonitor.notBought.reason.dryRun');
  const shouldPickByMcap = (() => {
    const tokens = Array.isArray(input.signal.tokens) ? (input.signal.tokens as UnifiedSignalToken[]) : [];
    const scanLimit = Math.min(500, tokens.length);
    const now = Date.now();
    const unique: UnifiedSignalToken[] = [];
    const seen = new Set<string>();
    for (const t of tokens) {
      const addr = typeof (t as any)?.tokenAddress === 'string' ? String((t as any).tokenAddress).trim() : '';
      const key = addr.toLowerCase();
      if (!addr) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(t);
      if (unique.length >= scanLimit) break;
    }

    const passes = (t: UnifiedSignalToken) => {
      const token = t as any;
      const mcRaw = typeof token.marketCapUsd === 'number' ? token.marketCapUsd : null;
      const mc = mcRaw != null && Number.isFinite(mcRaw) && mcRaw >= 3000 ? mcRaw : null;
      const holders = typeof token.holders === 'number' ? token.holders : null;
      const symbol = typeof token.tokenSymbol === 'string' ? token.tokenSymbol.trim() : '';
      const createdAtMs = normalizeEpochMs(token.createdAtMs);
      const firstSeenAtMs = normalizeEpochMs(token.firstSeenAtMs);
      const devHoldPctRaw = typeof token.devHoldPercent === 'number' && Number.isFinite(token.devHoldPercent) ? token.devHoldPercent : null;
      const tokenAgeMsForDev = now - (firstSeenAtMs ?? createdAtMs ?? signalAtMs);
      const devHoldPct = devHoldPctRaw == null && tokenAgeMsForDev > 3000 ? 0 : devHoldPctRaw;
      const devHasSold = getDevHasSold(t);

      if ((minMcap != null || maxMcap != null) && mcRaw != null && mc == null) return false;
      if (minMcap != null && mc == null) return false;
      if (maxMcap != null && mc == null) return false;
      if (minMcap != null && mc != null && mc < minMcap) return false;
      if (maxMcap != null && mc != null && mc > maxMcap) return false;

      if (minHolders != null && holders == null) return false;
      if (maxHolders != null && holders == null) return false;
      if (minHolders != null && holders != null && holders < minHolders) return false;
      if (maxHolders != null && holders != null && holders > maxHolders) return false;

      if (minTickerLen != null || maxTickerLen != null) {
        if (!symbol) return false;
        const len = computeTickerLen(symbol);
        if (minTickerLen != null && len < minTickerLen) return false;
        if (maxTickerLen != null && len > maxTickerLen) return false;
      }

      const tokenAtMs = createdAtMs ?? firstSeenAtMs;
      if ((minAgeSec != null || maxAgeSec != null) && tokenAtMs == null) return false;
      if (tokenAtMs != null) {
        const tokenAgeAtSignalMs = signalAtMs - tokenAtMs;
        if (tokenAgeAtSignalMs < -10_000) return false;
        if (minAgeSec != null && tokenAgeAtSignalMs < minAgeSec * 1000) return false;
        if (maxAgeSec != null && tokenAgeAtSignalMs > maxAgeSec * 1000) return false;
      }

      const minTweetAgeSecRaw = parseNumber((input.strategy as any)?.minTweetAgeSeconds);
      const maxTweetAgeSec = parseNumber((input.strategy as any)?.maxTweetAgeSeconds);
      const minTweetAgeSec = minTweetAgeSecRaw ?? (maxTweetAgeSec != null ? 0 : null);
      if (minTweetAgeSec != null || maxTweetAgeSec != null) {
        const tweetAgeMs = Date.now() - signalAtMs;
        if (tweetAgeMs < 0) return false;
        if (minTweetAgeSec != null && tweetAgeMs < minTweetAgeSec * 1000) return false;
        if (maxTweetAgeSec != null && tweetAgeMs > maxTweetAgeSec * 1000) return false;
      }

      if (minDevPct != null && devHoldPct == null) return false;
      if (maxDevPct != null && devHoldPct == null) return false;
      if (minDevPct != null && devHoldPct < minDevPct) return false;
      if (maxDevPct != null && devHoldPct > maxDevPct) return false;
      if (input.strategy?.blockIfDevSell && devHasSold === true) return false;

      return true;
    };

    const candidates = unique.filter(passes).slice();
    candidates.sort((a, b) => {
      const ma = typeof (a as any).marketCapUsd === 'number' ? (a as any).marketCapUsd : 0;
      const mb = typeof (b as any).marketCapUsd === 'number' ? (b as any).marketCapUsd : 0;
      if (mb !== ma) return mb - ma;
      const ta = typeof (a as any).firstSeenAtMs === 'number' && (a as any).firstSeenAtMs > 0 ? (a as any).firstSeenAtMs : 0;
      const tb = typeof (b as any).firstSeenAtMs === 'number' && (b as any).firstSeenAtMs > 0 ? (b as any).firstSeenAtMs : 0;
      return ta - tb;
    });

    const selected = candidates.slice(0, perTweetMax);
    const selectedKey = new Set<string>(
      selected
        .map((t) => (typeof (t as any)?.tokenAddress === 'string' ? String((t as any).tokenAddress).trim().toLowerCase() : ''))
        .filter(Boolean)
    );
    const curAddr = typeof (input.token as any)?.tokenAddress === 'string' ? String((input.token as any).tokenAddress).trim().toLowerCase() : '';
    return curAddr ? selectedKey.has(curAddr) : false;
  })();

  if (!shouldPickByMcap) return input.tt('contentUi.xMonitor.notBought.reason.quotaExceeded');
  return input.tt('contentUi.xMonitor.notBought.reason.passedButNoOrder');
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

const getTypeMeta = (
  type: UnifiedTwitterSignal['tweetType'] | undefined,
  tt: (key: string, subs?: Array<string | number>) => string,
) => {
  const key = type;
  switch (key) {
    case 'tweet':
      return { label: tt('contentUi.xMonitor.type.tweet'), className: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200' };
    case 'repost':
      return { label: tt('contentUi.xMonitor.type.repost'), className: 'border-sky-500/40 bg-sky-500/15 text-sky-200' };
    case 'quote':
      return { label: tt('contentUi.xMonitor.type.quote'), className: 'border-amber-500/40 bg-amber-500/15 text-amber-200' };
    case 'reply':
      return { label: tt('contentUi.xMonitor.type.reply'), className: 'border-purple-500/40 bg-purple-500/15 text-purple-200' };
    case 'delete_post':
      return { label: tt('contentUi.xMonitor.type.delete'), className: 'border-red-500/40 bg-red-500/15 text-red-200' };
    case 'follow':
      return { label: tt('contentUi.xMonitor.type.follow'), className: 'border-rose-500/40 bg-rose-500/15 text-rose-200' };
    case 'unfollow':
      return { label: tt('contentUi.xMonitor.type.unfollow'), className: 'border-zinc-600 bg-zinc-800/70 text-zinc-300' };
    default:
      return key ? { label: key, className: 'border-zinc-700 bg-zinc-900 text-zinc-400' } : null;
  }
};

const normalizeSignalTokensForDisplay = (signal: UnifiedTwitterSignal): UnifiedSignalToken[] => {
  const list = Array.isArray(signal.tokens) ? (signal.tokens as UnifiedSignalToken[]) : [];
  const cleaned = list
    .filter((t) => t && typeof (t as any).tokenAddress === 'string' && (t as any).tokenAddress.trim())
    .map((t) => ({
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
      devBuyRatio: t.devBuyRatio,
      top10HoldRatio: t.top10HoldRatio,
      devTokenStatus: t.devTokenStatus,
      createdAtMs: normalizeEpochMs(t.createdAtMs) ?? 0,
      firstSeenAtMs: normalizeEpochMs((t as any).firstSeenAtMs) ?? 0,
      updatedAtMs: normalizeEpochMs((t as any).updatedAtMs) ?? getSignalAtMs(signal),
    }));
  return cleaned;
};

const computeTickerLen = (symbol: string) => {
  let total = 0;
  for (const ch of symbol) {
    const cp = ch.codePointAt(0) ?? 0;
    const isCjk =
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0x20000 && cp <= 0x2a6df) ||
      (cp >= 0x2a700 && cp <= 0x2b73f) ||
      (cp >= 0x2b740 && cp <= 0x2b81f) ||
      (cp >= 0x2b820 && cp <= 0x2ceaf) ||
      (cp >= 0x2ceb0 && cp <= 0x2ebef) ||
      (cp >= 0x2f800 && cp <= 0x2fa1f);
    total += isCjk ? 2 : 1;
  }
  return total;
};

export function XMonitorContent({
  siteInfo,
  active,
  settings,
}: XMonitorContentProps) {
  const resolvedSettings = useMemo<Settings | null>(() => {
    if (settings) return settings;
    return (window as any).__DAGOBANG_SETTINGS__ ?? null;
  }, [settings]);
  const locale: Locale = normalizeLocale(resolvedSettings?.locale ?? 'zh_CN');
  const tt = (key: string, subs?: Array<string | number>) => t(key, locale, subs);

  const [wsMonitorEnabled, setWsMonitorEnabled] = useState(() => resolvedSettings?.autoTrade?.wsMonitorEnabled !== false);
  useEffect(() => {
    setWsMonitorEnabled(resolvedSettings?.autoTrade?.wsMonitorEnabled !== false);
  }, [resolvedSettings?.autoTrade?.wsMonitorEnabled]);

  const twitterSnipeSource = (resolvedSettings as any)?.autoTrade?.twitterSnipe ?? null;
  const twitterSnipeStrategy = useMemo(
    () => resolveTwitterSnipeByActivePreset(twitterSnipeSource),
    [twitterSnipeSource]
  );
  const activeStrategyName = useMemo(() => {
    const source = twitterSnipeSource ?? {};
    const presets = Array.isArray(source.presets) ? source.presets : [];
    const activePresetId = typeof source.activePresetId === 'string' ? source.activePresetId.trim() : '';
    if (!activePresetId) return '';
    const active = presets.find((item: any) => item && typeof item.id === 'string' && item.id === activePresetId);
    if (!active) return '';
    const name = typeof active.name === 'string' ? active.name.trim() : '';
    return name || activePresetId;
  }, [twitterSnipeSource]);

  const tickerLenFilter = useMemo(() => {
    const parseLen = (v: any) => {
      if (typeof v !== 'string') return null;
      const n = Number(v.trim());
      if (!Number.isFinite(n)) return null;
      const i = Math.floor(n);
      return i >= 0 ? i : null;
    };
    const snipe = twitterSnipeStrategy;
    const min = parseLen(snipe?.minTickerLen);
    const max = parseLen(snipe?.maxTickerLen);
    return { min, max };
  }, [twitterSnipeStrategy]);

  const [boughtByAddr, setBoughtByAddr] = useState<Record<string, { dryRun: boolean; tsMs: number }>>({});
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await browser.storage.local.get(HISTORY_STORAGE_KEY);
        const raw = (res as any)?.[HISTORY_STORAGE_KEY];
        const list = Array.isArray(raw) ? (raw as XSniperBuyRecordLite[]) : [];
        const next: Record<string, { dryRun: boolean; tsMs: number }> = {};
        for (const r of list) {
          if (!r || r.side !== 'buy') continue;
          const addr = typeof r.tokenAddress === 'string' ? r.tokenAddress.trim().toLowerCase() : '';
          if (!addr) continue;
          const tsMs = typeof r.tsMs === 'number' ? r.tsMs : 0;
          const prev = next[addr];
          if (prev && prev.tsMs >= tsMs) continue;
          next[addr] = { dryRun: r.dryRun === true, tsMs };
        }
        if (!cancelled) setBoughtByAddr(next);
      } catch {
        if (!cancelled) setBoughtByAddr({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const listener = (message: any) => {
      if (!message || message.type !== 'bg:xsniper:buy') return;
      const record = message.record as XSniperBuyRecordLite | undefined;
      if (!record || record.side !== 'buy') return;
      const addr = typeof record.tokenAddress === 'string' ? record.tokenAddress.trim().toLowerCase() : '';
      if (!addr) return;
      const tsMs = typeof record.tsMs === 'number' ? record.tsMs : 0;
      setBoughtByAddr((prev) => {
        const cur = prev[addr];
        if (cur && cur.tsMs >= tsMs) return prev;
        return { ...prev, [addr]: { dryRun: record.dryRun === true, tsMs } };
      });
    };
    browser.runtime.onMessage.addListener(listener as any);
    return () => browser.runtime.onMessage.removeListener(listener as any);
  }, [active]);

  const signalsRef = useRef<Map<string, UnifiedTwitterSignal>>(new Map());
  const [signalIds, setSignalIds] = useState<string[]>([]);
  const onlyWithTokensStorageKey = 'dagobang_xmonitor_onlyWithTokens_v1';
  const [onlyWithTokens, setOnlyWithTokens] = useState(() => {
    try {
      return window.localStorage.getItem(onlyWithTokensStorageKey) === '1';
    } catch {
      return false;
    }
  });
  const tokenLimitStorageKey = 'dagobang_xmonitor_tokenLimit_v1';
  const [tokenLimit, setTokenLimit] = useState<number>(() => {
    try {
      const raw = window.localStorage.getItem(tokenLimitStorageKey);
      const n = raw ? Number(raw) : NaN;
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    } catch {
    }
    return 200;
  });

  const listRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(520);
  const rowHeightsRef = useRef<Map<string, number>>(new Map());
  const [rowVersion, setRowVersion] = useState(0);

  useEffect(() => {
    try {
      window.localStorage.setItem(onlyWithTokensStorageKey, onlyWithTokens ? '1' : '0');
    } catch {
    }
  }, [onlyWithTokens]);

  useEffect(() => {
    try {
      window.localStorage.setItem(tokenLimitStorageKey, String(tokenLimit));
    } catch {
    }
  }, [tokenLimit]);

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
      .sort((a, b) => getSignalAtMs(b) - getSignalAtMs(a))
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
        .sort((a, b) => getSignalAtMs(b) - getSignalAtMs(a))
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
    return onlyWithTokens ? signalList.filter((s) => Array.isArray(s.tokens) && s.tokens.length > 0) : signalList;
  }, [signalList, onlyWithTokens]);

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
          <label className="flex items-center justify-between gap-2 flex-1">
            <div className="flex flex-col">
              <div className="text-[14px] font-semibold text-zinc-200">{tt('contentUi.xMonitor.wsMonitorEnabled')}</div>
              <div className="text-[11px] text-zinc-500">{tt('contentUi.xMonitor.wsMonitorEnabledDesc')}</div>
            </div>
            <input
              type="checkbox"
              className="h-4 w-4 accent-emerald-500"
              checked={wsMonitorEnabled}
              onChange={async (e) => {
                const next = e.target.checked;
                setWsMonitorEnabled(next);
                try {
                  window.localStorage.setItem('dagobang_ws_monitor_enabled_v1', next ? '1' : '0');
                } catch {
                }
                if (!resolvedSettings) return;
                const nextSettings: Settings = {
                  ...resolvedSettings,
                  autoTrade: {
                    ...(resolvedSettings as any).autoTrade,
                    wsMonitorEnabled: next,
                  } as any,
                };
                (window as any).__DAGOBANG_SETTINGS__ = nextSettings;
                try {
                  await call({ type: 'settings:set', settings: nextSettings } as const);
                } catch {
                }
              }}
            />
          </label>
        </div>
        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-[14px] text-zinc-300">
            <input
              type="checkbox"
              className="h-3 w-3 accent-emerald-500"
              checked={onlyWithTokens}
              onChange={(e) => setOnlyWithTokens(e.target.checked)}
            />
            {tt('contentUi.xMonitor.filterOnlyWithTokens')}
          </label>
          <div className="flex items-center gap-2 text-[12px] text-zinc-400">
            <div>{tt('contentUi.xMonitor.tokenLimit')}</div>
            <select
              className="h-7 rounded-md border border-zinc-800 bg-zinc-950/30 px-2 text-[12px] text-zinc-200 outline-none"
              value={String(tokenLimit)}
              onChange={(e) => {
                const n = Number(e.target.value);
                const next = Number.isFinite(n) && n > 0 ? Math.floor(n) : 10;
                setTokenLimit(next);
              }}
            >
              {[5, 10, 20, 50, 100, 200].map((n) => (
                <option key={n} value={String(n)}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        </div>
        {activeStrategyName ? (
          <div className="flex items-center gap-2 text-[11px] text-zinc-400">
            <span>当前生效策略</span>
            <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-emerald-300">
              {activeStrategyName}
            </span>
          </div>
        ) : null}

        {!resolvedSettings ? (
          <div className="text-[11px] text-zinc-500">{tt('contentUi.autoTradeStrategy.statusSettingsNotLoaded')}</div>
        ) : null}
      </div>

      <div ref={listRef} className="max-h-[62vh] overflow-y-auto p-3">
        {!wsMonitorEnabled ? (
          <div className="px-2 py-8 text-center text-[14px] text-zinc-500">{tt('contentUi.xMonitor.wsMonitorDisabled')}</div>
        ) : visibleSignals.length === 0 ? (
          <div className="px-2 py-8 text-center text-[14px] text-zinc-500">{tt('contentUi.xMonitor.empty')}</div>
        ) : (
          <div>
            {virtualRange.top > 0 ? <div style={{ height: virtualRange.top }} /> : null}
            {visibleSignals.slice(virtualRange.start, virtualRange.end).map((signal) => {
              const timeText = formatAgeShort(getSignalAtMs(signal));
              const displayName = signal.userName || signal.userScreen || tt('contentUi.xMonitor.unknownUser');
              const handle = signal.userScreen ? `@${signal.userScreen}` : null;
              const followerText = formatCountShort(signal.userFollowers);
              const typeMeta = getTypeMeta(signal.tweetType, tt);
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

              const displayTokens = normalizeSignalTokensForDisplay(signal)
                .filter((t) => {
                  const min = tickerLenFilter.min;
                  const max = tickerLenFilter.max;
                  if (min == null && max == null) return true;
                  const symbol = typeof t.tokenSymbol === 'string' ? t.tokenSymbol.trim() : '';
                  if (!symbol) return false;
                  const len = computeTickerLen(symbol);
                  if (min != null && len < min) return false;
                  if (max != null && len > max) return false;
                  return true;
                })
                .slice()
                .sort((a, b) => {
                  const aa = typeof a.tokenAddress === 'string' ? a.tokenAddress.trim().toLowerCase() : '';
                  const bb = typeof b.tokenAddress === 'string' ? b.tokenAddress.trim().toLowerCase() : '';
                  const ba = aa ? boughtByAddr[aa] : null;
                  const bbought = bb ? boughtByAddr[bb] : null;
                  const ra = ba ? (ba.dryRun ? 1 : 0) : 2;
                  const rb = bbought ? (bbought.dryRun ? 1 : 0) : 2;
                  if (ra !== rb) return ra - rb;
                  const ma = typeof a.marketCapUsd === 'number' ? a.marketCapUsd : 0;
                  const mb = typeof b.marketCapUsd === 'number' ? b.marketCapUsd : 0;
                  if (mb !== ma) return mb - ma;
                  const ta = ba ? ba.tsMs : 0;
                  const tb = bbought ? bbought.tsMs : 0;
                  if (tb !== ta) return tb - ta;
                  return a.firstSeenAtMs - b.firstSeenAtMs;
                })
                .slice(0, tokenLimit);

              return (
                <div
                  key={signal.id}
                  ref={setRowRef(signal.id)}
                  className="rounded-xl border border-zinc-800 bg-zinc-950/30 p-3 mb-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-zinc-800 text-[14px] font-semibold text-zinc-300">
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
                          {handle ? <div className="truncate text-[14px] text-zinc-400">{handle}</div> : null}
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
                    <div className="mt-2 text-[14px] text-amber-300">{tt('contentUi.xMonitor.replyTo', [replyHandle])}</div>
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
                              <div className="truncate text-[14px] font-semibold text-zinc-100">{followDisplayName}</div>
                              {followHandle ? <div className="truncate text-[11px] text-zinc-400">{followHandle}</div> : null}
                              {followFollowers ? <div className="text-[11px] text-zinc-500">{followFollowers}</div> : null}
                            </div>
                            <div className="text-[11px] text-zinc-500">
                              {signal.tweetType === 'follow' ? tt('contentUi.xMonitor.followTarget') : tt('contentUi.xMonitor.unfollowTarget')}
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
                        <div className="mt-2 max-h-36 overflow-y-auto pr-1 text-[14px] text-zinc-300 whitespace-pre-wrap break-words">
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
                                <div className="truncate text-[14px] font-semibold text-zinc-100">{quoteDisplayName}</div>
                              ) : null}
                              {quoteHandle ? <div className="truncate text-[11px] text-zinc-400">{quoteHandle}</div> : null}
                            </div>
                            <div className="text-[11px] text-zinc-500">{tt('contentUi.xMonitor.quotedTweet')}</div>
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
                        <div className="mt-2 max-h-40 overflow-y-auto pr-1 whitespace-pre-wrap break-words text-[14px] text-zinc-200">
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
                                <div className="truncate text-[14px] font-semibold text-zinc-100">{quoteDisplayName}</div>
                              ) : null}
                              {quoteHandle ? <div className="truncate text-[11px] text-zinc-400">{quoteHandle}</div> : null}
                            </div>
                            <div className="text-[11px] text-zinc-500">{tt('contentUi.xMonitor.repostedTweet')}</div>
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
                        <div className="mt-2 max-h-40 overflow-y-auto pr-1 whitespace-pre-wrap break-words text-[14px] text-zinc-200">
                          {renderRichText(signal.quotedText, `${signal.id}:quotedText:repost`)}
                        </div>
                      ) : null}
                      {signal.translatedText ? (
                        <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
                          <div className="text-[10px] text-zinc-500">{tt('contentUi.xMonitor.translation')}</div>
                          <div className="mt-1 max-h-40 overflow-y-auto pr-1 whitespace-pre-wrap break-words text-[14px] text-zinc-200">
                            {renderRichText(signal.translatedText, `${signal.id}:translated:repost`)}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {signal.text && signal.tweetType !== 'repost' ? (
                    <div className="mt-2">
                      <div className="mt-1 max-h-44 overflow-y-auto pr-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-zinc-100">
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
                      <div className="text-[10px] text-zinc-500">{tt('contentUi.xMonitor.translation')}</div>
                      <div className="mt-1 max-h-40 overflow-y-auto pr-1 whitespace-pre-wrap break-words text-[14px] text-zinc-200">
                        {renderRichText(signal.translatedText, `${signal.id}:translated`)}
                      </div>
                    </div>
                  ) : null}

                  {displayTokens.length ? (
                    <div className="mt-3 space-y-2">
                      {displayTokens.map((token) => {
                        const tokenAddr = token.tokenAddress;
                        const bought = boughtByAddr[tokenAddr.toLowerCase()] ?? null;
                        const notBoughtReason = !bought
                          ? buildNotBoughtReason({
                            tt,
                            wsMonitorEnabled,
                            strategy: twitterSnipeStrategy,
                            signal,
                            token,
                          })
                          : null;
                        const shortAddr = `${tokenAddr.slice(0, 6)}...${tokenAddr.slice(-4)}`;
                        const symbol = token.tokenSymbol?.trim() || '';
                        const tokenName = token.tokenName?.trim() || '';
                        const name = symbol || tokenName || shortAddr;
                        const mc = typeof token.marketCapUsd === 'number' ? token.marketCapUsd : null;
      const devBuyRatioPct =
        typeof token.devBuyRatio === 'number'
          ? token.devBuyRatio * 100
          : typeof token.devHoldPercent === 'number' && Number.isFinite(token.devHoldPercent)
            ? token.devHoldPercent
            : null;
                        const top10HoldRatioPct = typeof token.top10HoldRatio === 'number' ? token.top10HoldRatio * 100 : null;
                        const age = typeof token.createdAtMs === 'number' ? formatAgeShort(token.createdAtMs) : null;
                        const getRatioClassName = (pct: number | null) => {
                          if (pct == null) return '';
                          if (pct > 0 && pct < 10) return 'text-emerald-300';
                          if (pct > 10) return 'text-rose-300';
                          return '';
                        };
                        const devRatioClassName = getRatioClassName(devBuyRatioPct);
                        const top10RatioClassName = getRatioClassName(top10HoldRatioPct);
                        return (
                          <div
                            key={`${signal.id}:${tokenAddr}`}
                            className={[
                              'border px-3 py-2',
                              bought
                                ? bought.dryRun
                                  ? 'border-amber-500/40 bg-amber-500/10'
                                  : 'border-emerald-500/40 bg-emerald-500/10'
                                : 'border-zinc-800 bg-zinc-900/40',
                            ].join(' ')}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <button
                                type="button"
                                className="min-w-0 truncate text-left text-[14px] font-semibold text-zinc-100 hover:underline underline-offset-2"
                                onClick={() => {
                                  if (!siteInfo) return;
                                  navigateToUrl(parsePlatformTokenLink(siteInfo, tokenAddr));
                                }}
                                title={tokenAddr}
                              >
                                <span>{name}</span>
                                {symbol && tokenName ? <span className="ml-1 font-normal text-zinc-400">{tokenName}</span> : null}
                              </button>
                              <div className="flex flex-shrink-0 items-center gap-2">
                                {bought ? (
                                  <div
                                    className={[
                                      'rounded border px-1.5 py-0.5 text-[10px] font-semibold',
                                      bought.dryRun ? 'border-amber-500/40 text-amber-200' : 'border-emerald-500/40 text-emerald-200',
                                    ].join(' ')}
                                  >
                                    {bought.dryRun ? tt('contentUi.xMonitor.tag.dry') : tt('contentUi.xMonitor.tag.buy')}
                                  </div>
                                ) : null}
                                {mc != null ? (
                                  <div className="text-[14px] font-semibold text-emerald-300">
                                    MC ${formatCompactNumber(Math.round(mc))}
                                  </div>
                                ) : null}
                              </div>
                            </div>
                            <div className="mt-1 flex items-center justify-between gap-2">
                              <div className="min-w-0 truncate font-mono text-[11px] text-zinc-500">{shortAddr}</div>
                              <div className="flex flex-shrink-0 items-center gap-2 text-[11px] text-zinc-500">
                                {devBuyRatioPct != null ? (
                                  <span className={`inline-flex items-center gap-1 ${devRatioClassName}`} title={tt('contentUi.xMonitor.tooltip.devBuyRatio')}>
                                    <ChefHat size={12} />
                                    {devBuyRatioPct < 0.0001 ? '0%' : `${devBuyRatioPct.toFixed(2)}%`}
                                  </span>
                                ) : null}
                                {top10HoldRatioPct != null ? (
                                  <span className={`inline-flex items-center gap-1 ${top10RatioClassName}`} title={tt('contentUi.xMonitor.tooltip.top10HoldRatio')}>
                                    <UserStar size={12} />
                                    {top10HoldRatioPct === 0.0001 ? '0%' : `${top10HoldRatioPct.toFixed(2)}%`}
                                  </span>
                                ) : null}
                                {token.holders != null ? (
                                  <span className="inline-flex items-center gap-1" title={tt('contentUi.xMonitor.tooltip.holders')}>
                                    <Users size={12} />
                                    {formatCompactNumber(token.holders)}
                                  </span>
                                ) : null}
                                {token.kol != null ? (
                                  <span className="inline-flex items-center gap-1" title={tt('contentUi.xMonitor.tooltip.kol')}>
                                    <Trophy size={12} />
                                    {formatCompactNumber(token.kol)}
                                  </span>
                                ) : null}
                                {typeof (token as any).vol24hUsd === 'number' && Number.isFinite((token as any).vol24hUsd) ? (
                                  <span className="inline-flex items-center gap-1" title="24h 成交额">
                                    V24h ${formatCompactNumber(Math.round((token as any).vol24hUsd))}
                                  </span>
                                ) : null}
                                {typeof (token as any).netBuy24hUsd === 'number' && Number.isFinite((token as any).netBuy24hUsd) ? (
                                  <span className="inline-flex items-center gap-1" title="24h 净买入">
                                    NBA ${formatCompactNumber(Math.round((token as any).netBuy24hUsd))}
                                  </span>
                                ) : null}
                                {typeof (token as any).buyTx24h === 'number' && typeof (token as any).sellTx24h === 'number' ? (
                                  <span className="inline-flex items-center gap-1" title="24h 买/卖 交易数">
                                    B/S {(token as any).buyTx24h}/{(token as any).sellTx24h}
                                  </span>
                                ) : null}
                                {typeof (token as any).smartMoney === 'number' && Number.isFinite((token as any).smartMoney) ? (
                                  <span className="inline-flex items-center gap-1" title="聪明钱">
                                    SMT {(token as any).smartMoney}
                                  </span>
                                ) : null}
                                {age ? (
                                  <span className="inline-flex items-center gap-1" title={tt('contentUi.xMonitor.tooltip.age')}>
                                    <AlarmClockCheck size={12} />
                                    {age}
                                  </span>
                                ) : null}
                              </div>
                            </div>
                            {!bought && notBoughtReason ? (
                              <div className="mt-1 text-[10px] text-zinc-500">{tt('contentUi.xMonitor.notBought.prefix', [notBoughtReason])}</div>
                            ) : null}
                          </div>
                        );
                      })}
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
  siteInfo,
  visible,
  onVisibleChange,
  settings,
}: XMonitorPanelProps) {
  if (!visible) return null;

  const resolvedSettings = settings ?? ((window as any).__DAGOBANG_SETTINGS__ ?? null);
  const locale: Locale = normalizeLocale(resolvedSettings?.locale ?? 'zh_CN');
  const tt = (key: string, subs?: Array<string | number>) => t(key, locale, subs);

  return (
    <div
      className="fixed right-4 top-32 z-[2147483647] w-[360px] select-none rounded-xl border border-zinc-800 bg-[#0F0F11] text-zinc-100 shadow-xl shadow-emerald-500/20 font-sans"
    >
      <div
        className="flex items-center justify-between gap-3 px-4 py-3 border-b border-zinc-800/60"
      >
        <div className="text-xs font-semibold text-emerald-300">{tt('contentUi.xMonitor.title')}</div>
        <button className="text-zinc-400 hover:text-zinc-200" onClick={() => onVisibleChange(false)}>
          <X size={16} />
        </button>
      </div>
      <XMonitorContent
        siteInfo={siteInfo}
        active={visible}
        settings={settings}
      />
    </div>
  );
}
