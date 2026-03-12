import type { Settings, AutoTradeConfig, AdvancedAutoSellConfig } from '../types/extention';
import { TRADE_SUCCESS_SOUND_PRESETS } from '../types/extention';
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

function clampFloat(value: any, min: number, max: number, fallback: number) {
  const v = Number(value);
  if (!Number.isFinite(v)) return fallback;
  const clamped = Math.max(min, Math.min(max, v));
  return Math.round(clamped * 100) / 100;
}

function parseListInput(value: any, fallback: string[]) {
  if (Array.isArray(value)) {
    return value.map((x) => String(x).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/[\n,]/)
      .flatMap((x) => x.split(/\s+/))
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return fallback;
}

function clampStringNumber(value: any, fallback: string) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed;
}

function isAllowedProtectedRpcUrl(raw: string): boolean {
  const url = (raw ?? '').trim();
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = (u.hostname ?? '').toLowerCase();
  if (!host) return false;
  if (host.endsWith('48.club')) return true;
  if (host.endsWith('getblock')) return true;
  if (host.includes('blockrazor')) return true;
  if (host.includes('pancakeswap.finance')) return true;
  if (host.includes('dagobang.site')) return true;
  if (host.includes('blxrbdn.com')) return true;
  return false;
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

  const quickBuy1Bnb = typeof (input as any).quickBuy1Bnb === 'string'
    ? (input as any).quickBuy1Bnb.trim() || defaults.quickBuy1Bnb || '0.02'
    : defaults.quickBuy1Bnb || '0.02';
  const quickBuy2Bnb = typeof (input as any).quickBuy2Bnb === 'string'
    ? (input as any).quickBuy2Bnb.trim() || defaults.quickBuy2Bnb || '0.1'
    : defaults.quickBuy2Bnb || '0.1';
  const keyboardShortcutsEnabled = typeof (input as any).keyboardShortcutsEnabled === 'boolean'
    ? (input as any).keyboardShortcutsEnabled
    : ((defaults as any).keyboardShortcutsEnabled ?? false);
  const tradeSuccessSoundEnabled = typeof (input as any).tradeSuccessSoundEnabled === 'boolean'
    ? (input as any).tradeSuccessSoundEnabled
    : ((defaults as any).tradeSuccessSoundEnabled ?? false);
  const inputTradeSuccessSoundPresetBuy = (input as any).tradeSuccessSoundPresetBuy;
  const inputTradeSuccessSoundPresetSell = (input as any).tradeSuccessSoundPresetSell;
  const tradeSuccessSoundPresetBuy = TRADE_SUCCESS_SOUND_PRESETS.includes(inputTradeSuccessSoundPresetBuy)
    ? inputTradeSuccessSoundPresetBuy
    : ((defaults as any).tradeSuccessSoundPresetBuy ?? 'Bell');
  const tradeSuccessSoundPresetSell = TRADE_SUCCESS_SOUND_PRESETS.includes(inputTradeSuccessSoundPresetSell)
    ? inputTradeSuccessSoundPresetSell
    : ((defaults as any).tradeSuccessSoundPresetSell ?? 'Coins');
  const tradeSuccessSoundVolume = clampNumber(
    (input as any).tradeSuccessSoundVolume,
    0,
    100,
    typeof (defaults as any).tradeSuccessSoundVolume === 'number' ? (defaults as any).tradeSuccessSoundVolume : 60,
  );

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
        const protectedRpcUrls = (cInput.protectedRpcUrls || [])
          .map((x) => x.trim())
          .filter(Boolean)
          .filter(isAllowedProtectedRpcUrl);
        chains[cid] = {
          rpcUrls: (cInput.rpcUrls || []).map((x) => x.trim()).filter(Boolean),
          protectedRpcUrls,
          antiMev: !!cInput.antiMev && protectedRpcUrls.length > 0,
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
  const wsMonitorEnabled = typeof (inputAutoTrade as any)?.wsMonitorEnabled === 'boolean'
    ? !!(inputAutoTrade as any).wsMonitorEnabled
    : !!(defaultAutoTrade as any).wsMonitorEnabled;
  const inputTriggerSound = (inputAutoTrade as any)?.triggerSound as any;
  const defaultTriggerSound = (defaultAutoTrade as any).triggerSound as any;
  const triggerSoundPreset = TRADE_SUCCESS_SOUND_PRESETS.includes(inputTriggerSound?.preset)
    ? inputTriggerSound.preset
    : (defaultTriggerSound?.preset ?? 'Boom');
  const triggerSoundEnabled = typeof inputTriggerSound?.enabled === 'boolean'
    ? inputTriggerSound.enabled
    : !!defaultTriggerSound?.enabled;
  const inputTwitterSnipe = (inputAutoTrade as any)?.twitterSnipe ?? {};
  const defaultTwitterSnipe = (defaultAutoTrade as any).twitterSnipe;
  const allowedInteractionTypes = ['tweet', 'reply', 'quote', 'retweet', 'follow'] as const;
  const interactionTypesRaw = parseListInput(inputTwitterSnipe.interactionTypes, defaultTwitterSnipe.interactionTypes);
  const interactionTypes = interactionTypesRaw.filter((x) => allowedInteractionTypes.includes(x as any));
  const twitterSnipe = {
    enabled: typeof inputTwitterSnipe.enabled === 'boolean'
      ? inputTwitterSnipe.enabled
      : defaultTwitterSnipe.enabled ?? true,
    dryRun: typeof inputTwitterSnipe.dryRun === 'boolean'
      ? inputTwitterSnipe.dryRun
      : (defaultTwitterSnipe as any).dryRun ?? false,
    autoSellEnabled: typeof inputTwitterSnipe.autoSellEnabled === 'boolean'
      ? inputTwitterSnipe.autoSellEnabled
      : defaultTwitterSnipe.autoSellEnabled,
    buyAmountBnb: clampStringNumber(inputTwitterSnipe.buyAmountBnb, defaultTwitterSnipe.buyAmountBnb),
    buyNewCaCount: clampStringNumber(inputTwitterSnipe.buyNewCaCount, defaultTwitterSnipe.buyNewCaCount),
    buyOgCount: clampStringNumber(inputTwitterSnipe.buyOgCount, defaultTwitterSnipe.buyOgCount),
    minMarketCapUsd: clampStringNumber(inputTwitterSnipe.minMarketCapUsd, defaultTwitterSnipe.minMarketCapUsd),
    maxMarketCapUsd: clampStringNumber(inputTwitterSnipe.maxMarketCapUsd, defaultTwitterSnipe.maxMarketCapUsd),
    minHolders: clampStringNumber(inputTwitterSnipe.minHolders, defaultTwitterSnipe.minHolders),
    maxHolders: clampStringNumber(inputTwitterSnipe.maxHolders, defaultTwitterSnipe.maxHolders),
    minTickerLen: clampStringNumber(inputTwitterSnipe.minTickerLen, defaultTwitterSnipe.minTickerLen),
    maxTickerLen: clampStringNumber(inputTwitterSnipe.maxTickerLen, defaultTwitterSnipe.maxTickerLen),
    minTokenAgeSeconds: clampStringNumber(inputTwitterSnipe.minTokenAgeSeconds, defaultTwitterSnipe.minTokenAgeSeconds),
    maxTokenAgeSeconds: clampStringNumber(inputTwitterSnipe.maxTokenAgeSeconds, defaultTwitterSnipe.maxTokenAgeSeconds),
    minDevHoldPercent: clampStringNumber(inputTwitterSnipe.minDevHoldPercent, defaultTwitterSnipe.minDevHoldPercent),
    maxDevHoldPercent: clampStringNumber(inputTwitterSnipe.maxDevHoldPercent, defaultTwitterSnipe.maxDevHoldPercent),
    blockIfDevSell: typeof inputTwitterSnipe.blockIfDevSell === 'boolean'
      ? inputTwitterSnipe.blockIfDevSell
      : defaultTwitterSnipe.blockIfDevSell,
    deleteTweetSellPercent: clampStringNumber(inputTwitterSnipe.deleteTweetSellPercent, defaultTwitterSnipe.deleteTweetSellPercent),
    targetUsers: parseListInput(inputTwitterSnipe.targetUsers, defaultTwitterSnipe.targetUsers),
    interactionTypes: interactionTypes.length ? (interactionTypes as any) : defaultTwitterSnipe.interactionTypes,
  };

  const autoTrade: AutoTradeConfig = {
    takeProfitMultiple: typeof inputAutoTrade?.takeProfitMultiple === 'string'
      ? inputAutoTrade.takeProfitMultiple.trim()
      : defaultAutoTrade.takeProfitMultiple,
    stopLossMultiple: typeof inputAutoTrade?.stopLossMultiple === 'string'
      ? inputAutoTrade.stopLossMultiple.trim()
      : defaultAutoTrade.stopLossMultiple,
    maxHoldMinutes: typeof inputAutoTrade?.maxHoldMinutes === 'string'
      ? inputAutoTrade.maxHoldMinutes.trim()
      : defaultAutoTrade.maxHoldMinutes,
    wsMonitorEnabled,
    triggerSound: {
      enabled: triggerSoundEnabled,
      preset: triggerSoundPreset,
    },
    twitterSnipe,
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
  const inputTrailingStop = (inputAdvancedAutoSell as any)?.trailingStop as any;
  const defaultTrailingStop = (defaultAdvancedAutoSell as any)?.trailingStop as any;
  const trailingStopEnabled = typeof inputTrailingStop?.enabled === 'boolean'
    ? inputTrailingStop.enabled
    : !!defaultTrailingStop?.enabled;
  const trailingStopCallbackPercent = clampFloat(
    inputTrailingStop?.callbackPercent,
    0.1,
    99.9,
    typeof defaultTrailingStop?.callbackPercent === 'number' ? defaultTrailingStop.callbackPercent : 15
  );
  const activationMode = ((): 'immediate' | 'after_first_take_profit' | 'after_last_take_profit' => {
    const raw = inputTrailingStop?.activationMode;
    if (raw === 'immediate' || raw === 'after_first_take_profit' || raw === 'after_last_take_profit') return raw;
    const def = defaultTrailingStop?.activationMode;
    if (def === 'immediate' || def === 'after_first_take_profit' || def === 'after_last_take_profit') return def;
    return 'after_last_take_profit';
  })();
  const advancedAutoSell: AdvancedAutoSellConfig = {
    enabled: typeof inputAdvancedAutoSell?.enabled === 'boolean' ? inputAdvancedAutoSell.enabled : defaultAdvancedAutoSell.enabled,
    rules: rules as any,
    trailingStop: {
      enabled: trailingStopEnabled,
      callbackPercent: trailingStopCallbackPercent,
      activationMode,
    },
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
    quickBuy1Bnb,
    quickBuy2Bnb,
    keyboardShortcutsEnabled,
    tradeSuccessSoundEnabled,
    tradeSuccessSoundPresetBuy,
    tradeSuccessSoundPresetSell,
    tradeSuccessSoundVolume,
    limitOrderScanIntervalMs,
    autoTrade,
    advancedAutoSell,
  };
}
