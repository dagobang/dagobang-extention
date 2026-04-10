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
  runnerActivatedAtMs?: number;
  runnerMode?: boolean;
  stopLossHitCount?: number;
  lastStopLossAtMs?: number;
  protectionFloorPct?: number;
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
  takeProfitSellPercent: number;
  stopLossSellPercent: number;
  trailingStopSellPercent: number;
  runnerStopLossGraceMs: number;
  earlyReversalPeakPct: number;
  earlyReversalDropPct: number;
  emergencyStopLossPct: number;
  armProfitPct: number;
  protectFloorAfterArmPct: number;
  protectStep2PeakPct: number;
  protectStep2FloorPct: number;
  protectStep3PeakPct: number;
  protectStep3FloorPct: number;
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
const DEFAULT_AUX_WINDOW_10S_MS = 10000;
const DEFAULT_AUX_WINDOW_30S_MS = 30000;
const AUX_WINDOW_10S_TOLERANCE_MS = 3200;
const AUX_WINDOW_30S_TOLERANCE_MS = 6000;
const STOP_LOSS_ESCALATION_WINDOW_MS = 15000;
const STOP_LOSS_HARD_EXIT_FACTOR = 1.8;
const DEFAULT_RUNNER_STOP_LOSS_GRACE_MS = 8000;
const RUNNER_STOP_LOSS_EXTRA_BUFFER_PCT = 3.5;
const DEFAULT_EMERGENCY_STOP_LOSS_PCT = -12.6;
const EMERGENCY_STOP_LOSS_MIN_HOLD_MS = 350;
const EARLY_REVERSAL_MIN_HOLD_MS = 1800;
const EARLY_REVERSAL_PEAK_PCT_DEFAULT = 6.5;
const EARLY_REVERSAL_DROP_PCT_DEFAULT = 4.2;
const DEFAULT_TAKE_PROFIT_SELL_PERCENT = 25;
const DEFAULT_STOP_LOSS_SELL_PERCENT = 100;
const DEFAULT_TRAILING_STOP_SELL_PERCENT = 100;
const DEFAULT_ARM_PROFIT_PCT = 4;
const DEFAULT_PROTECT_FLOOR_AFTER_ARM_PCT = -1;
const DEFAULT_PROTECT_STEP2_PEAK_PCT = 12;
const DEFAULT_PROTECT_STEP2_FLOOR_PCT = 2;
const DEFAULT_PROTECT_STEP3_PEAK_PCT = 25;
const DEFAULT_PROTECT_STEP3_FLOOR_PCT = 8;

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
  const takeProfitSellPercent = clamp(
    parseUnknownNumber(o?.takeProfitSellPercent) ?? parseNumber(strategy?.rapidTakeProfitSellPercent) ?? DEFAULT_TAKE_PROFIT_SELL_PERCENT,
    1,
    100,
  );
  const stopLossSellPercent = clamp(
    parseUnknownNumber(o?.stopLossSellPercent) ?? parseNumber(strategy?.rapidStopLossSellPercent) ?? DEFAULT_STOP_LOSS_SELL_PERCENT,
    1,
    100,
  );
  const trailingStopSellPercent = clamp(
    parseUnknownNumber(o?.trailingStopSellPercent) ?? parseNumber(strategy?.rapidTrailingStopSellPercent) ?? DEFAULT_TRAILING_STOP_SELL_PERCENT,
    1,
    100,
  );
  const runnerStopLossGraceMs = clamp(
    Math.floor(parseUnknownNumber(o?.runnerStopLossGraceMs) ?? parseNumber(strategy?.rapidRunnerStopLossGraceMs) ?? DEFAULT_RUNNER_STOP_LOSS_GRACE_MS),
    0,
    15000,
  );
  const earlyReversalPeakPct = clamp(
    parseUnknownNumber(o?.earlyReversalPeakPct) ?? parseNumber(strategy?.rapidEarlyReversalPeakPct) ?? EARLY_REVERSAL_PEAK_PCT_DEFAULT,
    1,
    80,
  );
  const earlyReversalDropPct = clamp(
    parseUnknownNumber(o?.earlyReversalDropPct) ?? parseNumber(strategy?.rapidEarlyReversalDropPct) ?? EARLY_REVERSAL_DROP_PCT_DEFAULT,
    0.5,
    60,
  );
  const emergencyStopLossPct = -Math.abs(clamp(
    parseUnknownNumber(o?.emergencyStopLossPct) ?? parseNumber(strategy?.rapidEmergencyStopLossPct) ?? DEFAULT_EMERGENCY_STOP_LOSS_PCT,
    -90,
    -1,
  ));
  const armProfitPct = clamp(
    parseUnknownNumber(o?.armProfitPct) ?? parseNumber(strategy?.rapidArmProfitPct) ?? DEFAULT_ARM_PROFIT_PCT,
    0.5,
    80,
  );
  const protectFloorAfterArmPct = clamp(
    parseUnknownNumber(o?.protectFloorAfterArmPct) ?? parseNumber(strategy?.rapidProtectFloorAfterArmPct) ?? DEFAULT_PROTECT_FLOOR_AFTER_ARM_PCT,
    -50,
    50,
  );
  const protectStep2PeakPct = clamp(
    parseUnknownNumber(o?.protectStep2PeakPct) ?? parseNumber(strategy?.rapidProtectStep2PeakPct) ?? DEFAULT_PROTECT_STEP2_PEAK_PCT,
    2,
    200,
  );
  const protectStep2FloorPct = clamp(
    parseUnknownNumber(o?.protectStep2FloorPct) ?? parseNumber(strategy?.rapidProtectStep2FloorPct) ?? DEFAULT_PROTECT_STEP2_FLOOR_PCT,
    -20,
    100,
  );
  const protectStep3PeakPct = clamp(
    parseUnknownNumber(o?.protectStep3PeakPct) ?? parseNumber(strategy?.rapidProtectStep3PeakPct) ?? DEFAULT_PROTECT_STEP3_PEAK_PCT,
    3,
    300,
  );
  const protectStep3FloorPct = clamp(
    parseUnknownNumber(o?.protectStep3FloorPct) ?? parseNumber(strategy?.rapidProtectStep3FloorPct) ?? DEFAULT_PROTECT_STEP3_FLOOR_PCT,
    -20,
    200,
  );
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
    takeProfitSellPercent,
    stopLossSellPercent,
    trailingStopSellPercent,
    runnerStopLossGraceMs,
    earlyReversalPeakPct,
    earlyReversalDropPct,
    emergencyStopLossPct,
    armProfitPct,
    protectFloorAfterArmPct,
    protectStep2PeakPct,
    protectStep2FloorPct,
    protectStep3PeakPct,
    protectStep3FloorPct,
  };
};

const readRapidAuxWindows = (strategy: any) => {
  const window10sMs = clamp(
    Math.floor(parseUnknownNumber(strategy?.rapidAuxWindow10sMs) ?? DEFAULT_AUX_WINDOW_10S_MS),
    3000,
    30000,
  );
  const rawWindow30sMs = clamp(
    Math.floor(parseUnknownNumber(strategy?.rapidAuxWindow30sMs) ?? DEFAULT_AUX_WINDOW_30S_MS),
    10000,
    90000,
  );
  const window30sMs = Math.max(rawWindow30sMs, window10sMs + 2000);
  return { window10sMs, window30sMs };
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
  const { window10sMs, window30sMs } = readRapidAuxWindows(input.strategy);
  const window10ToleranceMs = clamp(Math.floor(window10sMs * 0.32), 1200, AUX_WINDOW_10S_TOLERANCE_MS);
  const window30ToleranceMs = clamp(Math.floor(window30sMs * 0.2), 2500, AUX_WINDOW_30S_TOLERANCE_MS);
  const window10EvalAheadMs = Math.min(1200, Math.floor(window10sMs * 0.2));
  const window30EvalAheadMs = Math.min(2200, Math.floor(window30sMs * 0.2));
  const window10StopAheadMs = Math.min(1000, Math.floor(window10sMs * 0.18));
  const window30TakeProfitAheadMs = Math.min(1800, Math.floor(window30sMs * 0.16));

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
    const window10Pnl = ageMs >= window10sMs - window10EvalAheadMs
      ? getPnlPctAtAge(snapshots, pos.openedAtMs, entryMcap, window10sMs, window10ToleranceMs)
      : null;
    const window30Pnl = ageMs >= window30sMs - window30EvalAheadMs
      ? getPnlPctAtAge(snapshots, pos.openedAtMs, entryMcap, window30sMs, window30ToleranceMs)
      : null;
    const windowWeakLoss = window10Pnl != null && window10Pnl <= -1.8;
    const windowGoldCandidate = window10Pnl != null && window10Pnl >= cfg.takeProfitPct;
    const windowGoldConfirmed = windowGoldCandidate && window30Pnl != null && window30Pnl >= window10Pnl + 4;
    const windowGoldFailed = windowGoldCandidate && window30Pnl != null && window30Pnl <= window10Pnl - 3;
    const runnerMode = pos.runnerMode === true;
    const stopLossHitCount = Number.isFinite(pos.stopLossHitCount) ? Math.max(0, Math.floor(pos.stopLossHitCount as number)) : 0;
    const adaptiveTrailActivatePct = runnerMode ? Math.max(cfg.trailActivatePct, 12) : cfg.trailActivatePct;
    const adaptiveTrailDropPct = runnerMode ? Math.max(2.8, cfg.trailDropPct * 0.85) : cfg.trailDropPct;
    let reason: 'rapid_take_profit' | 'rapid_stop_loss' | 'rapid_trailing_stop' | null = null;
    let sellPercent = cfg.sellPercent;
    if (!runnerMode && pnlPct >= cfg.armProfitPct) {
      pos.runnerMode = true;
      pos.runnerActivatedAtMs = input.nowMs;
      pos.protectionFloorPct = Math.max(pos.protectionFloorPct ?? -999, cfg.protectFloorAfterArmPct);
    }
    if (pos.runnerMode) {
      const nextFloor = (() => {
        if (peakPnlPct >= cfg.protectStep3PeakPct) return cfg.protectStep3FloorPct;
        if (peakPnlPct >= cfg.protectStep2PeakPct) return cfg.protectStep2FloorPct;
        return cfg.protectFloorAfterArmPct;
      })();
      pos.protectionFloorPct = Math.max(pos.protectionFloorPct ?? -999, nextFloor);
    }
    const liveRunnerMode = pos.runnerMode === true;
    const runnerElapsedMs = liveRunnerMode
      ? Math.max(0, input.nowMs - (pos.runnerActivatedAtMs ?? pos.openedAtMs))
      : 0;
    const runnerGraceActive = liveRunnerMode && runnerElapsedMs < cfg.runnerStopLossGraceMs;
    const effectiveStopLossPct = liveRunnerMode
      ? cfg.stopLossPct - RUNNER_STOP_LOSS_EXTRA_BUFFER_PCT
      : cfg.stopLossPct;
    const hardStop = pnlPct <= cfg.stopLossPct * STOP_LOSS_HARD_EXIT_FACTOR;
    const protectionFloorTriggered = (pos.runnerMode === true)
      && typeof pos.protectionFloorPct === 'number'
      && Number.isFinite(pos.protectionFloorPct)
      && pnlPct <= pos.protectionFloorPct;
    const baseStopLossTriggered = (
      ageMs >= cfg.minHoldMsForStopLoss
      && pnlPct <= effectiveStopLossPct
      && (!runnerGraceActive || hardStop)
    );
    const weakWindowStopLossTriggered = !liveRunnerMode
      && ageMs >= window10sMs - window10StopAheadMs
      && windowWeakLoss
      && pnlPct <= -1.2;
    const emergencyStopLossTriggered = ageMs >= Math.min(cfg.minHoldMsForStopLoss, EMERGENCY_STOP_LOSS_MIN_HOLD_MS)
      && pnlPct <= cfg.emergencyStopLossPct;
    const earlyReversalTrailingTriggered = !liveRunnerMode
      && ageMs >= Math.min(cfg.minHoldMsForTrail, EARLY_REVERSAL_MIN_HOLD_MS)
      && peakPnlPct >= cfg.earlyReversalPeakPct
      && dropFromPeakPct >= cfg.earlyReversalDropPct
      && pnlPct <= Math.max(cfg.takeProfitPct * 0.5, 4)
      && pnlPct > cfg.stopLossPct * STOP_LOSS_HARD_EXIT_FACTOR;
    const stopLossTriggered = emergencyStopLossTriggered || baseStopLossTriggered || weakWindowStopLossTriggered || protectionFloorTriggered;
    if (stopLossTriggered) {
      reason = 'rapid_stop_loss';
      sellPercent = cfg.stopLossSellPercent;
      const hitAgainSoon =
        stopLossHitCount >= 1
        && typeof pos.lastStopLossAtMs === 'number'
        && Number.isFinite(pos.lastStopLossAtMs)
        && input.nowMs - pos.lastStopLossAtMs <= STOP_LOSS_ESCALATION_WINDOW_MS;
      if (emergencyStopLossTriggered || hitAgainSoon || hardStop) {
        sellPercent = 100;
      }
    } else if (earlyReversalTrailingTriggered) {
      reason = 'rapid_trailing_stop';
      sellPercent = cfg.trailingStopSellPercent;
    } else {
      const tpCandidate = !liveRunnerMode && ageMs >= cfg.minHoldMsForTakeProfit && pnlPct >= cfg.takeProfitPct;
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
          sellPercent = Math.max(1, Math.min(cfg.takeProfitSellPercent, GOLD_DOG_INITIAL_SELL_PERCENT));
        } else if (!strongMomentum || tpSeenMs >= tpSkipMaxMs) {
          reason = 'rapid_take_profit';
          sellPercent = cfg.takeProfitSellPercent;
        }
      } else {
        pos.firstTakeProfitSeenAtMs = undefined;
      }
      if (!reason && !liveRunnerMode && ageMs >= window30sMs - window30TakeProfitAheadMs && windowGoldFailed && pnlPct > 0) {
        reason = 'rapid_take_profit';
        sellPercent = cfg.takeProfitSellPercent;
      }
      if (!reason && liveRunnerMode && ageMs >= window30sMs - window30TakeProfitAheadMs && windowGoldFailed) {
        reason = 'rapid_trailing_stop';
        sellPercent = cfg.trailingStopSellPercent;
      }
      if (!reason && ageMs >= cfg.minHoldMsForTrail && peakPnlPct >= adaptiveTrailActivatePct && dropFromPeakPct >= adaptiveTrailDropPct) {
        reason = 'rapid_trailing_stop';
        sellPercent = cfg.trailingStopSellPercent;
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
    if (sellPercent < 100) {
      const remainRatio = 1 - sellPercent / 100;
      if (remainRatio > 0.001) {
        pos.sizeBnb = pos.sizeBnb * remainRatio;
        pos.openedAtMs = input.nowMs;
        pos.entryMcapUsd = curMcap;
        pos.peakMcapUsd = curMcap;
        pos.firstTakeProfitSeenAtMs = undefined;
        pos.runnerMode = reason === 'rapid_take_profit';
        pos.runnerActivatedAtMs = reason === 'rapid_take_profit' ? input.nowMs : undefined;
        pos.protectionFloorPct = reason === 'rapid_take_profit' ? cfg.protectFloorAfterArmPct : undefined;
        if (reason === 'rapid_stop_loss') {
          pos.stopLossHitCount = stopLossHitCount + 1;
          pos.lastStopLossAtMs = input.nowMs;
        } else {
          pos.stopLossHitCount = 0;
          pos.lastStopLossAtMs = undefined;
        }
        input.rapidExitByPosKey.set(posKey, pos);
        continue;
      }
    }
    input.cleanupPosKey(posKey);
  }
};
