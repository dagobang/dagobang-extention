import { call } from '@/utils/messaging';
import { initWsMonitorForSite } from './content/ws-processor';

export default defineContentScript({
  matches: ['*://gmgn.ai/*', '*://*.gmgn.ai/*', '*://axiom.trade/*', '*://*.axiom.trade/*', '*://web3.binance.com/*',
    "*://web3.okx.com/*", "*://xxyy.io/*", "*://*.xxyy.io/*", "*://dexscreener.com/*", "*://*.dexscreener.com/*",
    "*://four.meme/*", "*://*.four.meme/*", "*://flap.sh/*", "*://*.flap.sh/*", "*://debot.ai/*", "*://*.debot.ai/*",
  ],
  allFrames: true,
  runAt: 'document_start',
  async main() {
    const hostname = window.location.hostname;
    let state: Awaited<ReturnType<typeof call>> | null = null;
    try {
      state = await call({ type: 'bg:getState' } as const);
      (window as any).__DAGOBANG_SETTINGS__ = state.settings;
    } catch {
    }
    const wsMonitor = initWsMonitorForSite({ hostname, call });
    if (state?.settings) {
      wsMonitor.setQuickBuySettings({
        quickBuy1Bnb: state.settings?.quickBuy1Bnb,
        quickBuy2Bnb: state.settings?.quickBuy2Bnb,
      });
    }
    wsMonitor.emitStatus();
  },
});
