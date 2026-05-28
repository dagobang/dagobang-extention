import { call } from '@/utils/messaging';
import { initWsMonitorForSite } from './content/ws-processor';
import { browser } from 'wxt/browser';
import type { BgGetStateResponse } from '@/types/extention';

const STATE_CHANGE_REFRESH_DEBOUNCE_MS = 300;

export default defineContentScript({
  matches: ['*://gmgn.ai/*', '*://*.gmgn.ai/*', '*://axiom.trade/*', '*://*.axiom.trade/*', '*://web3.binance.com/*',
    "*://web3.okx.com/*", "*://xxyy.io/*", "*://*.xxyy.io/*", "*://dexscreener.com/*", "*://*.dexscreener.com/*",
    "*://four.meme/*", "*://*.four.meme/*", "*://alt.fun/*", "*://*.alt.fun/*", "*://flap.sh/*", "*://*.flap.sh/*", "*://debot.ai/*", "*://*.debot.ai/*",
  ],
  allFrames: true,
  runAt: 'document_start',
  async main() {
    const hostname = window.location.hostname;
    let wsMonitor: ReturnType<typeof initWsMonitorForSite> | null = null;
    let stateRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    let stateRefreshInFlight: Promise<void> | null = null;
    let stateRefreshQueued = false;

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

    const refreshStateFromBackground = async () => {
      if (stateRefreshInFlight) {
        stateRefreshQueued = true;
        return await stateRefreshInFlight;
      }
      stateRefreshInFlight = (async () => {
        const next = await call({ type: 'bg:getState' } as const);
        await applyState(next);
      })().finally(() => {
        stateRefreshInFlight = null;
        if (stateRefreshQueued) {
          stateRefreshQueued = false;
          if (stateRefreshTimer) clearTimeout(stateRefreshTimer);
          stateRefreshTimer = setTimeout(() => {
            stateRefreshTimer = null;
            void refreshStateFromBackground();
          }, 0);
        }
      });
      return await stateRefreshInFlight;
    };

    const scheduleStateRefresh = () => {
      if (stateRefreshTimer) clearTimeout(stateRefreshTimer);
      stateRefreshTimer = setTimeout(() => {
        stateRefreshTimer = null;
        void refreshStateFromBackground();
      }, STATE_CHANGE_REFRESH_DEBOUNCE_MS);
    };

    try {
      await refreshStateFromBackground();
    } catch {
      setWsEnabledFlag(true);
      wsMonitor = initWsMonitorForSite({ hostname, call });
      wsMonitor.emitStatus();
    }

    const listener = (message: any) => {
      if (!message || message.type !== 'bg:stateChanged') return;
      scheduleStateRefresh();
    };
    browser.runtime.onMessage.addListener(listener);
    window.addEventListener('unload', () => {
      if (stateRefreshTimer) {
        clearTimeout(stateRefreshTimer);
        stateRefreshTimer = null;
      }
      browser.runtime.onMessage.removeListener(listener);
    });
  },
});
