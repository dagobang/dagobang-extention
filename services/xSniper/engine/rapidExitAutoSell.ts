import { parseNumber } from '@/services/xSniper/engine/metrics';
import type { WsSnapshot } from '@/services/xSniper/engine/wsSnapshots';
import type { AutoTradeInteractionType } from '@/types/extention';

export type RapidExitPosition = {
  chainId: number;
  tokenAddress: `0x${string}`;
  dryRun: boolean;
  openedAtMs: number;
  entryMcapUsd: number;
  peakMcapUsd: number;
  sizeBnb: number;
  tweetAtMs?: number;
  tweetUrl?: string;
  tweetType?: string;
  channel?: string;
  signalId?: string;
  signalEventId?: string;
  signalTweetId?: string;
  firstTakeProfitSeenAtMs?: number;
  runnerMode?: boolean;
};

type RapidExitConfig = {
  enabled: boolean;
  takeProfitPct: number;
  stopLossPct: number;
  trailActivatePct: number;
  trailDropPct: number;
  minHoldMsForTakeProfit: number;
  minHoldMsForStopLoss: number;
  minHoldMsForTrail: number;
  sellPercent: number;
};

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const parseUnknownNumber = (value: unknown) => {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return parseNumber(value);
  return null;
};
const getWindowMcapChangePct = (snapshots: WsSnapshot[], nowMs: number, curMcap: number, windowMs: number) => {
  if (!(windowMs > 0)) return null;
  const cutoff = nowMs - windowMs;
  let baseMcap: number | null = null;
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const s = snapshots[i];
    if (!s) continue;
    if (s.atMs > cutoff) continue;
    const m = typeof s.marketCapUsd === 'number' && Number.isFinite(s.marketCapUsd) ? s.marketCapUsd : null;
    if (m != null && m > 0) {
      baseMcap = m;
      break;
    }
  }
  if (!(baseMcap != null && baseMcap > 0)) {
    for (let i = 0; i < snapshots.length; i++) {
      const s = snapshots[i];
      if (!s || s.atMs < cutoff) continue;
      const m = typeof s.marketCapUsd === 'number' && Number.isFinite(s.marketCapUsd) ? s.marketCapUsd : null;
      if (m != null && m > 0) {
        baseMcap = m;
        break;
      }
    }
  }
  if (!(baseMcap != null && baseMcap > 0)) return null;
  return ((curMcap - baseMcap) / baseMcap) * 100;
};
const getPnlPctAtAge = (
  snapshots: WsSnapshot[],
  openedAtMs: number,
  entryMcapUsd: number,
  targetAgeMs: number,
  toleranceMs: number
) => {
  if (!(entryMcapUsd > 0) || !snapshots.length) return null;
  const targetMs = openedAtMs + targetAgeMs;
  const minMs = targetMs - toleranceMs;
  const maxMs = targetMs + toleranceMs;
  let best: WsSnapshot | null = null;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const s = snapshots[i];
    if (!s) continue;
    if (s.atMs < minMs) break;
    if (s.atMs > maxMs) continue;
    const m = typeof s.marketCapUsd === 'number' && Number.isFinite(s.marketCapUsd) ? s.marketCapUsd : null;
    if (!(m != null && m > 0)) continue;
    const diff = Math.abs(s.atMs - targetMs);
    if (diff < bestDiff) {
      best = s;
      bestDiff = diff;
    }
  }
  if (!best) return null;
  const targetMcap = typeof best.marketCapUsd === 'number' && Number.isFinite(best.marketCapUsd) ? best.marketCapUsd : null;
  if (!(targetMcap != null && targetMcap > 0)) return null;
  return ((targetMcap - entryMcapUsd) / entryMcapUsd) * 100;
};
const GOLD_DOG_INITIAL_SELL_PERCENT = 30;
const GOLD_DOG_SHORT_WINDOW_MS = 2200;
const GOLD_DOG_LONG_WINDOW_MS = 4800;
const GOLD_DOG_SHORT_MOMENTUM_PCT = 6.2;
const GOLD_DOG_LONG_MOMENTUM_PCT = 11.5;
const GOLD_DOG_MIN_EXTRA_PNL_PCT = 2.5;
const AUX_WINDOW_10S_MS = 10000;
const AUX_WINDOW_30S_MS = 30000;
const AUX_WINDOW_10S_TOLERANCE_MS = 3200;
const AUX_WINDOW_30S_TOLERANCE_MS = 6000;

const normalizeTweetType = (value: unknown): AutoTradeInteractionType | null => {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!raw) return null;
  if (raw === 'tweet' || raw === 'post') return 'tweet';
  if (raw === 'reply') return 'reply';
  if (raw === 'quote') return 'quote';
  if (raw === 'retweet' || raw === 'repost') return 'retweet';
  if (raw === 'follow') return 'follow';
  return null;
};

const readRapidTypeOverride = (strategy: any, tweetType: unknown) => {
  const key = normalizeTweetType(tweetType);
  if (!key) return null;
  if (strategy?.rapidByTweetTypeEnabled === false) return null;
  const map = strategy?.rapidByType;
  if (!map || typeof map !== 'object') return null;
  const override = (map as any)[key];
  if (!override || typeof override !== 'object') return null;
  return override as Record<string, unknown>;
};

export const readRapidExitConfig = (strategy: any, tweetType?: unknown): RapidExitConfig => {
  const o = readRapidTypeOverride(strategy, tweetType);
  const enabled = o?.enabled != null ? o.enabled !== false : strategy?.rapidExitEnabled !== false;
  const takeProfitPct = clamp(parseUnknownNumber(o?.takeProfitPct) ?? parseNumber(strategy?.rapidTakeProfitPct) ?? 12, 1, 300);
  const stopLossPct = -Math.abs(clamp(parseUnknownNumber(o?.stopLossPct) ?? parseNumber(strategy?.rapidStopLossPct) ?? -7, -90, -0.3));
  const trailActivatePct = clamp(parseUnknownNumber(o?.trailActivatePct) ?? parseNumber(strategy?.rapidTrailActivatePct) ?? 8, 0.3, 300);
  const trailDropPct = clamp(parseUnknownNumber(o?.trailDropPct) ?? parseNumber(strategy?.rapidTrailDropPct) ?? 4, 0.2, 99);
  const minHoldMsForTakeProfit = clamp(Math.floor(parseUnknownNumber(o?.minHoldMsForTakeProfit) ?? parseNumber(strategy?.rapidMinHoldMsForTakeProfit) ?? 1200), 0, 15000);
  const minHoldMsForStopLoss = clamp(Math.floor(parseUnknownNumber(o?.minHoldMsForStopLoss) ?? parseNumber(strategy?.rapidMinHoldMsForStopLoss) ?? 800), 0, 15000);
  const minHoldMsForTrail = clamp(Math.floor(parseUnknownNumber(o?.minHoldMsForTrail) ?? parseNumber(strategy?.rapidMinHoldMsForTrail) ?? 1800), 0, 15000);
  const sellPercent = clamp(parseUnknownNumber(o?.sellPercent) ?? parseNumber(strategy?.rapidSellPercent) ?? 100, 1, 100);
  return {
    enabled,
    takeProfitPct,
    stopLossPct,
    trailActivatePct,
    trailDropPct,
    minHoldMsForTakeProfit,
    minHoldMsForStopLoss,
    minHoldMsForTrail,
    sellPercent,
  };
};

export const registerRapidExitPosition = (input: {
  rapidExitByPosKey: Map<string, RapidExitPosition>;
  strategy: any;
  posKey: string;
  chainId: number;
  tokenAddress: `0x${string}`;
  dryRun: boolean;
  entryMcapUsd: number | null;
  buyAmountBnb: number;
  openedAtMs: number;
  tweetAtMs?: number;
  tweetUrl?: string;
  tweetType?: string;
  channel?: string;
  signalId?: string;
  signalEventId?: string;
  signalTweetId?: string;
}) => {
  const cfg = readRapidExitConfig(input.strategy, input.tweetType);
  if (!cfg.enabled) return;
  if (!(input.entryMcapUsd != null && Number.isFinite(input.entryMcapUsd) && input.entryMcapUsd > 0)) return;
  const sizeBnb = Number(input.buyAmountBnb);
  if (!(Number.isFinite(sizeBnb) && sizeBnb > 0)) return;
  input.rapidExitByPosKey.set(input.posKey, {
    chainId: input.chainId,
    tokenAddress: input.tokenAddress,
    dryRun: input.dryRun,
    openedAtMs: input.openedAtMs,
    entryMcapUsd: input.entryMcapUsd,
    peakMcapUsd: input.entryMcapUsd,
    sizeBnb,
    tweetAtMs: input.tweetAtMs,
    tweetUrl: input.tweetUrl,
    tweetType: input.tweetType,
    channel: input.channel,
    signalId: input.signalId,
    signalEventId: input.signalEventId,
    signalTweetId: input.signalTweetId,
  });
};

export const maybeEvaluateRapidExitAutoSell = async (input: {
  tokenAddress: `0x${string}`;
  nowMs: number;
  strategy: any;
  wsSnapshotsByAddr: Map<string, WsSnapshot[]>;
  rapidExitByPosKey: Map<string, RapidExitPosition>;
  cleanupPosKey: (posKey: string) => void;
  tryRapidExitSellOnce: (args: {
    chainId: number;
    tokenAddress: `0x${string}`;
    percent: number;
    dryRun: boolean;
    reason: 'rapid_take_profit' | 'rapid_stop_loss' | 'rapid_trailing_stop';
    meta: {
      tweetAtMs?: number;
      tweetUrl?: string;
      tweetType?: string;
      channel?: string;
      signalId?: string;
      signalEventId?: string;
      signalTweetId?: string;
    };
  }) => Promise<void>;
}) => {
  const snapshots = input.wsSnapshotsByAddr.get(input.tokenAddress) ?? [];
  const cur = snapshots.length ? snapshots[snapshots.length - 1] : null;
  const curMcap = typeof cur?.marketCapUsd === 'number' && Number.isFinite(cur.marketCapUsd) ? cur.marketCapUsd : null;
  if (!(curMcap != null && curMcap > 0)) return;

  const keys = Array.from(input.rapidExitByPosKey.keys()).filter((k) => {
    const parts = k.split(':');
    const addr = parts.length >= 2 ? parts[parts.length - 1] : '';
    return addr.toLowerCase() === input.tokenAddress.toLowerCase();
  });
  for (const posKey of keys) {
    const pos = input.rapidExitByPosKey.get(posKey);
    if (!pos) continue;
    const cfg = readRapidExitConfig(input.strategy, pos.tweetType);
    if (!cfg.enabled) {
      input.cleanupPosKey(posKey);
      continue;
    }
    const entryMcap = pos.entryMcapUsd;
    if (!(entryMcap > 0)) {
      input.cleanupPosKey(posKey);
      continue;
    }
    if (curMcap > pos.peakMcapUsd) pos.peakMcapUsd = curMcap;
    const ageMs = input.nowMs - pos.openedAtMs;
    const pnlPct = ((curMcap - entryMcap) / entryMcap) * 100;
    const peakPnlPct = ((pos.peakMcapUsd - entryMcap) / entryMcap) * 100;
    const dropFromPeakPct = pos.peakMcapUsd > 0 ? ((pos.peakMcapUsd - curMcap) / pos.peakMcapUsd) * 100 : 0;
    const window10Pnl = ageMs >= AUX_WINDOW_10S_MS - 1200
      ? getPnlPctAtAge(snapshots, pos.openedAtMs, entryMcap, AUX_WINDOW_10S_MS, AUX_WINDOW_10S_TOLERANCE_MS)
      : null;
    const window30Pnl = ageMs >= AUX_WINDOW_30S_MS - 2200
      ? getPnlPctAtAge(snapshots, pos.openedAtMs, entryMcap, AUX_WINDOW_30S_MS, AUX_WINDOW_30S_TOLERANCE_MS)
      : null;
    const windowWeakLoss = window10Pnl != null && window10Pnl <= -1.8;
    const windowGoldCandidate = window10Pnl != null && window10Pnl >= cfg.takeProfitPct;
    const windowGoldConfirmed = windowGoldCandidate && window30Pnl != null && window30Pnl >= window10Pnl + 4;
    const windowGoldFailed = windowGoldCandidate && window30Pnl != null && window30Pnl <= window10Pnl - 3;
    const runnerMode = pos.runnerMode === true;
    const adaptiveTrailActivatePct = runnerMode ? Math.max(cfg.trailActivatePct, 12) : cfg.trailActivatePct;
    const adaptiveTrailDropPct = runnerMode ? Math.max(2.8, cfg.trailDropPct * 0.85) : cfg.trailDropPct;
    let reason: 'rapid_take_profit' | 'rapid_stop_loss' | 'rapid_trailing_stop' | null = null;
    let sellPercent = cfg.sellPercent;
    let keepAfterSell = false;
    if (
      (ageMs >= cfg.minHoldMsForStopLoss && pnlPct <= cfg.stopLossPct)
      || (ageMs >= AUX_WINDOW_10S_MS - 1000 && windowWeakLoss && pnlPct <= -1.2)
    ) {
      reason = 'rapid_stop_loss';
    } else {
      const tpCandidate = !runnerMode && ageMs >= cfg.minHoldMsForTakeProfit && pnlPct >= cfg.takeProfitPct;
      if (tpCandidate) {
        if (!(pos.firstTakeProfitSeenAtMs && Number.isFinite(pos.firstTakeProfitSeenAtMs))) {
          pos.firstTakeProfitSeenAtMs = input.nowMs;
        }
        const momentumPct = getWindowMcapChangePct(snapshots, input.nowMs, curMcap, GOLD_DOG_SHORT_WINDOW_MS) ?? 0;
        const momentumLongPct = getWindowMcapChangePct(snapshots, input.nowMs, curMcap, GOLD_DOG_LONG_WINDOW_MS) ?? momentumPct;
        const strongMomentum = momentumPct >= 3.8;
        const tpSkipMaxMs = 9000;
        const tpSeenMs = input.nowMs - (pos.firstTakeProfitSeenAtMs ?? input.nowMs);
        const goldDogMode = (momentumPct >= GOLD_DOG_SHORT_MOMENTUM_PCT
          && momentumLongPct >= GOLD_DOG_LONG_MOMENTUM_PCT
          && pnlPct >= cfg.takeProfitPct + GOLD_DOG_MIN_EXTRA_PNL_PCT)
          || windowGoldConfirmed;
        if (goldDogMode && tpSeenMs <= 12000) {
          reason = 'rapid_take_profit';
          sellPercent = Math.max(1, Math.min(cfg.sellPercent, GOLD_DOG_INITIAL_SELL_PERCENT));
          keepAfterSell = sellPercent < 100;
        } else if (!strongMomentum || tpSeenMs >= tpSkipMaxMs) {
          reason = 'rapid_take_profit';
        }
      } else {
        pos.firstTakeProfitSeenAtMs = undefined;
      }
      if (!reason && !runnerMode && ageMs >= AUX_WINDOW_30S_MS - 1800 && windowGoldFailed && pnlPct > 0) {
        reason = 'rapid_take_profit';
      }
      if (!reason && runnerMode && ageMs >= AUX_WINDOW_30S_MS - 1800 && windowGoldFailed) {
        reason = 'rapid_trailing_stop';
      }
      if (!reason && ageMs >= cfg.minHoldMsForTrail && peakPnlPct >= adaptiveTrailActivatePct && dropFromPeakPct >= adaptiveTrailDropPct) {
        reason = 'rapid_trailing_stop';
      }
    }
    if (!reason) continue;

    await input.tryRapidExitSellOnce({
      chainId: pos.chainId,
      tokenAddress: pos.tokenAddress,
      percent: sellPercent,
      dryRun: pos.dryRun,
      reason,
      meta: {
        tweetAtMs: pos.tweetAtMs,
        tweetUrl: pos.tweetUrl,
        tweetType: pos.tweetType,
        channel: pos.channel,
        signalId: pos.signalId,
        signalEventId: pos.signalEventId,
        signalTweetId: pos.signalTweetId,
      },
    });
    if (keepAfterSell && reason === 'rapid_take_profit' && sellPercent < 100) {
      const remainRatio = 1 - sellPercent / 100;
      if (remainRatio > 0.001) {
        pos.sizeBnb = pos.sizeBnb * remainRatio;
        pos.openedAtMs = input.nowMs;
        pos.entryMcapUsd = curMcap;
        pos.peakMcapUsd = curMcap;
        pos.firstTakeProfitSeenAtMs = undefined;
        pos.runnerMode = true;
        input.rapidExitByPosKey.set(posKey, pos);
        continue;
      }
    }
    input.cleanupPosKey(posKey);
  }
};
