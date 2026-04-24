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

function parseCommaOrLineListInput(value: any, fallback: string[]) {
  if (Array.isArray(value)) {
    return value.map((x) => String(x).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/[\n,，]/)
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
        const allowedPriorityFeePresets = ['none', 'slow', 'standard', 'fast'] as const;
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
        const defaultPriorityFeePresets = {
          none: '0',
          slow: '0.000025',
          standard: '0.00004',
          fast: '0.0001',
        };
        const normalizePriorityFeePresetConfig = (
          raw: any,
          fallback: typeof defaultPriorityFeePresets,
          legacyValue?: string,
        ) => ({
          none: typeof raw?.none === 'string' ? raw.none.trim() : fallback.none,
          slow: typeof raw?.slow === 'string' ? raw.slow.trim() : fallback.slow,
          standard: typeof raw?.standard === 'string'
            ? raw.standard.trim()
            : (legacyValue && legacyValue.trim() ? legacyValue.trim() : fallback.standard),
          fast: typeof raw?.fast === 'string' ? raw.fast.trim() : fallback.fast,
        });
        const inputBuyPriorityFeeBnb = typeof (cInput as any).buyPriorityFeeBnb === 'string'
          ? (cInput as any).buyPriorityFeeBnb.trim()
          : '';
        const inputSellPriorityFeeBnb = typeof (cInput as any).sellPriorityFeeBnb === 'string'
          ? (cInput as any).sellPriorityFeeBnb.trim()
          : '';
        const defaultBuyPriorityFeePreset = allowedPriorityFeePresets.includes((cDef as any).buyPriorityFeePreset)
          ? (cDef as any).buyPriorityFeePreset
          : 'standard';
        const defaultSellPriorityFeePreset = allowedPriorityFeePresets.includes((cDef as any).sellPriorityFeePreset)
          ? (cDef as any).sellPriorityFeePreset
          : 'standard';
        const buyPriorityFeePreset = (allowedPriorityFeePresets.includes((cInput as any).buyPriorityFeePreset)
          ? (cInput as any).buyPriorityFeePreset
          : defaultBuyPriorityFeePreset) as (typeof allowedPriorityFeePresets)[number];
        const sellPriorityFeePreset = (allowedPriorityFeePresets.includes((cInput as any).sellPriorityFeePreset)
          ? (cInput as any).sellPriorityFeePreset
          : defaultSellPriorityFeePreset) as (typeof allowedPriorityFeePresets)[number];
        const defaultBuyPriorityFeePresets = normalizePriorityFeePresetConfig(
          (cDef as any).buyPriorityFeePresets,
          defaultPriorityFeePresets,
        );
        const defaultSellPriorityFeePresets = normalizePriorityFeePresetConfig(
          (cDef as any).sellPriorityFeePresets,
          defaultPriorityFeePresets,
        );
        const buyPriorityFeePresets = normalizePriorityFeePresetConfig(
          (cInput as any).buyPriorityFeePresets,
          defaultBuyPriorityFeePresets,
          inputBuyPriorityFeeBnb,
        );
        const sellPriorityFeePresets = normalizePriorityFeePresetConfig(
          (cInput as any).sellPriorityFeePresets,
          defaultSellPriorityFeePresets,
          inputSellPriorityFeeBnb,
        );
        const defaultBuyGasPreset = (cDef as any).buyGasPreset ?? cDef.gasPreset;
        const defaultSellGasPreset = (cDef as any).sellGasPreset ?? cDef.gasPreset;
        const buyGasPreset = allowedGasPresets.includes(inputBuyGasPreset) ? inputBuyGasPreset : defaultBuyGasPreset;
        const sellGasPreset = allowedGasPresets.includes(inputSellGasPreset) ? inputSellGasPreset : defaultSellGasPreset;
        const protectedRpcUrls = (cInput.protectedRpcUrls || [])
          .map((x) => x.trim())
          .filter(Boolean)
          .filter(isAllowedProtectedRpcUrl);
        const protectedRpcUrlsBuyRaw = ((cInput as any).protectedRpcUrlsBuy || [])
          .map((x: string) => x.trim())
          .filter(Boolean)
          .filter(isAllowedProtectedRpcUrl);
        const protectedRpcUrlsSellRaw = ((cInput as any).protectedRpcUrlsSell || [])
          .map((x: string) => x.trim())
          .filter(Boolean)
          .filter(isAllowedProtectedRpcUrl);
        const protectedRpcUrlsBuy = protectedRpcUrlsBuyRaw.length > 0 ? protectedRpcUrlsBuyRaw : undefined;
        const protectedRpcUrlsSell = protectedRpcUrlsSellRaw.length > 0 ? protectedRpcUrlsSellRaw : undefined;
        const bloxrouteBuyEnabled = typeof (cInput as any).bloxrouteBuyEnabled === 'boolean'
          ? (cInput as any).bloxrouteBuyEnabled
          : ((cDef as any).bloxrouteBuyEnabled ?? true);
        const bloxrouteSellEnabled = typeof (cInput as any).bloxrouteSellEnabled === 'boolean'
          ? (cInput as any).bloxrouteSellEnabled
          : ((cDef as any).bloxrouteSellEnabled ?? true);
        chains[cid] = {
          rpcUrls: (cInput.rpcUrls || []).map((x) => x.trim()).filter(Boolean),
          protectedRpcUrls,
          protectedRpcUrlsBuy,
          protectedRpcUrlsSell,
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
          buyPriorityFeePreset,
          sellPriorityFeePreset,
          buyPriorityFeePresets,
          sellPriorityFeePresets,
          bloxrouteBuyEnabled,
          bloxrouteSellEnabled,
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

  const inputTelegram = (input as any).telegram as any;
  const defaultTelegram = (defaults as any).telegram as any;
  const telegramEnabled = typeof inputTelegram?.enabled === 'boolean'
    ? inputTelegram.enabled
    : !!defaultTelegram?.enabled;
  const telegramBotToken = typeof inputTelegram?.botToken === 'string'
    ? inputTelegram.botToken.trim()
    : (defaultTelegram?.botToken ?? '');
  const telegramChatId = typeof inputTelegram?.chatId === 'string'
    ? inputTelegram.chatId.trim()
    : (defaultTelegram?.chatId ?? '');
  const telegramUserId = typeof inputTelegram?.userId === 'string'
    ? inputTelegram.userId.trim()
    : (defaultTelegram?.userId ?? '');
  const telegramEnforceUserId = typeof inputTelegram?.enforceUserId === 'boolean'
    ? inputTelegram.enforceUserId
    : (defaultTelegram?.enforceUserId ?? false);
  const inputTelegramPollIntervalMs = Number(inputTelegram?.pollIntervalMs);
  const defaultTelegramPollIntervalMs = Number(defaultTelegram?.pollIntervalMs);
  const telegramPollIntervalMs = Number.isFinite(inputTelegramPollIntervalMs) && inputTelegramPollIntervalMs >= 1000 && inputTelegramPollIntervalMs <= 10000
    ? Math.floor(inputTelegramPollIntervalMs)
    : (Number.isFinite(defaultTelegramPollIntervalMs) && defaultTelegramPollIntervalMs >= 1000
      ? Math.floor(defaultTelegramPollIntervalMs)
      : 2000);
  const telegramNotifyTradeSubmitted = typeof inputTelegram?.notifyTradeSubmitted === 'boolean'
    ? inputTelegram.notifyTradeSubmitted
    : (defaultTelegram?.notifyTradeSubmitted ?? true);
  const telegramNotifyTradeSuccess = typeof inputTelegram?.notifyTradeSuccess === 'boolean'
    ? inputTelegram.notifyTradeSuccess
    : (defaultTelegram?.notifyTradeSuccess ?? true);
  const telegramNotifyTradeRetrying = typeof inputTelegram?.notifyTradeRetrying === 'boolean'
    ? inputTelegram.notifyTradeRetrying
    : (defaultTelegram?.notifyTradeRetrying ?? true);
  const telegramNotifyLimitOrder = typeof inputTelegram?.notifyLimitOrder === 'boolean'
    ? inputTelegram.notifyLimitOrder
    : (defaultTelegram?.notifyLimitOrder ?? true);
  const telegramNotifyQuickTrade = typeof inputTelegram?.notifyQuickTrade === 'boolean'
    ? inputTelegram.notifyQuickTrade
    : (defaultTelegram?.notifyQuickTrade ?? true);

  const inputAutoTrade = (input as any).autoTrade as Partial<AutoTradeConfig> | undefined;
  const defaultAutoTrade = defaults.autoTrade;
  const wsMonitorEnabled = typeof (inputAutoTrade as any)?.wsMonitorEnabled === 'boolean'
    ? !!(inputAutoTrade as any).wsMonitorEnabled
    : !!(defaultAutoTrade as any).wsMonitorEnabled;
  const inputSignalForwardWindowMs = Number((inputAutoTrade as any)?.signalForwardWindowMs);
  const defaultSignalForwardWindowMs = Number((defaultAutoTrade as any)?.signalForwardWindowMs);
  const signalForwardWindowMs = Number.isFinite(inputSignalForwardWindowMs) && inputSignalForwardWindowMs >= 0
    ? Math.floor(inputSignalForwardWindowMs)
    : (Number.isFinite(defaultSignalForwardWindowMs) && defaultSignalForwardWindowMs >= 0
      ? Math.floor(defaultSignalForwardWindowMs)
      : undefined);
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
  const normalizeTwitterSnipeCore = (rawInput: any, fallbackInput: any) => ({
    enabled: typeof rawInput?.enabled === 'boolean'
      ? rawInput.enabled
      : fallbackInput.enabled ?? true,
    dryRun: typeof rawInput?.dryRun === 'boolean'
      ? rawInput.dryRun
      : (fallbackInput as any).dryRun ?? false,
    dryRunBuyDelayMs: clampStringNumber((rawInput as any)?.dryRunBuyDelayMs, (fallbackInput as any)?.dryRunBuyDelayMs),
    dryRunSellDelayMs: clampStringNumber((rawInput as any)?.dryRunSellDelayMs, (fallbackInput as any)?.dryRunSellDelayMs),
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
    wsConfirmMaxMcapChangePct: clampStringNumber((rawInput as any)?.wsConfirmMaxMcapChangePct, (fallbackInput as any)?.wsConfirmMaxMcapChangePct),
    wsConfirmMinHoldersDelta: clampStringNumber((rawInput as any)?.wsConfirmMinHoldersDelta, (fallbackInput as any)?.wsConfirmMinHoldersDelta),
    wsConfirmMinBuySellRatio: clampStringNumber((rawInput as any)?.wsConfirmMinBuySellRatio, (fallbackInput as any)?.wsConfirmMinBuySellRatio),
    wsConfirmMinNetBuy24hUsd: clampStringNumber((rawInput as any)?.wsConfirmMinNetBuy24hUsd, (fallbackInput as any)?.wsConfirmMinNetBuy24hUsd),
    wsConfirmMinVol24hUsd: clampStringNumber((rawInput as any)?.wsConfirmMinVol24hUsd, (fallbackInput as any)?.wsConfirmMinVol24hUsd),
    wsConfirmMinVolMcapRatio: clampStringNumber((rawInput as any)?.wsConfirmMinVolMcapRatio, (fallbackInput as any)?.wsConfirmMinVolMcapRatio),
    wsConfirmMinNetBuyMcapRatio: clampStringNumber((rawInput as any)?.wsConfirmMinNetBuyMcapRatio, (fallbackInput as any)?.wsConfirmMinNetBuyMcapRatio),
    wsConfirmMinSmartMoney: clampStringNumber((rawInput as any)?.wsConfirmMinSmartMoney, (fallbackInput as any)?.wsConfirmMinSmartMoney),
    rapidExitEnabled: typeof (rawInput as any)?.rapidExitEnabled === 'boolean'
      ? (rawInput as any).rapidExitEnabled
      : !!(fallbackInput as any)?.rapidExitEnabled,
    rapidEvalStepSec: clampStringNumber((rawInput as any)?.rapidEvalStepSec, (fallbackInput as any)?.rapidEvalStepSec),
    rapidStopLossPct: clampStringNumber((rawInput as any)?.rapidStopLossPct, (fallbackInput as any)?.rapidStopLossPct),
    rapidTakeProfitTriggerPct: clampStringNumber((rawInput as any)?.rapidTakeProfitTriggerPct, (fallbackInput as any)?.rapidTakeProfitTriggerPct),
    rapidTakeProfitStepUpPct: clampStringNumber((rawInput as any)?.rapidTakeProfitStepUpPct, (fallbackInput as any)?.rapidTakeProfitStepUpPct),
    rapidTakeProfitBatchPct: clampStringNumber((rawInput as any)?.rapidTakeProfitBatchPct, (fallbackInput as any)?.rapidTakeProfitBatchPct),
    rapidTakeProfitFloorPct: clampStringNumber((rawInput as any)?.rapidTakeProfitFloorPct, (fallbackInput as any)?.rapidTakeProfitFloorPct),
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
  const inputTokenSnipe = (inputAutoTrade as any)?.tokenSnipe ?? {};
  const defaultTokenSnipe = (defaultAutoTrade as any).tokenSnipe ?? {};
  const tokenSnipeEnabled = typeof inputTokenSnipe?.enabled === 'boolean'
    ? inputTokenSnipe.enabled
    : (defaultTokenSnipe.enabled !== false);
  const tokenSnipePlaySound = typeof inputTokenSnipe?.playSound === 'boolean'
    ? inputTokenSnipe.playSound
    : (defaultTokenSnipe.playSound !== false);
  const tokenSnipeSoundPreset = TRADE_SUCCESS_SOUND_PRESETS.includes((inputTokenSnipe as any)?.soundPreset)
    ? (inputTokenSnipe as any).soundPreset
    : (((defaultTokenSnipe as any)?.soundPreset ?? 'Boom') as any);
  const tokenSnipeTargetUsers = parseListInput(inputTokenSnipe?.targetUsers, defaultTokenSnipe.targetUsers ?? []);
  const tokenSnipeAllowedTweetTypes = ['all', 'tweet', 'reply', 'quote', 'retweet', 'follow'] as const;
  const tokenSnipeAllowedInteractionTypes = ['tweet', 'reply', 'quote', 'retweet', 'follow'] as const;
  const tokenSnipeAllowedBuyMethods = ['all', 'dagobang', 'gmgn'] as const;
  const tokenSnipeTasks = Array.isArray(inputTokenSnipe?.tasks)
    ? inputTokenSnipe.tasks
      .map((raw: any) => {
        const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
        const chain = Number(raw?.chain);
        const tokenAddress = normalizeAddress(typeof raw?.tokenAddress === 'string' ? raw.tokenAddress : '');
        if (!id || !tokenAddress || !Number.isFinite(chain) || chain <= 0) return null;
        const tokenSymbol = typeof raw?.tokenSymbol === 'string' ? raw.tokenSymbol.trim() : '';
        const tokenName = typeof raw?.tokenName === 'string' ? raw.tokenName.trim() : '';
        const tweetTypeRaw = typeof raw?.tweetType === 'string' ? raw.tweetType.trim().toLowerCase() : 'all';
        const tweetType = tokenSnipeAllowedTweetTypes.includes(tweetTypeRaw as any) ? tweetTypeRaw : 'all';
        const tweetTypesRaw = Array.isArray(raw?.tweetTypes)
          ? raw.tweetTypes
          : (tweetTypeRaw && tweetTypeRaw !== 'all' ? [tweetTypeRaw] : tokenSnipeAllowedInteractionTypes);
        const tweetTypes = tweetTypesRaw
          .map((x: any) => String(x).trim().toLowerCase())
          .filter((x: string) => tokenSnipeAllowedInteractionTypes.includes(x as any))
          .filter((x: string, idx: number, arr: string[]) => arr.indexOf(x) === idx);
        const normalizedTweetTypes = tweetTypes.length ? tweetTypes : [...tokenSnipeAllowedInteractionTypes];
        const legacyTweetType = normalizedTweetTypes.length === tokenSnipeAllowedInteractionTypes.length
          ? 'all'
          : normalizedTweetTypes[0];
        const targetUrls = parseListInput(raw?.targetUrls, [])
          .map((x) => x.trim())
          .filter(Boolean);
        const keywords = parseCommaOrLineListInput(raw?.keywords, [])
          .map((x) => x.trim())
          .filter(Boolean);
        const buyAmountBnbRaw = typeof raw?.buyAmountBnb === 'string' ? raw.buyAmountBnb.trim() : '';
        const buyAmountBnb = buyAmountBnbRaw || '0';
        const buyGasGwei = clampStringNumber(raw?.buyGasGwei, '');
        const buyBribeBnbRaw = clampStringNumber(raw?.buyBribeBnb, '');
        const buyBribeNum = Number(buyBribeBnbRaw);
        const buyBribeBnb =
          buyBribeBnbRaw && Number.isFinite(buyBribeNum) && buyBribeNum >= 0 && (buyBribeNum === 0 || buyBribeNum >= 0.000025)
            ? buyBribeBnbRaw
            : '';
        const buyMethodRaw = typeof raw?.buyMethod === 'string' ? raw.buyMethod.trim().toLowerCase() : '';
        const buyMethod = tokenSnipeAllowedBuyMethods.includes(buyMethodRaw as any) ? buyMethodRaw : 'dagobang';
        const createdAtNum = Number(raw?.createdAt);
        const createdAt = Number.isFinite(createdAtNum) && createdAtNum > 0 ? Math.floor(createdAtNum) : Date.now();
        return {
          id,
          chain: Math.floor(chain),
          tokenAddress,
          tokenSymbol: tokenSymbol || undefined,
          tokenName: tokenName || undefined,
          tweetType: legacyTweetType,
          tweetTypes: normalizedTweetTypes as any,
          targetUrls,
          keywords,
          autoBuy: typeof raw?.autoBuy === 'boolean' ? raw.autoBuy : true,
          buyAmountBnb,
          buyGasGwei: buyGasGwei || undefined,
          buyBribeBnb: buyBribeBnb || undefined,
          buyMethod: buyMethod as any,
          autoSell: typeof raw?.autoSell === 'boolean' ? raw.autoSell : true,
          createdAt,
        };
      })
      .filter(Boolean)
    : (Array.isArray(defaultTokenSnipe.tasks) ? defaultTokenSnipe.tasks : []);
  const tokenSnipe = {
    enabled: tokenSnipeEnabled,
    targetUsers: tokenSnipeTargetUsers,
    playSound: tokenSnipePlaySound,
    soundPreset: tokenSnipeSoundPreset,
    tasks: tokenSnipeTasks,
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
    signalForwardWindowMs,
    triggerSound: {
      enabled: triggerSoundEnabled,
      preset: triggerSoundPreset,
    },
    twitterSnipe,
    tokenSnipe,
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
    telegram: {
      enabled: telegramEnabled,
      botToken: telegramBotToken,
      chatId: telegramChatId,
      userId: telegramUserId,
      enforceUserId: telegramEnforceUserId,
      pollIntervalMs: telegramPollIntervalMs,
      notifyTradeSubmitted: telegramNotifyTradeSubmitted,
      notifyTradeSuccess: telegramNotifyTradeSuccess,
      notifyTradeRetrying: telegramNotifyTradeRetrying,
      notifyLimitOrder: telegramNotifyLimitOrder,
      notifyQuickTrade: telegramNotifyQuickTrade,
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
