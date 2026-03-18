import type { XSniperBuyRecord } from '@/types/extention';
import type { WsSnapshot } from '@/services/xSniper/engine/wsSnapshots';

export type DryRunAutoSellPos = {
  chainId: number;
  tokenAddress: `0x${string}`;
  openedAtMs: number;
  entryMcapUsd: number;
  remainingBps: number;
  takeProfits: Array<{ id: string; triggerMcapUsd: number; sellPercentBps: number; triggerPercent: number }>;
  stopLosses: Array<{ id: string; triggerMcapUsd: number; sellPercentBps: number; triggerPercent: number }>;
  trailing: null | {
    enabled: boolean;
    callbackPercent: number;
    sellPercentBps: number;
    activationMode: 'immediate' | 'after_first_take_profit' | 'after_last_take_profit';
    active: boolean;
    peakMcapUsd: number;
  };
  takeProfitTotal: number;
  takeProfitExecuted: number;
  executedIds: Set<string>;
  tweetAtMs?: number;
  tweetUrl?: string;
  tweetType?: string;
  channel?: string;
  signalId?: string;
  signalEventId?: string;
  signalTweetId?: string;
};

export const maybeEvaluateDryRunAutoSell = async (input: {
  tokenAddress: `0x${string}`;
  nowMs: number;
  wsSnapshotsByAddr: Map<string, WsSnapshot[]>;
  dryRunAutoSellByPosKey: Map<string, DryRunAutoSellPos>;
  cleanupPosKey: (posKey: string) => void;
  emitRecord: (record: XSniperBuyRecord) => void;
}) => {
  const snapshots = input.wsSnapshotsByAddr.get(input.tokenAddress) ?? [];
  const cur = snapshots.length ? snapshots[snapshots.length - 1] : null;
  const curMcap = typeof cur?.marketCapUsd === 'number' && Number.isFinite(cur.marketCapUsd) ? cur.marketCapUsd : null;
  if (curMcap == null || curMcap <= 0) return;

  const keys = Array.from(input.dryRunAutoSellByPosKey.keys()).filter((k) => k.endsWith(`:${input.tokenAddress.toLowerCase()}`));
  for (const posKey of keys) {
    const pos = input.dryRunAutoSellByPosKey.get(posKey);
    if (!pos) continue;
    if (!(pos.remainingBps > 0)) {
      input.cleanupPosKey(posKey);
      continue;
    }

    const pushSellRecord = (sellPercentBps: number, reason: 'dry_run_take_profit' | 'dry_run_stop_loss' | 'dry_run_trailing_stop') => {
      const sellBps = Math.max(1, Math.min(10000, Math.floor(Number(sellPercentBps))));
      const now = Date.now();
      const record: XSniperBuyRecord = {
        id: `${now}-${Math.random().toString(16).slice(2)}`,
        side: 'sell',
        tsMs: now,
        tweetAtMs: pos.tweetAtMs,
        tweetUrl: pos.tweetUrl,
        chainId: pos.chainId,
        tokenAddress: pos.tokenAddress,
        sellPercent: sellBps / 100,
        dryRun: true,
        marketCapUsd: curMcap,
        reason,
        tweetType: pos.tweetType,
        channel: pos.channel,
        signalId: pos.signalId,
        signalEventId: pos.signalEventId,
        signalTweetId: pos.signalTweetId,
      };
      input.emitRecord(record);
    };

    if (pos.trailing?.enabled) {
      const mode = pos.trailing.activationMode;
      const active =
        mode === 'immediate'
          ? true
          : mode === 'after_first_take_profit'
            ? pos.takeProfitExecuted >= 1
            : pos.takeProfitTotal > 0 && pos.takeProfitExecuted >= pos.takeProfitTotal;
      pos.trailing.active = active;
    }

    if (pos.trailing?.enabled && pos.trailing.active) {
      if (!(pos.trailing.peakMcapUsd > 0)) pos.trailing.peakMcapUsd = pos.entryMcapUsd;
      if (curMcap > pos.trailing.peakMcapUsd) pos.trailing.peakMcapUsd = curMcap;
      const trigger = pos.trailing.peakMcapUsd * (1 - pos.trailing.callbackPercent / 100);
      if (Number.isFinite(trigger) && trigger > 0 && curMcap <= trigger) {
        const trailingBps = Math.max(1, Math.min(10000, Math.round(Number(pos.trailing.sellPercentBps) || 10000)));
        const sellBps = Math.max(1, Math.floor((pos.remainingBps * trailingBps) / 10000));
        pos.remainingBps = Math.max(0, pos.remainingBps - sellBps);
        pos.trailing.active = false;
        pos.trailing.enabled = false;
        pushSellRecord(sellBps, 'dry_run_trailing_stop');
        if (!(pos.remainingBps > 0)) input.cleanupPosKey(posKey);
        continue;
      }
    }

    for (const r of pos.stopLosses) {
      if (pos.executedIds.has(r.id)) continue;
      if (!(curMcap <= r.triggerMcapUsd)) continue;
      pos.executedIds.add(r.id);
      const sellBps = Math.floor((pos.remainingBps * r.sellPercentBps) / 10000);
      if (!(sellBps > 0)) continue;
      pos.remainingBps = Math.max(0, pos.remainingBps - sellBps);
      pushSellRecord(sellBps, 'dry_run_stop_loss');
      if (!(pos.remainingBps > 0)) {
        input.cleanupPosKey(posKey);
      }
      break;
    }
    if (!input.dryRunAutoSellByPosKey.has(posKey)) continue;

    const tps = pos.takeProfits.slice().sort((a, b) => a.triggerMcapUsd - b.triggerMcapUsd);
    for (const r of tps) {
      if (!(pos.remainingBps > 0)) break;
      if (pos.executedIds.has(r.id)) continue;
      if (!(curMcap >= r.triggerMcapUsd)) continue;
      pos.executedIds.add(r.id);
      pos.takeProfitExecuted += 1;
      const sellBps = Math.floor((pos.remainingBps * r.sellPercentBps) / 10000);
      if (!(sellBps > 0)) continue;
      pos.remainingBps = Math.max(0, pos.remainingBps - sellBps);
      pushSellRecord(sellBps, 'dry_run_take_profit');
    }
    if (!(pos.remainingBps > 0)) {
      input.cleanupPosKey(posKey);
    }
  }
};
