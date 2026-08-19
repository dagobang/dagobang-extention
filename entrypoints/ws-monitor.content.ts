import { call } from '@/utils/messaging';
import { initWsMonitorForSite } from './content/ws-processor';
import { browser } from 'wxt/browser';
import type { BgGetStateResponse } from '@/types/extention';
import GmgnAPI, { type GmgnPageFetchRequest } from '@/hooks/GmgnAPI';

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
    const isGmgnHost = hostname.includes('gmgn.ai');
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

    const requestGmgnPageFetch = async (request: GmgnPageFetchRequest) => {
      const requestId = `gmgn-ws-monitor-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      console.info('[gmgn.wsMonitor.pageFetch.request]', {
        requestId,
        url: request.url,
        method: request.init.method,
        body: request.init.body,
      });
      return await new Promise<any>((resolve, reject) => {
        let done = false;
        const timeout = window.setTimeout(() => {
          if (done) return;
          done = true;
          window.removeEventListener('message', onMessage);
          console.warn('[gmgn.wsMonitor.pageFetch.timeout]', { requestId, url: request.url });
          reject(new Error('gmgn_page_fetch_timeout'));
        }, 15000);
        const onMessage = (event: MessageEvent) => {
          if (event.source !== window) return;
          const data = (event as any).data;
          if (!data || data.type !== 'DAGOBANG_GMGN_FETCH_RESULT' || data.requestId !== requestId) return;
          if (done) return;
          done = true;
          clearTimeout(timeout);
          window.removeEventListener('message', onMessage);
          if (!data.ok) {
            console.warn('[gmgn.wsMonitor.pageFetch.failed]', {
              requestId,
              url: request.url,
              status: data.status,
              error: data.error,
              text: data.text,
            });
            reject(new Error(String(data.error || data.text || `GMGN request failed: ${data.status || 0}`)));
            return;
          }
          const payload = data.json;
          console.info('[gmgn.wsMonitor.pageFetch.success]', {
            requestId,
            url: request.url,
            status: data.status,
            payload,
          });
          resolve(payload);
        };
        window.addEventListener('message', onMessage);
        window.postMessage({
          type: 'DAGOBANG_GMGN_FETCH',
          requestId,
          url: request.url,
          init: request.init,
        }, '*');
      });
    };

    try {
      await refreshStateFromBackground();
    } catch {
      setWsEnabledFlag(true);
      wsMonitor = initWsMonitorForSite({ hostname, call });
      wsMonitor.emitStatus();
    }

    const listener = (message: any) => {
      if (!message) return;
      if (message.type === 'bg:stateChanged') {
        scheduleStateRefresh();
        return;
      }
      if (message.type === 'bg:gmgn:pageFollowTokens') {
        return (async () => {
          console.info('[gmgn.wsMonitor.follow.receive]', {
            hostname,
            isGmgnHost,
            chain: message?.chain,
            tokens: message?.tokens,
          });
          if (!isGmgnHost) return { ok: false, error: 'not_gmgn_page' };
          try {
            const chain = typeof message?.chain === 'string' ? message.chain : 'bsc';
            const tokens = Array.isArray(message?.tokens) ? message.tokens : [];
            if (tokens.length <= 0) return { ok: false, error: 'invalid_tokens' };
            const request = await GmgnAPI.buildFollowTokensPageRequest(chain, tokens);
            await requestGmgnPageFetch(request);
            return { ok: true };
          } catch (error: any) {
            return { ok: false, error: String(error?.message || error || 'gmgn_follow_tokens_failed') };
          }
        })();
      }
      if (message.type === 'bg:gmgn:pageUnfollowTokens') {
        return (async () => {
          console.info('[gmgn.wsMonitor.unfollow.receive]', {
            hostname,
            isGmgnHost,
            chain: message?.chain,
            tokens: message?.tokens,
          });
          if (!isGmgnHost) return { ok: false, error: 'not_gmgn_page' };
          try {
            const chain = typeof message?.chain === 'string' ? message.chain : 'bsc';
            const tokens = Array.isArray(message?.tokens) ? message.tokens : [];
            if (tokens.length <= 0) return { ok: false, error: 'invalid_tokens' };
            const request = await GmgnAPI.buildUnfollowTokensPageRequest(chain, tokens);
            await requestGmgnPageFetch(request);
            return { ok: true };
          } catch (error: any) {
            return { ok: false, error: String(error?.message || error || 'gmgn_unfollow_tokens_failed') };
          }
        })();
      }
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
