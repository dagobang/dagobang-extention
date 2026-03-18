import { SettingsService } from '@/services/settings';
import type { TokenMetrics } from '@/services/xSniper/engine/metrics';
import { parseNumber } from '@/services/xSniper/engine/metrics';
import type { XSniperBuyRecord } from '@/types/extention';
import type { WsSnapshot } from '@/services/xSniper/engine/wsSnapshots';

export type StagedPosition = {
  chainId: number;
  tokenAddress: `0x${string}`;
  dryRun: boolean;
  openedAtMs: number;
  scoutAmountBnb: number;
  addAmountBnb: number;
  lastMetrics?: TokenMetrics;
  entryMcapUsd?: number;
  entryPriceUsd?: number;
  tweetAtMs?: number;
  tweetUrl?: string;
  tweetType?: string;
  channel?: string;
  signalId?: string;
  signalEventId?: string;
  signalTweetId?: string;
  timeStopRetryCount?: number;
};

export const scheduleTimeStopIfEnabled = (input: {
  posKey: string;
  strategy: any;
  stagedPositions: Map<string, StagedPosition>;
  timeStopTimers: Map<string, number>;
  wsSnapshotsByAddr: Map<string, WsSnapshot[]>;
  tryTimeStopSellOnce: (args: {
    chainId: number;
    tokenAddress: `0x${string}`;
    percent: number;
    pos: StagedPosition;
    reason: 'time_stop';
  }) => Promise<void>;
}) => {
  if (input.strategy?.timeStopEnabled !== true) return;
  if (input.timeStopTimers.has(input.posKey)) return;
  const currentPos = input.stagedPositions.get(input.posKey);
  const retryCount = Math.max(0, Math.floor(Number(currentPos?.timeStopRetryCount) || 0));
  const configuredSeconds = Math.max(1, Math.min(3600, Math.floor(parseNumber(input.strategy?.timeStopSeconds) ?? 0)));
  const seconds = retryCount > 0 ? Math.min(5, configuredSeconds) : configuredSeconds;
  if (!(seconds > 0)) return;
  const timer = setTimeout(async () => {
    input.timeStopTimers.delete(input.posKey);
    const pos = input.stagedPositions.get(input.posKey);
    if (!pos) return;
    let latestStrategy = input.strategy;
    try {
      const latest = await SettingsService.get();
      latestStrategy = (latest as any)?.autoTrade?.twitterSnipe ?? input.strategy;
      if (latestStrategy?.timeStopEnabled !== true) return;
    } catch {
      return;
    }
    const minPnlPct = parseNumber(latestStrategy?.timeStopMinPnlPct) ?? 0;
    const sellPct = Math.max(0, Math.min(100, parseNumber(latestStrategy?.timeStopSellPercent) ?? 100));
    const snaps = input.wsSnapshotsByAddr.get(pos.tokenAddress) ?? [];
    const cur = snaps.length ? snaps[snaps.length - 1] : null;
    const curMcap = typeof cur?.marketCapUsd === 'number' && Number.isFinite(cur.marketCapUsd) ? cur.marketCapUsd : null;
    const entryMcap = typeof pos.entryMcapUsd === 'number' && Number.isFinite(pos.entryMcapUsd) ? pos.entryMcapUsd : null;
    if (curMcap == null || entryMcap == null || entryMcap <= 0) {
      const nextRetry = retryCount + 1;
      if (nextRetry >= 3) {
        input.stagedPositions.delete(input.posKey);
        await input.tryTimeStopSellOnce({ chainId: pos.chainId, tokenAddress: pos.tokenAddress, percent: sellPct, pos, reason: 'time_stop' });
        return;
      }
      input.stagedPositions.set(input.posKey, { ...pos, timeStopRetryCount: nextRetry });
      scheduleTimeStopIfEnabled(input);
      return;
    }
    if (retryCount > 0) {
      input.stagedPositions.set(input.posKey, { ...pos, timeStopRetryCount: 0 });
    }
    const pnlPct = ((curMcap - entryMcap) / entryMcap) * 100;
    if (!(pnlPct <= minPnlPct)) {
      input.stagedPositions.delete(input.posKey);
      return;
    }
    input.stagedPositions.delete(input.posKey);
    await input.tryTimeStopSellOnce({ chainId: pos.chainId, tokenAddress: pos.tokenAddress, percent: sellPct, pos, reason: 'time_stop' });
  }, seconds * 1000) as any;
  input.timeStopTimers.set(input.posKey, timer as any);
};

export const scheduleStagedAddIfEnabled = (input: {
  posKey: string;
  strategy: any;
  stagedPositions: Map<string, StagedPosition>;
  stagedAddTimers: Map<string, number>;
  computeWsConfirm: (tokenAddress: `0x${string}`, nowMs: number, strategy: any) => { pass: boolean; stats: any; windowMs: number };
  getWsDrawdownPctSince: (tokenAddress: `0x${string}`, sinceMs: number) => number | null;
  tryAutoBuyOnce: (args: {
    chainId: number;
    tokenAddress: `0x${string}`;
    metrics: TokenMetrics;
    strategy: any;
    signal?: any;
    stage?: 'add';
    amountBnbOverride?: number;
  }) => Promise<boolean>;
  tryTimeStopSellOnce: (args: {
    chainId: number;
    tokenAddress: `0x${string}`;
    percent: number;
    pos: StagedPosition;
    reason: 'staged_abort';
  }) => Promise<void>;
  emitRecord: (record: XSniperBuyRecord) => void;
}) => {
  if (input.strategy?.stagedEntryEnabled !== true) return;
  if (input.stagedAddTimers.has(input.posKey)) return;
  const minDelayMs = Math.max(0, Math.min(60_000, Math.floor(parseNumber(input.strategy?.stagedEntryMinDelayMs) ?? 0)));
  const maxDelayMs = Math.max(500, Math.min(120_000, Math.floor(parseNumber(input.strategy?.stagedEntryMaxDelayMs) ?? 0)));
  const maxDrawdownPct = Math.max(0, Math.min(99.9, Math.abs(parseNumber(input.strategy?.stagedEntryMaxDrawdownPct) ?? 0)));
  const tickMs = 500;
  const timer = setInterval(async () => {
    const pos = input.stagedPositions.get(input.posKey);
    if (!pos) {
      const id = input.stagedAddTimers.get(input.posKey);
      if (id) clearInterval(id as any);
      input.stagedAddTimers.delete(input.posKey);
      return;
    }
    const addAmount = Number(pos.addAmountBnb);
    if (!(Number.isFinite(addAmount) && addAmount > 0)) {
      const id = input.stagedAddTimers.get(input.posKey);
      if (id) clearInterval(id as any);
      input.stagedAddTimers.delete(input.posKey);
      return;
    }
    const now = Date.now();
    const ageMs = now - pos.openedAtMs;
    if (ageMs < minDelayMs) return;
    if (ageMs > maxDelayMs) {
      const id = input.stagedAddTimers.get(input.posKey);
      if (id) clearInterval(id as any);
      input.stagedAddTimers.delete(input.posKey);
      return;
    }

    if (maxDrawdownPct > 0) {
      const dd = input.getWsDrawdownPctSince(pos.tokenAddress, pos.openedAtMs);
      if (typeof dd === 'number' && Number.isFinite(dd) && dd <= -maxDrawdownPct) {
        const id = input.stagedAddTimers.get(input.posKey);
        if (id) clearInterval(id as any);
        input.stagedAddTimers.delete(input.posKey);
        input.stagedPositions.delete(input.posKey);
        await input.tryTimeStopSellOnce({ chainId: pos.chainId, tokenAddress: pos.tokenAddress, percent: 100, pos, reason: 'staged_abort' });
        return;
      }
    }

    const confirm = input.computeWsConfirm(pos.tokenAddress, now, input.strategy);
    if (!confirm.pass) return;

    let latestStrategy = input.strategy;
    try {
      const latestSettings = await SettingsService.get();
      const s = (latestSettings as any)?.autoTrade?.twitterSnipe;
      if (s) latestStrategy = s;
    } catch {
    }
    if (latestStrategy?.stagedEntryEnabled !== true) {
      const id = input.stagedAddTimers.get(input.posKey);
      if (id) clearInterval(id as any);
      input.stagedAddTimers.delete(input.posKey);
      const latest = input.stagedPositions.get(input.posKey);
      if (latest) input.stagedPositions.set(input.posKey, { ...latest, addAmountBnb: 0 });
      return;
    }
    const latestConfirm = input.computeWsConfirm(pos.tokenAddress, now, latestStrategy);
    if (!latestConfirm.pass) return;

    const id = input.stagedAddTimers.get(input.posKey);
    if (id) clearInterval(id as any);
    input.stagedAddTimers.delete(input.posKey);

    const ok = await input.tryAutoBuyOnce({
      chainId: pos.chainId,
      tokenAddress: pos.tokenAddress,
      metrics: (pos.lastMetrics ?? { tokenAddress: pos.tokenAddress }) as any,
      strategy: latestStrategy,
      signal: {
        ts: typeof pos.tweetAtMs === 'number' ? pos.tweetAtMs : pos.openedAtMs,
        receivedAtMs: typeof pos.tweetAtMs === 'number' ? pos.tweetAtMs : pos.openedAtMs,
        tweetType: pos.tweetType,
        channel: pos.channel,
        id: pos.signalId,
        eventId: pos.signalEventId,
        tweetId: pos.signalTweetId,
      } as any,
      stage: 'add',
      amountBnbOverride: addAmount,
    });
    if (ok) {
      const latest = input.stagedPositions.get(input.posKey) ?? pos;
      input.stagedPositions.set(input.posKey, { ...latest, addAmountBnb: 0 });
    }
  }, tickMs) as any;
  input.stagedAddTimers.set(input.posKey, timer as any);
};
