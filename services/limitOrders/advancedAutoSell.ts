import type { AdvancedAutoSellConfig, LimitOrderCreateInput, LimitOrderType } from '@/types/extention';
import type { TokenInfo } from '@/types/token';

export function buildAdvancedAutoSellSellLimitOrderInputs(input: {
  config: AdvancedAutoSellConfig | null | undefined;
  chainId: number;
  tokenAddress: `0x${string}`;
  tokenSymbol?: string | null;
  tokenInfo: TokenInfo;
  basePriceUsd: number;
}): LimitOrderCreateInput[] {
  const { config, chainId, tokenAddress, tokenSymbol, tokenInfo } = input;
  const basePriceUsd = Number(input.basePriceUsd);
  if (!Number.isFinite(basePriceUsd) || basePriceUsd <= 0) return [];
  if (!config?.enabled) return [];
  const rules = Array.isArray(config.rules) ? config.rules : [];

  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

  const orders: LimitOrderCreateInput[] = [];
  for (const r of rules) {
    const rawTrigger = Number((r as any).triggerPercent);
    const rawSell = Number((r as any).sellPercent);
    if (!Number.isFinite(rawTrigger)) continue;
    if (!Number.isFinite(rawSell)) continue;

    const baseTrigger = clamp(rawTrigger, -99.9, 100000);
    const triggerPercent = r.type === 'stop_loss' ? -Math.abs(baseTrigger) : Math.abs(baseTrigger);
    const sellPercent = clamp(rawSell, 0, 100);
    const sellPercentBps = Math.round(sellPercent * 100);
    if (!(sellPercentBps > 0 && sellPercentBps <= 10000)) continue;

    const triggerPriceUsd = basePriceUsd * (1 + triggerPercent / 100);
    if (!Number.isFinite(triggerPriceUsd) || triggerPriceUsd <= 0) continue;

    const orderType: LimitOrderType = r.type === 'stop_loss' ? 'stop_loss_sell' : 'take_profit_sell';
    orders.push({
      chainId,
      tokenAddress,
      tokenSymbol: tokenSymbol ?? null,
      side: 'sell',
      orderType,
      triggerPriceUsd,
      sellPercentBps,
      tokenInfo,
    });
  }

  return orders;
}

export function buildAdvancedAutoSellTrailingStopSellLimitOrderInput(input: {
  config: AdvancedAutoSellConfig | null | undefined;
  chainId: number;
  tokenAddress: `0x${string}`;
  tokenSymbol?: string | null;
  tokenInfo: TokenInfo;
  basePriceUsd: number;
}): LimitOrderCreateInput | null {
  const { config, chainId, tokenAddress, tokenSymbol, tokenInfo } = input;
  const basePriceUsd = Number(input.basePriceUsd);
  if (!Number.isFinite(basePriceUsd) || basePriceUsd <= 0) return null;
  if (!config?.enabled) return null;

  const trailing = (config as any).trailingStop as any;
  if (!trailing?.enabled) return null;

  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
  const rawCallback = Number(trailing?.callbackPercent);
  const callbackPercent = Number.isFinite(rawCallback) ? clamp(rawCallback, 0.1, 99.9) : 15;
  const trailingStopBps = Math.round(callbackPercent * 100);
  const triggerPriceUsd = basePriceUsd * (1 - callbackPercent / 100);
  if (!(Number.isFinite(triggerPriceUsd) && triggerPriceUsd > 0 && trailingStopBps > 0 && trailingStopBps < 10000)) return null;

  const orderType: LimitOrderType = 'trailing_stop_sell';
  return {
    chainId,
    tokenAddress,
    tokenSymbol: tokenSymbol ?? null,
    side: 'sell',
    orderType,
    triggerPriceUsd,
    trailingStopBps,
    trailingPeakPriceUsd: basePriceUsd,
    sellPercentBps: 10000,
    tokenInfo,
  };
}

