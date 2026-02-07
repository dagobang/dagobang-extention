import type { Settings, ChainSettings, AutoTradeConfig, GasGweiConfig } from '../types/extention';

const DEFAULT_GAS_GWEI: GasGweiConfig = {
  slow: '0.06',
  standard: '0.12',
  fast: '1',
  turbo: '5',
};

const BSC_MAINNET: ChainSettings = {
  rpcUrls: ['https://bsc-dataseed.bnbchain.org'],
  protectedRpcUrls: [],
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
    gmgnQuickBuy1Bnb: '0.02',
    gmgnQuickBuy2Bnb: '0.1',
    limitOrderScanIntervalMs: 3000,
    autoTrade: DEFAULT_AUTOTRADE,
  };
}
