import type { BgRequest, BgResponse } from '@/types/extention';
import { initGmgnWsMonitor, type WsSiteMonitor } from './gmgn';

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
  if (options.hostname.includes('gmgn.ai')) {
    return initGmgnWsMonitor({ call: options.call });
  }
  return createNoopMonitor();
}
