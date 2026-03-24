import { WalletService } from '@/services/wallet';
import { SettingsService } from '@/services/settings';
import { TradeService } from '@/services/trade';
import { TokenService } from '@/services/token';
import { cancelAllSellLimitOrdersForToken } from '@/services/limitOrders/store';
import { buildTweetUrl, getSignalTimeMs } from '@/services/xSniper/engine/metrics';
import type { UnifiedTwitterSignal, XSniperBuyRecord } from '@/types/extention';
import type { TokenInfo } from '@/types/token';
import type { StagedPosition } from '@/services/xSniper/engine/stagedEntrySchedulers';

const calcSellAmountWei = (input: {
  balanceWei: bigint;
  sellPercentBps: number;
  isTurbo: boolean;
  tokenInfo: TokenInfo;
}) => {
  let amountWei = (input.balanceWei * BigInt(input.sellPercentBps)) / 10000n;
  if (amountWei > input.balanceWei) amountWei = input.balanceWei;
  const platform = input.tokenInfo?.launchpad_platform?.toLowerCase() || '';
  const isInnerFourMeme =
    !!(input.tokenInfo as any)?.launchpad &&
    platform.includes('fourmeme') &&
    (input.tokenInfo as any).launchpad_status !== 1;
  if (!input.isTurbo && isInnerFourMeme && amountWei > 0n) {
    amountWei = (amountWei / 1000000000n) * 1000000000n;
  }
  return amountWei;
};

export const createSellExecutors = (deps: {
  cleanupPosKey: (posKey: string) => void;
  emitRecord: (record: XSniperBuyRecord) => void;
  broadcastToActiveTabs: (message: any) => Promise<void>;
  fetchTokenInfoFresh: (chainId: number, tokenAddress: `0x${string}`) => Promise<TokenInfo | null>;
  buildGenericTokenInfo: (chainId: number, tokenAddress: `0x${string}`) => Promise<TokenInfo | null>;
  getLatestMarketCapUsd: (tokenAddress: `0x${string}`) => number | null;
}) => {
  const deleteSellInFlight = new Set<string>();
  const timeStopSellInFlight = new Set<string>();
  const rapidSellInFlight = new Set<string>();

  const tryTimeStopSellOnce = async (input: {
    chainId: number;
    tokenAddress: `0x${string}`;
    percent: number;
    pos: StagedPosition;
    reason: 'time_stop' | 'staged_abort';
  }) => {
    const percent = Math.max(0, Math.min(100, Number(input.percent)));
    if (!Number.isFinite(percent) || percent <= 0) return;
    const bps = Math.floor(percent * 100);
    if (!(bps > 0)) return;

    const dedupeKey = `${input.chainId}:${input.tokenAddress.toLowerCase()}:${bps}:${input.reason}`;
    if (timeStopSellInFlight.has(dedupeKey)) return;
    timeStopSellInFlight.add(dedupeKey);
    try {
      const now = Date.now();
      const latestMarketCapUsd = deps.getLatestMarketCapUsd(input.tokenAddress);
      const baseRecord: XSniperBuyRecord = {
        id: `${now}-${Math.random().toString(16).slice(2)}`,
        side: 'sell',
        tsMs: now,
        tweetAtMs: input.pos.tweetAtMs,
        tweetUrl: input.pos.tweetUrl,
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        sellPercent: percent,
        sellTokenAmountWei: undefined,
        txHash: undefined,
        dryRun: input.pos.dryRun,
        tweetType: input.pos.tweetType,
        channel: input.pos.channel,
        signalId: input.pos.signalId,
        signalEventId: input.pos.signalEventId,
        signalTweetId: input.pos.signalTweetId,
        marketCapUsd: latestMarketCapUsd != null && Number.isFinite(latestMarketCapUsd) && latestMarketCapUsd > 0 ? latestMarketCapUsd : undefined,
        reason: input.reason,
      };

      if (input.pos.dryRun) {
        deps.emitRecord(baseRecord);
        deps.cleanupPosKey(`${input.chainId}:${input.tokenAddress.toLowerCase()}`);
        return;
      }

      const status = await WalletService.getStatus();
      if (status.locked || !status.address) {
        deps.emitRecord({ ...baseRecord, dryRun: false, reason: 'wallet_locked' });
        return;
      }

      const tokenInfo =
        (await deps.fetchTokenInfoFresh(input.chainId, input.tokenAddress)) ??
        (await deps.buildGenericTokenInfo(input.chainId, input.tokenAddress));
      if (!tokenInfo) {
        deps.emitRecord({ ...baseRecord, dryRun: false, reason: 'token_info_missing' });
        return;
      }

      const settings = await SettingsService.get();
      const isTurbo = (settings as any).chains?.[input.chainId]?.executionMode === 'turbo';
      let balanceWei = 0n;
      try {
        balanceWei = BigInt(await TokenService.getBalance(input.tokenAddress, status.address));
      } catch {
        balanceWei = 0n;
      }

      if (balanceWei <= 0n) {
        deps.emitRecord({ ...baseRecord, dryRun: false, sellTokenAmountWei: '0', reason: 'no_balance' });
        return;
      }

      const amountWei = calcSellAmountWei({
        balanceWei,
        sellPercentBps: bps,
        isTurbo,
        tokenInfo,
      });
      if (!isTurbo && amountWei <= 0n) {
        deps.emitRecord({ ...baseRecord, dryRun: false, sellTokenAmountWei: '0', reason: 'invalid_amount' });
        return;
      }

      try {
        await cancelAllSellLimitOrdersForToken(input.chainId, input.tokenAddress);
      } catch {}
      try {
        await TradeService.approveMaxForSellIfNeeded(input.chainId, input.tokenAddress, tokenInfo);
      } catch {}
      let rsp: any;
      try {
        rsp = await TradeService.sell({
          chainId: input.chainId,
          tokenAddress: input.tokenAddress,
          tokenAmountWei: amountWei.toString(),
          tokenInfo,
          sellPercentBps: bps,
        } as any);
      } catch {
        deps.emitRecord({
          ...baseRecord,
          dryRun: false,
          sellTokenAmountWei: amountWei.toString(),
          reason: 'sell_submit_failed',
        });
        return;
      }
      void deps.broadcastToActiveTabs({
        type: 'bg:tradeSuccess',
        source: 'xsniper',
        side: 'sell',
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        txHash: (rsp as any)?.txHash,
      });

      deps.emitRecord({
        ...baseRecord,
        dryRun: false,
        sellTokenAmountWei: amountWei.toString(),
        txHash: typeof (rsp as any)?.txHash === 'string' ? ((rsp as any).txHash as any) : undefined,
      });
    } finally {
      timeStopSellInFlight.delete(dedupeKey);
    }
  };

  const tryDeleteTweetSellOnce = async (input: {
    chainId: number;
    tokenAddress: `0x${string}`;
    percent: number;
    signal: UnifiedTwitterSignal;
    relatedBuy?: XSniperBuyRecord;
    dryRun: boolean;
  }) => {
    const percent = Math.max(0, Math.min(100, Number(input.percent)));
    if (!Number.isFinite(percent) || percent <= 0) return;
    const bps = Math.floor(percent * 100);
    if (!(bps > 0)) return;
    const posKey = `${input.chainId}:${input.tokenAddress.toLowerCase()}`;
    const signalTweetId = String(input.signal.tweetId ?? '').trim();
    const sourceTweetId = String((input.signal as any)?.sourceTweetId ?? '').trim();
    const signalEventId = String(input.signal.eventId ?? '').trim();
    const signalStableId = signalTweetId || sourceTweetId || signalEventId;
    const dedupeKey = `${input.chainId}:${input.tokenAddress.toLowerCase()}:${signalStableId}:${bps}`;
    if (deleteSellInFlight.has(dedupeKey)) return;
    deleteSellInFlight.add(dedupeKey);
    try {
      const now = Date.now();
      const tweetAtMs = getSignalTimeMs(input.signal) ?? undefined;
      const tweetUrl = buildTweetUrl(input.signal);
      const latestMarketCapUsd = deps.getLatestMarketCapUsd(input.tokenAddress);
      const baseRecord: XSniperBuyRecord = {
        id: `${now}-${Math.random().toString(16).slice(2)}`,
        side: 'sell',
        tsMs: now,
        tweetAtMs,
        tweetUrl,
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        tokenSymbol: input.relatedBuy?.tokenSymbol,
        tokenName: input.relatedBuy?.tokenName,
        sellPercent: percent,
        sellTokenAmountWei: undefined,
        txHash: undefined,
        dryRun: input.dryRun,
        tweetType: input.signal.tweetType,
        channel: input.signal.channel,
        signalId: input.signal.id,
        signalEventId: input.signal.eventId,
        signalTweetId: input.signal.tweetId,
        marketCapUsd: latestMarketCapUsd != null && Number.isFinite(latestMarketCapUsd) && latestMarketCapUsd > 0 ? latestMarketCapUsd : undefined,
      };

      if (input.dryRun) {
        deps.emitRecord({ ...baseRecord, reason: 'dry_run' });
        deps.cleanupPosKey(posKey);
        return;
      }

      const status = await WalletService.getStatus();
      if (status.locked || !status.address) {
        deps.emitRecord({ ...baseRecord, dryRun: false, reason: 'wallet_locked' });
        return;
      }

      const tokenInfo =
        (await deps.fetchTokenInfoFresh(input.chainId, input.tokenAddress)) ??
        (await deps.buildGenericTokenInfo(input.chainId, input.tokenAddress));
      if (!tokenInfo) {
        deps.emitRecord({ ...baseRecord, dryRun: false, reason: 'token_info_missing' });
        return;
      }

      const settings = await SettingsService.get();
      const isTurbo = (settings as any).chains?.[input.chainId]?.executionMode === 'turbo';
      let balanceWei = 0n;
      try {
        balanceWei = BigInt(await TokenService.getBalance(input.tokenAddress, status.address));
      } catch {
        balanceWei = 0n;
      }

      if (balanceWei <= 0n) {
        deps.emitRecord({ ...baseRecord, dryRun: false, sellTokenAmountWei: '0', reason: 'no_balance' });
        deps.cleanupPosKey(posKey);
        return;
      }

      const amountWei = calcSellAmountWei({
        balanceWei,
        sellPercentBps: bps,
        isTurbo,
        tokenInfo,
      });
      if (!isTurbo && amountWei <= 0n) {
        deps.emitRecord({ ...baseRecord, dryRun: false, sellTokenAmountWei: '0', reason: 'invalid_amount' });
        return;
      }

      try {
        await cancelAllSellLimitOrdersForToken(input.chainId, input.tokenAddress);
      } catch {}
      try {
        await TradeService.approveMaxForSellIfNeeded(input.chainId, input.tokenAddress, tokenInfo);
      } catch {}
      let rsp: any;
      try {
        rsp = await TradeService.sell({
          chainId: input.chainId,
          tokenAddress: input.tokenAddress,
          tokenAmountWei: amountWei.toString(),
          tokenInfo,
          sellPercentBps: bps,
        } as any);
      } catch {
        deps.emitRecord({
          ...baseRecord,
          dryRun: false,
          sellTokenAmountWei: amountWei.toString(),
          reason: 'sell_submit_failed',
        });
        return;
      }
      void deps.broadcastToActiveTabs({
        type: 'bg:tradeSuccess',
        source: 'xsniper',
        side: 'sell',
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        txHash: (rsp as any)?.txHash,
      });

      deps.emitRecord({
        ...baseRecord,
        dryRun: false,
        tokenSymbol: tokenInfo.symbol ? String(tokenInfo.symbol) : baseRecord.tokenSymbol,
        tokenName: tokenInfo.name ? String(tokenInfo.name) : baseRecord.tokenName,
        sellTokenAmountWei: amountWei.toString(),
        txHash: typeof (rsp as any)?.txHash === 'string' ? ((rsp as any).txHash as any) : undefined,
      });
      deps.cleanupPosKey(posKey);
    } finally {
      deleteSellInFlight.delete(dedupeKey);
    }
  };

  const tryRapidExitSellOnce = async (input: {
    chainId: number;
    tokenAddress: `0x${string}`;
    percent: number;
    dryRun: boolean;
    reason: 'rapid_take_profit' | 'rapid_stop_loss' | 'rapid_trailing_stop' | 'rapid_time_stop';
    meta: {
      tweetAtMs?: number;
      tweetUrl?: string;
      tweetType?: string;
      channel?: string;
      signalId?: string;
      signalEventId?: string;
      signalTweetId?: string;
    };
  }) => {
    const percent = Math.max(0, Math.min(100, Number(input.percent)));
    if (!Number.isFinite(percent) || percent <= 0) return;
    const bps = Math.floor(percent * 100);
    if (!(bps > 0)) return;
    const dedupeKey = `${input.chainId}:${input.tokenAddress.toLowerCase()}:${input.reason}:${bps}`;
    if (rapidSellInFlight.has(dedupeKey)) return;
    rapidSellInFlight.add(dedupeKey);
    try {
      const now = Date.now();
      const latestMarketCapUsd = deps.getLatestMarketCapUsd(input.tokenAddress);
      const baseRecord: XSniperBuyRecord = {
        id: `${now}-${Math.random().toString(16).slice(2)}`,
        side: 'sell',
        tsMs: now,
        tweetAtMs: input.meta.tweetAtMs,
        tweetUrl: input.meta.tweetUrl,
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        sellPercent: percent,
        sellTokenAmountWei: undefined,
        txHash: undefined,
        dryRun: input.dryRun,
        tweetType: input.meta.tweetType,
        channel: input.meta.channel,
        signalId: input.meta.signalId,
        signalEventId: input.meta.signalEventId,
        signalTweetId: input.meta.signalTweetId,
        marketCapUsd: latestMarketCapUsd != null && Number.isFinite(latestMarketCapUsd) && latestMarketCapUsd > 0 ? latestMarketCapUsd : undefined,
        reason: input.reason,
      };

      if (input.dryRun) {
        deps.emitRecord(baseRecord);
        return;
      }

      const status = await WalletService.getStatus();
      if (status.locked || !status.address) {
        deps.emitRecord({ ...baseRecord, dryRun: false, reason: 'wallet_locked' });
        return;
      }

      const tokenInfo =
        (await deps.fetchTokenInfoFresh(input.chainId, input.tokenAddress)) ??
        (await deps.buildGenericTokenInfo(input.chainId, input.tokenAddress));
      if (!tokenInfo) {
        deps.emitRecord({ ...baseRecord, dryRun: false, reason: 'token_info_missing' });
        return;
      }

      const settings = await SettingsService.get();
      const isTurbo = (settings as any).chains?.[input.chainId]?.executionMode === 'turbo';
      let balanceWei = 0n;
      try {
        balanceWei = BigInt(await TokenService.getBalance(input.tokenAddress, status.address));
      } catch {
        balanceWei = 0n;
      }

      if (balanceWei <= 0n) {
        deps.emitRecord({ ...baseRecord, dryRun: false, sellTokenAmountWei: '0', reason: 'no_balance' });
        return;
      }

      const amountWei = calcSellAmountWei({
        balanceWei,
        sellPercentBps: bps,
        isTurbo,
        tokenInfo,
      });
      if (!isTurbo && amountWei <= 0n) {
        deps.emitRecord({ ...baseRecord, dryRun: false, sellTokenAmountWei: '0', reason: 'invalid_amount' });
        return;
      }

      try {
        await cancelAllSellLimitOrdersForToken(input.chainId, input.tokenAddress);
      } catch {}
      try {
        await TradeService.approveMaxForSellIfNeeded(input.chainId, input.tokenAddress, tokenInfo);
      } catch {}
      let rsp: any;
      try {
        rsp = await TradeService.sell({
          chainId: input.chainId,
          tokenAddress: input.tokenAddress,
          tokenAmountWei: amountWei.toString(),
          tokenInfo,
          sellPercentBps: bps,
        } as any);
      } catch {
        deps.emitRecord({
          ...baseRecord,
          dryRun: false,
          sellTokenAmountWei: amountWei.toString(),
          reason: 'sell_submit_failed',
        });
        return;
      }
      void deps.broadcastToActiveTabs({
        type: 'bg:tradeSuccess',
        source: 'xsniper',
        side: 'sell',
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        txHash: (rsp as any)?.txHash,
      });

      deps.emitRecord({
        ...baseRecord,
        dryRun: false,
        tokenSymbol: tokenInfo.symbol ? String(tokenInfo.symbol) : baseRecord.tokenSymbol,
        tokenName: tokenInfo.name ? String(tokenInfo.name) : baseRecord.tokenName,
        sellTokenAmountWei: amountWei.toString(),
        txHash: typeof (rsp as any)?.txHash === 'string' ? ((rsp as any).txHash as any) : undefined,
      });
    } finally {
      rapidSellInFlight.delete(dedupeKey);
    }
  };

  return {
    tryTimeStopSellOnce,
    tryDeleteTweetSellOnce,
    tryRapidExitSellOnce,
  };
};
