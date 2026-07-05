import { parseAbi } from 'viem';
import { ChainId } from '@/constants/chains/chainId';
import { SettingsService } from '@/services/settings';
import { RpcService } from '@/services/rpc';
import { SolanaRpcService } from '@/services/chain/solana/rpc';
import { getLimitOrders } from '@/services/storage';
import {
  buildStrategyRollingFloorOrderInputs,
  buildStrategyRollingTakeProfitOrderInputs,
  buildStrategySellOrderInputs,
  buildStrategyTrailingSellOrderInputs,
  getAdvancedAutoSellMode,
} from './advancedAutoSell';
import { applyTrailingStopUpdate, cancelAllSellLimitOrdersForToken, createLimitOrder, hitLimitOrder, normalizeLimitOrderType, patchLimitOrder } from './store';
import { extractRevertReasonFromError, tryGetReceiptRevertReason } from '@/services/tx/errors';
import { createTokenInfoResolvers } from '@/services/xSniper/engine/tokenInfoResolver';
import type { LimitOrder } from '@/types/extention';
import { getTradeExecutor, getWalletAdapter } from '@/services/chain/registry';
import type { ChainAddress } from '@/types/chain/address';
import { buildScopedTokenKey, normalizeWalletAddressKey } from '@/services/xSniper/engine/metrics';

const erc20AbiLite = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
]);

export const tickLimitOrdersForToken = async (input: {
  chainId: number;
  tokenAddress: ChainAddress;
  priceUsd: number;
  executeLimitOrder: (order: LimitOrder, ctx?: { priceUsd?: number }) => Promise<string>;
}) => {
  const { chainId, tokenAddress, priceUsd, executeLimitOrder } = input;
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    return { triggered: [], executed: [], failed: [] as Array<{ id: string; error: string }> };
  }

  const all = await getLimitOrders();
  const keyAddr = buildScopedTokenKey(chainId, tokenAddress);
  const nowMs = Date.now();
  const candidates = all.filter((o) => {
    if (o.chainId !== chainId) return false;
    if (buildScopedTokenKey(o.chainId, o.tokenAddress) !== keyAddr) return false;
    if (!(o.status === 'open' || o.status === 'triggered')) return false;
    if (typeof o.retryAtMs === 'number' && Number.isFinite(o.retryAtMs) && o.retryAtMs > nowMs) return false;
    return true;
  });
  if (!candidates.length) {
    return { triggered: [], executed: [], failed: [] as Array<{ id: string; error: string }> };
  }

  const triggered: string[] = [];
  const executed: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  for (const o of candidates) {
    const prepared = await applyTrailingStopUpdate(o, priceUsd);
    const orderType = normalizeLimitOrderType(prepared.orderType, prepared.side);
    const hit = prepared.status === 'triggered'
      ? true
      : hitLimitOrder(orderType, priceUsd, prepared.triggerPriceUsd);
    if (!hit) continue;

    triggered.push(o.id);
    if (prepared.status !== 'triggered') {
      await patchLimitOrder(o.id, { status: 'triggered' as const });
    }

    try {
      const txHash = await executeLimitOrder({ ...prepared, status: 'triggered' }, { priceUsd });
      executed.push(o.id);
      await patchLimitOrder(o.id, {
        status: 'executed' as const,
        txHash,
        retryCount: 0,
        retryAtMs: undefined,
        lastError: undefined,
      });
    } catch (e: any) {
      const msg = typeof e?.message === 'string' ? e.message : String(e);
      const nextRetryCount = Math.max(0, Math.floor(Number(prepared.retryCount) || 0)) + 1;
      if (nextRetryCount <= 2) {
        const backoffMs = nextRetryCount === 1 ? 1000 : 3000;
        await patchLimitOrder(o.id, {
          status: 'open' as const,
          retryCount: nextRetryCount,
          retryAtMs: Date.now() + backoffMs,
          lastError: msg,
        });
      } else {
        failed.push({ id: o.id, error: msg });
        await patchLimitOrder(o.id, {
          status: 'failed' as const,
          retryCount: nextRetryCount,
          retryAtMs: undefined,
          lastError: msg,
        });
      }
    }
  }

  return { triggered, executed, failed };
};

export const createLimitOrderExecutor = (deps: {
  onOrdersChanged: () => void;
  resolveLatestTokenInfo?: (input: { chainId: number; tokenAddress: string; tokenInfo?: any | null }) => Promise<any | null>;
  onOrderTxSubmitted?: (input: { order: LimitOrder; txHash: string; submitElapsedMs?: number }) => void;
  onOrderSubmitted?: (input: {
    order: LimitOrder;
    txHash: string;
    submitElapsedMs?: number;
    receiptElapsedMs?: number;
    totalElapsedMs?: number;
    broadcastVia?: string;
    broadcastUrl?: string;
    isBundle?: boolean;
  }) => void;
}) => {
  const { fetchTokenInfoFresh, buildGenericTokenInfo } = createTokenInfoResolvers();
  const ensureTxSuccess = async (
    txHash: `0x${string}`,
    chainId: number,
    txSide?: 'buy' | 'sell',
    phase?: 'buy_submit' | 'sell_submit'
  ) => {
    try {
      const receipt = await RpcService.waitForTransactionReceiptAny(txHash, { chainId, txSide, timeoutMs: 20_000 });
      if (receipt.status !== 'success') {
        const client = await RpcService.getClient(chainId);
        const reason = await tryGetReceiptRevertReason(client, txHash, receipt.blockNumber);
        throw new Error(reason ?? 'Transaction failed');
      }
    } catch (e: any) {
      const reason = extractRevertReasonFromError(e);
      const msg = reason ?? (typeof e?.message === 'string' ? e.message : String(e));
      const prefix = phase ? `[${phase}] ` : '';
      throw new Error(`${prefix}${msg}`);
    }
  };

  const resolveFollowupEntryPriceUsd = (order: LimitOrder) => {
    const anchoredEntry = Number(order.rollingEntryPriceUsd);
    if (Number.isFinite(anchoredEntry) && anchoredEntry > 0) return anchoredEntry;
    const trigger = Number(order.triggerPriceUsd);
    const change = Number(order.targetChangePercent);
    if (!(Number.isFinite(trigger) && trigger > 0 && Number.isFinite(change) && change > -99.9)) return undefined;
    const entry = trigger / (1 + change / 100);
    if (!(Number.isFinite(entry) && entry > 0)) return undefined;
    return entry;
  };

  const resolveSellBalance = async (order: LimitOrder): Promise<bigint> => {
    if (order.chainId === ChainId.SOL) {
      const signer = await getWalletAdapter(order.chainId).getSigner(order.fromAddress);
      const ownerAddress = signer?.publicKey?.toBase58?.();
      if (!ownerAddress) throw new Error('Solana signer unavailable');
      return await SolanaRpcService.getSplTokenBalance(ownerAddress, order.tokenAddress);
    }

    const account = await getWalletAdapter(order.chainId).getSigner(order.fromAddress);
    const client = await RpcService.getClient(order.chainId);
    return await client.readContract({
      address: order.tokenAddress as `0x${string}`,
      abi: erc20AbiLite,
      functionName: 'balanceOf',
      args: [account.address],
    });
  };

  const executeLimitOrder = async (order: LimitOrder, ctx?: { priceUsd?: number }) => {
    const resolveLatestTokenInfo = async () => {
      const refreshed = order.chainId === ChainId.SOL
        ? (deps.resolveLatestTokenInfo
          ? await deps.resolveLatestTokenInfo({
            chainId: order.chainId,
            tokenAddress: order.tokenAddress,
            tokenInfo: order.tokenInfo ?? null,
          })
          : null)
        : (
          (await fetchTokenInfoFresh(order.chainId, order.tokenAddress as `0x${string}`)) ??
          (await buildGenericTokenInfo(order.chainId, order.tokenAddress as `0x${string}`))
        );
      if (!refreshed) return order.tokenInfo ?? null;
      if (!order.tokenInfo || JSON.stringify(order.tokenInfo) !== JSON.stringify(refreshed)) {
        try {
          await patchLimitOrder(order.id, { tokenInfo: refreshed });
        } catch {
        }
      }
      return refreshed;
    };
    const tokenInfo = await resolveLatestTokenInfo();
    if (!tokenInfo) throw new Error('Token info required');
    if (order.side === 'buy') {
      const buyAmountWei = order.buyNativeAmountWei || order.buyBnbAmountWei;
      if (!buyAmountWei) throw new Error('Buy amount required');
      const trade = getTradeExecutor(order.chainId);
      const res = await trade.buyWithReceiptAndNonceRecovery({
        chainId: order.chainId,
        tokenAddress: order.tokenAddress,
        nativeAmountWei: buyAmountWei,
        bnbAmountWei: buyAmountWei,
        baseTokenAddress: order.baseTokenAddress,
        fromAddress: order.fromAddress,
        tokenInfo,
      }, {
        maxRetry: 1,
        onSubmitted: (ctx) => {
          deps.onOrderTxSubmitted?.({ order, txHash: ctx.txHash, submitElapsedMs: ctx.submitElapsedMs });
        },
      });
      const txHash = res.txHash;
      await patchLimitOrder(order.id, { txHash });
      deps.onOrderSubmitted?.({
        order,
        txHash,
        submitElapsedMs: (res as any)?.submitElapsedMs,
        receiptElapsedMs: (res as any)?.receiptElapsedMs,
        totalElapsedMs: (res as any)?.totalElapsedMs,
        broadcastVia: (res as any)?.broadcastVia,
        broadcastUrl: (res as any)?.broadcastUrl,
        isBundle: (res as any)?.isBundle,
      });

      try {
        const settings = await SettingsService.get();
        const config = (settings as any).advancedAutoSell;
        const basePriceUsd = Number(ctx?.priceUsd ?? order.triggerPriceUsd);
        let created = 0;
        const orders = buildStrategySellOrderInputs({
          config,
          chainId: order.chainId,
          tokenAddress: order.tokenAddress,
          tokenSymbol: order.tokenSymbol ?? null,
          tokenInfo,
          basePriceUsd,
          entryPriceUsd: basePriceUsd,
        });
        for (const o of orders) {
          await createLimitOrder({ ...o, fromAddress: order.fromAddress, baseTokenAddress: order.baseTokenAddress });
          created += 1;
        }
        const mode = (config as any)?.trailingStop?.activationMode ?? 'after_first_take_profit';
        const autoSellMode = getAdvancedAutoSellMode(config);
        if (mode === 'immediate' && (config as any)?.trailingStop?.enabled) {
          if (autoSellMode === 'rolling_take_profit') {
            const entryPriceUsd = basePriceUsd;
            const rolling = buildStrategyRollingTakeProfitOrderInputs({
              config,
              chainId: order.chainId,
              tokenAddress: order.tokenAddress,
              tokenSymbol: order.tokenSymbol ?? null,
              tokenInfo,
              basePriceUsd,
              entryPriceUsd,
            });
            if (rolling) {
              await createLimitOrder({ ...rolling, fromAddress: order.fromAddress, baseTokenAddress: order.baseTokenAddress });
              created += 1;
            }
            const floor = buildStrategyRollingFloorOrderInputs({
              config,
              chainId: order.chainId,
              tokenAddress: order.tokenAddress,
              tokenSymbol: order.tokenSymbol ?? null,
              tokenInfo,
              entryPriceUsd,
            });
            if (floor) {
              await createLimitOrder({ ...floor, fromAddress: order.fromAddress, baseTokenAddress: order.baseTokenAddress });
              created += 1;
            }
          } else {
            const trailing = buildStrategyTrailingSellOrderInputs({
              config,
              chainId: order.chainId,
              tokenAddress: order.tokenAddress,
              tokenSymbol: order.tokenSymbol ?? null,
              tokenInfo,
              basePriceUsd,
            });
            if (trailing) {
              await createLimitOrder({ ...trailing, fromAddress: order.fromAddress, baseTokenAddress: order.baseTokenAddress });
              created += 1;
            }
          }
        }
        if (created > 0) deps.onOrdersChanged();
      } catch {
      }

      return txHash;
    }

    const balance = await resolveSellBalance(order);
    const fixedAmount = (() => {
      try {
        return order.sellTokenAmountWei ? BigInt(order.sellTokenAmountWei) : 0n;
      } catch {
        return 0n;
      }
    })();
    const percentBps = order.sellPercentBps ?? 0;
    const platform = tokenInfo.launchpad_platform?.toLowerCase() || '';
    const isInnerFourMeme = !!tokenInfo.launchpad && (platform.includes('four')) && tokenInfo.launchpad_status !== 1;
    const amountByPercent = (Number.isFinite(percentBps) && percentBps > 0 && percentBps <= 10000)
      ? (() => {
        const raw = (balance * BigInt(percentBps)) / 10000n;
        if (percentBps === 10000) return raw;
        if (!isInnerFourMeme) return raw;
        return (raw / 1000000000n) * 1000000000n;
      })()
      : 0n;
    const rawAmountIn = fixedAmount > 0n ? fixedAmount : amountByPercent;
    const amountIn = rawAmountIn > balance ? balance : rawAmountIn;
    if (amountIn <= 0n) throw new Error('No balance');

    const sellInput = {
      chainId: order.chainId,
      tokenAddress: order.tokenAddress,
      tokenAmountWei: amountIn.toString(),
      baseTokenAddress: order.baseTokenAddress,
      fromAddress: order.fromAddress,
      tokenInfo,
      sellPercentBps: Number.isFinite(percentBps) && percentBps > 0 && percentBps <= 10000 ? percentBps : undefined,
    } as const;

    const firstSell = await getTradeExecutor(order.chainId).sellWithReceiptAndAutoRecovery(sellInput, {
      maxRetry: 1,
      timeoutMs: 20_000,
      onSubmitted: (ctx) => {
        deps.onOrderTxSubmitted?.({ order, txHash: ctx.txHash, submitElapsedMs: ctx.submitElapsedMs });
      },
    });
    let { txHash } = firstSell;
    await patchLimitOrder(order.id, { txHash });
    deps.onOrderSubmitted?.({
      order,
      txHash,
      submitElapsedMs: (firstSell as any)?.submitElapsedMs,
      receiptElapsedMs: (firstSell as any)?.receiptElapsedMs,
      totalElapsedMs: (firstSell as any)?.totalElapsedMs,
      broadcastVia: (firstSell as any)?.broadcastVia,
      broadcastUrl: (firstSell as any)?.broadcastUrl,
      isBundle: (firstSell as any)?.isBundle,
    });

    try {
      const type = normalizeLimitOrderType(order.orderType, order.side);
      const isRollingTakeProfit = type === 'take_profit_sell' && Number(order.rollingStepPercent) > 0;
      if (isRollingTakeProfit && percentBps > 0 && percentBps < 10000) {
        const settings = await SettingsService.get();
        const config = (settings as any).advancedAutoSell;
        const entryPriceUsd = Number(order.rollingEntryPriceUsd);
        const basePriceUsd = Number(ctx?.priceUsd ?? order.triggerPriceUsd);
        const nextRolling = buildStrategyRollingTakeProfitOrderInputs({
          config,
          chainId: order.chainId,
          tokenAddress: order.tokenAddress,
          tokenSymbol: order.tokenSymbol ?? null,
          tokenInfo,
          basePriceUsd,
          entryPriceUsd: Number.isFinite(entryPriceUsd) && entryPriceUsd > 0 ? entryPriceUsd : basePriceUsd,
        });
        if (nextRolling) await createLimitOrder({ ...nextRolling, fromAddress: order.fromAddress, baseTokenAddress: order.baseTokenAddress });

        if (Number.isFinite(entryPriceUsd) && entryPriceUsd > 0) {
          const floor = buildStrategyRollingFloorOrderInputs({
            config,
            chainId: order.chainId,
            tokenAddress: order.tokenAddress,
            tokenSymbol: order.tokenSymbol ?? null,
            tokenInfo,
            entryPriceUsd,
          });
          if (floor) await createLimitOrder({ ...floor, fromAddress: order.fromAddress, baseTokenAddress: order.baseTokenAddress });
        }
        deps.onOrdersChanged();
      } else if (type === 'take_profit_sell' && percentBps > 0 && percentBps < 10000) {
        const all = await getLimitOrders();
        const keyAddr = buildScopedTokenKey(order.chainId, order.tokenAddress);
        const settings = await SettingsService.get();
        const config = (settings as any).advancedAutoSell;
        const mode = (config as any)?.trailingStop?.activationMode ?? 'after_first_take_profit';
        const autoSellMode = getAdvancedAutoSellMode(config);
        const hasSpecialOrder = all.some((o) => {
          if (o.chainId !== order.chainId) return false;
          if (o.status !== 'open') return false;
          if (buildScopedTokenKey(o.chainId, o.tokenAddress) !== keyAddr) return false;
          if ((o.fromAddress ? normalizeWalletAddressKey(o.fromAddress) : null) !== (order.fromAddress ? normalizeWalletAddressKey(order.fromAddress) : null)) return false;
          const ot = normalizeLimitOrderType(o.orderType, o.side);
          if (autoSellMode === 'rolling_take_profit') {
            return ot === 'take_profit_sell' && Number(o.rollingStepPercent) > 0;
          }
          return ot === 'trailing_stop_sell';
        });
        if (hasSpecialOrder) return txHash;
        if (mode === 'after_first_take_profit' || mode === 'after_last_take_profit') {
          const shouldCreate = mode === 'after_first_take_profit'
            ? true
            : !all.some((o) => {
              if (o.chainId !== order.chainId) return false;
              if (o.status !== 'open') return false;
              if (buildScopedTokenKey(o.chainId, o.tokenAddress) !== keyAddr) return false;
              if ((o.fromAddress ? normalizeWalletAddressKey(o.fromAddress) : null) !== (order.fromAddress ? normalizeWalletAddressKey(order.fromAddress) : null)) return false;
              const ot = normalizeLimitOrderType(o.orderType, o.side);
              if (ot !== 'take_profit_sell' || Number(o.rollingStepPercent) > 0) return false;
              return o.triggerPriceUsd > order.triggerPriceUsd;
            });
          if (shouldCreate) {
            const basePriceUsd = Number(ctx?.priceUsd ?? order.triggerPriceUsd);
            if (autoSellMode === 'rolling_take_profit') {
              const resolvedEntryPriceUsd = resolveFollowupEntryPriceUsd(order);
              if (resolvedEntryPriceUsd == null) return txHash;
              const entryPriceUsd = resolvedEntryPriceUsd;
              const nextRolling = buildStrategyRollingTakeProfitOrderInputs({
                config,
                chainId: order.chainId,
                tokenAddress: order.tokenAddress,
                tokenSymbol: order.tokenSymbol ?? null,
                tokenInfo,
                basePriceUsd,
                entryPriceUsd,
              });
              if (nextRolling) {
                await createLimitOrder({ ...nextRolling, fromAddress: order.fromAddress, baseTokenAddress: order.baseTokenAddress });
              }
              const floor = buildStrategyRollingFloorOrderInputs({
                config,
                chainId: order.chainId,
                tokenAddress: order.tokenAddress,
                tokenSymbol: order.tokenSymbol ?? null,
                tokenInfo,
                entryPriceUsd,
              });
              if (floor) await createLimitOrder({ ...floor, fromAddress: order.fromAddress, baseTokenAddress: order.baseTokenAddress });
              deps.onOrdersChanged();
            } else {
              const input = buildStrategyTrailingSellOrderInputs({
                config,
                chainId: order.chainId,
                tokenAddress: order.tokenAddress,
                tokenSymbol: order.tokenSymbol ?? null,
                tokenInfo,
                basePriceUsd,
              });
              if (input) {
                await createLimitOrder({ ...input, fromAddress: order.fromAddress, baseTokenAddress: order.baseTokenAddress });
                deps.onOrdersChanged();
              }
            }
          }
        }
      }
    } catch {
    }

    if (percentBps === 10000) {
      setTimeout(() => {
        void cancelAllSellLimitOrdersForToken(order.chainId, order.tokenAddress, order.fromAddress);
        deps.onOrdersChanged();
      }, 2000);
    }

    return txHash;
  };

  return { executeLimitOrder };
};
