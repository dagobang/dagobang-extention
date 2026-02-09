import type { LimitOrder, LimitOrderCreateInput, LimitOrderType } from '@/types/extention';
import { getLimitOrders, setLimitOrders } from '@/services/storage';
import { normalizePriceValue } from '@/utils/format';

export const makeLimitOrderId = () => {
  try {
    return crypto.randomUUID();
  } catch {
    return `lo_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
};

export const normalizeLimitOrderType = (orderType: LimitOrderType | undefined, side: 'buy' | 'sell'): LimitOrderType => {
  if (
    orderType === 'take_profit_sell' ||
    orderType === 'stop_loss_sell' ||
    orderType === 'trailing_stop_sell' ||
    orderType === 'low_buy' ||
    orderType === 'high_buy'
  ) {
    return orderType;
  }
  return side === 'buy' ? 'low_buy' : 'take_profit_sell';
};

export const sideFromLimitOrderType = (orderType: LimitOrderType): 'buy' | 'sell' => {
  return orderType === 'low_buy' || orderType === 'high_buy' ? 'buy' : 'sell';
};

export const hitLimitOrder = (orderType: LimitOrderType, priceUsd: number, triggerPriceUsd: number) => {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return false;
  if (!Number.isFinite(triggerPriceUsd) || triggerPriceUsd <= 0) return false;
  if (orderType === 'high_buy' || orderType === 'take_profit_sell') return priceUsd >= triggerPriceUsd;
  return priceUsd <= triggerPriceUsd;
};

const normalizePriceUsd = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return value;
  return normalizePriceValue(value, 4, 4);
};

export const patchLimitOrder = async (id: string, patch: Partial<LimitOrder>) => {
  const all = await getLimitOrders();
  const nextPatch = { ...patch } as Partial<LimitOrder>;
  if (typeof nextPatch.triggerPriceUsd === 'number') nextPatch.triggerPriceUsd = normalizePriceUsd(nextPatch.triggerPriceUsd);
  if (typeof nextPatch.trailingPeakPriceUsd === 'number') nextPatch.trailingPeakPriceUsd = normalizePriceUsd(nextPatch.trailingPeakPriceUsd);
  const next = all.map((o) => (o.id === id ? { ...o, ...nextPatch } : o));
  await setLimitOrders(next);
  return next;
};

export const applyTrailingStopUpdate = async (order: LimitOrder, priceUsd: number) => {
  if (order.orderType !== 'trailing_stop_sell') return order;
  const bps = order.trailingStopBps ?? 0;
  if (!Number.isFinite(bps) || bps <= 0 || bps >= 10000) return order;
  const prevPeak = Number(order.trailingPeakPriceUsd);
  const peak = Number.isFinite(prevPeak) && prevPeak > 0 ? prevPeak : priceUsd;
  const nextPeak = priceUsd > peak ? priceUsd : peak;
  const nextTrigger = normalizePriceUsd(nextPeak * (1 - bps / 10000));
  if (!Number.isFinite(nextTrigger) || nextTrigger <= 0) return order;

  const nextPeakN = normalizePriceUsd(nextPeak);
  const needPatch = nextPeakN !== peak || Math.abs(nextTrigger - order.triggerPriceUsd) / nextTrigger > 0.000001;
  if (!needPatch) return { ...order, trailingPeakPriceUsd: nextPeakN, triggerPriceUsd: nextTrigger };
  await patchLimitOrder(order.id, { trailingPeakPriceUsd: nextPeakN, triggerPriceUsd: nextTrigger });
  return { ...order, trailingPeakPriceUsd: nextPeakN, triggerPriceUsd: nextTrigger };
};

export const listLimitOrders = async (chainId: number, tokenAddress?: `0x${string}`) => {
  const all = await getLimitOrders();
  const filtered = all.filter((o) => {
    if (o.chainId !== chainId) return false;
    if (tokenAddress && o.tokenAddress.toLowerCase() !== tokenAddress.toLowerCase()) return false;
    return true;
  });
  filtered.sort((a, b) => b.createdAtMs - a.createdAtMs);
  return filtered;
};

export const createLimitOrder = async (input: LimitOrderCreateInput) => {
  const triggerPriceUsd = normalizePriceUsd(Number(input.triggerPriceUsd));
  if (!Number.isFinite(triggerPriceUsd) || triggerPriceUsd <= 0) throw new Error('Invalid trigger price');
  if (!input.tokenInfo) throw new Error('Token info required');
  const orderType = normalizeLimitOrderType(input.orderType, input.side);
  const side = sideFromLimitOrderType(orderType);
  if (input.orderType && side !== input.side) throw new Error('Order type mismatches side');

  const trailingStopBps = input.trailingStopBps != null ? Number(input.trailingStopBps) : null;
  const trailingPeakPriceUsd = input.trailingPeakPriceUsd != null ? normalizePriceUsd(Number(input.trailingPeakPriceUsd)) : null;
  if (orderType === 'trailing_stop_sell') {
    if (!(side === 'sell')) throw new Error('Trailing stop must be sell');
    if (trailingStopBps == null || !Number.isFinite(trailingStopBps) || !(trailingStopBps > 0 && trailingStopBps < 10000)) {
      throw new Error('Invalid trailing bps');
    }
    if (trailingPeakPriceUsd != null && (!Number.isFinite(trailingPeakPriceUsd) || trailingPeakPriceUsd <= 0)) {
      throw new Error('Invalid trailing peak');
    }
  }

  if (side === 'buy') {
    if (!input.buyBnbAmountWei) throw new Error('Buy amount required');
    const v = BigInt(input.buyBnbAmountWei);
    if (v <= 0n) throw new Error('Invalid buy amount');
  } else {
    const tokenAmountWei = (() => {
      try {
        return input.sellTokenAmountWei ? BigInt(input.sellTokenAmountWei) : 0n;
      } catch {
        return 0n;
      }
    })();
    const bps = input.sellPercentBps ?? 0;
    const hasTokenAmount = tokenAmountWei > 0n;
    const hasPercent = Number.isFinite(bps) && bps > 0 && bps <= 10000;
    if (!hasTokenAmount && !hasPercent) throw new Error('Invalid sell amount');
  }

  const order: LimitOrder = {
    id: makeLimitOrderId(),
    chainId: input.chainId,
    tokenAddress: input.tokenAddress,
    tokenSymbol: input.tokenSymbol ?? null,
    side,
    orderType,
    triggerPriceUsd,
    trailingStopBps: orderType === 'trailing_stop_sell' ? (trailingStopBps as number) : undefined,
    trailingPeakPriceUsd:
      orderType === 'trailing_stop_sell'
        ? trailingPeakPriceUsd != null && Number.isFinite(trailingPeakPriceUsd) && trailingPeakPriceUsd > 0
          ? trailingPeakPriceUsd
          : triggerPriceUsd
        : undefined,
    buyBnbAmountWei: input.buyBnbAmountWei,
    sellPercentBps: input.sellPercentBps,
    sellTokenAmountWei: input.sellTokenAmountWei,
    createdAtMs: Date.now(),
    status: 'open',
    tokenInfo: input.tokenInfo,
  };

  const all = await getLimitOrders();
  await setLimitOrders([order, ...all]);
  return order;
};

export const cancelLimitOrder = async (id: string) => {
  const all = await getLimitOrders();
  const next = all.filter((o) => !(o.id === id));
  await setLimitOrders(next);
  return next;
};

export const cancelAllLimitOrders = async (chainId: number, tokenAddress?: `0x${string}`) => {
  const all = await getLimitOrders();
  const next = all.filter((o) => {
    if (o.chainId !== chainId) return true;
    if (tokenAddress && o.tokenAddress.toLowerCase() !== tokenAddress.toLowerCase()) return true;
    if (o.status === 'executed') return true;
    return false;
  });
  await setLimitOrders(next);
  return next;
};

export const cancelAllSellLimitOrdersForToken = async (chainId: number, tokenAddress: `0x${string}` | null | undefined) => {
  if (!tokenAddress) return getLimitOrders();
  const keyAddr = tokenAddress.toLowerCase();
  const all = await getLimitOrders();
  const next = all.filter((o) => {
    if (o.chainId !== chainId) return true;
    if (o.tokenAddress.toLowerCase() !== keyAddr) return true;
    if (o.side !== 'sell') return true;
    if (o.status === 'executed') return true;
    return false;
  });
  await setLimitOrders(next);
  return next;
};
