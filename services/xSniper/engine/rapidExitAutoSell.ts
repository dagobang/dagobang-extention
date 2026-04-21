import { parseNumber } from '@/services/xSniper/engine/metrics';
import type { WsSnapshot } from '@/services/xSniper/engine/wsSnapshots';

type RapidRoute = 'staged' | 'exit20' | 'hold';
type CaptureCheckpointKey = 'p3Captured' | 'p5Captured' | 'p8Captured' | 'p10Captured' | 'p15Captured' | 'p20Captured';
type StageDoneKey = 'staged1Done' | 'staged2Done' | 'staged3Done' | 'staged4Done';

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
  remainingPercent?: number;
  route?: RapidRoute;
  minEarlyPnlPct?: number;
  p3Captured?: boolean;
  p5Captured?: boolean;
  p8Captured?: boolean;
  p10Captured?: boolean;
  p15Captured?: boolean;
  p20Captured?: boolean;
  staged1Done?: boolean;
  staged2Done?: boolean;
  staged3Done?: boolean;
  staged4Done?: boolean;
  lastEvalSlot?: number;
  emergencyHitCount?: number;
};

type RapidExitConfig = {
  enabled: boolean;
  holdSeconds: number;
  evalStepSec: number;
  lookbackSec: number;
  emergencyConfirmSteps: number;
  emergencyStopLossPct: number;
  routeCut1Pct: number;
  routeCut2Pct: number;
  exit20Sec: number;
  stage1Sec: number;
  stage2Sec: number;
  stage3Sec: number;
  stage4Sec: number;
  stage1ProfitPct: number;
  stage2ProfitPct: number;
  stage3ProfitPct: number;
  stage4ProfitPct: number;
  stage1SellPct: number;
  stage2SellPct: number;
  stage3SellPct: number;
  stage4SellPct: number;
  runnerArmProfitPct: number;
  runnerPeakCut1Pct: number;
  runnerPeakCut2Pct: number;
  runnerDrawdown1Pct: number;
  runnerDrawdown2Pct: number;
  runnerDrawdown3Pct: number;
};

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const parseUnknownNumber = (value: unknown) => {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return parseNumber(value);
  return null;
};
const DEFAULT_EMERGENCY_STOP_LOSS_PCT = -40;
const EMERGENCY_STOP_LOSS_MIN_HOLD_MS = 350;

const getWindowPeakMcap = (snapshots: WsSnapshot[], nowMs: number, lookbackSec: number, fallbackMcap: number) => {
  const cutoff = nowMs - lookbackSec * 1000;
  let peak = fallbackMcap;
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const s = snapshots[i];
    if (!s) continue;
    if (s.atMs < cutoff) break;
    const m = typeof s.marketCapUsd === 'number' && Number.isFinite(s.marketCapUsd) ? s.marketCapUsd : null;
    if (m != null && m > peak) peak = m;
  }
  return peak;
};

export const readRapidExitConfig = (strategy: any): RapidExitConfig => {
  const enabled = strategy?.rapidExitEnabled !== false;
  const holdSeconds = clamp(
    Math.floor(parseUnknownNumber(strategy?.rapidHoldSeconds) ?? 60),
    3,
    300,
  );
  const evalStepSec = clamp(Math.floor(parseUnknownNumber(strategy?.rapidEvalStepSec) ?? 5), 1, 20);
  const lookbackSec = clamp(Math.floor(parseUnknownNumber(strategy?.rapidLookbackSec) ?? 6), 3, 60);
  const emergencyConfirmSteps = clamp(Math.floor(parseUnknownNumber(strategy?.rapidEmergencyConfirmSteps) ?? 2), 1, 6);
  const emergencyStopLossPct = -Math.abs(clamp(
    parseUnknownNumber(strategy?.rapidEmergencyStopLossPct) ?? DEFAULT_EMERGENCY_STOP_LOSS_PCT,
    -90,
    -1,
  ));
  const routeCut1Pct = clamp(parseUnknownNumber(strategy?.rapidRouteCut1Pct) ?? -10, -80, 80);
  const routeCut2Pct = clamp(parseUnknownNumber(strategy?.rapidRouteCut2Pct) ?? 4, -80, 120);
  const exit20Sec = clamp(Math.floor(parseUnknownNumber(strategy?.rapidExit20Sec) ?? 20), 5, 120);
  const stage1Sec = clamp(Math.floor(parseUnknownNumber(strategy?.rapidStage1Sec) ?? 3), 1, 120);
  const stage2Sec = clamp(Math.floor(parseUnknownNumber(strategy?.rapidStage2Sec) ?? 6), 1, 120);
  const stage3Sec = clamp(Math.floor(parseUnknownNumber(strategy?.rapidStage3Sec) ?? 8), 1, 120);
  const stage4Sec = clamp(Math.floor(parseUnknownNumber(strategy?.rapidStage4Sec) ?? 10), 1, 120);
  const stage1ProfitPct = clamp(parseUnknownNumber(strategy?.rapidStage1ProfitPct) ?? 4, -50, 300);
  const stage2ProfitPct = clamp(parseUnknownNumber(strategy?.rapidStage2ProfitPct) ?? 8, -50, 300);
  const stage3ProfitPct = clamp(parseUnknownNumber(strategy?.rapidStage3ProfitPct) ?? 12, -50, 300);
  const stage4ProfitPct = clamp(parseUnknownNumber(strategy?.rapidStage4ProfitPct) ?? 15, -50, 300);
  const stage1SellPct = clamp(parseUnknownNumber(strategy?.rapidStage1SellPct) ?? 20, 0, 100);
  const stage2SellPct = clamp(parseUnknownNumber(strategy?.rapidStage2SellPct) ?? 25, 0, 100);
  const stage3SellPct = clamp(parseUnknownNumber(strategy?.rapidStage3SellPct) ?? 25, 0, 100);
  const stage4SellPct = clamp(parseUnknownNumber(strategy?.rapidStage4SellPct) ?? 10, 0, 100);
  const runnerArmProfitPct = clamp(parseUnknownNumber(strategy?.rapidRunnerArmProfitPct) ?? 8, 0, 300);
  const runnerPeakCut1Pct = clamp(parseUnknownNumber(strategy?.rapidRunnerPeakCut1Pct) ?? 6, 0, 300);
  const runnerPeakCut2Pct = clamp(parseUnknownNumber(strategy?.rapidRunnerPeakCut2Pct) ?? 40, 0, 500);
  const runnerDrawdown1Pct = clamp(parseUnknownNumber(strategy?.rapidRunnerDrawdown1Pct) ?? 0.2, 0, 100);
  const runnerDrawdown2Pct = clamp(parseUnknownNumber(strategy?.rapidRunnerDrawdown2Pct) ?? 0.5, 0, 100);
  const runnerDrawdown3Pct = clamp(parseUnknownNumber(strategy?.rapidRunnerDrawdown3Pct) ?? 10, 0, 100);
  return {
    enabled,
    holdSeconds,
    evalStepSec,
    lookbackSec,
    emergencyConfirmSteps,
    emergencyStopLossPct,
    routeCut1Pct,
    routeCut2Pct,
    exit20Sec,
    stage1Sec,
    stage2Sec,
    stage3Sec,
    stage4Sec,
    stage1ProfitPct,
    stage2ProfitPct,
    stage3ProfitPct,
    stage4ProfitPct,
    stage1SellPct,
    stage2SellPct,
    stage3SellPct,
    stage4SellPct,
    runnerArmProfitPct,
    runnerPeakCut1Pct,
    runnerPeakCut2Pct,
    runnerDrawdown1Pct,
    runnerDrawdown2Pct,
    runnerDrawdown3Pct,
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
  const cfg = readRapidExitConfig(input.strategy);
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
    remainingPercent: 100,
    route: undefined,
    minEarlyPnlPct: undefined,
    p3Captured: false,
    p5Captured: false,
    p8Captured: false,
    p10Captured: false,
    p15Captured: false,
    p20Captured: false,
    staged1Done: false,
    staged2Done: false,
    staged3Done: false,
    staged4Done: false,
    lastEvalSlot: -1,
    emergencyHitCount: 0,
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
  }) => Promise<boolean>;
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
    const cfg = readRapidExitConfig(input.strategy);
    if (!cfg.enabled) {
      input.cleanupPosKey(posKey);
      continue;
    }
    const entryMcap = pos.entryMcapUsd;
    if (!(entryMcap > 0)) {
      input.cleanupPosKey(posKey);
      continue;
    }
    const remainingPercent = Number.isFinite(pos.remainingPercent) ? Math.max(0, Math.min(100, Number(pos.remainingPercent))) : 100;
    if (!(remainingPercent > 0)) {
      input.cleanupPosKey(posKey);
      continue;
    }
    if (curMcap > pos.peakMcapUsd) pos.peakMcapUsd = curMcap;
    const ageMs = input.nowMs - pos.openedAtMs;
    const holdMs = cfg.holdSeconds * 1000;
    const exit20Ms = cfg.exit20Sec * 1000;
    const pnlPct = ((curMcap - entryMcap) / entryMcap) * 100;
    const evalSlot = Math.floor(ageMs / (cfg.evalStepSec * 1000));
    const shouldEval = pos.lastEvalSlot !== evalSlot;
    const emergencyHits = Number.isFinite(pos.emergencyHitCount) ? Math.max(0, Math.floor(Number(pos.emergencyHitCount))) : 0;
    if (ageMs >= EMERGENCY_STOP_LOSS_MIN_HOLD_MS && pnlPct <= cfg.emergencyStopLossPct) {
      pos.emergencyHitCount = emergencyHits + 1;
    } else {
      pos.emergencyHitCount = 0;
    }
    const emergencyStopLossTriggered = ageMs >= EMERGENCY_STOP_LOSS_MIN_HOLD_MS
      && (pos.emergencyHitCount ?? 0) >= cfg.emergencyConfirmSteps;
    if (emergencyStopLossTriggered) {
      const sold = await input.tryRapidExitSellOnce({
        chainId: pos.chainId,
        tokenAddress: pos.tokenAddress,
        percent: 100,
        dryRun: pos.dryRun,
        reason: 'rapid_stop_loss',
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
      if (sold) input.cleanupPosKey(posKey);
      continue;
    }
    if (!shouldEval) {
      input.rapidExitByPosKey.set(posKey, pos);
      continue;
    }
    pos.lastEvalSlot = evalSlot;

    const captureCheckpoint = (flag: CaptureCheckpointKey, sec: number) => {
      if (pos[flag]) return;
      if (ageMs < sec * 1000) return;
      pos[flag] = true;
      pos.minEarlyPnlPct = typeof pos.minEarlyPnlPct === 'number' ? Math.min(pos.minEarlyPnlPct, pnlPct) : pnlPct;
    };
    captureCheckpoint('p3Captured', 3);
    captureCheckpoint('p5Captured', 5);
    captureCheckpoint('p8Captured', 8);
    captureCheckpoint('p10Captured', 10);
    captureCheckpoint('p15Captured', 15);
    captureCheckpoint('p20Captured', 20);

    if (!pos.route && ageMs >= exit20Ms) {
      const minEarly = typeof pos.minEarlyPnlPct === 'number' ? pos.minEarlyPnlPct : pnlPct;
      if (minEarly < cfg.routeCut1Pct) pos.route = 'staged';
      else if (minEarly < cfg.routeCut2Pct) pos.route = 'hold';
      else if (minEarly < 27) pos.route = 'exit20';
      else pos.route = 'hold';
    }

    const sellPercentOfOriginal = async (portionOfOriginalPct: number, reason: 'rapid_take_profit' | 'rapid_stop_loss' | 'rapid_trailing_stop') => {
      const nowRemaining = Number.isFinite(pos.remainingPercent) ? Math.max(0, Math.min(100, Number(pos.remainingPercent))) : 100;
      if (!(nowRemaining > 0)) return false;
      const targetPortion = Math.max(0, Math.min(nowRemaining, portionOfOriginalPct));
      if (!(targetPortion > 0)) return false;
      const percentOfCurrent = clamp((targetPortion / nowRemaining) * 100, 0, 100);
      const sold = await input.tryRapidExitSellOnce({
        chainId: pos.chainId,
        tokenAddress: pos.tokenAddress,
        percent: percentOfCurrent,
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
      if (!sold) return false;
      pos.remainingPercent = Math.max(0, nowRemaining - targetPortion);
      return true;
    };

    if (pos.route === 'exit20') {
      if (ageMs >= exit20Ms) {
        const sold = await sellPercentOfOriginal(remainingPercent, 'rapid_take_profit');
        if (sold || !(pos.remainingPercent! > 0)) input.cleanupPosKey(posKey);
      }
      continue;
    }

    if (pos.route === 'hold') {
      if (ageMs >= holdMs) {
        const sold = await sellPercentOfOriginal(remainingPercent, 'rapid_take_profit');
        if (sold || !(pos.remainingPercent! > 0)) input.cleanupPosKey(posKey);
      }
      continue;
    }

    if (pos.route === 'staged') {
      const windowPeakMcap = getWindowPeakMcap(snapshots, input.nowMs, cfg.lookbackSec, curMcap);
      const windowPeakPnlPct = ((windowPeakMcap - entryMcap) / entryMcap) * 100;
      const windowDrawdownPct = windowPeakMcap > 0 ? ((windowPeakMcap - curMcap) / windowPeakMcap) * 100 : 0;
      const runStage = async (doneFlag: StageDoneKey, sec: number, profitPct: number, sellPct: number) => {
        if (pos[doneFlag]) return;
        if (ageMs < sec * 1000) return;
        if (!(pnlPct >= profitPct)) return;
        const sold = await sellPercentOfOriginal(sellPct, 'rapid_take_profit');
        if (sold) pos[doneFlag] = true;
      };
      await runStage('staged1Done', cfg.stage1Sec, cfg.stage1ProfitPct, cfg.stage1SellPct);
      await runStage('staged2Done', cfg.stage2Sec, cfg.stage2ProfitPct, cfg.stage2SellPct);
      await runStage('staged3Done', cfg.stage3Sec, cfg.stage3ProfitPct, cfg.stage3SellPct);
      await runStage('staged4Done', cfg.stage4Sec, cfg.stage4ProfitPct, cfg.stage4SellPct);

      const runnerDrawdownThreshold =
        windowPeakPnlPct < cfg.runnerPeakCut1Pct
          ? cfg.runnerDrawdown1Pct
          : windowPeakPnlPct < cfg.runnerPeakCut2Pct
            ? cfg.runnerDrawdown2Pct
            : cfg.runnerDrawdown3Pct;
      const runnerTriggered = ageMs >= cfg.stage1Sec * 1000
        && windowPeakPnlPct >= cfg.runnerArmProfitPct
        && windowDrawdownPct >= runnerDrawdownThreshold;
      if (runnerTriggered || ageMs >= holdMs) {
        const sold = await sellPercentOfOriginal(Number(pos.remainingPercent ?? 0), 'rapid_trailing_stop');
        if (sold || !(pos.remainingPercent! > 0)) input.cleanupPosKey(posKey);
      }
      continue;
    }

    input.rapidExitByPosKey.set(posKey, pos);
  }
};
