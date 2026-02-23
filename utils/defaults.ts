import type { Settings, ChainSettings, AutoTradeConfig, GasGweiConfig, AdvancedAutoSellConfig } from '../types/extention';

const DEFAULT_GAS_GWEI: GasGweiConfig = {
  slow: '0.06',
  standard: '0.12',
  fast: '1',
  turbo: '5',
};

const BSC_MAINNET: ChainSettings = {
  rpcUrls: [
    'https://0.48.club',
    'https://1rpc.io/bnb',
    'https://bsc.rpc.blxrbdn.com',
    'https://bsc-dataseed.ninicoin.io',
    'https://bsc-dataseed.defibit.io',
    'https://bsc-dataseed-public.bnbchain.org',
    'https://bscrpc.pancakeswap.finance',
  ],
  protectedRpcUrls: [
    'https://bscrpc.pancakeswap.finance',
    'https://pancake.rpc.48.club',
    'https://four.rpc.48.club',
  ],
  antiMev: true,
  gasPreset: 'standard',
  buyGasPreset: 'standard',
  sellGasPreset: 'standard',
  executionMode: 'default',
  slippageBps: 4000,
  deadlineSeconds: 60,
  buyPresets: ['0.1', '0.5', '1.0', '2.0'],
  sellPresets: ['25', '50', '75', '100'],
  buyGasGwei: DEFAULT_GAS_GWEI,
  sellGasGwei: DEFAULT_GAS_GWEI,
};

const DEFAULT_AUTOTRADE: AutoTradeConfig = {
  enabled: false,
  buyAmountBnb: '0.05',
  maxMarketCapUsd: '',
  minLiquidityUsd: '',
  minHolders: '',
  maxTokenAgeMinutes: '',
  maxDevHoldPercent: '',
  blockIfDevSell: true,
  autoSellEnabled: false,
  takeProfitMultiple: '2',
  stopLossMultiple: '0.5',
  maxHoldMinutes: '',
};

const DEFAULT_ADVANCED_AUTO_SELL: AdvancedAutoSellConfig = {
  enabled: false,
  rules: [
    { id: 'tp_100', type: 'take_profit', triggerPercent: 100, sellPercent: 50 },
    { id: 'tp_300', type: 'take_profit', triggerPercent: 300, sellPercent: 50 },
    { id: 'sl_50', type: 'stop_loss', triggerPercent: -50, sellPercent: 100 },
  ],
  trailingStop: {
    enabled: false,
    callbackPercent: 15,
    activationMode: 'after_last_take_profit',
  },
};

export function defaultSettings(): Settings {
  return {
    chainId: 56,
    chains: {
      56: BSC_MAINNET,
    },
    autoLockSeconds: 30 * 60, // 30 minutes
    locale: 'zh_CN',
    accountAliases: {},
    toastPosition: 'top-center',
    seedreamApiKey: '',
    bloxrouteAuthHeader: '',
    quickBuy1Bnb: '0',
    quickBuy2Bnb: '0',
    keyboardShortcutsEnabled: false,
    tradeSuccessSoundEnabled: false,
    tradeSuccessSoundPresetBuy: 'Bell',
    tradeSuccessSoundPresetSell: 'Coins',
    tradeSuccessSoundVolume: 60,
    limitOrderScanIntervalMs: 3000,
    autoTrade: DEFAULT_AUTOTRADE,
    advancedAutoSell: DEFAULT_ADVANCED_AUTO_SELL,
  };
}
