import type { Settings, AutoTradeConfig, AdvancedAutoSellConfig } from '../types/extention';
import { defaultSettings } from './defaults';

// Simple normalization helper (could be moved to a formatter util if needed)
function normalizeAddress(addr: string | undefined): `0x${string}` | '' {
  if (!addr) return '';
  const trimmed = addr.trim();
  if (!trimmed) return '';
  // Basic check, could use viem's isAddress/getAddress
  return trimmed as `0x${string}`;
}

function clampNumber(value: any, min: number, max: number, fallback: number) {
  const v = Number(value);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(v)));
}

export function validateSettings(input: Settings): Settings | null {
  const defaults = defaultSettings();
  const chainId = 56;
  const autoLockSeconds = clampNumber(input.autoLockSeconds, 30, 3600, defaults.autoLockSeconds);
  const limitOrderScanIntervalOptionsMs = [1000, 3000, 5000, 10000, 30000, 60000, 120000] as const;
  const inputLimitOrderScanIntervalMs = Number((input as any).limitOrderScanIntervalMs);
  const limitOrderScanIntervalMs = Number.isFinite(inputLimitOrderScanIntervalMs) && limitOrderScanIntervalOptionsMs.includes(Math.floor(inputLimitOrderScanIntervalMs) as any)
    ? Math.floor(inputLimitOrderScanIntervalMs)
    : (defaults as any).limitOrderScanIntervalMs ?? 3000;
  const locale = (['zh_CN', 'zh_TW', 'en'] as const).includes(input.locale as any)
    ? (input.locale as 'zh_CN' | 'zh_TW' | 'en')
    : defaults.locale;
  const accountAliases: Record<string, string> = {};
  if (input.accountAliases && typeof input.accountAliases === 'object') {
    for (const [addr, alias] of Object.entries(input.accountAliases)) {
      if (typeof alias !== 'string') continue;
      const trimmed = alias.trim();
      if (!trimmed) continue;
      if (typeof addr !== 'string' || !addr.trim()) continue;
      accountAliases[addr.trim().toLowerCase()] = trimmed;
    }
  }

  const gmgnQuickBuy1Bnb = typeof (input as any).gmgnQuickBuy1Bnb === 'string'
    ? (input as any).gmgnQuickBuy1Bnb.trim() || defaults.gmgnQuickBuy1Bnb || '0.02'
    : defaults.gmgnQuickBuy1Bnb || '0.02';
  const gmgnQuickBuy2Bnb = typeof (input as any).gmgnQuickBuy2Bnb === 'string'
    ? (input as any).gmgnQuickBuy2Bnb.trim() || defaults.gmgnQuickBuy2Bnb || '0.1'
    : defaults.gmgnQuickBuy2Bnb || '0.1';

  const chains = { ...defaults.chains };
  
  if (input.chains) {
    ([56] as const).forEach((cid) => {
      const cInput = input.chains[cid];
      const cDef = defaults.chains[cid];
      if (cInput) {
        const inputBuyGas = (cInput as any).buyGasGwei as any;
        const inputSellGas = (cInput as any).sellGasGwei as any;
        const inputBuyGasPreset = (cInput as any).buyGasPreset as any;
        const inputSellGasPreset = (cInput as any).sellGasPreset as any;
        const allowedGasPresets = ['slow', 'standard', 'fast', 'turbo'] as const;
        const buyGasGwei = {
          slow: typeof inputBuyGas?.slow === 'string' && inputBuyGas.slow.trim() ? inputBuyGas.slow.trim() : cDef.buyGasGwei.slow,
          standard: typeof inputBuyGas?.standard === 'string' && inputBuyGas.standard.trim() ? inputBuyGas.standard.trim() : cDef.buyGasGwei.standard,
          fast: typeof inputBuyGas?.fast === 'string' && inputBuyGas.fast.trim() ? inputBuyGas.fast.trim() : cDef.buyGasGwei.fast,
          turbo: typeof inputBuyGas?.turbo === 'string' && inputBuyGas.turbo.trim() ? inputBuyGas.turbo.trim() : cDef.buyGasGwei.turbo,
        };
        const sellGasGwei = {
          slow: typeof inputSellGas?.slow === 'string' && inputSellGas.slow.trim() ? inputSellGas.slow.trim() : cDef.sellGasGwei.slow,
          standard: typeof inputSellGas?.standard === 'string' && inputSellGas.standard.trim() ? inputSellGas.standard.trim() : cDef.sellGasGwei.standard,
          fast: typeof inputSellGas?.fast === 'string' && inputSellGas.fast.trim() ? inputSellGas.fast.trim() : cDef.sellGasGwei.fast,
          turbo: typeof inputSellGas?.turbo === 'string' && inputSellGas.turbo.trim() ? inputSellGas.turbo.trim() : cDef.sellGasGwei.turbo,
        };
        const defaultBuyGasPreset = (cDef as any).buyGasPreset ?? cDef.gasPreset;
        const defaultSellGasPreset = (cDef as any).sellGasPreset ?? cDef.gasPreset;
        const buyGasPreset = allowedGasPresets.includes(inputBuyGasPreset) ? inputBuyGasPreset : defaultBuyGasPreset;
        const sellGasPreset = allowedGasPresets.includes(inputSellGasPreset) ? inputSellGasPreset : defaultSellGasPreset;
        chains[cid] = {
          rpcUrls: (cInput.rpcUrls || []).map((x) => x.trim()).filter(Boolean),
          protectedRpcUrls: (cInput.protectedRpcUrls || []).map((x) => x.trim()).filter(Boolean),
          antiMev: !!cInput.antiMev,
          gasPreset: ['slow', 'standard', 'fast', 'turbo'].includes(cInput.gasPreset) ? cInput.gasPreset : cDef.gasPreset,
          buyGasPreset,
          sellGasPreset,
          executionMode: cInput.executionMode === 'turbo' ? 'turbo' : cDef.executionMode,
          slippageBps: clampNumber(cInput.slippageBps, 0, 9000, cDef.slippageBps),
          deadlineSeconds: clampNumber(cInput.deadlineSeconds, 10, 3600, cDef.deadlineSeconds),
          buyPresets: Array.isArray(cInput.buyPresets) ? cInput.buyPresets.map(String) : cDef.buyPresets,
          sellPresets: Array.isArray(cInput.sellPresets) ? cInput.sellPresets.map(String) : cDef.sellPresets,
          buyGasGwei,
          sellGasGwei,
        };
        // Fallback for RPCs if empty
        if (chains[cid].rpcUrls.length === 0) {
          chains[cid].rpcUrls = cDef.rpcUrls;
        }
      }
    });
  }

  const toastPositionOptions = [
    'top-left',
    'top-center',
    'top-right',
    'bottom-left',
    'bottom-center',
    'bottom-right',
  ] as const;
  const inputToastPosition = (input as any).toastPosition;
  const toastPosition = toastPositionOptions.includes(inputToastPosition)
    ? inputToastPosition
    : defaults.toastPosition ?? 'top-center';

  const seedreamApiKey = typeof (input as any).seedreamApiKey === 'string'
    ? (input as any).seedreamApiKey.trim()
    : defaults.seedreamApiKey ?? '';

  const bloxrouteAuthHeader = typeof (input as any).bloxrouteAuthHeader === 'string'
    ? (input as any).bloxrouteAuthHeader.trim()
    : defaults.bloxrouteAuthHeader ?? '';

  const inputAutoTrade = (input as any).autoTrade as Partial<AutoTradeConfig> | undefined;
  const defaultAutoTrade = defaults.autoTrade;
  const autoTrade: AutoTradeConfig = {
    enabled: !!inputAutoTrade?.enabled,
    buyAmountBnb: typeof inputAutoTrade?.buyAmountBnb === 'string' && inputAutoTrade.buyAmountBnb.trim()
      ? inputAutoTrade.buyAmountBnb.trim()
      : defaultAutoTrade.buyAmountBnb,
    maxMarketCapUsd: typeof inputAutoTrade?.maxMarketCapUsd === 'string'
      ? inputAutoTrade.maxMarketCapUsd.trim()
      : defaultAutoTrade.maxMarketCapUsd,
    minLiquidityUsd: typeof inputAutoTrade?.minLiquidityUsd === 'string'
      ? inputAutoTrade.minLiquidityUsd.trim()
      : defaultAutoTrade.minLiquidityUsd,
    minHolders: typeof inputAutoTrade?.minHolders === 'string'
      ? inputAutoTrade.minHolders.trim()
      : defaultAutoTrade.minHolders,
    maxTokenAgeMinutes: typeof inputAutoTrade?.maxTokenAgeMinutes === 'string'
      ? inputAutoTrade.maxTokenAgeMinutes.trim()
      : defaultAutoTrade.maxTokenAgeMinutes,
    maxDevHoldPercent: typeof inputAutoTrade?.maxDevHoldPercent === 'string'
      ? inputAutoTrade.maxDevHoldPercent.trim()
      : defaultAutoTrade.maxDevHoldPercent,
    blockIfDevSell: typeof inputAutoTrade?.blockIfDevSell === 'boolean'
      ? inputAutoTrade.blockIfDevSell
      : defaultAutoTrade.blockIfDevSell,
    autoSellEnabled: typeof inputAutoTrade?.autoSellEnabled === 'boolean'
      ? inputAutoTrade.autoSellEnabled
      : defaultAutoTrade.autoSellEnabled,
    takeProfitMultiple: typeof inputAutoTrade?.takeProfitMultiple === 'string'
      ? inputAutoTrade.takeProfitMultiple.trim()
      : defaultAutoTrade.takeProfitMultiple,
    stopLossMultiple: typeof inputAutoTrade?.stopLossMultiple === 'string'
      ? inputAutoTrade.stopLossMultiple.trim()
      : defaultAutoTrade.stopLossMultiple,
    maxHoldMinutes: typeof inputAutoTrade?.maxHoldMinutes === 'string'
      ? inputAutoTrade.maxHoldMinutes.trim()
      : defaultAutoTrade.maxHoldMinutes,
  };

  const inputAdvancedAutoSell = (input as any).advancedAutoSell as Partial<AdvancedAutoSellConfig> | undefined;
  const defaultAdvancedAutoSell = (defaults as any).advancedAutoSell as AdvancedAutoSellConfig;
  const rules = Array.isArray(inputAdvancedAutoSell?.rules)
    ? inputAdvancedAutoSell!.rules
      .map((r: any) => {
        const id = typeof r?.id === 'string' && r.id.trim() ? r.id.trim() : '';
        const type = r?.type === 'take_profit' || r?.type === 'stop_loss' ? r.type : null;
        const triggerPercent = Number(r?.triggerPercent);
        const sellPercent = Number(r?.sellPercent);
        if (!id || !type) return null;
        if (!Number.isFinite(triggerPercent)) return null;
        if (!Number.isFinite(sellPercent)) return null;
        const safeSell = Math.max(0, Math.min(100, sellPercent));
        const safeTrigger = Math.max(-99.9, Math.min(100000, triggerPercent));
        return { id, type, triggerPercent: safeTrigger, sellPercent: safeSell };
      })
      .filter(Boolean)
    : defaultAdvancedAutoSell.rules;
  const advancedAutoSell: AdvancedAutoSellConfig = {
    enabled: typeof inputAdvancedAutoSell?.enabled === 'boolean' ? inputAdvancedAutoSell.enabled : defaultAdvancedAutoSell.enabled,
    rules: rules as any,
  };

  return {
    chainId,
    chains,
    autoLockSeconds,
    lastSelectedAddress: input.lastSelectedAddress,
    locale,
    accountAliases,
    toastPosition,
    seedreamApiKey,
    bloxrouteAuthHeader,
    gmgnQuickBuy1Bnb,
    gmgnQuickBuy2Bnb,
    limitOrderScanIntervalMs,
    autoTrade,
    advancedAutoSell,
  };
}
