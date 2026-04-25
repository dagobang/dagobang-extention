import { parseNumber } from '@/services/xSniper/engine/metrics';
import type { WsSnapshot } from '@/services/xSniper/engine/wsSnapshots';

export type RapidExitPosition = {
  chainId: number;
  tokenAddress: `0x${string}`;
  dryRun: boolean;
  openedAtMs: number;
  entryMcapUsd: number;
  impliedSupply?: number;
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
  armed?: boolean;
  lastTakeProfitPnlPct?: number;
  lastEvalSlot?: number;
  evalInProgress?: boolean;
};

type RapidExitConfig = {
  enabled: boolean;
  evalStepSec: number;
  stopLossPct: number;
  takeProfitTriggerPct: number;
  takeProfitStepUpPct: number;
  takeProfitBatchPct: number;
  takeProfitFloorPct: number;
};

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const parseUnknownNumber = (value: unknown) => {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return parseNumber(value);
  return null;
};

export const readRapidExitConfig = (strategy: any): RapidExitConfig => {
  const enabled = strategy?.rapidExitEnabled !== false;
  const evalStepSec = clamp(Math.floor(parseUnknownNumber(strategy?.rapidEvalStepSec) ?? 5), 1, 20);
  const stopLossPct = -Math.abs(clamp(parseUnknownNumber(strategy?.rapidStopLossPct) ?? -15, -90, -1));
  const takeProfitTriggerPct = clamp(parseUnknownNumber(strategy?.rapidTakeProfitTriggerPct) ?? 45, 0, 1000);
  const takeProfitStepUpPct = clamp(parseUnknownNumber(strategy?.rapidTakeProfitStepUpPct) ?? 25, 0, 1000);
  const takeProfitBatchPct = clamp(parseUnknownNumber(strategy?.rapidTakeProfitBatchPct) ?? 15, 1, 100);
  const takeProfitFloorPct = clamp(parseUnknownNumber(strategy?.rapidTakeProfitFloorPct) ?? 40, -50, 5000);
  return {
    enabled,
    evalStepSec,
    stopLossPct,
    takeProfitTriggerPct,
    takeProfitStepUpPct,
    takeProfitBatchPct,
    takeProfitFloorPct,
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
  entryPriceUsd?: number | null;
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
    impliedSupply:
      (() => {
        const p = Number(input.entryPriceUsd);
        if (!(Number.isFinite(p) && p > 0)) return undefined;
        const supply = input.entryMcapUsd / p;
        return Number.isFinite(supply) && supply > 0 ? supply : 1_000_000_000;
      })(),
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
    armed: false,
    lastTakeProfitPnlPct: undefined,
    lastEvalSlot: -1,
    evalInProgress: false,
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
      triggerMarketCapUsd?: number;
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
    if (pos.evalInProgress) continue;
    pos.evalInProgress = true;
    let cleanedUp = false;
    const cleanup = () => {
      input.cleanupPosKey(posKey);
      cleanedUp = true;
    };
    try {
      const cfg = readRapidExitConfig(input.strategy);
      if (!cfg.enabled) {
        cleanup();
        continue;
      }
      const entryMcap = pos.entryMcapUsd;
      if (!(entryMcap > 0)) {
        cleanup();
        continue;
      }
      const remainingPercent = Number.isFinite(pos.remainingPercent) ? Math.max(0, Math.min(100, Number(pos.remainingPercent))) : 100;
      if (!(remainingPercent > 0)) {
        cleanup();
        continue;
      }

      const ageMs = input.nowMs - pos.openedAtMs;
      const pnlPct = ((curMcap - entryMcap) / entryMcap) * 100;
      const evalSlot = Math.floor(ageMs / (cfg.evalStepSec * 1000));
      if (pos.lastEvalSlot === evalSlot) {
        input.rapidExitByPosKey.set(posKey, pos);
        continue;
      }
      pos.lastEvalSlot = evalSlot;

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
            triggerMarketCapUsd: curMcap,
          },
        });
        if (!sold) return false;
        pos.remainingPercent = Math.max(0, nowRemaining - targetPortion);
        return true;
      };

      const armed = pos.armed === true;
      if (armed && pnlPct <= cfg.takeProfitFloorPct) {
        const sold = await sellPercentOfOriginal(remainingPercent, 'rapid_trailing_stop');
        if (sold || !(pos.remainingPercent! > 0)) cleanup();
        continue;
      }

      if (pnlPct <= cfg.stopLossPct) {
        const sold = await sellPercentOfOriginal(remainingPercent, 'rapid_stop_loss');
        if (sold || !(pos.remainingPercent! > 0)) cleanup();
        continue;
      }

      if (!armed && pnlPct >= cfg.takeProfitTriggerPct) {
        const sold = await sellPercentOfOriginal(cfg.takeProfitBatchPct, 'rapid_take_profit');
        if (sold) {
          pos.armed = true;
          pos.lastTakeProfitPnlPct = pnlPct;
        }
      } else if (armed) {
        const lastMilestone = Number.isFinite(pos.lastTakeProfitPnlPct) ? Number(pos.lastTakeProfitPnlPct) : cfg.takeProfitTriggerPct;
        if (pnlPct >= lastMilestone + cfg.takeProfitStepUpPct) {
          const sold = await sellPercentOfOriginal(cfg.takeProfitBatchPct, 'rapid_take_profit');
          if (sold) pos.lastTakeProfitPnlPct = pnlPct;
        }
      }

      input.rapidExitByPosKey.set(posKey, pos);
    } finally {
      if (!cleanedUp) {
        pos.evalInProgress = false;
        input.rapidExitByPosKey.set(posKey, pos);
      }
    }
  }
};
