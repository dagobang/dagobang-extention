import type { AdvancedAutoSellConfig, LimitOrderCreateInput, LimitOrderType } from '@/types/extention';
import type { TokenInfo } from '@/types/token';

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export const getAdvancedAutoSellMode = (config: AdvancedAutoSellConfig | null | undefined): 'trailing_stop' | 'rolling_take_profit' => {
  const mode = (config as any)?.trailingStop?.mode;
  return mode === 'rolling_take_profit' ? 'rolling_take_profit' : 'trailing_stop';
};

export function buildStrategySellOrderInputs(input: {
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
      targetChangePercent: triggerPercent,
      sellPercentBps,
      tokenInfo,
    });
  }

  return orders;
}

export function buildStrategyTrailingSellOrderInputs(input: {
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
  if (getAdvancedAutoSellMode(config) !== 'trailing_stop') return null;

  const trailing = (config as any).trailingStop as any;
  if (!trailing?.enabled) return null;

  const rawCallback = Number(trailing?.callbackPercent);
  const callbackPercent = Number.isFinite(rawCallback) ? clamp(rawCallback, 0.1, 99.9) : 15;
  const rawSellPercent = Number(trailing?.sellPercent);
  const sellPercent = Number.isFinite(rawSellPercent) ? clamp(rawSellPercent, 1, 100) : 100;
  const sellPercentBps = Math.round(sellPercent * 100);
  const trailingStopBps = Math.round(callbackPercent * 100);
  const triggerPriceUsd = basePriceUsd * (1 - callbackPercent / 100);
  if (!(Number.isFinite(triggerPriceUsd) && triggerPriceUsd > 0 && trailingStopBps > 0 && trailingStopBps < 10000 && sellPercentBps > 0 && sellPercentBps <= 10000)) return null;

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
    sellPercentBps,
    tokenInfo,
  };
}

export function buildStrategyRollingTakeProfitOrderInputs(input: {
  config: AdvancedAutoSellConfig | null | undefined;
  chainId: number;
  tokenAddress: `0x${string}`;
  tokenSymbol?: string | null;
  tokenInfo: TokenInfo;
  basePriceUsd: number;
  entryPriceUsd: number;
}): LimitOrderCreateInput | null {
  const { config, chainId, tokenAddress, tokenSymbol, tokenInfo } = input;
  const basePriceUsd = Number(input.basePriceUsd);
  const entryPriceUsd = Number(input.entryPriceUsd);
  if (!Number.isFinite(basePriceUsd) || basePriceUsd <= 0) return null;
  if (!Number.isFinite(entryPriceUsd) || entryPriceUsd <= 0) return null;
  if (!config?.enabled) return null;
  if (getAdvancedAutoSellMode(config) !== 'rolling_take_profit') return null;

  const trailing = (config as any).trailingStop as any;
  if (!trailing?.enabled) return null;

  const rawStep = Number(trailing?.rollingStepPercent);
  const stepPercent = Number.isFinite(rawStep) ? clamp(rawStep, 0.1, 100000) : 30;
  const rawSellPercent = Number(trailing?.rollingSellPercent);
  const fallbackSellPercent = Number(trailing?.sellPercent);
  const sellPercent = Number.isFinite(rawSellPercent)
    ? clamp(rawSellPercent, 1, 100)
    : (Number.isFinite(fallbackSellPercent) ? clamp(fallbackSellPercent, 1, 100) : 15);
  const sellPercentBps = Math.round(sellPercent * 100);
  const triggerPriceUsd = basePriceUsd * (1 + stepPercent / 100);
  if (!(Number.isFinite(triggerPriceUsd) && triggerPriceUsd > 0 && sellPercentBps > 0 && sellPercentBps <= 10000)) return null;

  return {
    chainId,
    tokenAddress,
    tokenSymbol: tokenSymbol ?? null,
    side: 'sell',
    orderType: 'take_profit_sell',
    triggerPriceUsd,
    targetChangePercent: stepPercent,
    sellPercentBps,
    rollingStepPercent: stepPercent,
    rollingEntryPriceUsd: entryPriceUsd,
    tokenInfo,
  };
}

export function buildStrategyRollingFloorOrderInputs(input: {
  config: AdvancedAutoSellConfig | null | undefined;
  chainId: number;
  tokenAddress: `0x${string}`;
  tokenSymbol?: string | null;
  tokenInfo: TokenInfo;
  entryPriceUsd: number;
}): LimitOrderCreateInput | null {
  const { config, chainId, tokenAddress, tokenSymbol, tokenInfo } = input;
  const entryPriceUsd = Number(input.entryPriceUsd);
  if (!Number.isFinite(entryPriceUsd) || entryPriceUsd <= 0) return null;
  if (!config?.enabled) return null;
  if (getAdvancedAutoSellMode(config) !== 'rolling_take_profit') return null;

  const trailing = (config as any).trailingStop as any;
  if (!trailing?.enabled) return null;

  const rawFloor = Number(trailing?.rollingFloorPercent);
  const floorPercent = Number.isFinite(rawFloor) ? clamp(rawFloor, 0, 100000) : 20;
  const triggerPriceUsd = entryPriceUsd * (1 + floorPercent / 100);
  if (!(Number.isFinite(triggerPriceUsd) && triggerPriceUsd > 0)) return null;

  return {
    chainId,
    tokenAddress,
    tokenSymbol: tokenSymbol ?? null,
    side: 'sell',
    orderType: 'stop_loss_sell',
    triggerPriceUsd,
    targetChangePercent: floorPercent,
    sellPercentBps: 10000,
    rollingFloorPercent: floorPercent,
    rollingEntryPriceUsd: entryPriceUsd,
    rollingIsFloor: true,
    tokenInfo,
  };
}
