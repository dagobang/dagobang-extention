import type { UnifiedSignalToken, UnifiedTwitterSignal } from '@/types/extention';
import { evaluateBuyByConfig, getSignalTimeMs, isRepostOrQuoteSignal, normalizeAddress, normalizeEpochMs, parseNumber, sanitizeMarketCapUsd, type TokenMetrics } from '@/services/xSniper/engine/metrics';
import { extractLaunchpadPlatform } from '@/constants/launchpad';

const normalizePlatformFilters = (input: unknown): string[] => {
  const raw = Array.isArray(input) ? input : [];
  return raw
    .map((x) => String(x).trim().toLowerCase())
    .filter(Boolean);
};

const extractTokenPlatform = (token: UnifiedSignalToken): string => {
  return extractLaunchpadPlatform(token as any) ?? '';
};

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
  const devMaxBuyPercentRaw = typeof (t as any).devMaxBuyPercent === 'number' ? (t as any).devMaxBuyPercent : undefined;
  const devMaxBuyPercent =
    typeof devMaxBuyPercentRaw === 'number' && Number.isFinite(devMaxBuyPercentRaw)
      ? devMaxBuyPercentRaw >= 0 && devMaxBuyPercentRaw <= 1
        ? devMaxBuyPercentRaw * 100
        : devMaxBuyPercentRaw
      : undefined;
  return {
    tokenAddress,
    chain: typeof (t as any).chain === 'string' ? String((t as any).chain).trim().toLowerCase() : undefined,
    tokenSymbol: typeof (t as any).tokenSymbol === 'string' ? String((t as any).tokenSymbol) : undefined,
    launchpadPlatform: extractTokenPlatform(t) || undefined,
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
    devMaxBuyPercent,
    viewerCount: typeof (t as any).viewerCount === 'number' ? (t as any).viewerCount : undefined,
    devCreatedTokenCount: typeof (t as any).devCreatedTokenCount === 'number' ? (t as any).devCreatedTokenCount : undefined,
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
  const allowedPlatforms = normalizePlatformFilters(strategy?.platforms);
  if (perTweetMax <= 0) return { picked: [], skipped: [], decisions: [] };
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

  const candidates: Array<{ t: UnifiedSignalToken; m: TokenMetrics }> = [];
  const skipped: Array<{ t: UnifiedSignalToken; m: TokenMetrics | null; reason: string }> = [];
  const decisions: Array<{
    t: UnifiedSignalToken;
    m: TokenMetrics | null;
    fullPass: boolean;
    fullFailReason?: string;
    tokenWindowPass: boolean;
    tokenWindowFailReason?: string;
    tweetWindowPass: boolean;
    tweetWindowFailReason?: string;
    wsConfirmPass: boolean;
    wsConfirmReason?: string;
  }> = [];
  for (const t of unique) {
    const m = metricsFromUnifiedToken(t);
    if (m?.tokenAddress) input.pushWsSnapshot(m.tokenAddress, m);
    if (!m?.tokenAddress) {
      decisions.push({
        t,
        m: m ?? null,
        fullPass: false,
        fullFailReason: 'buy_filter_invalid_token_address',
        tokenWindowPass: false,
        tokenWindowFailReason: 'buy_filter_invalid_token_address',
        tweetWindowPass: false,
        tweetWindowFailReason: 'buy_filter_invalid_token_address',
        wsConfirmPass: false,
      });
      skipped.push({ t, m: m ?? null, reason: 'buy_filter_invalid_token_address' });
      continue;
    }
    const tokenWindowDecision = evaluateBuyByConfig(m, strategy, signalAtMs, now, {
      skipTokenCreatedAtWindowCheck,
      skipTweetAgeWindowCheck: true,
    });
    const tweetWindowDecision = evaluateBuyByConfig(m, strategy, signalAtMs, now, {
      skipTokenCreatedAtWindowCheck: true,
    });
    let fullDecision = evaluateBuyByConfig(m, strategy, signalAtMs, now, {
      skipTokenCreatedAtWindowCheck,
    });
    let wsConfirmPass = false;
    let wsConfirmReason: string | undefined;
    if (allowedPlatforms.length > 0) {
      const tokenPlatform = extractTokenPlatform(t);
      if (!tokenPlatform || !allowedPlatforms.includes(tokenPlatform)) {
        fullDecision = { pass: false, reason: 'buy_filter_platform_mismatch' };
        decisions.push({
          t,
          m,
          fullPass: false,
          fullFailReason: fullDecision.reason,
          tokenWindowPass: tokenWindowDecision.pass,
          tokenWindowFailReason: tokenWindowDecision.reason,
          tweetWindowPass: tweetWindowDecision.pass,
          tweetWindowFailReason: tweetWindowDecision.reason,
          wsConfirmPass,
          wsConfirmReason,
        });
        skipped.push({ t, m, reason: 'buy_filter_platform_mismatch' });
        continue;
      }
    }
    if (!fullDecision.pass) {
      decisions.push({
        t,
        m,
        fullPass: false,
        fullFailReason: fullDecision.reason,
        tokenWindowPass: tokenWindowDecision.pass,
        tokenWindowFailReason: tokenWindowDecision.reason,
        tweetWindowPass: tweetWindowDecision.pass,
        tweetWindowFailReason: tweetWindowDecision.reason,
        wsConfirmPass,
        wsConfirmReason,
      });
      skipped.push({ t, m, reason: fullDecision.reason || 'buy_filter_rejected' });
      continue;
    }
    const confirm = input.computeWsConfirm(m.tokenAddress, now, strategy);
    wsConfirmPass = confirm.pass;
    if (!wsConfirmPass) wsConfirmReason = 'ws_confirm_failed';
    decisions.push({
      t,
      m,
      fullPass: true,
      tokenWindowPass: tokenWindowDecision.pass,
      tokenWindowFailReason: tokenWindowDecision.reason,
      tweetWindowPass: tweetWindowDecision.pass,
      tweetWindowFailReason: tweetWindowDecision.reason,
      wsConfirmPass,
      wsConfirmReason,
    });
    candidates.push({ t, m });
  }

  candidates.sort((a, b) => {
    const ma = typeof a.m?.marketCapUsd === 'number' ? a.m.marketCapUsd : 0;
    const mb = typeof b.m?.marketCapUsd === 'number' ? b.m.marketCapUsd : 0;
    if (mb !== ma) return mb - ma;
    const ta = normalizeEpochMs((a.t as any).firstSeenAtMs) ?? 0;
    const tb = normalizeEpochMs((b.t as any).firstSeenAtMs) ?? 0;
    return ta - tb;
  });

  return { picked: candidates, skipped, decisions };
};
