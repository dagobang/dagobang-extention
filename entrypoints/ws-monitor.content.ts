import { call } from '@/utils/messaging';
import { initWsMonitorForSite } from './content/ws-processor';
import { browser } from 'wxt/browser';
import type { BgGetStateResponse } from '@/types/extention';

export default defineContentScript({
  matches: ['*://gmgn.ai/*', '*://*.gmgn.ai/*', '*://axiom.trade/*', '*://*.axiom.trade/*', '*://web3.binance.com/*',
    "*://web3.okx.com/*", "*://xxyy.io/*", "*://*.xxyy.io/*", "*://dexscreener.com/*", "*://*.dexscreener.com/*",
    "*://four.meme/*", "*://*.four.meme/*", "*://flap.sh/*", "*://*.flap.sh/*", "*://debot.ai/*", "*://*.debot.ai/*",
  ],
  allFrames: true,
  runAt: 'document_start',
  async main() {
    const hostname = window.location.hostname;
    let wsMonitor: ReturnType<typeof initWsMonitorForSite> | null = null;

    const setWsEnabledFlag = (enabled: boolean) => {
      try {
        window.localStorage.setItem('dagobang_ws_monitor_enabled_v1', enabled ? '1' : '0');
      } catch {
      }
    };

    const emitDisabledStatus = () => {
      const payload = {
        connected: false,
        lastPacketAt: 0,
        lastSignalAt: 0,
        latencyMs: null,
        packetCount: 0,
        signalCount: 0,
        logs: [],
      };
      (window as any).__DAGOBANG_WS_STATUS__ = payload;
      window.dispatchEvent(new CustomEvent('dagobang-ws-status', { detail: payload }));
    };

    const applyState = async (state: BgGetStateResponse) => {
      (window as any).__DAGOBANG_SETTINGS__ = state.settings;
      const wsEnabled = state.settings?.autoTrade?.wsMonitorEnabled !== false;
      setWsEnabledFlag(wsEnabled);
      if (!wsEnabled) {
        wsMonitor?.dispose();
        wsMonitor = null;
        emitDisabledStatus();
        return;
      }

      if (!wsMonitor) {
        wsMonitor = initWsMonitorForSite({ hostname, call });
      }
      wsMonitor.setQuickBuySettings({
        quickBuy1Bnb: state.settings.quickBuy1Bnb,
        quickBuy2Bnb: state.settings.quickBuy2Bnb,
      });
      wsMonitor.emitStatus();
    };

    try {
      const state = await call({ type: 'bg:getState' } as const);
      await applyState(state);
    } catch {
      setWsEnabledFlag(true);
      wsMonitor = initWsMonitorForSite({ hostname, call });
      wsMonitor.emitStatus();
    }

    const listener = (message: any) => {
      if (!message || message.type !== 'bg:stateChanged') return;
      void (async () => {
        try {
          const next = await call({ type: 'bg:getState' } as const);
          await applyState(next);
        } catch {
        }
      })();
    };
    browser.runtime.onMessage.addListener(listener);
    window.addEventListener('unload', () => browser.runtime.onMessage.removeListener(listener));
  },
});
