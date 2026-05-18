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

const parseStrategyWalletAddress = (input: unknown): `0x${string}` | undefined => {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw) return undefined;
  if (!/^0x[a-f0-9]{40}$/.test(raw)) return undefined;
  return raw as `0x${string}`;
};

const buildPositionKey = (input: {
  chainId: number;
  tokenAddress: `0x${string}`;
  walletAddress?: `0x${string}`;
  dryRun: boolean;
}) => {
  const walletKey = input.walletAddress ? String(input.walletAddress).toLowerCase() : 'all-wallets';
  return `${input.dryRun ? 'dry:' : ''}${input.chainId}:${input.tokenAddress.toLowerCase()}:${walletKey}`;
};

const summarizeTokenInfoForLog = (tokenInfo: TokenInfo | null | undefined) => {
  if (!tokenInfo) return null;
  return {
    chain: tokenInfo.chain,
    address: tokenInfo.address,
    symbol: tokenInfo.symbol,
    launchpad: (tokenInfo as any)?.launchpad,
    launchpad_platform: tokenInfo.launchpad_platform,
    launchpad_status: (tokenInfo as any)?.launchpad_status,
    pool_pair: (tokenInfo as any)?.pool_pair,
    quote_token: tokenInfo.quote_token,
    ai_creator: (tokenInfo as any)?.ai_creator,
  };
};

const summarizeErrorForLog = (error: unknown) => {
  const e = error as any;
  return {
    shortMessage: e?.shortMessage ? String(e.shortMessage) : undefined,
    message: e?.message ? String(e.message) : undefined,
    causeShortMessage: e?.cause?.shortMessage ? String(e.cause.shortMessage) : undefined,
    causeMessage: e?.cause?.message ? String(e.cause.message) : undefined,
    name: e?.name ? String(e.name) : undefined,
  };
};

export const createSellExecutors = (deps: {
  cleanupPosKey: (posKey: string) => void;
  emitRecord: (record: XSniperBuyRecord) => void;
  broadcastToActiveTabs: (message: any) => Promise<void>;
  fetchTokenInfoFresh: (chainId: number, tokenAddress: `0x${string}`) => Promise<TokenInfo | null>;
  buildGenericTokenInfo: (chainId: number, tokenAddress: `0x${string}`) => Promise<TokenInfo | null>;
  getLatestMarketCapUsd: (chainId: number, tokenAddress: `0x${string}`) => number | null;
}) => {
  const deleteSellInFlight = new Set<string>();
  const rapidSellInFlight = new Set<string>();
  const classifySellFailureReason = (error: unknown, phase: 'submit' | 'receipt') => {
    const e = error as any;
    const text = String(
      e?.shortMessage ??
      e?.message ??
      e?.cause?.shortMessage ??
      e?.cause?.message ??
      e ??
      '',
    ).toLowerCase();
    if (!text) return phase === 'submit' ? 'sell_submit_failed_unknown' : 'sell_receipt_failed_unknown';
    if (text.includes('nonce')) return phase === 'submit' ? 'sell_submit_failed_nonce' : 'sell_receipt_failed_nonce';
    if (text.includes('allowance') || text.includes('insufficient allowance')) {
      return phase === 'submit' ? 'sell_submit_failed_allowance' : 'sell_receipt_failed_allowance';
    }
    if (text.includes('pool') || text.includes('liquidity') || text.includes('route') || text.includes('pair')) {
      return phase === 'submit' ? 'sell_submit_failed_route' : 'sell_receipt_failed_route';
    }
    if (text.includes('token info') || text.includes('token_info')) {
      return phase === 'submit' ? 'sell_submit_failed_token_info' : 'sell_receipt_failed_token_info';
    }
    if (text.includes('timeout') || text.includes('timed out')) {
      return phase === 'submit' ? 'sell_submit_failed_timeout' : 'sell_receipt_failed_timeout';
    }
    return phase === 'submit' ? 'sell_submit_failed_unknown' : 'sell_receipt_failed_unknown';
  };
  const analyzeReceiptFailureBeforeRetry = async (input: {
    chainId: number;
    tokenAddress: `0x${string}`;
    tokenInfo: TokenInfo;
    fromAddress: `0x${string}`;
    reason: string;
  }) => {
    let balanceWei = 0n;
    try {
      balanceWei = BigInt(await TokenService.getBalance(input.tokenAddress, input.fromAddress, input.chainId));
    } catch {
      balanceWei = 0n;
    }
    if (balanceWei <= 0n) {
      return {
        reason: 'sell_receipt_failed_zero_balance',
        terminal: true,
        soldOut: true,
        allowanceRepaired: false,
      } as const;
    }

    let allowanceInsufficient = false;
    try {
      const check = await TradeService.checkSellAllowanceInsufficient(
        input.chainId,
        input.tokenAddress,
        input.tokenInfo,
        { fromAddress: input.fromAddress },
      );
      allowanceInsufficient = check.insufficient === true;
    } catch {
      allowanceInsufficient = false;
    }

    if (!allowanceInsufficient) {
      return {
        reason: input.reason,
        terminal: false,
        soldOut: false,
        allowanceRepaired: false,
      } as const;
    }

    let repaired = false;
    try {
      await TradeService.approveMaxForSellIfNeeded(
        input.chainId,
        input.tokenAddress,
        input.tokenInfo,
        { fromAddress: input.fromAddress },
      );
      repaired = true;
    } catch {
      repaired = false;
    }

    return {
      reason: repaired ? 'sell_receipt_failed_allowance_repaired' : 'sell_receipt_failed_allowance',
      terminal: !repaired,
      soldOut: false,
      allowanceRepaired: repaired,
    } as const;
  };
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
    walletAddress?: `0x${string}`;
  }) => {
    const percent = Math.max(0, Math.min(100, Number(input.percent)));
    if (!Number.isFinite(percent) || percent <= 0) return;
    const bps = Math.floor(percent * 100);
    if (!(bps > 0)) return;
    const posKey = buildPositionKey({
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      walletAddress: input.walletAddress,
      dryRun: input.dryRun,
    });
    const signalTweetId = String(input.signal.tweetId ?? '').trim();
    const sourceTweetId = String((input.signal as any)?.sourceTweetId ?? '').trim();
    const signalEventId = String(input.signal.eventId ?? '').trim();
    const signalStableId = signalTweetId || sourceTweetId || signalEventId;
    const walletKey = input.walletAddress ? String(input.walletAddress).toLowerCase() : 'all-wallets';
    const dedupeKey = `${input.chainId}:${input.tokenAddress.toLowerCase()}:${walletKey}:${signalStableId}:${bps}`;
    if (deleteSellInFlight.has(dedupeKey)) return;
    deleteSellInFlight.add(dedupeKey);
    try {
      const now = Date.now();
      const tweetAtMs = getSignalTimeMs(input.signal) ?? undefined;
      const tweetUrl = buildTweetUrl(input.signal);
      const latestMarketCapUsd = deps.getLatestMarketCapUsd(input.chainId, input.tokenAddress);
      const baseRecord: XSniperBuyRecord = {
        id: `${now}-${Math.random().toString(16).slice(2)}`,
        side: 'sell',
        tsMs: now,
        tweetAtMs,
        tweetUrl,
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        walletAddress: input.walletAddress,
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
        const latestAfterDelay = deps.getLatestMarketCapUsd(input.chainId, input.tokenAddress);
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
      const preferredWalletAddress = parseStrategyWalletAddress(input.walletAddress);
      const availableWalletSet = new Set(
        (status.accounts ?? [])
          .map((acc) => String(acc?.address ?? '').trim().toLowerCase())
          .filter((addr): addr is `0x${string}` => /^0x[a-f0-9]{40}$/.test(addr)),
      );
      if (preferredWalletAddress && !availableWalletSet.has(preferredWalletAddress)) {
        deps.emitRecord({ ...baseRecord, dryRun: false, reason: 'wallet_not_found' });
        return;
      }
      const sellFromAddress = preferredWalletAddress ?? (status.address ? (String(status.address).toLowerCase() as `0x${string}`) : undefined);
      if (status.locked || !sellFromAddress) {
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
          balanceWei = BigInt(await TokenService.getBalance(input.tokenAddress, sellFromAddress, input.chainId));
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
      let submittedTxHash: `0x${string}` | null = null;
      let sellErr: unknown = null;
      let tokenInfoForTrade = tokenInfo;
      try {
        rsp = await TradeService.sellWithReceiptAndAutoRecovery({
          chainId: input.chainId,
          tokenAddress: input.tokenAddress,
          tokenAmountWei: amountWei.toString(),
          tokenInfo: tokenInfoForTrade,
          sellPercentBps: bps,
          fromAddress: sellFromAddress,
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
          },
        });
      } catch (err) {
        sellErr = err;
      }
      if (!rsp) {
        const emitFailRecord = (reason: string) => {
          deps.emitRecord({
            ...baseRecord,
            dryRun: false,
            sellTokenAmountWei: isTurbo ? undefined : amountWei.toString(),
            txHash: submittedTxHash as any,
            reason,
          });
        };
        if (submittedTxHash && sellFromAddress) {
          const firstReason = classifySellFailureReason(sellErr, 'receipt');
          const firstAnalysis = await analyzeReceiptFailureBeforeRetry({
            chainId: input.chainId,
            tokenAddress: input.tokenAddress,
            tokenInfo: tokenInfoForTrade,
            fromAddress: sellFromAddress,
            reason: firstReason,
          });
          console.error('[xsniper.sell.receipt.failed]', {
            chainId: input.chainId,
            tokenAddress: input.tokenAddress,
            fromAddress: sellFromAddress,
            sellPercentBps: bps,
            isTurbo,
            sellTokenAmountWei: isTurbo ? undefined : amountWei.toString(),
            txHash: submittedTxHash,
            reason: firstAnalysis.reason,
            terminal: firstAnalysis.terminal,
            soldOut: firstAnalysis.soldOut,
            tokenInfo: summarizeTokenInfoForLog(tokenInfoForTrade),
            error: summarizeErrorForLog(sellErr),
          });
          if (!firstAnalysis.allowanceRepaired) {
            emitFailRecord(firstAnalysis.reason);
            if (firstAnalysis.soldOut || firstAnalysis.terminal) deps.cleanupPosKey(posKey);
            return;
          }

          // Allowance repaired: submit exactly one follow-up sell attempt.
          let retryRsp: any;
          let retrySubmittedTxHash: `0x${string}` | null = null;
          let retryErr: unknown = null;
          try {
            retryRsp = await TradeService.sellWithReceiptAndAutoRecovery({
              chainId: input.chainId,
              tokenAddress: input.tokenAddress,
              tokenAmountWei: amountWei.toString(),
              tokenInfo: tokenInfoForTrade,
              sellPercentBps: bps,
              fromAddress: sellFromAddress,
            } as any, {
              maxRetry: 0,
              timeoutMs: 20_000,
              onSubmitted: async (ctx) => {
                retrySubmittedTxHash = ctx.txHash;
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
          } catch (err) {
            retryErr = err;
          }
          if (!retryRsp) {
            const retryTxHash = retrySubmittedTxHash ?? submittedTxHash;
            if (retrySubmittedTxHash) {
              const retryReason = classifySellFailureReason(retryErr, 'receipt');
              const retryAnalysis = await analyzeReceiptFailureBeforeRetry({
                chainId: input.chainId,
                tokenAddress: input.tokenAddress,
                tokenInfo: tokenInfoForTrade,
                fromAddress: sellFromAddress,
                reason: retryReason,
              });
              console.error('[xsniper.sell.receipt.failed.retry]', {
                chainId: input.chainId,
                tokenAddress: input.tokenAddress,
                fromAddress: sellFromAddress,
                sellPercentBps: bps,
                isTurbo,
                sellTokenAmountWei: isTurbo ? undefined : amountWei.toString(),
                txHash: retryTxHash,
                reason: retryAnalysis.reason,
                terminal: retryAnalysis.terminal,
                soldOut: retryAnalysis.soldOut,
                tokenInfo: summarizeTokenInfoForLog(tokenInfoForTrade),
                error: summarizeErrorForLog(retryErr),
              });
              deps.emitRecord({
                ...baseRecord,
                dryRun: false,
                sellTokenAmountWei: isTurbo ? undefined : amountWei.toString(),
                txHash: retryTxHash as any,
                reason: retryAnalysis.reason,
              });
              if (retryAnalysis.soldOut || retryAnalysis.terminal) deps.cleanupPosKey(posKey);
            } else {
              deps.emitRecord({
                ...baseRecord,
                dryRun: false,
                sellTokenAmountWei: isTurbo ? undefined : amountWei.toString(),
                txHash: retryTxHash as any,
                reason: classifySellFailureReason(retryErr, 'submit'),
              });
            }
            return;
          }
          rsp = retryRsp;
        }
      }
      if (!rsp) {
        deps.emitRecord({
          ...baseRecord,
          dryRun: false,
          sellTokenAmountWei: isTurbo ? undefined : amountWei.toString(),
          txHash: submittedTxHash as any,
          reason: classifySellFailureReason(sellErr, submittedTxHash ? 'receipt' : 'submit'),
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
    onReceiptFailed?: (meta?: {
      reason?: string;
      terminal?: boolean;
      soldOut?: boolean;
      allowanceRepaired?: boolean;
    }) => void | Promise<void>;
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
      walletAddress?: `0x${string}`;
    };
  }) => {
    const percent = Math.max(0, Math.min(100, Number(input.percent)));
    if (!Number.isFinite(percent) || percent <= 0) return false;
    const bps = Math.floor(percent * 100);
    if (!(bps > 0)) return false;
    const walletKey = input.meta.walletAddress ? String(input.meta.walletAddress).toLowerCase() : 'all-wallets';
    const dedupeKey = `${input.chainId}:${input.tokenAddress.toLowerCase()}:${walletKey}:${input.reason}:${bps}`;
    if (rapidSellInFlight.has(dedupeKey)) return false;
    rapidSellInFlight.add(dedupeKey);
    try {
      const now = Date.now();
      const latestMarketCapUsd = deps.getLatestMarketCapUsd(input.chainId, input.tokenAddress);
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
        walletAddress: input.meta.walletAddress,
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
        const latestAfterDelay = deps.getLatestMarketCapUsd(input.chainId, input.tokenAddress);
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
      const preferredWalletAddress = parseStrategyWalletAddress(input.meta.walletAddress);
      const availableWalletSet = new Set(
        (status.accounts ?? [])
          .map((acc) => String(acc?.address ?? '').trim().toLowerCase())
          .filter((addr): addr is `0x${string}` => /^0x[a-f0-9]{40}$/.test(addr)),
      );
      if (preferredWalletAddress && !availableWalletSet.has(preferredWalletAddress)) {
        deps.emitRecord({ ...baseRecord, dryRun: false, reason: 'wallet_not_found' });
        return false;
      }
      const sellFromAddress = preferredWalletAddress ?? (status.address ? (String(status.address).toLowerCase() as `0x${string}`) : undefined);
      if (status.locked || !sellFromAddress) {
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
          balanceWei = BigInt(await TokenService.getBalance(input.tokenAddress, sellFromAddress, input.chainId));
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
      let submitFailedReason: string = 'sell_submit_failed_unknown';
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
          fromAddress: sellFromAddress,
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
          .catch(async (err) => {
            if (!submittedSettled) {
              submittedSettled = true;
              submitFailedReason = classifySellFailureReason(err, 'submit');
              rejectSubmitted?.(new Error(submitFailedReason));
              return;
            }
            const receiptFailedReason = classifySellFailureReason(err, 'receipt');
            const receiptAnalysis = await analyzeReceiptFailureBeforeRetry({
              chainId: input.chainId,
              tokenAddress: input.tokenAddress,
              tokenInfo: tokenInfoForTrade,
              fromAddress: sellFromAddress,
              reason: receiptFailedReason,
            });
            const txHash = submittedTxHash as any;
            console.error('[xsniper.rapid.sell.receipt.failed]', {
              chainId: input.chainId,
              tokenAddress: input.tokenAddress,
              fromAddress: sellFromAddress,
              sellPercentBps: bps,
              isTurbo,
              sellTokenAmountWei: isTurbo ? undefined : amountWei.toString(),
              txHash,
              reason: receiptAnalysis.reason,
              terminal: receiptAnalysis.terminal,
              soldOut: receiptAnalysis.soldOut,
              tokenInfo: summarizeTokenInfoForLog(tokenInfoForTrade),
              error: summarizeErrorForLog(err),
            });
            deps.emitRecord({
              ...baseRecord,
              dryRun: false,
              sellTokenAmountWei: isTurbo ? undefined : amountWei.toString(),
              txHash,
              reason: receiptAnalysis.reason,
            } as any);
            try {
              await input.onReceiptFailed?.({
                reason: receiptAnalysis.reason,
                terminal: receiptAnalysis.terminal,
                soldOut: receiptAnalysis.soldOut,
                allowanceRepaired: receiptAnalysis.allowanceRepaired,
              });
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
          reason: submitFailedReason,
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
