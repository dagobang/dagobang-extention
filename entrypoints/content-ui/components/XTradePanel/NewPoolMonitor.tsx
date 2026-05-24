import { useEffect, useMemo, useRef, useState } from 'react';
import { AtSign, ChefHat, Coins, ExternalLink, Eye, Flame, Globe2, Image as ImageIcon, Layers3, Trophy, UserStar, Users, X } from 'lucide-react';
import type { Settings, UnifiedMarketSignalSource } from '@/types/extention';
import { normalizeLocale, t, type Locale } from '@/utils/i18n';
import { formatAgeShort, formatCompactNumber } from '@/utils/format';
import { navigateToUrl, parsePlatformTokenLink, type SiteInfo } from '@/utils/sites';
import { pickMaxFiniteNumber } from '@/utils/value';
import { PLATFORM_OPTIONS, extractLaunchpadPlatform } from '@/constants/launchpad';
import { XSniperFilterSection } from './XSniperFilterSection';

type NewPoolMonitorContentProps = {
  siteInfo: SiteInfo | null;
  active: boolean;
  settings: Settings | null;
};

type NewPoolMonitorPanelProps = {
  siteInfo: SiteInfo | null;
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  settings: Settings | null;
  displayMode: 'floating' | 'tab';
  onDisplayModeChange: (mode: 'floating' | 'tab') => void;
};

type MarketTokenEventDetail = {
  source: UnifiedMarketSignalSource;
  channel: string;
  tokenData: any;
  receivedAtMs: number;
};

type MonitorFilterDraft = {
  platforms?: string[];
  minMarketCapUsd?: string;
  maxMarketCapUsd?: string;
  minHolders?: string;
  maxHolders?: string;
  minKol?: string;
  maxKol?: string;
  minTickerLen?: string;
  maxTickerLen?: string;
  minTokenAgeSeconds?: string;
  maxTokenAgeSeconds?: string;
  minDevHoldPercent?: string;
  maxDevHoldPercent?: string;
  minDevMaxBuyPercent?: string;
  maxDevMaxBuyPercent?: string;
  minViewerCount?: string;
  maxViewerCount?: string;
  minDevCreatedTokenCount?: string;
  maxDevCreatedTokenCount?: string;
  blockIfDevSell?: boolean;
};

type MarketTokenRow = {
  tokenAddress: string;
  channel: string;
  signalId: string;
  receivedAtMs: number;
  updatedAtMs: number;
  createdAtMs: number;
  tokenName?: string;
  tokenSymbol?: string;
  tokenLogo?: string;
  marketCapUsd?: number;
  prevMarketCapUsd?: number;
  marketCapChangedAtMs?: number;
  marketCapDirection?: 'up' | 'down';
  vol24hUsd?: number;
  holders?: number;
  kol?: number;
  viewerCount?: number;
  top10HoldRatio?: number;
  devHoldPercent?: number;
  devMaxBuyPercent?: number;
  devCreatedTokenCount?: number;
  devHasSold?: boolean;
  launchpadPlatform?: string;
  tweetAuthor?: string;
  tweetId?: string;
  tweetUrl?: string;
  website?: string;
  websiteHost?: string;
  groupLabel?: string;
};

type GroupSourceFilter = 'all' | 'withTweet' | 'withoutTweet';
type MonitorViewMode = 'grouped' | 'globalHot';

type MarketTokenGroup = {
  key: string;
  kind: 'tweet' | 'website' | 'image' | 'name' | 'address';
  label: string;
  tweetAuthor?: string;
  tweetId?: string;
  tweetUrl?: string;
  website?: string;
  latestAtMs: number;
  newestTokenAtMs: number;
  topMarketCapUsd: number;
  totalCount: number;
  tokens: MarketTokenRow[];
};

const MARKET_TOKEN_CACHE_LIMIT = 1200;
const GROUP_PAGE_SIZE = 20;
const HOT_PAGE_SIZE = 30;
const FILTER_STORAGE_KEY = 'dagobang_newpool_monitor_filters_v1';
const FILTER_OPEN_STORAGE_KEY = 'dagobang_newpool_monitor_filter_open_v1';
const GROUP_SOURCE_FILTER_STORAGE_KEY = 'dagobang_newpool_monitor_group_source_filter_v1';
const VIEW_MODE_STORAGE_KEY = 'dagobang_newpool_monitor_view_mode_v1';
const ROWS_STORAGE_KEY = 'dagobang_newpool_monitor_rows_v1';
const ALL_PLATFORM_VALUES = PLATFORM_OPTIONS.map((x) => x.value);
const MCAP_HIGHLIGHT_WINDOW_MS = 6000;
const PANEL_MIN_HEIGHT = 420;
const PANEL_DEFAULT_HEIGHT = 640;
const PERSISTED_ROWS_LIMIT = 400;

const parseNumber = (v: any) => {
  if (v == null) return null;
  const s = typeof v === 'string' ? v.trim() : String(v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const parseKNumber = (v: any) => {
  const n = parseNumber(v);
  return n == null ? null : n * 1000;
};

const normalizeEpochMs = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (n >= 1e14) return Math.floor(n / 1000);
  if (n < 1e11) return Math.floor(n * 1000);
  return Math.floor(n);
};

const toFiniteNumber = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const pickString = (...values: unknown[]) => {
  for (const value of values) {
    const s = typeof value === 'string' ? value.trim() : '';
    if (s) return s;
  }
  return undefined;
};

const shouldUseIncomingValue = (value: unknown) => {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  return true;
};

const mergeTokenRow = (prev: MarketTokenRow | undefined, next: MarketTokenRow): MarketTokenRow => {
  if (!prev) return next;
  const merged: MarketTokenRow = {
    ...prev,
    tokenAddress: next.tokenAddress,
    signalId: next.signalId,
    channel: next.channel,
    receivedAtMs: Math.max(prev.receivedAtMs, next.receivedAtMs),
    updatedAtMs: Math.max(prev.updatedAtMs, next.updatedAtMs),
    createdAtMs: Math.min(prev.createdAtMs, next.createdAtMs),
  };
  if (
    typeof prev.marketCapUsd === 'number' &&
    Number.isFinite(prev.marketCapUsd) &&
    typeof next.marketCapUsd === 'number' &&
    Number.isFinite(next.marketCapUsd) &&
    next.marketCapUsd !== prev.marketCapUsd
  ) {
    merged.prevMarketCapUsd = prev.marketCapUsd;
    merged.marketCapChangedAtMs = Date.now();
    merged.marketCapDirection = next.marketCapUsd > prev.marketCapUsd ? 'up' : 'down';
  }
  const keys = Object.keys(next) as Array<keyof MarketTokenRow>;
  for (const key of keys) {
    if (key === 'tokenAddress' || key === 'signalId' || key === 'channel' || key === 'receivedAtMs' || key === 'updatedAtMs' || key === 'createdAtMs') continue;
    const value = next[key];
    if (!shouldUseIncomingValue(value)) continue;
    if (key === 'devMaxBuyPercent') {
      (merged as any)[key] = pickMaxFiniteNumber(value, prev.devMaxBuyPercent);
      continue;
    }
    (merged as any)[key] = value;
  }
  return merged;
};

const collectStringValues = (input: unknown, out: string[], seen: Set<unknown>, depth = 0) => {
  if (input == null || depth > 3 || out.length >= 80) return;
  if (typeof input === 'string') {
    const s = input.trim();
    if (s) out.push(s);
    return;
  }
  if (typeof input !== 'object') return;
  if (seen.has(input)) return;
  seen.add(input);
  if (Array.isArray(input)) {
    for (const item of input) collectStringValues(item, out, seen, depth + 1);
    return;
  }
  for (const value of Object.values(input as Record<string, unknown>)) {
    collectStringValues(value, out, seen, depth + 1);
  }
};

const findFirstUrl = (values: string[], predicate?: (url: URL) => boolean) => {
  for (const value of values) {
    const matches = value.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
    for (const raw of matches) {
      try {
        const url = new URL(raw);
        if (!predicate || predicate(url)) return url.toString();
      } catch {
      }
    }
  }
  return undefined;
};

const normalizeHost = (input: string) => {
  try {
    const host = new URL(input).hostname.replace(/^www\./i, '').toLowerCase();
    return host || undefined;
  } catch {
    return undefined;
  }
};

const normalizeImageUrl = (input: unknown) => {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return undefined;
  if (/^data:image\//i.test(raw)) return raw;
  if (/^https?:\/\//i.test(raw)) return raw.replace(/^http:\/\//i, 'https://');
  if (raw.startsWith('//')) return `https:${raw}`;
  if (/^ipfs:\/\//i.test(raw)) return raw.replace(/^ipfs:\/\//i, 'https://ipfs.io/ipfs/');
  if (/^[a-z0-9]{46,}$/i.test(raw)) return `https://ipfs.io/ipfs/${raw}`;
  return undefined;
};

const normalizeTweetAuthor = (input: unknown) => {
  const raw = typeof input === 'string' ? input.trim().replace(/^@/, '') : '';
  if (!raw) return undefined;
  const normalized = raw.toLowerCase();
  if (normalized === 'i' || normalized === 'status' || normalized === 'home' || normalized === 'explore') return undefined;
  return raw;
};

const extractWebsiteRef = (tokenData: any): { website?: string; websiteHost?: string } => {
  const strings: string[] = [];
  collectStringValues(tokenData, strings, new Set());
  const website = findFirstUrl(strings, (url) => {
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    if (!host) return false;
    if (host.includes('x.com') || host.includes('twitter.com')) return false;
    if (host.includes('t.me') || host.includes('telegram.me')) return false;
    if (host.includes('discord.gg') || host.includes('discord.com')) return false;
    const pathname = url.pathname.toLowerCase();
    if (/\.(png|jpg|jpeg|gif|webp|svg)$/.test(pathname)) return false;
    return true;
  });
  return {
    website,
    websiteHost: website ? normalizeHost(website) : undefined,
  };
};

const extractTweetRef = (tokenData: any): { tweetAuthor?: string; tweetId?: string; tweetUrl?: string } => {
  const strings: string[] = [];
  collectStringValues(tokenData, strings, new Set());
  for (const value of strings) {
    const fullMatch = value.match(/https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/([^/\s]+)\/status\/(\d{6,})/i);
    if (fullMatch?.[2]) {
      const author = normalizeTweetAuthor(fullMatch[1]);
      return { tweetAuthor: author, tweetId: fullMatch[2], tweetUrl: fullMatch[0] };
    }
    const pathMatch = value.match(/(?:^|\/)?([A-Za-z0-9_]{1,32})\/status\/(\d{6,})(?:\?[^\s]*)?$/i);
    if (pathMatch?.[2]) {
      const author = normalizeTweetAuthor(pathMatch[1]);
      const tweetId = pathMatch[2];
      return {
        tweetAuthor: author,
        tweetId,
        tweetUrl: author ? `https://x.com/${author}/status/${tweetId}` : `https://x.com/i/status/${tweetId}`,
      };
    }
  }
  const directAuthor = normalizeTweetAuthor(pickString(
    tokenData?.m_x_user,
    tokenData?.f?.m_x_user,
    tokenData?.tweetUserScreen,
    tokenData?.userScreen,
    tokenData?.twitterScreenName,
    tokenData?.twUser,
    tokenData?.twUserScreen,
  ));
  const directMx = pickString(tokenData?.m_x, tokenData?.f?.m_x);
  if (directMx) {
    const directMxFull = directMx.match(/https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/([^/\s]+)\/status\/(\d{6,})/i);
    if (directMxFull?.[2]) {
      return { tweetAuthor: normalizeTweetAuthor(directMxFull[1]), tweetId: directMxFull[2], tweetUrl: directMxFull[0] };
    }
    const directMxPath = directMx.match(/([A-Za-z0-9_]{1,32})\/status\/(\d{6,})(?:\?[^\s]*)?$/i);
    if (directMxPath?.[2]) {
      const author = normalizeTweetAuthor(directMxPath[1]);
      return {
        tweetAuthor: author,
        tweetId: directMxPath[2],
        tweetUrl: author ? `https://x.com/${author}/status/${directMxPath[2]}` : `https://x.com/i/status/${directMxPath[2]}`,
      };
    }
  }
  const directId = pickString(tokenData?.tweetId, tokenData?.sourceTweetId, tokenData?.twId);
  if (directId && /^\d{6,}$/.test(directId)) {
    return {
      tweetAuthor: directAuthor,
      tweetId: directId,
      tweetUrl: directAuthor ? `https://x.com/${directAuthor}/status/${directId}` : `https://x.com/i/status/${directId}`,
    };
  }
  return {};
};

const extractImageRef = (tokenData: any) => {
  const candidate = normalizeImageUrl(pickString(
    tokenData?.tokenLogo,
    tokenData?.logo,
    tokenData?.image,
    tokenData?.img,
    tokenData?.icon,
    tokenData?.avatar,
    tokenData?.pic,
    tokenData?.f?.l,
    tokenData?.f?.logo,
    tokenData?.f?.image,
    tokenData?.l,
  ));
  if (candidate) return candidate;
  const strings: string[] = [];
  collectStringValues(tokenData, strings, new Set());
  const found = findFirstUrl(strings, (url) => /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(url.pathname) || url.hostname.length > 0);
  return normalizeImageUrl(found);
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

const createDefaultFilterDraft = (settings: Settings | null): MonitorFilterDraft => {
  const source = ((settings as any)?.autoTrade?.newCoinSnipe ?? {}) as any;
  return {
    platforms: Array.isArray(source.platforms) ? source.platforms.map((x: any) => String(x).trim().toLowerCase()).filter(Boolean) : PLATFORM_OPTIONS.map((x) => x.value),
    minMarketCapUsd: String(source.minMarketCapUsd ?? ''),
    maxMarketCapUsd: String(source.maxMarketCapUsd ?? ''),
    minHolders: String(source.minHolders ?? ''),
    maxHolders: String(source.maxHolders ?? ''),
    minKol: String(source.minKol ?? ''),
    maxKol: String(source.maxKol ?? ''),
    minTickerLen: String(source.minTickerLen ?? ''),
    maxTickerLen: String(source.maxTickerLen ?? ''),
    minTokenAgeSeconds: String(source.minTokenAgeSeconds ?? ''),
    maxTokenAgeSeconds: String(source.maxTokenAgeSeconds ?? ''),
    minDevHoldPercent: String(source.minDevHoldPercent ?? ''),
    maxDevHoldPercent: String(source.maxDevHoldPercent ?? ''),
    minDevMaxBuyPercent: String((source as any).minDevMaxBuyPercent ?? ''),
    maxDevMaxBuyPercent: String((source as any).maxDevMaxBuyPercent ?? ''),
    minViewerCount: String((source as any).minViewerCount ?? ''),
    maxViewerCount: String((source as any).maxViewerCount ?? ''),
    minDevCreatedTokenCount: String((source as any).minDevCreatedTokenCount ?? ''),
    maxDevCreatedTokenCount: String((source as any).maxDevCreatedTokenCount ?? ''),
    blockIfDevSell: source.blockIfDevSell === true,
  };
};

const buildMarketTokenRow = (detail: MarketTokenEventDetail): MarketTokenRow | null => {
  const tokenData = detail.tokenData;
  const tokenAddress = pickString(tokenData?.tokenAddress, tokenData?.address, tokenData?.a)?.toLowerCase();
  if (!tokenAddress || !/^0x[a-f0-9]{40}$/i.test(tokenAddress)) return null;
  const createdAtMs = normalizeEpochMs(
    tokenData?.createdAtMs ??
    tokenData?.createdAt ??
    tokenData?.created_at ??
    tokenData?.launchAt ??
    tokenData?.launch_at ??
    tokenData?.ct ??
    tokenData?.ot
  );
  if (typeof createdAtMs !== 'number' || createdAtMs <= 0) return null;
  const updatedAtMs = normalizeEpochMs(tokenData?.updatedAtMs ?? tokenData?.ut ?? detail.receivedAtMs) ?? detail.receivedAtMs;
  const { tweetAuthor, tweetId, tweetUrl } = extractTweetRef(tokenData);
  const { website, websiteHost } = extractWebsiteRef(tokenData);
  const tokenLogo = extractImageRef(tokenData) ?? pickString(tokenData?.tokenLogo, tokenData?.logo, tokenData?.f?.l, tokenData?.l);
  const devHoldPercentRaw = toFiniteNumber(tokenData?.devHoldPercent ?? tokenData?.d_br);
  const devMaxBuyPercentRaw = toFiniteNumber(tokenData?.devMaxBuyPercent ?? tokenData?.d_br);
  return {
    tokenAddress,
    signalId: `${detail.source}:${detail.channel}:${tokenAddress}`,
    channel: detail.channel,
    receivedAtMs: detail.receivedAtMs,
    updatedAtMs,
    createdAtMs,
    tokenName: pickString(tokenData?.tokenName, tokenData?.name, tokenData?.nm),
    tokenSymbol: pickString(tokenData?.tokenSymbol, tokenData?.symbol, tokenData?.s),
    tokenLogo: tokenLogo ?? undefined,
    marketCapUsd: toFiniteNumber(tokenData?.marketCapUsd ?? tokenData?.mc),
    vol24hUsd: toFiniteNumber(tokenData?.vol24hUsd ?? tokenData?.v24h),
    holders: toFiniteNumber(tokenData?.holders ?? tokenData?.hd),
    kol: toFiniteNumber(tokenData?.kol),
    viewerCount: toFiniteNumber(tokenData?.viewerCount ?? tokenData?.v_c),
    top10HoldRatio: toFiniteNumber(tokenData?.top10HoldRatio ?? tokenData?.t10),
    devHoldPercent: devHoldPercentRaw != null ? (devHoldPercentRaw >= 0 && devHoldPercentRaw <= 1 ? devHoldPercentRaw * 100 : devHoldPercentRaw) : undefined,
    devMaxBuyPercent: devMaxBuyPercentRaw != null ? (devMaxBuyPercentRaw >= 0 && devMaxBuyPercentRaw <= 1 ? devMaxBuyPercentRaw * 100 : devMaxBuyPercentRaw) : undefined,
    devCreatedTokenCount: toFiniteNumber(tokenData?.devCreatedTokenCount ?? tokenData?.d_ccc),
    devHasSold: typeof tokenData?.devHasSold === 'boolean'
      ? tokenData.devHasSold
      : typeof tokenData?.devTokenStatus === 'string'
        ? tokenData.devTokenStatus.toLowerCase().includes('sell')
        : typeof tokenData?.d_ts === 'string'
          ? String(tokenData.d_ts).toLowerCase().includes('sell')
          : undefined,
    launchpadPlatform: pickString(tokenData?.launchpadPlatform, extractLaunchpadPlatform(tokenData)),
    tweetAuthor,
    tweetId,
    tweetUrl,
    website,
    websiteHost,
  };
};

const ingestRows = (map: Map<string, MarketTokenRow>, items: MarketTokenEventDetail[]) => {
  for (const item of items) {
    const row = buildMarketTokenRow(item);
    if (!row) continue;
    map.set(row.tokenAddress, mergeTokenRow(map.get(row.tokenAddress), row));
  }
};

const resolveGroupInfo = (row: MarketTokenRow): Pick<MarketTokenGroup, 'key' | 'kind' | 'label' | 'tweetAuthor' | 'tweetId' | 'tweetUrl' | 'website'> => {
  if (row.tweetId) {
    const author = row.tweetAuthor?.replace(/^@/, '').trim();
    return {
      key: `tweet:${row.tweetId}`,
      kind: 'tweet',
      label: row.groupLabel || (author ? `@${author}` : `Tweet #${row.tweetId}`),
      tweetAuthor: author,
      tweetId: row.tweetId,
      tweetUrl: row.tweetUrl,
    };
  }
  if (row.websiteHost) {
    return {
      key: `website:${row.websiteHost}`,
      kind: 'website',
      label: row.websiteHost,
      website: row.website,
    };
  }
  if (row.tokenLogo) {
    return {
      key: `image:${row.tokenLogo}`,
      kind: 'image',
      label: '同图分组',
    };
  }
  const nameKey = (pickString(row.tokenSymbol, row.tokenName) || row.tokenAddress).toLowerCase();
  if (nameKey) {
    return {
      key: `name:${nameKey}`,
      kind: 'name',
      label: pickString(row.tokenSymbol, row.tokenName) || row.tokenAddress,
    };
  }
  return {
    key: `address:${row.tokenAddress}`,
    kind: 'address',
    label: row.tokenAddress,
  };
};

const matchesTokenFilter = (row: MarketTokenRow, filterDraft: MonitorFilterDraft) => {
  const selectedPlatforms = Array.isArray(filterDraft.platforms)
    ? filterDraft.platforms.map((x) => String(x).trim().toLowerCase()).filter(Boolean)
    : [];
  const shouldFilterPlatforms =
    selectedPlatforms.length > 0 &&
    selectedPlatforms.length < ALL_PLATFORM_VALUES.length &&
    !ALL_PLATFORM_VALUES.every((value) => selectedPlatforms.includes(value));
  if (shouldFilterPlatforms) {
    const platform = String(row.launchpadPlatform || '').trim().toLowerCase();
    if (!platform || !selectedPlatforms.includes(platform)) return false;
  }
  const minMcap = parseKNumber(filterDraft.minMarketCapUsd);
  const maxMcap = parseKNumber(filterDraft.maxMarketCapUsd);
  if (minMcap != null && (row.marketCapUsd == null || row.marketCapUsd < minMcap)) return false;
  if (maxMcap != null && (row.marketCapUsd == null || row.marketCapUsd > maxMcap)) return false;
  const minHolders = parseNumber(filterDraft.minHolders);
  const maxHolders = parseNumber(filterDraft.maxHolders);
  if (minHolders != null && (row.holders == null || row.holders < minHolders)) return false;
  if (maxHolders != null && (row.holders == null || row.holders > maxHolders)) return false;
  const minKol = parseNumber(filterDraft.minKol);
  const maxKol = parseNumber(filterDraft.maxKol);
  if (minKol != null && (row.kol == null || row.kol < minKol)) return false;
  if (maxKol != null && (row.kol == null || row.kol > maxKol)) return false;
  const minTickerLen = parseNumber(filterDraft.minTickerLen);
  const maxTickerLen = parseNumber(filterDraft.maxTickerLen);
  if (minTickerLen != null || maxTickerLen != null) {
    const symbol = String(row.tokenSymbol || '').trim();
    if (!symbol) return false;
    const len = computeTickerLen(symbol);
    if (minTickerLen != null && len < minTickerLen) return false;
    if (maxTickerLen != null && len > maxTickerLen) return false;
  }
  const minAgeSeconds = parseNumber(filterDraft.minTokenAgeSeconds);
  const maxAgeSeconds = parseNumber(filterDraft.maxTokenAgeSeconds);
  if (minAgeSeconds != null || maxAgeSeconds != null) {
    const ageBaseMs = row.createdAtMs;
    const ageSeconds = Math.max(0, Math.floor((Date.now() - ageBaseMs) / 1000));
    if (minAgeSeconds != null && ageSeconds < minAgeSeconds) return false;
    if (maxAgeSeconds != null && ageSeconds > maxAgeSeconds) return false;
  }
  const minDevHold = parseNumber(filterDraft.minDevHoldPercent);
  const maxDevHold = parseNumber(filterDraft.maxDevHoldPercent);
  if (minDevHold != null && (row.devHoldPercent == null || row.devHoldPercent < minDevHold)) return false;
  if (maxDevHold != null && (row.devHoldPercent == null || row.devHoldPercent > maxDevHold)) return false;
  const minDevMaxBuy = parseNumber(filterDraft.minDevMaxBuyPercent);
  const maxDevMaxBuy = parseNumber(filterDraft.maxDevMaxBuyPercent);
  if (minDevMaxBuy != null && (row.devMaxBuyPercent == null || row.devMaxBuyPercent < minDevMaxBuy)) return false;
  if (maxDevMaxBuy != null && (row.devMaxBuyPercent == null || row.devMaxBuyPercent > maxDevMaxBuy)) return false;
  const minViewer = parseNumber(filterDraft.minViewerCount);
  const maxViewer = parseNumber(filterDraft.maxViewerCount);
  if (minViewer != null && (row.viewerCount == null || row.viewerCount < minViewer)) return false;
  if (maxViewer != null && (row.viewerCount == null || row.viewerCount > maxViewer)) return false;
  const minDevCreated = parseNumber(filterDraft.minDevCreatedTokenCount);
  const maxDevCreated = parseNumber(filterDraft.maxDevCreatedTokenCount);
  if (minDevCreated != null && (row.devCreatedTokenCount == null || row.devCreatedTokenCount < minDevCreated)) return false;
  if (maxDevCreated != null && (row.devCreatedTokenCount == null || row.devCreatedTokenCount > maxDevCreated)) return false;
  if (filterDraft.blockIfDevSell && row.devHasSold === true) return false;
  return true;
};

const getGroupIcon = (kind: MarketTokenGroup['kind']) => {
  if (kind === 'tweet') return <AtSign size={12} />;
  if (kind === 'website') return <Globe2 size={12} />;
  if (kind === 'image') return <ImageIcon size={12} />;
  return <Layers3 size={12} />;
};

const clampPanelHeight = (value: number, panelTop: number) => {
  const viewportHeight = window.innerHeight || 0;
  const maxHeight = Math.max(PANEL_MIN_HEIGHT, viewportHeight - Math.max(0, panelTop) - 12);
  return Math.min(Math.max(PANEL_MIN_HEIGHT, value), maxHeight);
};

const clampPanelPos = (value: { x: number; y: number }, panelWidth: number, panelHeight: number) => {
  const width = window.innerWidth || 0;
  const height = window.innerHeight || 0;
  const clampedX = Math.min(Math.max(0, value.x), Math.max(0, width - panelWidth));
  const clampedY = Math.min(Math.max(0, value.y), Math.max(0, height - panelHeight));
  return { x: clampedX, y: clampedY };
};

const loadPersistedRows = (): MarketTokenRow[] => {
  try {
    const raw = window.localStorage.getItem(ROWS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is MarketTokenRow => {
        return !!item
          && typeof item === 'object'
          && typeof (item as any).tokenAddress === 'string'
          && /^0x[a-f0-9]{40}$/i.test((item as any).tokenAddress)
          && typeof (item as any).createdAtMs === 'number'
          && Number.isFinite((item as any).createdAtMs)
          && typeof (item as any).updatedAtMs === 'number'
          && Number.isFinite((item as any).updatedAtMs);
      })
      .slice(0, PERSISTED_ROWS_LIMIT);
  } catch {
    return [];
  }
};

const persistRows = (map: Map<string, MarketTokenRow>) => {
  try {
    const rows = Array.from(map.values())
      .sort((a, b) => {
        const createdDiff = b.createdAtMs - a.createdAtMs;
        if (createdDiff !== 0) return createdDiff;
        return b.updatedAtMs - a.updatedAtMs;
      })
      .slice(0, PERSISTED_ROWS_LIMIT);
    window.localStorage.setItem(ROWS_STORAGE_KEY, JSON.stringify(rows));
  } catch {
  }
};

const getPlatformBadgeClassName = (platform?: string) => {
  const normalized = typeof platform === 'string' ? platform.trim().toLowerCase() : '';
  if (normalized === 'fourmeme') return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300';
  if (normalized === 'flap') return 'border-violet-500/40 bg-violet-500/10 text-violet-300';
  return 'border-zinc-800 text-zinc-500';
};

const formatMetricPercent = (value: number | null | undefined) => {
  if (value == null) return '-';
  if (value < 0.0001) return '0%';
  if (value >= 100) return `${Math.round(value)}%`;
  if (value >= 10) return `${value.toFixed(1)}%`;
  return `${value.toFixed(1)}%`;
};

const compareByMarketCapDesc = (a: MarketTokenRow, b: MarketTokenRow) => {
  const mcDiff = (b.marketCapUsd ?? 0) - (a.marketCapUsd ?? 0);
  if (mcDiff !== 0) return mcDiff;
  const updatedDiff = b.updatedAtMs - a.updatedAtMs;
  if (updatedDiff !== 0) return updatedDiff;
  return b.createdAtMs - a.createdAtMs;
};

const compareByViewerAndMarketCapDesc = (a: MarketTokenRow, b: MarketTokenRow) => {
  const viewerDiff = (b.viewerCount ?? -1) - (a.viewerCount ?? -1);
  if (viewerDiff !== 0) return viewerDiff;
  return compareByMarketCapDesc(a, b);
};

type TokenRowCardProps = {
  row: MarketTokenRow;
  rank: number;
  listKey: string;
  resolvedSiteInfo: SiteInfo;
  tt: (key: string, subs?: Array<string | number>) => string;
};

function TokenRowCard({
  row,
  rank,
  listKey,
  resolvedSiteInfo,
  tt,
}: TokenRowCardProps) {
  const shortAddr = `${row.tokenAddress.slice(0, 6)}...${row.tokenAddress.slice(-4)}`;
  const symbol = row.tokenSymbol?.trim() || '';
  const tokenName = row.tokenName?.trim() || '';
  const displayName = symbol || tokenName || shortAddr;
  const ageText = formatAgeShort(row.createdAtMs);
  const marketCapHighlightActive =
    typeof row.marketCapChangedAtMs === 'number' &&
    Date.now() - row.marketCapChangedAtMs <= MCAP_HIGHLIGHT_WINDOW_MS &&
    row.marketCapDirection != null;
  const marketCapValueClassName = (() => {
    if (row.marketCapUsd == null || row.marketCapUsd <= 0) return 'text-zinc-500';
    if (row.marketCapUsd >= 50_000) return 'text-amber-300';
    if (row.marketCapUsd >= 30_000) return 'text-sky-300';
    if (row.marketCapUsd >= 10_000) return 'text-emerald-300';
    return 'text-zinc-200';
  })();
  const marketCapPrefix = marketCapHighlightActive
    ? row.marketCapDirection === 'up'
      ? '▲'
      : '▼'
    : '';
  const marketCapPrefixClassName = marketCapHighlightActive
    ? row.marketCapDirection === 'up'
      ? 'text-emerald-300'
      : 'text-rose-300'
    : 'text-transparent';
  const volumeClassName = row.vol24hUsd != null && row.vol24hUsd > 0 ? 'text-zinc-100' : 'text-zinc-500';
  const top10HoldRatioPct = typeof row.top10HoldRatio === 'number' ? row.top10HoldRatio * 100 : null;
  const getRatioClassName = (pct: number | null) => {
    if (pct == null) return 'text-zinc-500';
    if (pct > 0 && pct < 10) return 'text-emerald-300';
    if (pct > 10) return 'text-rose-300';
    return 'text-zinc-400';
  };
  const devHoldClassName = getRatioClassName(typeof row.devHoldPercent === 'number' ? row.devHoldPercent : null);
  const devMaxBuyClassName = getRatioClassName(typeof row.devMaxBuyPercent === 'number' ? row.devMaxBuyPercent : null);
  const top10RatioClassName = getRatioClassName(top10HoldRatioPct);
  const holdersClassName = (() => {
    if (row.holders == null) return 'text-zinc-500';
    if (row.holders >= 100) return 'text-cyan-200';
    if (row.holders >= 30) return 'text-sky-300';
    if (row.holders >= 10) return 'text-sky-200';
    return 'text-zinc-400';
  })();
  const viewersClassName = (() => {
    if (row.viewerCount == null) return 'text-zinc-500';
    if (row.viewerCount >= 100) return 'text-violet-200';
    if (row.viewerCount >= 30) return 'text-fuchsia-300';
    if (row.viewerCount >= 10) return 'text-violet-300';
    return 'text-zinc-400';
  })();
  const rankCornerClassName = rank === 1
    ? 'bg-amber-500/90'
    : rank === 2
      ? 'bg-zinc-500/90'
      : rank === 3
        ? 'bg-orange-600/90'
        : 'bg-zinc-700/90';
  const metricItems = [
    {
      key: 'devCreated',
      title: tt('contentUi.xMonitor.tooltip.devCreatedTokenCount'),
      icon: Coins,
      value: row.devCreatedTokenCount == null ? '-' : formatCompactNumber(Math.round(row.devCreatedTokenCount)),
      className: row.devCreatedTokenCount == null ? 'text-zinc-500' : 'text-zinc-300',
    },
    {
      key: 'devHold',
      title: tt('contentUi.xMonitor.tooltip.devHoldPercent'),
      icon: ChefHat,
      value: formatMetricPercent(row.devHoldPercent),
      className: row.devHoldPercent == null ? 'text-zinc-500' : devHoldClassName,
    },
    {
      key: 'devMaxBuy',
      title: tt('contentUi.xMonitor.tooltip.devMaxBuyPercent'),
      icon: Flame,
      value: formatMetricPercent(row.devMaxBuyPercent),
      className: row.devMaxBuyPercent == null ? 'text-zinc-500' : devMaxBuyClassName,
    },
    {
      key: 'top10',
      title: tt('contentUi.xMonitor.tooltip.top10HoldRatio'),
      icon: UserStar,
      value: formatMetricPercent(top10HoldRatioPct),
      className: top10HoldRatioPct == null ? 'text-zinc-500' : top10RatioClassName,
    },
    {
      key: 'kol',
      title: tt('contentUi.xMonitor.tooltip.kol'),
      icon: Trophy,
      value: row.kol == null ? '-' : formatCompactNumber(Math.round(row.kol)),
      className: row.kol == null ? 'text-zinc-500' : row.kol > 0 ? 'text-amber-200' : 'text-zinc-500',
    },
    {
      key: 'holders',
      title: tt('contentUi.xMonitor.tooltip.holders'),
      icon: Users,
      value: row.holders == null ? '-' : formatCompactNumber(Math.round(row.holders)),
      className: holdersClassName,
    },
    {
      key: 'viewers',
      title: tt('contentUi.xMonitor.tooltip.viewerCount'),
      icon: Eye,
      value: row.viewerCount == null ? '-' : formatCompactNumber(Math.round(row.viewerCount)),
      className: viewersClassName,
    },
  ] as const;

  return (
    <button
      type="button"
      className="relative grid w-full grid-cols-[52px_minmax(0,1fr)] items-start gap-x-2.5 gap-y-1 rounded-md px-1 py-1.5 text-left hover:bg-zinc-900/60"
      onClick={() => navigateToUrl(parsePlatformTokenLink(resolvedSiteInfo, row.tokenAddress))}
    >
      <span
        className={`pointer-events-none absolute left-0 top-0 h-6 w-6 ${rankCornerClassName}`}
        style={{ clipPath: 'polygon(0 0, 100% 0, 0 100%)' }}
      />
      <span className="pointer-events-none absolute left-[4px] top-[1px] text-[9px] font-bold leading-none text-[#111]">
        {rank}
      </span>
      <div className="flex h-[52px] w-[52px] shrink-0 items-center justify-center overflow-hidden rounded-md border border-zinc-800 bg-zinc-950 text-[10px] text-zinc-500">
        {row.tokenLogo ? (
          <img
            src={row.tokenLogo}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        ) : (
          <ImageIcon size={14} />
        )}
      </div>
      <div className="min-w-0 pt-0.5">
        <div className="grid grid-cols-[minmax(0,1fr)_78px] items-start gap-x-2 gap-y-1">
          <div className="min-w-0">
            <div className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-1.5 leading-none">
              <div className="min-w-0 truncate text-[13px] font-semibold text-zinc-100">{displayName}</div>
              {symbol && tokenName ? (
                <div className="min-w-0 truncate text-[11px] text-zinc-500">{tokenName}</div>
              ) : null}
            </div>
            <div className={`mt-1 flex items-center text-[10px] ${row.launchpadPlatform ? 'gap-2' : 'gap-1.5'}`}>
              <span className="min-w-0 truncate font-mono text-[10px] text-zinc-500">{shortAddr}</span>
              <span className={`inline-flex items-center font-bold text-[12px] leading-none ${typeof row.createdAtMs === 'number' && Date.now() - row.createdAtMs <= 60_000
                ? 'text-emerald-300'
                : typeof row.createdAtMs === 'number' && Date.now() - row.createdAtMs <= 5 * 60_000
                  ? 'text-amber-300'
                  : 'text-zinc-200'
                }`}>
                {ageText}
              </span>
              {row.launchpadPlatform ? (
                <span className={`rounded border px-1 py-0.5 text-[9px] ${getPlatformBadgeClassName(row.launchpadPlatform)}`}>{row.launchpadPlatform}</span>
              ) : null}
            </div>
          </div>
          <div className="w-[78px] shrink-0 self-start pt-0.5 text-right leading-tight">
            <div className="flex flex-row items-center justify-end gap-0.5">
              <span className="mr-1 text-[12px] text-zinc-500">MC </span>
              <div className="flex items-center justify-end gap-0.5 text-[14px] font-semibold tabular-nums">
                <span className={marketCapPrefixClassName}>{marketCapPrefix}</span>
                <span className={marketCapValueClassName}>
                  ${row.marketCapUsd != null ? formatCompactNumber(Math.round(row.marketCapUsd)) : '-'}
                </span>
              </div>
            </div>
            <div className={`mt-1 text-[12px] font-medium tabular-nums ${volumeClassName}`}>
              V ${row.vol24hUsd != null ? formatCompactNumber(Math.round(row.vol24hUsd)) : '-'}
            </div>
          </div>
        </div>
      </div>
      <div className="col-span-2 mt-0.5 grid grid-cols-[repeat(7,max-content)] justify-between gap-x-1 text-[10px] font-medium tracking-tight text-zinc-200">
        {metricItems.map((item) => {
          const Icon = item.icon;
          return (
            <span
              key={`${listKey}:${row.tokenAddress}:${item.key}`}
              title={item.title}
              className={`inline-flex items-center justify-center gap-0.5 whitespace-nowrap tabular-nums ${item.className}`}
            >
              <Icon size={12} className="shrink-0" />
              <span>{item.value}</span>
            </span>
          );
        })}
      </div>
    </button>
  );
}

export function NewPoolMonitorContent({
  siteInfo,
  active,
  settings,
}: NewPoolMonitorContentProps) {
  const resolvedSettings = useMemo<Settings | null>(() => settings ?? ((window as any).__DAGOBANG_SETTINGS__ ?? null), [settings]);
  const locale: Locale = normalizeLocale(resolvedSettings?.locale ?? 'zh_CN');
  const tt = (key: string, subs?: Array<string | number>) => t(key, locale, subs);
  const resolvedSiteInfo = siteInfo ?? { chain: 'bsc', tokenAddress: '', platform: 'gmgn', showBar: true };

  const tokenMapRef = useRef<Map<string, MarketTokenRow>>(new Map());
  const [tokenIds, setTokenIds] = useState<string[]>([]);
  const [groupPage, setGroupPage] = useState(1);
  const [globalPage, setGlobalPage] = useState(1);
  const [listHovered, setListHovered] = useState(false);
  const [frozenGroupKeys, setFrozenGroupKeys] = useState<string[] | null>(null);
  const [frozenGlobalTokenIds, setFrozenGlobalTokenIds] = useState<string[] | null>(null);
  const [viewMode, setViewMode] = useState<MonitorViewMode>(() => {
    try {
      const raw = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
      if (raw === 'grouped' || raw === 'globalHot') return raw;
    } catch {
    }
    return 'grouped';
  });
  const [filterOpen, setFilterOpen] = useState(() => {
    try {
      return window.localStorage.getItem(FILTER_OPEN_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [groupSourceFilter, setGroupSourceFilter] = useState<GroupSourceFilter>(() => {
    try {
      const raw = window.localStorage.getItem(GROUP_SOURCE_FILTER_STORAGE_KEY);
      if (raw === 'withTweet' || raw === 'withoutTweet' || raw === 'all') return raw;
    } catch {
    }
    return 'all';
  });
  const [filterDraft, setFilterDraft] = useState<MonitorFilterDraft>(() => {
    try {
      const raw = window.localStorage.getItem(FILTER_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed as MonitorFilterDraft;
      }
    } catch {
    }
    return createDefaultFilterDraft(resolvedSettings);
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(FILTER_OPEN_STORAGE_KEY, filterOpen ? '1' : '0');
    } catch {
    }
  }, [filterOpen]);

  useEffect(() => {
    try {
      window.localStorage.setItem(GROUP_SOURCE_FILTER_STORAGE_KEY, groupSourceFilter);
    } catch {
    }
  }, [groupSourceFilter]);

  useEffect(() => {
    try {
      window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode);
    } catch {
    }
  }, [viewMode]);

  useEffect(() => {
    try {
      window.localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filterDraft));
    } catch {
    }
  }, [filterDraft]);

  useEffect(() => {
    if (!active) return;
    const restoredRows = loadPersistedRows();
    tokenMapRef.current.clear();
    for (const row of restoredRows) {
      tokenMapRef.current.set(row.tokenAddress, row);
    }
    setTokenIds(
      restoredRows
        .slice()
        .sort((a, b) => b.createdAtMs - a.createdAtMs)
        .slice(0, MARKET_TOKEN_CACHE_LIMIT)
        .map((item) => item.tokenAddress)
    );
    const pendingDetails: MarketTokenEventDetail[] = [];
    let flushTimer: number | null = null;
    let persistTimer: number | null = null;
    const schedulePersist = () => {
      if (persistTimer != null) return;
      persistTimer = window.setTimeout(() => {
        persistTimer = null;
        persistRows(tokenMapRef.current);
      }, 600);
    };
    const syncIds = () => {
      const map = tokenMapRef.current;
      const nextIds = Array.from(map.values())
        .sort((a, b) => b.createdAtMs - a.createdAtMs)
        .slice(0, MARKET_TOKEN_CACHE_LIMIT)
        .map((item) => item.tokenAddress);
      setTokenIds(nextIds);
      schedulePersist();
    };
    const flush = () => {
      flushTimer = null;
      const map = tokenMapRef.current;
      const batch = pendingDetails.splice(0, pendingDetails.length);
      if (!batch.length) return;
      ingestRows(map, batch);
      syncIds();
    };
    const onBatch = (event: Event) => {
      const detail = (event as CustomEvent<{ items?: MarketTokenEventDetail[] }>).detail;
      const items = Array.isArray(detail?.items) ? detail.items : [];
      if (!items.length) return;
      pendingDetails.push(...items);
      if (flushTimer == null) flushTimer = window.setTimeout(flush, 80);
    };
    const onSnapshot = (event: Event) => {
      const detail = (event as CustomEvent<{ items?: MarketTokenEventDetail[] }>).detail;
      const items = Array.isArray(detail?.items) ? detail.items : [];
      if (!items.length) return;
      tokenMapRef.current.clear();
      ingestRows(tokenMapRef.current, items);
      syncIds();
    };
    try {
      (window as any).__DAGOBANG_NEWPOOL_MONITOR_ACTIVE__ = true;
    } catch {
    }
    window.addEventListener('dagobang-newpool-monitor-batch' as any, onBatch as any);
    window.addEventListener('dagobang-newpool-monitor-snapshot' as any, onSnapshot as any);
    window.dispatchEvent(new CustomEvent('dagobang-newpool-monitor-request-snapshot'));
    return () => {
      try {
        (window as any).__DAGOBANG_NEWPOOL_MONITOR_ACTIVE__ = false;
      } catch {
      }
      window.removeEventListener('dagobang-newpool-monitor-batch' as any, onBatch as any);
      window.removeEventListener('dagobang-newpool-monitor-snapshot' as any, onSnapshot as any);
      if (flushTimer != null) {
        window.clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (persistTimer != null) {
        window.clearTimeout(persistTimer);
        persistTimer = null;
      }
      flush();
      persistRows(tokenMapRef.current);
    };
  }, [active]);

  const tokenList = useMemo(() => {
    const map = tokenMapRef.current;
    return tokenIds.map((id) => map.get(id)).filter(Boolean) as MarketTokenRow[];
  }, [tokenIds]);

  const filteredTokens = useMemo(() => tokenList.filter((row) => matchesTokenFilter(row, filterDraft)), [tokenList, filterDraft]);

  const tokensBySource = useMemo(() => {
    const withTweet = filteredTokens.filter((row) => !!row.tweetId);
    const withoutTweet = filteredTokens.filter((row) => !row.tweetId);
    return {
      withTweet,
      withoutTweet,
    };
  }, [filteredTokens]);

  const groups = useMemo<MarketTokenGroup[]>(() => {
    const groupMap = new Map<string, MarketTokenGroup>();
    for (const row of filteredTokens) {
      const groupInfo = resolveGroupInfo(row);
      const current = groupMap.get(groupInfo.key);
      if (!current) {
        groupMap.set(groupInfo.key, {
          key: groupInfo.key,
          kind: groupInfo.kind,
          label: groupInfo.label,
          tweetAuthor: groupInfo.tweetAuthor,
          tweetId: groupInfo.tweetId,
          tweetUrl: groupInfo.tweetUrl,
          website: groupInfo.website,
          latestAtMs: row.updatedAtMs,
          newestTokenAtMs: row.createdAtMs,
          topMarketCapUsd: row.marketCapUsd ?? 0,
          totalCount: 1,
          tokens: [row],
        });
        continue;
      }
      current.tokens.push(row);
      current.totalCount += 1;
      current.latestAtMs = Math.max(current.latestAtMs, row.updatedAtMs);
      current.newestTokenAtMs = Math.max(current.newestTokenAtMs, row.createdAtMs);
      current.topMarketCapUsd = Math.max(current.topMarketCapUsd, row.marketCapUsd ?? 0);
      if (!current.tweetAuthor && groupInfo.tweetAuthor) current.tweetAuthor = groupInfo.tweetAuthor;
      if (!current.tweetId && groupInfo.tweetId) current.tweetId = groupInfo.tweetId;
      if (!current.tweetUrl && groupInfo.tweetUrl) current.tweetUrl = groupInfo.tweetUrl;
      if (!current.website && groupInfo.website) current.website = groupInfo.website;
    }
    const out = Array.from(groupMap.values()).map((group) => ({
      ...group,
      tokens: group.tokens
        .slice()
        .sort(compareByMarketCapDesc)
        .slice(0, 3),
    }));
    out.sort((a, b) => {
      const ageDiff = b.newestTokenAtMs - a.newestTokenAtMs;
      if (ageDiff !== 0) return ageDiff;
      const timeDiff = b.latestAtMs - a.latestAtMs;
      if (timeDiff !== 0) return timeDiff;
      return b.topMarketCapUsd - a.topMarketCapUsd;
    });
    return out;
  }, [filteredTokens]);

  useEffect(() => {
    setGroupPage(1);
  }, [filterDraft, groupSourceFilter, viewMode]);

  useEffect(() => {
    setGlobalPage(1);
  }, [filterDraft, groupSourceFilter, viewMode]);

  const groupsBySource = useMemo(() => {
    const withTweet = groups.filter((group) => group.kind === 'tweet');
    const withoutTweet = groups.filter((group) => group.kind !== 'tweet');
    return {
      withTweet,
      withoutTweet,
    };
  }, [groups]);

  const scopedGroups = useMemo(() => {
    if (groupSourceFilter === 'withTweet') return groupsBySource.withTweet;
    if (groupSourceFilter === 'withoutTweet') return groupsBySource.withoutTweet;
    return groups;
  }, [groups, groupsBySource, groupSourceFilter]);

  const scopedTokens = useMemo(() => {
    if (groupSourceFilter === 'withTweet') return tokensBySource.withTweet;
    if (groupSourceFilter === 'withoutTweet') return tokensBySource.withoutTweet;
    return filteredTokens;
  }, [filteredTokens, tokensBySource, groupSourceFilter]);

  const groupsForDisplay = useMemo(() => {
    if (!frozenGroupKeys?.length) return scopedGroups;
    const groupMap = new Map(scopedGroups.map((group) => [group.key, group] as const));
    return frozenGroupKeys
      .map((key) => groupMap.get(key))
      .filter(Boolean) as MarketTokenGroup[];
  }, [scopedGroups, frozenGroupKeys]);

  const visibleGroups = useMemo(() => groupsForDisplay.slice(0, groupPage * GROUP_PAGE_SIZE), [groupsForDisplay, groupPage]);
  const hasMoreGroups = visibleGroups.length < groupsForDisplay.length;

  const globalHotTokens = useMemo(
    () => scopedTokens.slice().sort(compareByViewerAndMarketCapDesc),
    [scopedTokens]
  );
  const globalHotTokensForDisplay = useMemo(() => {
    if (!frozenGlobalTokenIds?.length) return globalHotTokens;
    const tokenMap = new Map(globalHotTokens.map((row) => [row.tokenAddress, row] as const));
    return frozenGlobalTokenIds
      .map((id) => tokenMap.get(id))
      .filter(Boolean) as MarketTokenRow[];
  }, [globalHotTokens, frozenGlobalTokenIds]);
  const visibleGlobalHotTokens = useMemo(
    () => globalHotTokensForDisplay.slice(0, globalPage * HOT_PAGE_SIZE),
    [globalHotTokensForDisplay, globalPage]
  );
  const hasMoreGlobalHotTokens = visibleGlobalHotTokens.length < globalHotTokensForDisplay.length;

  const updateFilterDraft = (patch: Partial<MonitorFilterDraft>) => {
    setFilterDraft((prev) => ({
      ...prev,
      ...patch,
    }));
  };

  const handleListMouseEnter = () => {
    setListHovered(true);
    if (viewMode === 'grouped') {
      setFrozenGroupKeys(groupsForDisplay.map((group) => group.key));
      setFrozenGlobalTokenIds(null);
      return;
    }
    setFrozenGlobalTokenIds(globalHotTokensForDisplay.map((row) => row.tokenAddress));
    setFrozenGroupKeys(null);
  };

  const handleListMouseLeave = () => {
    setListHovered(false);
    setFrozenGroupKeys(null);
    setFrozenGlobalTokenIds(null);
  };

  if (!active) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-zinc-800/60 px-4 py-2">
        <div className="flex items-center justify-between gap-3">
          <div className="inline-flex shrink-0 rounded-xl border border-zinc-800 bg-zinc-950/70 p-1">
            {([
              ['grouped', '分组'],
              ['globalHot', '热榜'],
            ] as Array<[MonitorViewMode, string]>).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={
                  viewMode === value
                    ? 'min-w-[58px] rounded-lg border border-sky-500/50 bg-sky-500/15 px-3 py-1.5 text-[12px] font-medium text-sky-200'
                    : 'min-w-[58px] rounded-lg border border-transparent px-3 py-1.5 text-[12px] text-zinc-400 hover:text-zinc-200'
                }
                onClick={() => setViewMode(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {listHovered ? <div className="text-[10px] text-amber-300">暂停</div> : null}
            <button
              type="button"
              className="rounded-md border border-zinc-800 bg-zinc-900/40 px-2 py-1 text-[11px] text-zinc-300 hover:border-zinc-700"
              onClick={() => setFilterOpen((v) => !v)}
            >
              {filterOpen ? '收起' : '筛选'}
            </button>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-2 overflow-x-auto">
          {([
            ['all', `全部 ${viewMode === 'grouped' ? groups.length : filteredTokens.length}`],
            ['withTweet', `有推特 ${viewMode === 'grouped' ? groupsBySource.withTweet.length : tokensBySource.withTweet.length}`],
            ['withoutTweet', `无推特 ${viewMode === 'grouped' ? groupsBySource.withoutTweet.length : tokensBySource.withoutTweet.length}`],
          ] as Array<[GroupSourceFilter, string]>).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={
                groupSourceFilter === value
                  ? 'rounded-full border border-emerald-500/50 bg-emerald-500/15 px-2.5 py-1 text-[11px] text-emerald-200'
                  : 'rounded-full border border-zinc-700 bg-zinc-900/40 px-2.5 py-1 text-[11px] text-zinc-400 hover:border-zinc-600'
              }
              onClick={() => setGroupSourceFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {filterOpen ? (
          <div className="mt-2">
            <XSniperFilterSection
              open={filterOpen}
              canEdit
              twitterSnipe={filterDraft}
              tt={tt}
              onToggle={() => setFilterOpen((v) => !v)}
              updateTwitterSnipe={updateFilterDraft}
              showTweetAge={false}
              platformOptions={[...PLATFORM_OPTIONS]}
            />
          </div>
        ) : null}
      </div>

      <div
        className="dagobang-scrollbar min-h-0 flex-1 overflow-y-auto px-2 py-2"
        onMouseEnter={handleListMouseEnter}
        onMouseLeave={handleListMouseLeave}
      >
        {viewMode === 'grouped' ? (
          visibleGroups.length === 0 ? (
            <div className="px-2 py-8 text-center text-[14px] text-zinc-500">暂无符合条件的新池分组</div>
          ) : (
            <div>
              {visibleGroups.map((group) => (
                <div key={group.key} className="mt-2 rounded-lg border border-zinc-800/90 bg-zinc-950/30 px-2 py-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] first:mt-0">
                  {group.totalCount > 1 ? (
                    <div className="mb-1 flex items-center justify-between gap-3 border-b border-zinc-800/80 pb-1">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-[12px] text-zinc-300">
                          <span className="inline-flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-900/50 px-1.5 py-0.5 text-[10px] text-zinc-500">
                            {getGroupIcon(group.kind)}
                            {group.kind === 'tweet' ? '推文' : group.kind === 'website' ? '站点' : group.kind === 'image' ? '同图' : '名称'}
                          </span>
                          {group.kind === 'tweet' && group.tweetAuthor ? (
                            <button
                              type="button"
                              className="truncate font-semibold text-sky-300 hover:text-sky-200 hover:underline underline-offset-2"
                              onClick={(e) => {
                                e.stopPropagation();
                                window.open(`https://x.com/${group.tweetAuthor}`, '_blank');
                              }}
                              title={`@${group.tweetAuthor}`}
                            >
                              @{group.tweetAuthor}
                            </button>
                          ) : group.kind === 'tweet' && group.tweetId ? (
                            <span className="truncate font-semibold text-sky-300">Tweet #{group.tweetId.slice(-6)}</span>
                          ) : (
                            <span className="truncate font-semibold text-zinc-100">{group.label}</span>
                          )}
                          <span className="text-[10px] text-zinc-500">{group.totalCount}</span>
                        </div>
                      </div>
                      {group.tweetUrl || group.website ? (
                        <button
                          type="button"
                          className="shrink-0 rounded-md border border-zinc-800 bg-zinc-900 px-1.5 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
                          onClick={() => window.open(group.tweetUrl || group.website || '', '_blank')}
                        >
                          <ExternalLink size={12} />
                        </button>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="space-y-0.5">
                    {group.tokens.map((row, idx) => (
                      <TokenRowCard
                        key={`${group.key}:${row.tokenAddress}`}
                        row={row}
                        rank={idx + 1}
                        listKey={group.key}
                        resolvedSiteInfo={resolvedSiteInfo}
                        tt={tt}
                      />
                    ))}
                  </div>
                </div>
              ))}
              {hasMoreGroups ? (
                <div className="flex justify-center">
                  <button
                    type="button"
                    className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-[12px] text-zinc-200 hover:bg-zinc-800"
                    onClick={() => setGroupPage((p) => p + 1)}
                  >
                    加载更多
                  </button>
                </div>
              ) : null}
            </div>
          )
        ) : (
          visibleGlobalHotTokens.length === 0 ? (
            <div className="px-2 py-8 text-center text-[14px] text-zinc-500">暂无符合条件的新池热度数据</div>
          ) : (
            <div className="space-y-1">
              {visibleGlobalHotTokens.map((row, idx) => (
                <div key={`global-hot:${row.tokenAddress}`} className="rounded-lg border border-zinc-800/90 bg-zinc-950/30 px-2 py-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
                  <TokenRowCard
                    row={row}
                    rank={idx + 1}
                    listKey="global-hot"
                    resolvedSiteInfo={resolvedSiteInfo}
                    tt={tt}
                  />
                </div>
              ))}
              {hasMoreGlobalHotTokens ? (
                <div className="flex justify-center">
                  <button
                    type="button"
                    className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-[12px] text-zinc-200 hover:bg-zinc-800"
                    onClick={() => setGlobalPage((p) => p + 1)}
                  >
                    加载更多
                  </button>
                </div>
              ) : null}
            </div>
          )
        )}
      </div>
    </div>
  );
}

export function NewPoolMonitorPanel({
  siteInfo,
  visible,
  onVisibleChange,
  settings,
  displayMode,
  onDisplayModeChange,
}: NewPoolMonitorPanelProps) {
  const panelWidth = Math.min(380, Math.max(320, (window.innerWidth || 0) - 24));
  const [panelHeight, setPanelHeight] = useState(() => clampPanelHeight(PANEL_DEFAULT_HEIGHT, 120));
  const [pos, setPos] = useState(() => {
    const width = window.innerWidth || 0;
    const defaultX = Math.max(0, width - panelWidth - 12);
    return { x: defaultX, y: 120 };
  });
  const posRef = useRef(pos);
  const panelHeightRef = useRef(panelHeight);
  const dragging = useRef<null | { startX: number; startY: number; baseX: number; baseY: number }>(null);
  const resizing = useRef<null | { startY: number; baseHeight: number }>(null);

  useEffect(() => {
    posRef.current = pos;
  }, [pos]);

  useEffect(() => {
    panelHeightRef.current = panelHeight;
  }, [panelHeight]);

  useEffect(() => {
    if (!visible) return;
    try {
      const rawHeight = window.localStorage.getItem('dagobang_newpool_monitor_panel_height');
      const storedHeight = rawHeight ? Number(rawHeight) : NaN;
      const raw = window.localStorage.getItem('dagobang_newpool_monitor_panel_pos');
      const parsed = raw ? JSON.parse(raw) : null;
      const nextPos = parsed && typeof parsed.x === 'number' && typeof parsed.y === 'number'
        ? { x: parsed.x, y: parsed.y }
        : posRef.current;
      const nextHeight = Number.isFinite(storedHeight)
        ? clampPanelHeight(storedHeight, nextPos.y)
        : clampPanelHeight(panelHeightRef.current, nextPos.y);
      setPanelHeight(nextHeight);
      setPos(clampPanelPos(nextPos, panelWidth, nextHeight));
    } catch {
    }
  }, [visible, panelWidth]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (dragging.current) {
        const dx = e.clientX - dragging.current.startX;
        const dy = e.clientY - dragging.current.startY;
        setPos(clampPanelPos({ x: dragging.current.baseX + dx, y: dragging.current.baseY + dy }, panelWidth, panelHeightRef.current));
        return;
      }
      if (resizing.current) {
        const dy = e.clientY - resizing.current.startY;
        setPanelHeight(clampPanelHeight(resizing.current.baseHeight + dy, posRef.current.y));
      }
    };
    const onUp = () => {
      const didDrag = !!dragging.current;
      const didResize = !!resizing.current;
      dragging.current = null;
      resizing.current = null;
      if (!didDrag && !didResize) return;
      try {
        window.localStorage.setItem('dagobang_newpool_monitor_panel_pos', JSON.stringify(posRef.current));
        window.localStorage.setItem('dagobang_newpool_monitor_panel_height', String(panelHeightRef.current));
      } catch {
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [panelWidth]);

  useEffect(() => {
    if (!visible) return;
    const onResize = () => {
      const nextHeight = clampPanelHeight(panelHeightRef.current, posRef.current.y);
      setPanelHeight(nextHeight);
      setPos((prev) => clampPanelPos(prev, panelWidth, nextHeight));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [visible, panelWidth]);

  if (!visible) return null;

  return (
    <div
      className="fixed z-[2147483647] flex overflow-hidden rounded-xl border border-zinc-800 bg-[#0F0F11] text-zinc-100 shadow-xl shadow-emerald-500/25 font-sans"
      style={{ left: pos.x, top: pos.y, width: `${panelWidth}px`, height: `${panelHeight}px`, flexDirection: 'column' }}
    >
      <div
        className="flex cursor-grab items-center justify-between border-b border-zinc-800/60 px-4 py-3"
        onPointerDown={(e) => {
          dragging.current = {
            startX: e.clientX,
            startY: e.clientY,
            baseX: posRef.current.x,
            baseY: posRef.current.y,
          };
        }}
      >
        <div className="text-[13px] font-semibold text-emerald-300">新池监控</div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-full border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-300 hover:border-zinc-500"
            onClick={() => onDisplayModeChange(displayMode === 'floating' ? 'tab' : 'floating')}
            title={displayMode === 'floating' ? '切换为 Tab 显示' : '切换为独立浮窗'}
          >
            {displayMode === 'floating' ? 'Tab' : '独立'}
          </button>
          <button
            type="button"
            className="text-zinc-400 hover:text-zinc-200"
            onClick={() => onVisibleChange(false)}
          >
            <X size={16} />
          </button>
        </div>
      </div>
      <NewPoolMonitorContent
        siteInfo={siteInfo}
        active={visible}
        settings={settings}
      />
      <div
        className="flex shrink-0 cursor-ns-resize justify-center border-t border-zinc-800/60 px-4 py-1.5"
        onPointerDown={(e) => {
          e.stopPropagation();
          resizing.current = {
            startY: e.clientY,
            baseHeight: panelHeightRef.current,
          };
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          const nextHeight = clampPanelHeight(PANEL_DEFAULT_HEIGHT, posRef.current.y);
          setPanelHeight(nextHeight);
          try {
            window.localStorage.setItem('dagobang_newpool_monitor_panel_height', String(nextHeight));
          } catch {
          }
        }}
        title="拖动调整高度"
      >
        <div className="h-1 w-14 rounded-full bg-zinc-700/80" />
      </div>
    </div>
  );
}
