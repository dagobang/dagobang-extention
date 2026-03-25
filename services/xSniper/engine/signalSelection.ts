import type { UnifiedSignalToken, UnifiedTwitterSignal } from '@/types/extention';
import { getSignalTimeMs, isRepostOrQuoteSignal, normalizeAddress, normalizeEpochMs, parseNumber, sanitizeMarketCapUsd, shouldBuyByConfig, type TokenMetrics } from '@/services/xSniper/engine/metrics';

export const matchesTwitterFilters = (signal: UnifiedTwitterSignal, strategy: any) => {
  const type = (() => {
    const raw = signal.tweetType === 'delete_post' ? (signal.sourceTweetType ?? null) : signal.tweetType;
    if (raw === 'repost') return 'retweet';
    if (raw === 'tweet') return 'tweet';
    if (raw === 'reply') return 'reply';
    if (raw === 'quote') return 'quote';
    if (raw === 'follow') return 'follow';
    return '';
  })();
  const allowedTypes = Array.isArray(strategy?.interactionTypes) ? strategy.interactionTypes.map((x: any) => String(x).toLowerCase()) : [];
  if (allowedTypes.length && !allowedTypes.includes(type)) return false;

  const targetUsers = Array.isArray(strategy?.targetUsers) ? strategy.targetUsers.map((x: any) => String(x).toLowerCase()).filter(Boolean) : [];
  if (!targetUsers.length) return true;

  const screen = String(signal.userScreen ?? '').replace(/^@/, '').toLowerCase();
  const name = String(signal.userName ?? '').toLowerCase();
  return targetUsers.some((u: string) => u === screen || u === name);
};

export const metricsFromUnifiedToken = (t: UnifiedSignalToken): TokenMetrics | null => {
  const tokenAddress = normalizeAddress(t.tokenAddress);
  if (!tokenAddress) return null;
  const now = Date.now();
  const createdAtMs = normalizeEpochMs((t as any).createdAtMs) ?? undefined;
  const firstSeenAtMs = normalizeEpochMs((t as any).firstSeenAtMs) ?? undefined;
  const tokenAtMs = firstSeenAtMs ?? createdAtMs;
  const tokenAgeMsForDev = tokenAtMs != null ? now - tokenAtMs : null;

  const devHoldPercentRaw = typeof (t as any).devHoldPercent === 'number' ? (t as any).devHoldPercent : undefined;
  let devHoldPercent =
    typeof devHoldPercentRaw === 'number' && Number.isFinite(devHoldPercentRaw)
      ? devHoldPercentRaw >= 0 && devHoldPercentRaw <= 1
        ? devHoldPercentRaw * 100
        : devHoldPercentRaw
      : undefined;
  if (devHoldPercent == null && tokenAgeMsForDev != null && tokenAgeMsForDev > 3000) devHoldPercent = 0;
  return {
    tokenAddress,
    tokenSymbol: typeof (t as any).tokenSymbol === 'string' ? String((t as any).tokenSymbol) : undefined,
    marketCapUsd: sanitizeMarketCapUsd((t as any).marketCapUsd) ?? undefined,
    liquidityUsd: typeof (t as any).liquidityUsd === 'number' ? (t as any).liquidityUsd : undefined,
    holders: typeof (t as any).holders === 'number' ? (t as any).holders : undefined,
    kol: typeof (t as any).kol === 'number' ? (t as any).kol : undefined,
    vol24hUsd: typeof (t as any).vol24hUsd === 'number' ? (t as any).vol24hUsd : undefined,
    netBuy24hUsd: typeof (t as any).netBuy24hUsd === 'number' ? (t as any).netBuy24hUsd : undefined,
    buyTx24h: typeof (t as any).buyTx24h === 'number' ? (t as any).buyTx24h : undefined,
    sellTx24h: typeof (t as any).sellTx24h === 'number' ? (t as any).sellTx24h : undefined,
    smartMoney: typeof (t as any).smartMoney === 'number' ? (t as any).smartMoney : undefined,
    createdAtMs,
    firstSeenAtMs,
    updatedAtMs: normalizeEpochMs((t as any).updatedAtMs) ?? undefined,
    devAddress: normalizeAddress((t as any).devAddress) ?? undefined,
    devHoldPercent,
    devHasSold: typeof (t as any).devHasSold === 'boolean'
      ? (t as any).devHasSold
      : (typeof (t as any).devTokenStatus === 'string' ? String((t as any).devTokenStatus).toLowerCase().includes('sell') : undefined),
    priceUsd: typeof (t as any).priceUsd === 'number' ? (t as any).priceUsd : undefined,
  };
};

export const pickTokensToBuyFromSignal = (input: {
  signal: UnifiedTwitterSignal;
  strategy: any;
  pushWsSnapshot: (tokenAddress: `0x${string}`, metrics: TokenMetrics) => void;
  computeWsConfirm: (tokenAddress: `0x${string}`, nowMs: number, strategy: any) => { pass: boolean };
}) => {
  const { signal, strategy } = input;
  const tokens = Array.isArray(signal.tokens) ? (signal.tokens as UnifiedSignalToken[]) : [];
  const now = Date.now();
  const signalAtMs = getSignalTimeMs(signal) ?? now;
  const skipTokenCreatedAtWindowCheck = isRepostOrQuoteSignal(signal);
  const perTweetMax = Math.max(0, Math.floor(parseNumber(strategy?.buyNewCaCount) ?? 0));
  if (perTweetMax <= 0) return [];
  const scanLimit = Math.min(500, tokens.length);
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

  const candidates = unique
    .map((t) => {
      const m = metricsFromUnifiedToken(t);
      if (m?.tokenAddress) {
        input.pushWsSnapshot(m.tokenAddress, m);
      }
      return { t, m };
    })
    .filter((x) => {
      if (!x.m?.tokenAddress) return false;
      if (!shouldBuyByConfig(x.m, strategy, signalAtMs, now, { skipTokenCreatedAtWindowCheck })) return false;
      const confirm = input.computeWsConfirm(x.m.tokenAddress, now, strategy);
      return confirm.pass;
    });

  candidates.sort((a, b) => {
    const ma = typeof a.m?.marketCapUsd === 'number' ? a.m.marketCapUsd : 0;
    const mb = typeof b.m?.marketCapUsd === 'number' ? b.m.marketCapUsd : 0;
    if (mb !== ma) return mb - ma;
    const ta = normalizeEpochMs((a.t as any).firstSeenAtMs) ?? 0;
    const tb = normalizeEpochMs((b.t as any).firstSeenAtMs) ?? 0;
    return ta - tb;
  });

  return candidates;
};
