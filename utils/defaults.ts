import type { Settings, ChainSettings } from '../types/extention';

const BSC_MAINNET: ChainSettings = {
  rpcUrls: ['https://bsc-dataseed.bnbchain.org'],
  protectedRpcUrls: [],
  antiMev: true,
  gasPreset: 'standard',
  executionMode: 'default',
  slippageBps: 4000,
  deadlineSeconds: 60,
  buyPresets: ['0.1', '0.5', '1.0', '2.0'],
  sellPresets: ['25', '50', '75', '100'],
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
  };
}
