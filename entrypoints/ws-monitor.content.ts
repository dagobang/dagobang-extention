import { call } from '@/utils/messaging';
import { initWsMonitorForSite } from './content/ws';

export default defineContentScript({
  matches: ['*://gmgn.ai/*', '*://*.gmgn.ai/*', '*://axiom.trade/*', '*://*.axiom.trade/*', '*://web3.binance.com/*',
    "*://web3.okx.com/*", "*://xxyy.io/*", "*://*.xxyy.io/*", "*://dexscreener.com/*", "*://*.dexscreener.com/*",
    "*://four.meme/*", "*://*.four.meme/*", "*://flap.sh/*", "*://*.flap.sh/*", "*://debot.ai/*", "*://*.debot.ai/*",
  ],
  allFrames: true,
  runAt: 'document_start',
  async main() {
    const hostname = window.location.hostname;
    const wsMonitor = initWsMonitorForSite({ hostname, call });
    try {
      const state = await call({ type: 'bg:getState' } as const);
      (window as any).__DAGOBANG_SETTINGS__ = state.settings;
      wsMonitor.setQuickBuySettings({
        quickBuy1Bnb: state.settings?.quickBuy1Bnb,
        quickBuy2Bnb: state.settings?.quickBuy2Bnb,
      });
      wsMonitor.emitStatus();
    } catch {
    }
  },
});
