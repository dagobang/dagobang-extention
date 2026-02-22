import { parseAbi } from 'viem';
import { WalletService } from '@/services/wallet';
import { SettingsService } from '@/services/settings';
import { TradeService } from '@/services/trade';
import { RpcService } from '@/services/rpc';
import { getLimitOrders } from '@/services/storage';
import { buildAdvancedAutoSellSellLimitOrderInputs, buildAdvancedAutoSellTrailingStopSellLimitOrderInput } from './advancedAutoSell';
import { applyTrailingStopUpdate, cancelAllSellLimitOrdersForToken, createLimitOrder, hitLimitOrder, normalizeLimitOrderType, patchLimitOrder } from './store';
import { extractRevertReasonFromError, tryGetReceiptRevertReason } from '@/services/tx/errors';
import type { LimitOrder } from '@/types/extention';

const erc20AbiLite = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
]);

export const tickLimitOrdersForToken = async (input: {
  chainId: number;
  tokenAddress: `0x${string}`;
  priceUsd: number;
  executeLimitOrder: (order: LimitOrder, ctx?: { priceUsd?: number }) => Promise<`0x${string}`>;
}) => {
  const { chainId, tokenAddress, priceUsd, executeLimitOrder } = input;
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    return { triggered: [], executed: [], failed: [] as Array<{ id: string; error: string }> };
  }

  const all = await getLimitOrders();
  const keyAddr = tokenAddress.toLowerCase();
  const candidates = all.filter((o) => o.chainId === chainId && o.status === 'open' && o.tokenAddress.toLowerCase() === keyAddr);
  if (!candidates.length) {
    return { triggered: [], executed: [], failed: [] as Array<{ id: string; error: string }> };
  }

  const triggered: string[] = [];
  const executed: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  for (const o of candidates) {
    const prepared = await applyTrailingStopUpdate(o, priceUsd);
    const orderType = normalizeLimitOrderType(prepared.orderType, prepared.side);
    const hit = hitLimitOrder(orderType, priceUsd, prepared.triggerPriceUsd);
    if (!hit) continue;

    triggered.push(o.id);
    await patchLimitOrder(o.id, { status: 'triggered' as const });

    try {
      const txHash = await executeLimitOrder({ ...prepared, status: 'triggered' }, { priceUsd });
      executed.push(o.id);
      await patchLimitOrder(o.id, { status: 'executed' as const, txHash });
    } catch (e: any) {
      const msg = typeof e?.message === 'string' ? e.message : String(e);
      failed.push({ id: o.id, error: msg });
      await patchLimitOrder(o.id, { status: 'failed' as const, lastError: msg });
    }
  }

  return { triggered, executed, failed };
};

export const createLimitOrderExecutor = (deps: { onOrdersChanged: () => void }) => {
  const ensureTxSuccess = async (txHash: `0x${string}`) => {
    try {
      const client = await RpcService.getClient();
      const receipt = await client.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== 'success') {
        const reason = await tryGetReceiptRevertReason(client, txHash, receipt.blockNumber);
        throw new Error(reason ?? 'Transaction failed');
      }
    } catch (e: any) {
      const reason = extractRevertReasonFromError(e);
      throw new Error(reason ?? (typeof e?.message === 'string' ? e.message : String(e)));
    }
  };

  const executeLimitOrder = async (order: LimitOrder, ctx?: { priceUsd?: number }) => {
    if (!order.tokenInfo) throw new Error('Token info required');
    if (order.side === 'buy') {
      if (!order.buyBnbAmountWei) throw new Error('Buy amount required');
      const res = await TradeService.buy({
        chainId: order.chainId,
        tokenAddress: order.tokenAddress,
        bnbAmountWei: order.buyBnbAmountWei,
        tokenInfo: order.tokenInfo,
      });
      const txHash = res.txHash as `0x${string}`;
      await patchLimitOrder(order.id, { txHash });
      await ensureTxSuccess(txHash);

      await TradeService.approveMaxForSellIfNeeded(order.chainId, order.tokenAddress, order.tokenInfo);

      try {
        const settings = await SettingsService.get();
        const config = (settings as any).advancedAutoSell;
        const basePriceUsd = Number(ctx?.priceUsd ?? order.triggerPriceUsd);
        let created = 0;
        const orders = buildAdvancedAutoSellSellLimitOrderInputs({
          config,
          chainId: order.chainId,
          tokenAddress: order.tokenAddress,
          tokenSymbol: order.tokenSymbol ?? null,
          tokenInfo: order.tokenInfo,
          basePriceUsd,
        });
        for (const o of orders) {
          await createLimitOrder(o);
          created += 1;
        }
        const mode = (config as any)?.trailingStop?.activationMode ?? 'after_last_take_profit';
        if (mode === 'immediate' && (config as any)?.trailingStop?.enabled) {
          const trailing = buildAdvancedAutoSellTrailingStopSellLimitOrderInput({
            config,
            chainId: order.chainId,
            tokenAddress: order.tokenAddress,
            tokenSymbol: order.tokenSymbol ?? null,
            tokenInfo: order.tokenInfo,
            basePriceUsd,
          });
          if (trailing) {
            await createLimitOrder(trailing);
            created += 1;
          }
        }
        if (created > 0) deps.onOrdersChanged();
      } catch {
      }

      return txHash;
    }

    const account = await WalletService.getSigner();
    const client = await RpcService.getClient();
    const balance = await client.readContract({
      address: order.tokenAddress,
      abi: erc20AbiLite,
      functionName: 'balanceOf',
      args: [account.address],
    });
    const fixedAmount = (() => {
      try {
        return order.sellTokenAmountWei ? BigInt(order.sellTokenAmountWei) : 0n;
      } catch {
        return 0n;
      }
    })();
    const percentBps = order.sellPercentBps ?? 0;
    const platform = order.tokenInfo?.launchpad_platform?.toLowerCase() || '';
    const isInnerFourMeme = !!order.tokenInfo?.launchpad && (platform === 'fourmeme' || platform === 'bn_fourmeme') && order.tokenInfo.launchpad_status !== 1;
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

    const approveTx = await TradeService.approveMaxForSellIfNeeded(order.chainId, order.tokenAddress, order.tokenInfo);
    if (approveTx) {
      await ensureTxSuccess(approveTx);
    }

    const { txHash } = await TradeService.sell({
      chainId: order.chainId,
      tokenAddress: order.tokenAddress,
      tokenAmountWei: amountIn.toString(),
      tokenInfo: order.tokenInfo,
      sellPercentBps: Number.isFinite(percentBps) && percentBps > 0 && percentBps <= 10000 ? percentBps : undefined,
    });
    await patchLimitOrder(order.id, { txHash });
    await ensureTxSuccess(txHash);

    try {
      const type = normalizeLimitOrderType(order.orderType, order.side);
      if (type === 'take_profit_sell' && percentBps > 0 && percentBps < 10000) {
        const all = await getLimitOrders();
        const keyAddr = order.tokenAddress.toLowerCase();
        const hasTrailing = all.some((o) => {
          if (o.chainId !== order.chainId) return false;
          if (o.status !== 'open') return false;
          if (o.tokenAddress.toLowerCase() !== keyAddr) return false;
          const ot = normalizeLimitOrderType(o.orderType, o.side);
          return ot === 'trailing_stop_sell';
        });
        if (!hasTrailing) {
          const settings = await SettingsService.get();
          const config = (settings as any).advancedAutoSell;
          const mode = (config as any)?.trailingStop?.activationMode ?? 'after_last_take_profit';
          if (mode === 'after_first_take_profit' || mode === 'after_last_take_profit') {
            const shouldCreate = mode === 'after_first_take_profit'
              ? true
              : !all.some((o) => {
                if (o.chainId !== order.chainId) return false;
                if (o.status !== 'open') return false;
                if (o.tokenAddress.toLowerCase() !== keyAddr) return false;
                const ot = normalizeLimitOrderType(o.orderType, o.side);
                if (ot !== 'take_profit_sell') return false;
                return o.triggerPriceUsd > order.triggerPriceUsd;
              });
            if (shouldCreate) {
              const basePriceUsd = Number(ctx?.priceUsd ?? order.triggerPriceUsd);
              const input = buildAdvancedAutoSellTrailingStopSellLimitOrderInput({
                config,
                chainId: order.chainId,
                tokenAddress: order.tokenAddress,
                tokenSymbol: order.tokenSymbol ?? null,
                tokenInfo: order.tokenInfo,
                basePriceUsd,
              });
              if (input) {
                await createLimitOrder(input);
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
        void cancelAllSellLimitOrdersForToken(order.chainId, order.tokenAddress);
        deps.onOrdersChanged();
      }, 2000);
    }

    return txHash;
  };

  return { executeLimitOrder };
};
