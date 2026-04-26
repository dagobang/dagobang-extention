import { WalletService } from '@/services/wallet';
import { SettingsService } from '@/services/settings';
import { TradeService } from '@/services/trade';
import { TokenService } from '@/services/token';
import { cancelAllSellLimitOrdersForToken } from '@/services/limitOrders/store';
import { buildTweetUrl, getSignalTimeMs } from '@/services/xSniper/engine/metrics';
import type { UnifiedTwitterSignal, XSniperBuyRecord } from '@/types/extention';
import type { TokenInfo } from '@/types/token';

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
    platform.includes('four') &&
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
  const rapidSellInFlight = new Set<string>();
  const readDryRunSellDelayMs = async () => {
    try {
      const settings = await SettingsService.get();
      const raw = (settings as any)?.autoTrade?.twitterSnipe?.dryRunSellDelayMs;
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (Number.isFinite(n)) return Math.max(0, Math.min(10000, Math.floor(n)));
    } catch {
    }
    return 2000;
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
        const delayMs = await readDryRunSellDelayMs();
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        const latestAfterDelay = deps.getLatestMarketCapUsd(input.tokenAddress);
        const now2 = Date.now();
        deps.emitRecord({
          ...baseRecord,
          tsMs: now2,
          id: `${now2}-${Math.random().toString(16).slice(2)}`,
          marketCapUsd: latestAfterDelay != null && Number.isFinite(latestAfterDelay) && latestAfterDelay > 0 ? latestAfterDelay : baseRecord.marketCapUsd,
          reason: 'dry_run',
        });
        deps.cleanupPosKey(posKey);
        return;
      }

      const status = await WalletService.getStatus();
      if (status.locked || !status.address) {
        deps.emitRecord({ ...baseRecord, dryRun: false, reason: 'wallet_locked' });
        return;
      }

      const settings = await SettingsService.get();
      const isTurbo = (settings as any).chains?.[input.chainId]?.executionMode === 'turbo';
      const tokenInfo =
        (await deps.fetchTokenInfoFresh(input.chainId, input.tokenAddress)) ??
        (await deps.buildGenericTokenInfo(input.chainId, input.tokenAddress));
      if (!tokenInfo) {
        deps.emitRecord({ ...baseRecord, dryRun: false, reason: 'token_info_missing' });
        return;
      }

      let amountWei = 0n;
      if (!isTurbo) {
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
        amountWei = calcSellAmountWei({
          balanceWei,
          sellPercentBps: bps,
          isTurbo,
          tokenInfo,
        });
        if (amountWei <= 0n) {
          deps.emitRecord({ ...baseRecord, dryRun: false, sellTokenAmountWei: '0', reason: 'invalid_amount' });
          return;
        }
      }

      try {
        await cancelAllSellLimitOrdersForToken(input.chainId, input.tokenAddress);
      } catch {}
      let rsp: any;
      let tokenInfoForTrade = tokenInfo;
      try {
        rsp = await TradeService.sellWithReceiptAndAutoRecovery({
          chainId: input.chainId,
          tokenAddress: input.tokenAddress,
          tokenAmountWei: amountWei.toString(),
          tokenInfo: tokenInfoForTrade,
          sellPercentBps: bps,
        } as any, {
          maxRetry: 1,
          timeoutMs: 20_000,
          onSubmitted: async (ctx) => {
            await deps.broadcastToActiveTabs({
              type: 'bg:tradeSubmitted',
              source: 'xsniper',
              side: 'sell',
              chainId: input.chainId,
              tokenAddress: input.tokenAddress,
              txHash: ctx.txHash,
              submitElapsedMs: ctx.submitElapsedMs,
            });
          },
        });
      } catch {
      }
      if (!rsp) {
        deps.emitRecord({
          ...baseRecord,
          dryRun: false,
          sellTokenAmountWei: amountWei.toString(),
          reason: 'sell_submit_failed',
        });
        return;
      }
      const finalTxHash = (rsp as any)?.txHash as `0x${string}`;
      void deps.broadcastToActiveTabs({
        type: 'bg:tradeSuccess',
        source: 'xsniper',
        side: 'sell',
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        txHash: finalTxHash,
        submitElapsedMs: (rsp as any)?.submitElapsedMs,
        receiptElapsedMs: (rsp as any)?.receiptElapsedMs,
        totalElapsedMs: (rsp as any)?.totalElapsedMs,
        broadcastVia: (rsp as any)?.broadcastVia,
        broadcastUrl: (rsp as any)?.broadcastUrl,
        isBundle: (rsp as any)?.isBundle,
      });

      deps.emitRecord({
        ...baseRecord,
        dryRun: false,
        tokenSymbol: tokenInfoForTrade.symbol ? String(tokenInfoForTrade.symbol) : baseRecord.tokenSymbol,
        tokenName: tokenInfoForTrade.name ? String(tokenInfoForTrade.name) : baseRecord.tokenName,
        sellTokenAmountWei: isTurbo ? undefined : amountWei.toString(),
        txHash: finalTxHash as any,
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
  }) => {
    const percent = Math.max(0, Math.min(100, Number(input.percent)));
    if (!Number.isFinite(percent) || percent <= 0) return false;
    const bps = Math.floor(percent * 100);
    if (!(bps > 0)) return false;
    const dedupeKey = `${input.chainId}:${input.tokenAddress.toLowerCase()}:${input.reason}:${bps}`;
    if (rapidSellInFlight.has(dedupeKey)) return false;
    rapidSellInFlight.add(dedupeKey);
    try {
      const now = Date.now();
      const latestMarketCapUsd = deps.getLatestMarketCapUsd(input.tokenAddress);
      const triggerMarketCapUsd = Number(input.meta.triggerMarketCapUsd);
      const lockedTriggerMcapUsd =
        Number.isFinite(triggerMarketCapUsd) && triggerMarketCapUsd > 0 ? triggerMarketCapUsd : null;
      const baseRecord: XSniperBuyRecord = {
        id: `${now}-${Math.random().toString(16).slice(2)}`,
        side: 'sell',
        tsMs: now,
        tweetAtMs: input.meta.tweetAtMs,
        tweetUrl: input.meta.tweetUrl,
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        sellPercent: Number.isFinite(Number(input.meta.sellPercentOfCurrent)) ? Number(input.meta.sellPercentOfCurrent) : percent,
        sellPercentOfOriginal: Number.isFinite(Number(input.meta.sellPercentOfOriginal)) ? Number(input.meta.sellPercentOfOriginal) : undefined,
        sellPercentOfCurrent: Number.isFinite(Number(input.meta.sellPercentOfCurrent)) ? Number(input.meta.sellPercentOfCurrent) : percent,
        sellTokenAmountWei: undefined,
        txHash: undefined,
        dryRun: input.dryRun,
        tweetType: input.meta.tweetType,
        channel: input.meta.channel,
        signalId: input.meta.signalId,
        signalEventId: input.meta.signalEventId,
        signalTweetId: input.meta.signalTweetId,
        // Lock to evaluation-time mcap when provided so post-trade slippage can be diagnosed from history.
        marketCapUsd:
          lockedTriggerMcapUsd ??
          (latestMarketCapUsd != null && Number.isFinite(latestMarketCapUsd) && latestMarketCapUsd > 0
            ? latestMarketCapUsd
            : undefined),
        reason: input.reason,
      };

      if (input.dryRun) {
        const delayMs = await readDryRunSellDelayMs();
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        const latestAfterDelay = deps.getLatestMarketCapUsd(input.tokenAddress);
        const now2 = Date.now();
        deps.emitRecord({
          ...baseRecord,
          tsMs: now2,
          id: `${now2}-${Math.random().toString(16).slice(2)}`,
          marketCapUsd:
            lockedTriggerMcapUsd ??
            (latestAfterDelay != null && Number.isFinite(latestAfterDelay) && latestAfterDelay > 0
              ? latestAfterDelay
              : baseRecord.marketCapUsd),
        });
        return true;
      }

      const status = await WalletService.getStatus();
      if (status.locked || !status.address) {
        deps.emitRecord({ ...baseRecord, dryRun: false, reason: 'wallet_locked' });
        return false;
      }

      const settings = await SettingsService.get();
      const isTurbo = (settings as any).chains?.[input.chainId]?.executionMode === 'turbo';
      const tokenInfo =
        (await deps.fetchTokenInfoFresh(input.chainId, input.tokenAddress)) ??
        (await deps.buildGenericTokenInfo(input.chainId, input.tokenAddress));
      if (!tokenInfo) {
        deps.emitRecord({ ...baseRecord, dryRun: false, reason: 'token_info_missing' });
        return false;
      }

      let amountWei = 0n;
      if (!isTurbo) {
        let balanceWei = 0n;
        try {
          balanceWei = BigInt(await TokenService.getBalance(input.tokenAddress, status.address));
        } catch {
          balanceWei = 0n;
        }
        if (balanceWei <= 0n) {
          deps.emitRecord({ ...baseRecord, dryRun: false, sellTokenAmountWei: '0', reason: 'no_balance' });
          return false;
        }
        amountWei = calcSellAmountWei({
          balanceWei,
          sellPercentBps: bps,
          isTurbo,
          tokenInfo,
        });
        if (amountWei <= 0n) {
          deps.emitRecord({ ...baseRecord, dryRun: false, sellTokenAmountWei: '0', reason: 'invalid_amount' });
          return false;
        }
      }

      try {
        await cancelAllSellLimitOrdersForToken(input.chainId, input.tokenAddress);
      } catch {}
      let tokenInfoForTrade = tokenInfo;
      let submittedTxHash: `0x${string}` | null = null;
      let submittedSettled = false;
      let resolveSubmitted: (() => void) | null = null;
      let rejectSubmitted: ((e: unknown) => void) | null = null;
      const submittedGate = new Promise<void>((resolve, reject) => {
        resolveSubmitted = resolve;
        rejectSubmitted = reject;
      });
      try {
        const settlePromise = TradeService.sellWithReceiptAndAutoRecovery({
          chainId: input.chainId,
          tokenAddress: input.tokenAddress,
          tokenAmountWei: amountWei.toString(),
          tokenInfo: tokenInfoForTrade,
          sellPercentBps: bps,
        } as any, {
          maxRetry: 1,
          timeoutMs: 20_000,
          onSubmitted: async (ctx) => {
            submittedTxHash = ctx.txHash;
            await deps.broadcastToActiveTabs({
              type: 'bg:tradeSubmitted',
              source: 'xsniper',
              side: 'sell',
              chainId: input.chainId,
              tokenAddress: input.tokenAddress,
              txHash: ctx.txHash,
              submitElapsedMs: ctx.submitElapsedMs,
            });
            if (!submittedSettled) {
              submittedSettled = true;
              resolveSubmitted?.();
            }
          },
        });
        void settlePromise
          .then(async (doneRsp) => {
            const finalTxHash = (doneRsp as any)?.txHash as `0x${string}`;
            await deps.broadcastToActiveTabs({
              type: 'bg:tradeSuccess',
              source: 'xsniper',
              side: 'sell',
              chainId: input.chainId,
              tokenAddress: input.tokenAddress,
              txHash: finalTxHash,
              submitElapsedMs: (doneRsp as any)?.submitElapsedMs,
              receiptElapsedMs: (doneRsp as any)?.receiptElapsedMs,
              totalElapsedMs: (doneRsp as any)?.totalElapsedMs,
              broadcastVia: (doneRsp as any)?.broadcastVia,
              broadcastUrl: (doneRsp as any)?.broadcastUrl,
              isBundle: (doneRsp as any)?.isBundle,
            });
          })
          .catch(async () => {
            if (!submittedSettled) {
              submittedSettled = true;
              rejectSubmitted?.(new Error('sell_submit_failed'));
              return;
            }
            const txHash = submittedTxHash as any;
            deps.emitRecord({
              ...baseRecord,
              dryRun: false,
              sellTokenAmountWei: isTurbo ? undefined : amountWei.toString(),
              txHash,
              reason: 'sell_receipt_failed',
            } as any);
            try {
              await input.onReceiptFailed?.();
            } catch {
            }
          });
        await submittedGate;
      } catch {
      }
      if (!submittedTxHash) {
        deps.emitRecord({
          ...baseRecord,
          dryRun: false,
          sellTokenAmountWei: amountWei.toString(),
          reason: 'sell_submit_failed',
        });
        return false;
      }
      deps.emitRecord({
        ...baseRecord,
        dryRun: false,
        tokenSymbol: tokenInfoForTrade.symbol ? String(tokenInfoForTrade.symbol) : baseRecord.tokenSymbol,
        tokenName: tokenInfoForTrade.name ? String(tokenInfoForTrade.name) : baseRecord.tokenName,
        sellTokenAmountWei: isTurbo ? undefined : amountWei.toString(),
        txHash: submittedTxHash as any,
      });
      return true;
    } catch {
      return false;
    } finally {
      rapidSellInFlight.delete(dedupeKey);
    }
  };

  return {
    tryDeleteTweetSellOnce,
    tryRapidExitSellOnce,
  };
};
