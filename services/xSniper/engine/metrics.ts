import type { UnifiedTwitterSignal } from '@/types/extention';

export type TokenMetrics = {
  tokenAddress?: `0x${string}`;
  chain?: string;
  tokenSymbol?: string;
  launchpadPlatform?: string;
  marketCapUsd?: number;
  liquidityUsd?: number;
  holders?: number;
  kol?: number;
  vol24hUsd?: number;
  netBuy24hUsd?: number;
  buyTx24h?: number;
  sellTx24h?: number;
  smartMoney?: number;
  createdAtMs?: number;
  firstSeenAtMs?: number;
  updatedAtMs?: number;
  devAddress?: `0x${string}`;
  devHoldPercent?: number;
  devMaxBuyPercent?: number;
  viewerCount?: number;
  devCreatedTokenCount?: number;
  devHasSold?: boolean;
  priceUsd?: number;
};

export const parseNumber = (v: string | null | undefined) => {
  if (!v) return null;
  const n = Number(v.trim());
  if (!Number.isFinite(n)) return null;
  return n;
};

export const parseKNumber = (v: string | null | undefined) => {
  const n = parseNumber(v);
  if (n == null) return null;
  return n * 1000;
};

export const sanitizeMarketCapUsd = (v: unknown) => {
  if (typeof v !== 'number') return null;
  if (!Number.isFinite(v)) return null;
  return v >= 3000 ? v : null;
};

export const computeTickerLen = (symbol: string) => {
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

export const normalizeAddress = (addr: string | null | undefined): `0x${string}` | null => {
  if (!addr) return null;
  const trimmed = addr.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) return null;
  return trimmed as `0x${string}`;
};

export const normalizeEpochMs = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e14) return Math.floor(n / 1000);
  if (n < 1e11) return Math.floor(n * 1000);
  return Math.floor(n);
};

export const getSignalTimeMs = (signal?: UnifiedTwitterSignal): number | null => {
  if (!signal) return null;
  const received = normalizeEpochMs((signal as any).receivedAtMs);
  if (received != null) return received;
  const ts = normalizeEpochMs((signal as any).ts);
  if (ts != null) return ts;
  return null;
};

export const isRepostOrQuoteSignal = (signal?: UnifiedTwitterSignal | null) => {
  if (!signal) return false;
  const rawType = signal.tweetType === 'delete_post' ? (signal.sourceTweetType ?? signal.tweetType) : signal.tweetType;
  return rawType === 'repost' || rawType === 'quote';
};

export const buildTweetUrl = (signal?: UnifiedTwitterSignal): string | undefined => {
  if (!signal) return undefined;
  const id = String(signal.tweetId ?? '').trim();
  if (!/^\d{6,}$/.test(id)) return undefined;
  const user = String(signal.userScreen ?? '')
    .trim()
    .replace(/^@/, '');
  if (user) return `https://x.com/${encodeURIComponent(user)}/status/${id}`;
  return `https://x.com/i/web/status/${id}`;
};

export const shouldBuyByConfig = (
  metrics: TokenMetrics,
  config: any,
  signalAtMs?: number | null,
  orderAtMs?: number | null,
  options?: {
    skipTokenCreatedAtWindowCheck?: boolean;
    skipTweetAgeWindowCheck?: boolean;
    tokenAgeMode?: 'signal_delta' | 'now_age';
  },
) => {
  return evaluateBuyByConfig(metrics, config, signalAtMs, orderAtMs, options).pass;
};

export type BuyByConfigDecision = {
  pass: boolean;
  reason?: string;
};

export const evaluateBuyByConfig = (
  metrics: TokenMetrics,
  config: any,
  signalAtMs?: number | null,
  orderAtMs?: number | null,
  options?: {
    skipTokenCreatedAtWindowCheck?: boolean;
    skipTweetAgeWindowCheck?: boolean;
    tokenAgeMode?: 'signal_delta' | 'now_age';
  },
): BuyByConfigDecision => {
  if (!metrics || !config) return { pass: false, reason: 'buy_filter_config_missing' };
  const marketCapUsd = sanitizeMarketCapUsd(metrics.marketCapUsd);
  const minMcap = parseKNumber(config.minMarketCapUsd);
  const maxMcap = parseKNumber(config.maxMarketCapUsd);
  if (minMcap != null && marketCapUsd == null) return { pass: false, reason: 'buy_filter_market_cap_missing' };
  if (maxMcap != null && marketCapUsd == null) return { pass: false, reason: 'buy_filter_market_cap_missing' };
  if (minMcap != null && marketCapUsd != null && marketCapUsd < minMcap) return { pass: false, reason: 'buy_filter_market_cap_too_low' };
  if (maxMcap != null && marketCapUsd != null && marketCapUsd > maxMcap) return { pass: false, reason: 'buy_filter_market_cap_too_high' };

  const minHolders = parseNumber(config.minHolders);
  const maxHolders = parseNumber(config.maxHolders);
  if (minHolders != null && metrics.holders == null) return { pass: false, reason: 'buy_filter_holders_missing' };
  if (maxHolders != null && metrics.holders == null) return { pass: false, reason: 'buy_filter_holders_missing' };
  if (minHolders != null && metrics.holders != null && metrics.holders < minHolders) return { pass: false, reason: 'buy_filter_holders_too_low' };
  if (maxHolders != null && metrics.holders != null && metrics.holders > maxHolders) return { pass: false, reason: 'buy_filter_holders_too_high' };

  const minKol = parseNumber(config.minKol);
  const maxKol = parseNumber(config.maxKol);
  if (minKol != null && metrics.kol == null) return { pass: false, reason: 'buy_filter_kol_missing' };
  if (maxKol != null && metrics.kol == null) return { pass: false, reason: 'buy_filter_kol_missing' };
  if (minKol != null && metrics.kol != null && metrics.kol < minKol) return { pass: false, reason: 'buy_filter_kol_too_low' };
  if (maxKol != null && metrics.kol != null && metrics.kol > maxKol) return { pass: false, reason: 'buy_filter_kol_too_high' };

  const minTickerLenRaw = parseNumber(config.minTickerLen);
  const maxTickerLenRaw = parseNumber(config.maxTickerLen);
  const minTickerLen = minTickerLenRaw != null ? Math.max(0, Math.floor(minTickerLenRaw)) : null;
  const maxTickerLen = maxTickerLenRaw != null ? Math.max(0, Math.floor(maxTickerLenRaw)) : null;
  if (minTickerLen != null || maxTickerLen != null) {
    const symbol = typeof metrics.tokenSymbol === 'string' ? metrics.tokenSymbol.trim() : '';
    if (!symbol) return { pass: false, reason: 'buy_filter_ticker_missing' };
    const len = computeTickerLen(symbol);
    if (minTickerLen != null && len < minTickerLen) return { pass: false, reason: 'buy_filter_ticker_too_short' };
    if (maxTickerLen != null && len > maxTickerLen) return { pass: false, reason: 'buy_filter_ticker_too_long' };
  }

  const minAgeSecRaw = parseNumber(config.minTokenAgeSeconds);
  const maxAgeSec = parseNumber(config.maxTokenAgeSeconds);
  const minAgeSec = minAgeSecRaw ?? (maxAgeSec != null ? 0 : null);
  const firstSeenAtMs = normalizeEpochMs(metrics.firstSeenAtMs);
  const createdAtMs = normalizeEpochMs(metrics.createdAtMs);
  const tokenAtMs = createdAtMs ?? firstSeenAtMs;
  const shouldCheckTokenCreatedAtWindow = options?.skipTokenCreatedAtWindowCheck !== true;
  if (shouldCheckTokenCreatedAtWindow && (minAgeSec != null || maxAgeSec != null) && tokenAtMs == null) return { pass: false, reason: 'buy_filter_token_created_at_missing' };
  if (shouldCheckTokenCreatedAtWindow && tokenAtMs != null && (minAgeSec != null || maxAgeSec != null)) {
    const tokenAgeMode = options?.tokenAgeMode ?? 'signal_delta';
    if (tokenAgeMode === 'now_age') {
      const now = normalizeEpochMs(orderAtMs) ?? Date.now();
      const tokenAgeMs = now - tokenAtMs;
      if (tokenAgeMs < 0) return { pass: false, reason: 'buy_filter_token_age_invalid' };
      if (minAgeSec != null && tokenAgeMs < minAgeSec * 1000) return { pass: false, reason: 'buy_filter_token_age_too_young' };
      if (maxAgeSec != null && tokenAgeMs > maxAgeSec * 1000) return { pass: false, reason: 'buy_filter_token_age_too_old' };
    } else {
      const ref = normalizeEpochMs(signalAtMs);
      if (ref == null) return { pass: false, reason: 'buy_filter_signal_time_missing' };
      const tokenDelayFromSignalMs = tokenAtMs - ref;
      if (minAgeSec != null && tokenDelayFromSignalMs < minAgeSec * 1000) return { pass: false, reason: 'buy_filter_token_age_too_young' };
      if (maxAgeSec != null && tokenDelayFromSignalMs > maxAgeSec * 1000) return { pass: false, reason: 'buy_filter_token_age_too_old' };
    }
  }

  const shouldCheckTweetAgeWindow = options?.skipTweetAgeWindowCheck !== true;
  if (shouldCheckTweetAgeWindow) {
    const minTweetAgeSecRaw = parseNumber((config as any).minTweetAgeSeconds);
    const maxTweetAgeSec = parseNumber((config as any).maxTweetAgeSeconds);
    const minTweetAgeSec = minTweetAgeSecRaw ?? (maxTweetAgeSec != null ? 0 : null);
    if (minTweetAgeSec != null || maxTweetAgeSec != null) {
      const ref = normalizeEpochMs(signalAtMs);
      const now = normalizeEpochMs(orderAtMs) ?? Date.now();
      if (ref == null) return { pass: false, reason: 'buy_filter_signal_time_missing' };
      const tweetAgeMs = now - ref;
      if (tweetAgeMs < 0) return { pass: false, reason: 'buy_filter_tweet_age_invalid' };
      if (minTweetAgeSec != null && tweetAgeMs < minTweetAgeSec * 1000) return { pass: false, reason: 'buy_filter_tweet_age_too_young' };
      if (maxTweetAgeSec != null && tweetAgeMs > maxTweetAgeSec * 1000) return { pass: false, reason: 'buy_filter_tweet_age_too_old' };
    }
  }

  const minDevPct = parseNumber(config.minDevHoldPercent);
  const maxDevPct = parseNumber(config.maxDevHoldPercent);
  const devHoldPct = typeof metrics.devHoldPercent === 'number' && Number.isFinite(metrics.devHoldPercent) ? metrics.devHoldPercent : null;
  if (minDevPct != null) {
    if (devHoldPct == null) return { pass: false, reason: 'buy_filter_dev_hold_missing' };
    if (devHoldPct < minDevPct) return { pass: false, reason: 'buy_filter_dev_hold_too_low' };
  }
  if (maxDevPct != null) {
    if (devHoldPct == null) return { pass: false, reason: 'buy_filter_dev_hold_missing' };
    if (devHoldPct > maxDevPct) return { pass: false, reason: 'buy_filter_dev_hold_too_high' };
  }

  const minDevMaxBuyPct = parseNumber((config as any).minDevMaxBuyPercent);
  const maxDevMaxBuyPct = parseNumber((config as any).maxDevMaxBuyPercent);
  const devMaxBuyPct = typeof metrics.devMaxBuyPercent === 'number' && Number.isFinite(metrics.devMaxBuyPercent)
    ? metrics.devMaxBuyPercent
    : null;
  if (minDevMaxBuyPct != null) {
    if (devMaxBuyPct == null) return { pass: false, reason: 'buy_filter_dev_max_buy_missing' };
    if (devMaxBuyPct < minDevMaxBuyPct) return { pass: false, reason: 'buy_filter_dev_max_buy_too_low' };
  }
  if (maxDevMaxBuyPct != null) {
    if (devMaxBuyPct == null) return { pass: false, reason: 'buy_filter_dev_max_buy_missing' };
    if (devMaxBuyPct > maxDevMaxBuyPct) return { pass: false, reason: 'buy_filter_dev_max_buy_too_high' };
  }

  const minViewerCount = parseNumber((config as any).minViewerCount);
  const maxViewerCount = parseNumber((config as any).maxViewerCount);
  const viewerCount = typeof metrics.viewerCount === 'number' && Number.isFinite(metrics.viewerCount)
    ? metrics.viewerCount
    : null;
  if (minViewerCount != null) {
    if (viewerCount == null) return { pass: false, reason: 'buy_filter_viewer_count_missing' };
    if (viewerCount < minViewerCount) return { pass: false, reason: 'buy_filter_viewer_count_too_low' };
  }
  if (maxViewerCount != null) {
    if (viewerCount == null) return { pass: false, reason: 'buy_filter_viewer_count_missing' };
    if (viewerCount > maxViewerCount) return { pass: false, reason: 'buy_filter_viewer_count_too_high' };
  }

  const minDevCreatedTokenCount = parseNumber((config as any).minDevCreatedTokenCount);
  const maxDevCreatedTokenCount = parseNumber((config as any).maxDevCreatedTokenCount);
  const devCreatedTokenCount = typeof metrics.devCreatedTokenCount === 'number' && Number.isFinite(metrics.devCreatedTokenCount)
    ? metrics.devCreatedTokenCount
    : null;
  if (minDevCreatedTokenCount != null) {
    if (devCreatedTokenCount == null) return { pass: false, reason: 'buy_filter_dev_created_count_missing' };
    if (devCreatedTokenCount < minDevCreatedTokenCount) return { pass: false, reason: 'buy_filter_dev_created_count_too_low' };
  }
  if (maxDevCreatedTokenCount != null) {
    if (devCreatedTokenCount == null) return { pass: false, reason: 'buy_filter_dev_created_count_missing' };
    if (devCreatedTokenCount > maxDevCreatedTokenCount) return { pass: false, reason: 'buy_filter_dev_created_count_too_high' };
  }

  if (config.blockIfDevSell && metrics.devHasSold === true) return { pass: false, reason: 'buy_filter_dev_has_sold' };
  return { pass: true };
};
