import type { BgRequest, BgResponse } from '@/types/extention';
import { initGmgnWsMonitor } from './gmgn';
type QuickBuySettings = { quickBuy1Bnb?: string; quickBuy2Bnb?: string };

export type WsSiteMonitor = {
  setQuickBuySettings: (settings: QuickBuySettings) => void;
  emitStatus: () => void;
  dispose: () => void;
};

const createNoopMonitor = (): WsSiteMonitor => ({
  setQuickBuySettings: () => {
  },
  emitStatus: () => {
  },
  dispose: () => {
  },
});

export function initWsMonitorForSite(options: {
  hostname: string;
  call: <T extends BgRequest>(req: T) => Promise<BgResponse<T>>;
}): WsSiteMonitor {
  const host = options.hostname.toLowerCase();
  if (host.includes('gmgn.ai')) {
    return initGmgnWsMonitor({ call: options.call });
  }
  return createNoopMonitor();
}
