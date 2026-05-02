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
  nextRetryAtMs?: number;
  failCount?: number;
};

type RapidExitConfig = {
  enabled: boolean;
  evalStepSec: number;
  stopLossPct: number;
  takeProfitTriggerPct: number;
  takeProfitStepUpPct: number;
  takeProfitBatchPct: number;
  protectQuotaPct: number;
  tailSellPctOfRemaining: number;
  takeProfitFloorPct: number;
  maxReceiptRetries: number;
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
  const protectQuotaPct = clamp(parseUnknownNumber(strategy?.rapidProtectQuotaPct) ?? 40, 0, 100);
  const tailSellPctOfRemaining = clamp(parseUnknownNumber(strategy?.rapidTailSellPctOfRemaining) ?? 15, 0, 100);
  const takeProfitFloorPct = clamp(parseUnknownNumber(strategy?.rapidTakeProfitFloorPct) ?? 40, -50, 5000);
  const maxReceiptRetries = clamp(
    Math.floor(
      parseUnknownNumber(strategy?.rapidReceiptRetryCount)
      ?? parseUnknownNumber(strategy?.rapidRetryMaxFailCount)
      ?? 1,
    ),
    1,
    3,
  );
  return {
    enabled,
    evalStepSec,
    stopLossPct,
    takeProfitTriggerPct,
    takeProfitStepUpPct,
    takeProfitBatchPct,
    protectQuotaPct,
    tailSellPctOfRemaining,
    takeProfitFloorPct,
    maxReceiptRetries,
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
    nextRetryAtMs: 0,
    failCount: 0,
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
    onReceiptFailed?: () => void | Promise<void>;
    meta: {
      tweetAtMs?: number;
      tweetUrl?: string;
      tweetType?: string;
      channel?: string;
      signalId?: string;
      signalEventId?: string;
      signalTweetId?: string;
      triggerMarketCapUsd?: number;
      sellPercentOfOriginal?: number;
      sellPercentOfCurrent?: number;
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
      const nextRetryAtMs = Number(pos.nextRetryAtMs ?? 0);
      if (Number.isFinite(nextRetryAtMs) && nextRetryAtMs > input.nowMs) {
        input.rapidExitByPosKey.set(posKey, pos);
        continue;
      }

      const ageMs = input.nowMs - pos.openedAtMs;
      if (ageMs < cfg.evalStepSec * 1000) {
        input.rapidExitByPosKey.set(posKey, pos);
        continue;
      }
      const pnlPct = ((curMcap - entryMcap) / entryMcap) * 100;
      const evalSlot = Math.floor(ageMs / (cfg.evalStepSec * 1000));
      if (pos.lastEvalSlot === evalSlot) {
        input.rapidExitByPosKey.set(posKey, pos);
        continue;
      }
      pos.lastEvalSlot = evalSlot;

      const executeSell = async (inputSell: {
        targetPortionOfOriginalPct: number;
        percentOfCurrent: number;
        reason: 'rapid_take_profit' | 'rapid_stop_loss' | 'rapid_trailing_stop';
      }) => {
        const markReceiptFailureAndBackoff = (nextPos: RapidExitPosition, nowMs: number) => {
          const failCount = Math.max(0, Math.floor(Number(nextPos.failCount) || 0)) + 1;
          nextPos.failCount = failCount;
          if (failCount > cfg.maxReceiptRetries) {
            console.warn('[rapidExit][disabled_after_receipt_retries]', {
              chainId: nextPos.chainId,
              tokenAddress: nextPos.tokenAddress,
              failCount,
              maxReceiptRetries: cfg.maxReceiptRetries,
              reason: inputSell.reason,
            });
            cleanup();
            return;
          }
          const backoffMs = Math.min(120_000, 30_000 * (2 ** Math.min(2, failCount - 1)));
          nextPos.nextRetryAtMs = nowMs + backoffMs;
          input.rapidExitByPosKey.set(posKey, nextPos);
        };

        const nowRemaining = Number.isFinite(pos.remainingPercent) ? Math.max(0, Math.min(100, Number(pos.remainingPercent))) : 100;
        if (!(nowRemaining > 0)) return false;
        const targetPortion = Math.max(0, Math.min(nowRemaining, inputSell.targetPortionOfOriginalPct));
        if (!(targetPortion > 0)) return false;
        const percentOfCurrent = clamp(inputSell.percentOfCurrent, 0, 100);
        if (!(percentOfCurrent > 0)) return false;
        const sold = await input.tryRapidExitSellOnce({
          chainId: pos.chainId,
          tokenAddress: pos.tokenAddress,
          percent: percentOfCurrent,
          dryRun: pos.dryRun,
          reason: inputSell.reason,
          onReceiptFailed: () => {
            const cur = input.rapidExitByPosKey.get(posKey) ?? pos;
            const nowRemaining2 = Number.isFinite(cur.remainingPercent) ? Math.max(0, Math.min(100, Number(cur.remainingPercent))) : 100;
            cur.remainingPercent = Math.max(0, Math.min(100, nowRemaining2 + targetPortion));
            // If the position was cleaned up right after submit-success, restore it into a retryable state.
            cur.evalInProgress = false;
            cur.lastEvalSlot = -1;
            markReceiptFailureAndBackoff(cur, Date.now());
          },
          meta: {
            tweetAtMs: pos.tweetAtMs,
            tweetUrl: pos.tweetUrl,
            tweetType: pos.tweetType,
            channel: pos.channel,
            signalId: pos.signalId,
            signalEventId: pos.signalEventId,
            signalTweetId: pos.signalTweetId,
            triggerMarketCapUsd: curMcap,
            sellPercentOfOriginal: targetPortion,
            sellPercentOfCurrent: percentOfCurrent,
          },
        });
        if (!sold) {
          // Only receipt-failed trades are retryable; submit-stage failures should not loop forever.
          console.warn('[rapidExit][disabled_after_non_receipt_failure]', {
            chainId: pos.chainId,
            tokenAddress: pos.tokenAddress,
            reason: inputSell.reason,
          });
          cleanup();
          return false;
        }
        pos.failCount = 0;
        pos.nextRetryAtMs = 0;
        pos.remainingPercent = Math.max(0, nowRemaining - targetPortion);
        return true;
      };
      const sellPercentOfOriginal = async (
        portionOfOriginalPct: number,
        reason: 'rapid_take_profit' | 'rapid_stop_loss' | 'rapid_trailing_stop',
      ) => {
        const nowRemaining = Number.isFinite(pos.remainingPercent) ? Math.max(0, Math.min(100, Number(pos.remainingPercent))) : 100;
        if (!(nowRemaining > 0)) return false;
        const targetPortion = Math.max(0, Math.min(nowRemaining, portionOfOriginalPct));
        if (!(targetPortion > 0)) return false;
        const percentOfCurrent = clamp((targetPortion / nowRemaining) * 100, 0, 100);
        return executeSell({
          targetPortionOfOriginalPct: targetPortion,
          percentOfCurrent,
          reason,
        });
      };
      const sellPercentOfRemaining = async (
        percentOfRemaining: number,
        reason: 'rapid_take_profit' | 'rapid_stop_loss' | 'rapid_trailing_stop',
      ) => {
        const nowRemaining = Number.isFinite(pos.remainingPercent) ? Math.max(0, Math.min(100, Number(pos.remainingPercent))) : 100;
        if (!(nowRemaining > 0)) return false;
        const percentOfCurrent = clamp(percentOfRemaining, 0, 100);
        if (!(percentOfCurrent > 0)) return false;
        const targetPortion = clamp((nowRemaining * percentOfCurrent) / 100, 0, nowRemaining);
        if (!(targetPortion > 0)) return false;
        return executeSell({
          targetPortionOfOriginalPct: targetPortion,
          percentOfCurrent,
          reason,
        });
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
        const soldOriginalPct = clamp(100 - remainingPercent, 0, 100);
        const protectLeftPct = clamp(cfg.protectQuotaPct - soldOriginalPct, 0, 100);
        const sold = protectLeftPct > 0
          ? await sellPercentOfOriginal(Math.min(cfg.takeProfitBatchPct, protectLeftPct), 'rapid_take_profit')
          : await sellPercentOfRemaining(cfg.tailSellPctOfRemaining, 'rapid_take_profit');
        if (sold) {
          pos.armed = true;
          pos.lastTakeProfitPnlPct = pnlPct;
        }
      } else if (armed) {
        const lastMilestone = Number.isFinite(pos.lastTakeProfitPnlPct) ? Number(pos.lastTakeProfitPnlPct) : cfg.takeProfitTriggerPct;
        if (pnlPct >= lastMilestone + cfg.takeProfitStepUpPct) {
          const soldOriginalPct = clamp(100 - remainingPercent, 0, 100);
          const protectLeftPct = clamp(cfg.protectQuotaPct - soldOriginalPct, 0, 100);
          const sold = protectLeftPct > 0
            ? await sellPercentOfOriginal(Math.min(cfg.takeProfitBatchPct, protectLeftPct), 'rapid_take_profit')
            : await sellPercentOfRemaining(cfg.tailSellPctOfRemaining, 'rapid_take_profit');
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
