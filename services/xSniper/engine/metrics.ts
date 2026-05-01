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
  if (!metrics || !config) return false;
  const marketCapUsd = sanitizeMarketCapUsd(metrics.marketCapUsd);
  const minMcap = parseKNumber(config.minMarketCapUsd);
  const maxMcap = parseKNumber(config.maxMarketCapUsd);
  if (minMcap != null && marketCapUsd == null) return false;
  if (maxMcap != null && marketCapUsd == null) return false;
  if (minMcap != null && marketCapUsd != null && marketCapUsd < minMcap) return false;
  if (maxMcap != null && marketCapUsd != null && marketCapUsd > maxMcap) return false;

  const minHolders = parseNumber(config.minHolders);
  const maxHolders = parseNumber(config.maxHolders);
  if (minHolders != null && metrics.holders == null) return false;
  if (maxHolders != null && metrics.holders == null) return false;
  if (minHolders != null && metrics.holders != null && metrics.holders < minHolders) return false;
  if (maxHolders != null && metrics.holders != null && metrics.holders > maxHolders) return false;

  const minKol = parseNumber(config.minKol);
  const maxKol = parseNumber(config.maxKol);
  if (minKol != null && metrics.kol == null) return false;
  if (maxKol != null && metrics.kol == null) return false;
  if (minKol != null && metrics.kol != null && metrics.kol < minKol) return false;
  if (maxKol != null && metrics.kol != null && metrics.kol > maxKol) return false;

  const minTickerLenRaw = parseNumber(config.minTickerLen);
  const maxTickerLenRaw = parseNumber(config.maxTickerLen);
  const minTickerLen = minTickerLenRaw != null ? Math.max(0, Math.floor(minTickerLenRaw)) : null;
  const maxTickerLen = maxTickerLenRaw != null ? Math.max(0, Math.floor(maxTickerLenRaw)) : null;
  if (minTickerLen != null || maxTickerLen != null) {
    const symbol = typeof metrics.tokenSymbol === 'string' ? metrics.tokenSymbol.trim() : '';
    if (!symbol) return false;
    const len = computeTickerLen(symbol);
    if (minTickerLen != null && len < minTickerLen) return false;
    if (maxTickerLen != null && len > maxTickerLen) return false;
  }

  const minAgeSecRaw = parseNumber(config.minTokenAgeSeconds);
  const maxAgeSec = parseNumber(config.maxTokenAgeSeconds);
  const minAgeSec = minAgeSecRaw ?? (maxAgeSec != null ? 0 : null);
  const firstSeenAtMs = normalizeEpochMs(metrics.firstSeenAtMs);
  const createdAtMs = normalizeEpochMs(metrics.createdAtMs);
  const tokenAtMs = createdAtMs ?? firstSeenAtMs;
  const shouldCheckTokenCreatedAtWindow = options?.skipTokenCreatedAtWindowCheck !== true;
  if (shouldCheckTokenCreatedAtWindow && (minAgeSec != null || maxAgeSec != null) && tokenAtMs == null) return false;
  if (shouldCheckTokenCreatedAtWindow && tokenAtMs != null && (minAgeSec != null || maxAgeSec != null)) {
    const tokenAgeMode = options?.tokenAgeMode ?? 'signal_delta';
    if (tokenAgeMode === 'now_age') {
      const now = normalizeEpochMs(orderAtMs) ?? Date.now();
      const tokenAgeMs = now - tokenAtMs;
      if (tokenAgeMs < 0) return false;
      if (minAgeSec != null && tokenAgeMs < minAgeSec * 1000) return false;
      if (maxAgeSec != null && tokenAgeMs > maxAgeSec * 1000) return false;
    } else {
      const ref = normalizeEpochMs(signalAtMs);
      if (ref == null) return false;
      const tokenDelayFromSignalMs = tokenAtMs - ref;
      if (minAgeSec != null && tokenDelayFromSignalMs < minAgeSec * 1000) return false;
      if (maxAgeSec != null && tokenDelayFromSignalMs > maxAgeSec * 1000) return false;
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
      if (ref == null) return false;
      const tweetAgeMs = now - ref;
      if (tweetAgeMs < 0) return false;
      if (minTweetAgeSec != null && tweetAgeMs < minTweetAgeSec * 1000) return false;
      if (maxTweetAgeSec != null && tweetAgeMs > maxTweetAgeSec * 1000) return false;
    }
  }

  const minDevPct = parseNumber(config.minDevHoldPercent);
  const maxDevPct = parseNumber(config.maxDevHoldPercent);
  const devHoldPct = typeof metrics.devHoldPercent === 'number' && Number.isFinite(metrics.devHoldPercent) ? metrics.devHoldPercent : null;
  if (minDevPct != null) {
    if (devHoldPct == null) return false;
    if (devHoldPct < minDevPct) return false;
  }
  if (maxDevPct != null) {
    if (devHoldPct == null) return false;
    if (devHoldPct > maxDevPct) return false;
  }
  if (config.blockIfDevSell && metrics.devHasSold === true) return false;
  return true;
};
