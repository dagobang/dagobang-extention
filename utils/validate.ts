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
  const tokenBalancePollIntervalOptionsMs = [500, 1000, 1500, 2000, 3000, 5000, 10000] as const;
  const inputTokenBalancePollIntervalMs = Number((input as any).tokenBalancePollIntervalMs);
  const tokenBalancePollIntervalMs =
    Number.isFinite(inputTokenBalancePollIntervalMs) && tokenBalancePollIntervalOptionsMs.includes(Math.floor(inputTokenBalancePollIntervalMs) as any)
      ? Math.floor(inputTokenBalancePollIntervalMs)
      : ((defaults as any).tokenBalancePollIntervalMs ?? 2000);
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
  const showToolbar = typeof (input as any)?.ui?.showToolbar === 'boolean'
    ? (input as any).ui.showToolbar
    : ((defaults as any)?.ui?.showToolbar ?? true);
  const limitTradePanelOnlyOnTokenPage = typeof (input as any)?.ui?.limitTradePanelOnlyOnTokenPage === 'boolean'
    ? (input as any).ui.limitTradePanelOnlyOnTokenPage
    : ((defaults as any)?.ui?.limitTradePanelOnlyOnTokenPage ?? false);
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
        const approveGasGwei =
          typeof (cInput as any).approveGasGwei === 'string' && (cInput as any).approveGasGwei.trim()
            ? (cInput as any).approveGasGwei.trim()
            : (cDef as any).approveGasGwei ?? '0.06';
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
          approveGasGwei,
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
  const normalizeInteractionTypes = (value: any, fallback: any) => {
    const raw = parseListInput(value, fallback);
    const list = raw.filter((x) => allowedInteractionTypes.includes(x as any));
    return list.length ? (list as any) : fallback;
  };
  const normalizeRapidByType = (value: any, fallback: any) => {
    const inputMap = value && typeof value === 'object' ? value : {};
    const fallbackMap = fallback && typeof fallback === 'object' ? fallback : {};
    const nextMap: Record<string, any> = {};
    for (const key of allowedInteractionTypes) {
      const rawNode = (inputMap as any)[key];
      const fallbackNode = (fallbackMap as any)[key];
      const source = rawNode && typeof rawNode === 'object' ? rawNode : {};
      const base = fallbackNode && typeof fallbackNode === 'object' ? fallbackNode : {};
      nextMap[key] = {
        enabled: typeof source.enabled === 'boolean'
          ? source.enabled
          : (typeof base.enabled === 'boolean' ? base.enabled : true),
        takeProfitPct: clampStringNumber(source.takeProfitPct, base.takeProfitPct ?? ''),
        stopLossPct: clampStringNumber(source.stopLossPct, base.stopLossPct ?? ''),
        maxHoldSeconds: clampStringNumber(source.maxHoldSeconds, base.maxHoldSeconds ?? ''),
        trailActivatePct: clampStringNumber(source.trailActivatePct, base.trailActivatePct ?? ''),
        trailDropPct: clampStringNumber(source.trailDropPct, base.trailDropPct ?? ''),
        minHoldMsForTakeProfit: clampStringNumber(source.minHoldMsForTakeProfit, base.minHoldMsForTakeProfit ?? ''),
        minHoldMsForStopLoss: clampStringNumber(source.minHoldMsForStopLoss, base.minHoldMsForStopLoss ?? ''),
        minHoldMsForTrail: clampStringNumber(source.minHoldMsForTrail, base.minHoldMsForTrail ?? ''),
        sellPercent: clampStringNumber(source.sellPercent, base.sellPercent ?? ''),
      };
    }
    return nextMap;
  };
  const normalizeTwitterSnipeCore = (rawInput: any, fallbackInput: any) => ({
    enabled: typeof rawInput?.enabled === 'boolean'
      ? rawInput.enabled
      : fallbackInput.enabled ?? true,
    dryRun: typeof rawInput?.dryRun === 'boolean'
      ? rawInput.dryRun
      : (fallbackInput as any).dryRun ?? false,
    autoSellEnabled: typeof rawInput?.autoSellEnabled === 'boolean'
      ? rawInput.autoSellEnabled
      : fallbackInput.autoSellEnabled,
    buyAmountBnb: clampStringNumber(rawInput?.buyAmountBnb, fallbackInput.buyAmountBnb),
    buyNewCaCount: clampStringNumber(rawInput?.buyNewCaCount, fallbackInput.buyNewCaCount),
    buyOgCount: clampStringNumber(rawInput?.buyOgCount, fallbackInput.buyOgCount),
    minMarketCapUsd: clampStringNumber(rawInput?.minMarketCapUsd, fallbackInput.minMarketCapUsd),
    maxMarketCapUsd: clampStringNumber(rawInput?.maxMarketCapUsd, fallbackInput.maxMarketCapUsd),
    minHolders: clampStringNumber(rawInput?.minHolders, fallbackInput.minHolders),
    maxHolders: clampStringNumber(rawInput?.maxHolders, fallbackInput.maxHolders),
    minKol: clampStringNumber((rawInput as any)?.minKol, (fallbackInput as any)?.minKol),
    maxKol: clampStringNumber((rawInput as any)?.maxKol, (fallbackInput as any)?.maxKol),
    minTickerLen: clampStringNumber(rawInput?.minTickerLen, fallbackInput.minTickerLen),
    maxTickerLen: clampStringNumber(rawInput?.maxTickerLen, fallbackInput.maxTickerLen),
    minTokenAgeSeconds: clampStringNumber(rawInput?.minTokenAgeSeconds, fallbackInput.minTokenAgeSeconds),
    maxTokenAgeSeconds: clampStringNumber(rawInput?.maxTokenAgeSeconds, fallbackInput.maxTokenAgeSeconds),
    minTweetAgeSeconds: clampStringNumber((rawInput as any)?.minTweetAgeSeconds, (fallbackInput as any)?.minTweetAgeSeconds),
    maxTweetAgeSeconds: clampStringNumber((rawInput as any)?.maxTweetAgeSeconds, (fallbackInput as any)?.maxTweetAgeSeconds),
    minDevHoldPercent: clampStringNumber(rawInput?.minDevHoldPercent, fallbackInput.minDevHoldPercent),
    maxDevHoldPercent: clampStringNumber(rawInput?.maxDevHoldPercent, fallbackInput.maxDevHoldPercent),
    blockIfDevSell: typeof rawInput?.blockIfDevSell === 'boolean'
      ? rawInput.blockIfDevSell
      : fallbackInput.blockIfDevSell,
    wsConfirmEnabled: typeof (rawInput as any)?.wsConfirmEnabled === 'boolean'
      ? (rawInput as any).wsConfirmEnabled
      : !!(fallbackInput as any).wsConfirmEnabled,
    wsConfirmWindowMs: clampStringNumber((rawInput as any)?.wsConfirmWindowMs, (fallbackInput as any)?.wsConfirmWindowMs),
    wsConfirmMinMcapChangePct: clampStringNumber((rawInput as any)?.wsConfirmMinMcapChangePct, (fallbackInput as any)?.wsConfirmMinMcapChangePct),
    wsConfirmMinHoldersDelta: clampStringNumber((rawInput as any)?.wsConfirmMinHoldersDelta, (fallbackInput as any)?.wsConfirmMinHoldersDelta),
    wsConfirmMinBuySellRatio: clampStringNumber((rawInput as any)?.wsConfirmMinBuySellRatio, (fallbackInput as any)?.wsConfirmMinBuySellRatio),
    wsConfirmMinNetBuy24hUsd: clampStringNumber((rawInput as any)?.wsConfirmMinNetBuy24hUsd, (fallbackInput as any)?.wsConfirmMinNetBuy24hUsd),
    wsConfirmMinVol24hUsd: clampStringNumber((rawInput as any)?.wsConfirmMinVol24hUsd, (fallbackInput as any)?.wsConfirmMinVol24hUsd),
    wsConfirmMinSmartMoney: clampStringNumber((rawInput as any)?.wsConfirmMinSmartMoney, (fallbackInput as any)?.wsConfirmMinSmartMoney),
    rapidExitEnabled: typeof (rawInput as any)?.rapidExitEnabled === 'boolean'
      ? (rawInput as any).rapidExitEnabled
      : !!(fallbackInput as any)?.rapidExitEnabled,
    rapidTakeProfitPct: clampStringNumber((rawInput as any)?.rapidTakeProfitPct, (fallbackInput as any)?.rapidTakeProfitPct),
    rapidStopLossPct: clampStringNumber((rawInput as any)?.rapidStopLossPct, (fallbackInput as any)?.rapidStopLossPct),
    rapidMaxHoldSeconds: clampStringNumber((rawInput as any)?.rapidMaxHoldSeconds, (fallbackInput as any)?.rapidMaxHoldSeconds),
    rapidTrailActivatePct: clampStringNumber((rawInput as any)?.rapidTrailActivatePct, (fallbackInput as any)?.rapidTrailActivatePct),
    rapidTrailDropPct: clampStringNumber((rawInput as any)?.rapidTrailDropPct, (fallbackInput as any)?.rapidTrailDropPct),
    rapidMinHoldMsForTakeProfit: clampStringNumber((rawInput as any)?.rapidMinHoldMsForTakeProfit, (fallbackInput as any)?.rapidMinHoldMsForTakeProfit),
    rapidMinHoldMsForStopLoss: clampStringNumber((rawInput as any)?.rapidMinHoldMsForStopLoss, (fallbackInput as any)?.rapidMinHoldMsForStopLoss),
    rapidMinHoldMsForTrail: clampStringNumber((rawInput as any)?.rapidMinHoldMsForTrail, (fallbackInput as any)?.rapidMinHoldMsForTrail),
    rapidAuxWindow10sMs: clampStringNumber((rawInput as any)?.rapidAuxWindow10sMs, (fallbackInput as any)?.rapidAuxWindow10sMs),
    rapidAuxWindow30sMs: clampStringNumber((rawInput as any)?.rapidAuxWindow30sMs, (fallbackInput as any)?.rapidAuxWindow30sMs),
    rapidSellPercent: clampStringNumber((rawInput as any)?.rapidSellPercent, (fallbackInput as any)?.rapidSellPercent),
    rapidByTweetTypeEnabled: typeof (rawInput as any)?.rapidByTweetTypeEnabled === 'boolean'
      ? (rawInput as any).rapidByTweetTypeEnabled
      : ((fallbackInput as any)?.rapidByTweetTypeEnabled !== false),
    rapidByType: normalizeRapidByType((rawInput as any)?.rapidByType, (fallbackInput as any)?.rapidByType),
    deleteTweetSellPercent: clampStringNumber(rawInput?.deleteTweetSellPercent, fallbackInput.deleteTweetSellPercent),
    deleteTweetPlaySound: typeof rawInput?.deleteTweetPlaySound === 'boolean'
      ? rawInput.deleteTweetPlaySound
      : ((fallbackInput as any)?.deleteTweetPlaySound ?? true),
    deleteTweetSoundPreset: TRADE_SUCCESS_SOUND_PRESETS.includes((rawInput as any)?.deleteTweetSoundPreset)
      ? (rawInput as any).deleteTweetSoundPreset
      : (((fallbackInput as any)?.deleteTweetSoundPreset ?? 'Handgun') as any),
    targetUsers: parseListInput(rawInput?.targetUsers, fallbackInput.targetUsers),
    interactionTypes: normalizeInteractionTypes(rawInput?.interactionTypes, fallbackInput.interactionTypes),
  });
  const twitterSnipeBase = normalizeTwitterSnipeCore(inputTwitterSnipe, defaultTwitterSnipe);
  const rawPresets = Array.isArray((inputTwitterSnipe as any)?.presets) ? (inputTwitterSnipe as any).presets : [];
  const defaultPresets = Array.isArray((defaultTwitterSnipe as any)?.presets) ? (defaultTwitterSnipe as any).presets : [];
  const normalizedPresets = rawPresets
    .map((item: any, idx: number) => {
      const idRaw = typeof item?.id === 'string' ? item.id.trim() : '';
      const id = idRaw || `preset-${idx + 1}`;
      const nameRaw = typeof item?.name === 'string' ? item.name.trim() : '';
      const name = nameRaw || `方案 ${idx + 1}`;
      const strategy = normalizeTwitterSnipeCore(item?.strategy ?? {}, twitterSnipeBase);
      return { id, name, strategy };
    })
    .filter((x: any, idx: number, arr: any[]) => arr.findIndex((v) => v.id === x.id) === idx);
  const presets = normalizedPresets.length
    ? normalizedPresets
    : defaultPresets.map((item: any, idx: number) => {
      const idRaw = typeof item?.id === 'string' ? item.id.trim() : '';
      const id = idRaw || `preset-default-${idx + 1}`;
      const nameRaw = typeof item?.name === 'string' ? item.name.trim() : '';
      const name = nameRaw || `默认方案 ${idx + 1}`;
      const strategy = normalizeTwitterSnipeCore(item?.strategy ?? {}, twitterSnipeBase);
      return { id, name, strategy };
    });
  const activePresetIdRaw = typeof (inputTwitterSnipe as any)?.activePresetId === 'string'
    ? (inputTwitterSnipe as any).activePresetId.trim()
    : '';
  const activePresetId = presets.some((p: any) => p.id === activePresetIdRaw)
    ? activePresetIdRaw
    : (presets[0]?.id ?? '');
  const activePreset = presets.find((p: any) => p.id === activePresetId);
  const twitterSnipe = {
    ...twitterSnipeBase,
    ...(activePreset?.strategy ?? {}),
    presets,
    activePresetId,
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
  const trailingStopSellPercent = clampFloat(
    inputTrailingStop?.sellPercent,
    1,
    100,
    typeof defaultTrailingStop?.sellPercent === 'number' ? defaultTrailingStop.sellPercent : 100
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
      sellPercent: trailingStopSellPercent,
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
    ui: {
      showToolbar,
      limitTradePanelOnlyOnTokenPage,
    },
    tradeSuccessSoundEnabled,
    tradeSuccessSoundPresetBuy,
    tradeSuccessSoundPresetSell,
    tradeSuccessSoundVolume,
    limitOrderScanIntervalMs,
    tokenBalancePollIntervalMs,
    autoTrade,
    advancedAutoSell,
  };
}
