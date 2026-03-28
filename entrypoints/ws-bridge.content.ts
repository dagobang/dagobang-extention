export default defineContentScript({
  matches: ['*://gmgn.ai/*', '*://*.gmgn.ai/*', '*://axiom.trade/*', '*://*.axiom.trade/*', '*://web3.binance.com/*',
    "*://web3.okx.com/*", "*://xxyy.io/*", "*://*.xxyy.io/*", "*://dexscreener.com/*", "*://*.dexscreener.com/*",
    "*://four.meme/*", "*://*.four.meme/*", "*://flap.sh/*", "*://*.flap.sh/*", "*://debot.ai/*", "*://*.debot.ai/*",
  ],
  allFrames: true,
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    type WsSite = 'gmgn' | 'axiom';
    type WsAdapter = {
      site: WsSite;
      matchWsUrl: (url: string) => boolean;
      parseEnvelope: (parsed: any) => { channel?: string; payload?: any };
      getConnectionInfo: (wsUrl: string) => any;
      supportsWorker: boolean;
      shouldWrapWorkerScriptUrl: (workerScriptUrl: string) => boolean;
    };

    const parseGmgnEnvelope = (data: any): { channel?: string; payload?: any } => {
      if (Array.isArray(data) && typeof data[0] === 'string') {
        return { channel: data[0], payload: data[1] };
      }
      if (data && typeof data === 'object') {
        const channel =
          typeof (data as any).channel === 'string'
            ? (data as any).channel
            : typeof (data as any).event === 'string'
              ? (data as any).event
              : typeof (data as any).type === 'string'
                ? (data as any).type
                : undefined;
        if (channel) {
          const payload = (data as any).data ?? (data as any).payload ?? (data as any).body ?? (data as any).msg;
          return { channel, payload: payload ?? data };
        }
      }
      return { payload: data };
    };

    const extractGmgnWsConnectionInfo = (url: string): { device_id?: string | null; client_id?: string | null; uuid?: string | null } => {
      try {
        const urlObj = new URL(url);
        const params = new URLSearchParams(urlObj.search);
        return {
          device_id: params.get('device_id'),
          client_id: params.get('client_id'),
          uuid: params.get('uuid'),
        };
      } catch {
        return {};
      }
    };

    const ADAPTERS: WsAdapter[] = [
      {
        site: 'gmgn',
        matchWsUrl: (url) => url.includes('gmgn.ai'),
        parseEnvelope: parseGmgnEnvelope,
        getConnectionInfo: extractGmgnWsConnectionInfo,
        supportsWorker: true,
        shouldWrapWorkerScriptUrl: (workerScriptUrl) => workerScriptUrl.includes('gmgn.ai'),
      },
      {
        site: 'axiom',
        matchWsUrl: (url) => url.includes('axiom.trade'),
        parseEnvelope: (parsed) => ({ payload: parsed }),
        getConnectionInfo: () => ({}),
        supportsWorker: false,
        shouldWrapWorkerScriptUrl: () => false,
      },
    ];
    const GMGN_MONITORED_CHANNELS = new Set([
      'public_broadcast',
      'new_pool_info',
      'trenches_update',
      'twitter_user_monitor_basic',
      'twitter_monitor_basic',
      'twitter_monitor_token',
      'twitter_monitor_translation',
    ]);

    const normalizeWsChannel = (channel: unknown): string => {
      if (typeof channel !== 'string') return '';
      return channel.trim().toLowerCase();
    };

    const shouldForwardWsPacket = (site: WsSite, direction: 'send' | 'receive', channel: unknown): boolean => {
      if (site !== 'gmgn') return true;
      if (direction !== 'receive') return false;
      const normalized = normalizeWsChannel(channel);
      if (!normalized) return false;
      return GMGN_MONITORED_CHANNELS.has(normalized);
    };

    (function mainWorldEntry() {
      const g = globalThis as any;
      if (g.__DAGOBANG_MAIN_WORLD_READY__) return;
      g.__DAGOBANG_MAIN_WORLD_READY__ = true;

      installUrlChangeEmitter();
      installNavigateListener();

      const host = window.location.hostname;
      if (!shouldMonitorWsOnHost(host)) return;

      installWebSocketHook();
      if (ADAPTERS.some((adapter) => adapter.supportsWorker)) {
        installWorkerHook();
      }
    })();

    const WS_MONITOR_ENABLED_KEY = 'dagobang_ws_monitor_enabled_v1';
    const WS_BRIDGE_PROBE_ENABLED_KEY = 'dagobang_ws_bridge_probe_enabled_v1';
    let wsCaptureEnabledCache = true;
    let wsBridgeProbeEnabledCache = false;
    let wsFlagCacheInitialized = false;
    type WsBridgeProbeWindow = {
      windowStartAt: number;
      packets: number;
      parseAttempts: number;
      parseFail: number;
      handleTotalMs: number;
      handleMaxMs: number;
    };
    const createWsBridgeProbeWindow = (now: number): WsBridgeProbeWindow => ({
      windowStartAt: now,
      packets: 0,
      parseAttempts: 0,
      parseFail: 0,
      handleTotalMs: 0,
      handleMaxMs: 0,
    });
    let wsBridgeProbeWindow = createWsBridgeProbeWindow(Date.now());

    const applyWsFlagFromStorage = (key: string, raw: string | null) => {
      if (key === WS_MONITOR_ENABLED_KEY) {
        if (raw === '0') wsCaptureEnabledCache = false;
        else if (raw === '1') wsCaptureEnabledCache = true;
        else wsCaptureEnabledCache = true;
      }
      if (key === WS_BRIDGE_PROBE_ENABLED_KEY) {
        wsBridgeProbeEnabledCache = raw === '1';
      }
    };

    const readWsFlagsFromStorage = () => {
      try {
        applyWsFlagFromStorage(WS_MONITOR_ENABLED_KEY, window.localStorage.getItem(WS_MONITOR_ENABLED_KEY));
        applyWsFlagFromStorage(WS_BRIDGE_PROBE_ENABLED_KEY, window.localStorage.getItem(WS_BRIDGE_PROBE_ENABLED_KEY));
      } catch {
      }
    };

    const ensureWsFlagCache = () => {
      if (wsFlagCacheInitialized) return;
      readWsFlagsFromStorage();
      window.addEventListener('storage', (event) => {
        if (!event || typeof event.key !== 'string') return;
        if (event.key !== WS_MONITOR_ENABLED_KEY && event.key !== WS_BRIDGE_PROBE_ENABLED_KEY) return;
        applyWsFlagFromStorage(event.key, event.newValue);
      });
      try {
        const rawSetItem = window.localStorage.setItem.bind(window.localStorage);
        window.localStorage.setItem = ((key: string, value: string) => {
          rawSetItem(key, value);
          if (key === WS_MONITOR_ENABLED_KEY || key === WS_BRIDGE_PROBE_ENABLED_KEY) {
            applyWsFlagFromStorage(key, value);
          }
        }) as Storage['setItem'];
        const rawRemoveItem = window.localStorage.removeItem.bind(window.localStorage);
        window.localStorage.removeItem = ((key: string) => {
          rawRemoveItem(key);
          if (key === WS_MONITOR_ENABLED_KEY || key === WS_BRIDGE_PROBE_ENABLED_KEY) {
            applyWsFlagFromStorage(key, null);
          }
        }) as Storage['removeItem'];
      } catch {
      }
      wsFlagCacheInitialized = true;
    };

    function isWsCaptureEnabled(): boolean {
      if (!wsFlagCacheInitialized) ensureWsFlagCache();
      return wsCaptureEnabledCache;
    }

    function isWsBridgeProbeEnabled(): boolean {
      if (!wsFlagCacheInitialized) ensureWsFlagCache();
      return wsBridgeProbeEnabledCache;
    }
    ensureWsFlagCache();

    function flushWsBridgeProbe(now: number): void {
      const duration = now - wsBridgeProbeWindow.windowStartAt;
      if (duration < 3000) return;
      const packetsPerSec = duration > 0 ? (wsBridgeProbeWindow.packets * 1000) / duration : 0;
      const avgHandleMs = wsBridgeProbeWindow.packets > 0 ? wsBridgeProbeWindow.handleTotalMs / wsBridgeProbeWindow.packets : 0;
      const parseFailRate = wsBridgeProbeWindow.parseAttempts > 0 ? wsBridgeProbeWindow.parseFail / wsBridgeProbeWindow.parseAttempts : 0;
      const localBusyScore = (avgHandleMs >= 1 ? 1 : 0) + (wsBridgeProbeWindow.handleMaxMs >= 6 ? 1 : 0) + (packetsPerSec >= 120 ? 1 : 0);
      const remoteCongestionScore = (packetsPerSec < 20 ? 1 : 0) + (avgHandleMs < 0.8 ? 1 : 0) + (wsBridgeProbeWindow.handleMaxMs < 4 ? 1 : 0);
      const likelyCause =
        localBusyScore >= 2 && remoteCongestionScore <= 1
          ? 'local_main_thread_busy'
          : remoteCongestionScore >= 2 && localBusyScore <= 1
            ? 'network_or_remote_congestion'
            : 'mixed_or_uncertain';
      const snapshot = {
        ...wsBridgeProbeWindow,
        durationMs: duration,
        packetsPerSec,
        avgHandleMs,
        parseFailRate,
        likelyCause,
      };
      (window as any).__DAGOBANG_WS_BRIDGE_PROBE__ = snapshot;
      window.postMessage({ type: 'DAGOBANG_WS_BRIDGE_PROBE', payload: snapshot }, '*');
      wsBridgeProbeWindow = createWsBridgeProbeWindow(now);
    }

    function recordWsBridgeProbe(entry: {
      parseAttempted: boolean;
      parseSucceeded: boolean;
      handleMs: number;
    }): void {
      if (!isWsBridgeProbeEnabled()) return;
      const now = Date.now();
      const next = wsBridgeProbeWindow;
      next.packets += 1;
      if (entry.parseAttempted) next.parseAttempts += 1;
      if (entry.parseAttempted && !entry.parseSucceeded) next.parseFail += 1;
      next.handleTotalMs += entry.handleMs;
      if (entry.handleMs > next.handleMaxMs) next.handleMaxMs = entry.handleMs;
      flushWsBridgeProbe(now);
    }

    function installUrlChangeEmitter() {
      const dispatchUrlChange = () => {
        window.postMessage(
          {
            type: 'DAGOBANG_URL_CHANGE',
            href: window.location.href,
            ts: Date.now(),
          },
          '*',
        );
      };

      const rawPushState = history.pushState;
      const rawReplaceState = history.replaceState;
      history.pushState = function (this: History, ...args: Parameters<History['pushState']>) {
        const ret = rawPushState.apply(this, args);
        dispatchUrlChange();
        return ret;
      };
      history.replaceState = function (this: History, ...args: Parameters<History['replaceState']>) {
        const ret = rawReplaceState.apply(this, args);
        dispatchUrlChange();
        return ret;
      };

      window.addEventListener('popstate', dispatchUrlChange);
      window.addEventListener('hashchange', dispatchUrlChange);
      dispatchUrlChange();
    }

    function installNavigateListener() {
      const findNextRouter = (): any | null => {
        try {
          const g = globalThis as any;
          if (g.__DAGOBANG_NEXT_ROUTER__ && typeof g.__DAGOBANG_NEXT_ROUTER__.push === 'function') return g.__DAGOBANG_NEXT_ROUTER__;
          const directCandidates = [
            g.next?.router,
            g.__NEXT_ROUTER__,
            g.__router,
            g.router,
          ].filter(Boolean);
          for (const c of directCandidates) {
            if (c && typeof c.push === 'function' && typeof c.replace === 'function') {
              g.__DAGOBANG_NEXT_ROUTER__ = c;
              return c;
            }
          }

          const host = document.getElementById('__next') ?? document.body;
          if (!host) return null;
          const anyHost = host as any;
          const keys = Object.keys(anyHost);
          const containerKey = keys.find((k) => k.startsWith('__reactContainer$') || k.startsWith('__reactFiber$')) ?? null;
          const rootKey = keys.find((k) => k.startsWith('_reactRootContainer')) ?? null;
          const rootFiber = (() => {
            if (containerKey && anyHost[containerKey]) return anyHost[containerKey];
            const root = rootKey ? anyHost[rootKey] : null;
            const current = root?.current ?? root?._internalRoot?.current ?? null;
            return current ?? null;
          })();
          if (!rootFiber) return null;

          const seen = new Set<any>();
          const stack: any[] = [rootFiber];
          let steps = 0;
          while (stack.length && steps < 20000) {
            const node = stack.pop();
            steps += 1;
            if (!node || seen.has(node)) continue;
            seen.add(node);

            const probe = (obj: any) => {
              if (!obj || typeof obj !== 'object') return null;
              if (typeof obj.push === 'function' && typeof obj.replace === 'function') return obj;
              return null;
            };
            const found =
              probe(node.memoizedProps) ??
              probe(node.memoizedState) ??
              probe(node.stateNode) ??
              probe(node.pendingProps);
            if (found) {
              g.__DAGOBANG_NEXT_ROUTER__ = found;
              return found;
            }

            if (node.child) stack.push(node.child);
            if (node.sibling) stack.push(node.sibling);
            if (node.return) stack.push(node.return);
          }
        } catch {
        }
        return null;
      };

      const handler = (e: MessageEvent) => {
        const data = (e as any).data;
        if (!data || data.type !== 'DAGOBANG_NAVIGATE') return;
        const href = typeof data.href === 'string' ? data.href.trim() : '';
        const navId = typeof data.navId === 'string' ? data.navId : '';
        if (!href) return;
        try {
          const target = new URL(href, window.location.href);
          const current = new URL(window.location.href);
          if (target.origin !== current.origin) {
            window.location.href = target.href;
            if (navId) window.postMessage({ type: 'DAGOBANG_NAV_DONE', navId, ok: true, mode: 'assign' }, '*');
            return;
          }
          if (target.href === current.href) return;
          const nextUrl = `${target.pathname}${target.search}${target.hash}`;

          const router = findNextRouter();
          if (router && typeof router.push === 'function') {
            try {
              const ret = router.push(nextUrl);
              if (navId) window.postMessage({ type: 'DAGOBANG_NAV_DONE', navId, ok: true, mode: 'router' }, '*');
              if (ret && typeof ret.then === 'function') {
                void ret.then(
                  () => navId && window.postMessage({ type: 'DAGOBANG_NAV_DONE', navId, ok: true, mode: 'router' }, '*'),
                  () => navId && window.postMessage({ type: 'DAGOBANG_NAV_DONE', navId, ok: false, mode: 'router' }, '*'),
                );
              }
              return;
            } catch {
            }
          }

          const prevState = history.state;
          const nextState = (() => {
            const base: any =
              prevState && typeof prevState === 'object'
                ? { ...(prevState as any) }
                : {
                    url: nextUrl,
                    as: nextUrl,
                    options: {},
                  };
            base.url = nextUrl;
            base.as = nextUrl;
            if (!base.options || typeof base.options !== 'object') base.options = {};
            base.__N = true;
            base.__NA = true;
            base.key = typeof base.key === 'string' && base.key ? base.key : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
            return base;
          })();
          history.pushState(nextState, '', target.href);
          try {
            window.dispatchEvent(new PopStateEvent('popstate', { state: nextState }));
          } catch {
            window.dispatchEvent(new Event('popstate'));
          }
          try {
            window.dispatchEvent(new Event('pushstate'));
            window.dispatchEvent(new Event('locationchange'));
          } catch {
          }
          if (navId) window.postMessage({ type: 'DAGOBANG_NAV_DONE', navId, ok: true, mode: 'history' }, '*');
        } catch {
          if (navId) window.postMessage({ type: 'DAGOBANG_NAV_DONE', navId, ok: false, mode: 'error' }, '*');
        }
      };
      window.addEventListener('message', handler);
    }

    function shouldMonitorWsOnHost(hostname: string) {
      return hostname.includes('gmgn.ai') || hostname.includes('axiom.trade');
    }

    function getAdapterByWsUrl(url: string): WsAdapter | null {
      for (const adapter of ADAPTERS) {
        if (adapter.matchWsUrl(url)) return adapter;
      }
      return null;
    }

    function postWsPacket(adapter: WsAdapter, direction: 'send' | 'receive', parsed: any, raw: any, connectionInfo: any): boolean {
      if (!isWsCaptureEnabled()) return false;
      const normalized = adapter.parseEnvelope(parsed);
      if (!shouldForwardWsPacket(adapter.site, direction, normalized.channel)) return false;
      const packet: any = {
        type: 'DAGOBANG_WS_PACKET',
        site: adapter.site,
        direction,
        channel: normalized.channel ?? null,
        payload: normalized.payload ?? null,
        timestamp: Date.now(),
      };
      if (adapter.site !== 'gmgn' && raw !== undefined) {
        packet.raw = raw;
      }
      if (adapter.site !== 'gmgn' && connectionInfo && Object.keys(connectionInfo).length) {
        packet.connectionInfo = connectionInfo;
      }
      window.postMessage(
        packet,
        '*',
      );
      return true;
    }

    function createWrappedWebSocket(BaseWebSocket: typeof WebSocket) {
      const WrappedWebSocket = function (this: unknown, url: string | URL, protocols?: string | string[]) {
        const urlStr = String(url);
        const ws = new BaseWebSocket(url, protocols);
        const adapter = getAdapterByWsUrl(urlStr);
        if (!adapter) return ws;

        const connectionInfo = adapter.getConnectionInfo(urlStr);
        const originalSend = ws.send;

        ws.send = function (data: any) {
          if (adapter.site === 'gmgn') return originalSend.call(this, data);
          if (!isWsCaptureEnabled()) return originalSend.call(this, data);
          const shouldProbe = isWsBridgeProbeEnabled();
          const startedAt = shouldProbe ? performance.now() : 0;
          let parseAttempted = false;
          let parseSucceeded = false;
          try {
            if (typeof data === 'string') {
              parseAttempted = true;
              const parsed = JSON.parse(data);
              parseSucceeded = true;
              postWsPacket(adapter, 'send', parsed, undefined, connectionInfo);
            } else {
              postWsPacket(adapter, 'send', null, data, connectionInfo);
            }
          } catch {
            postWsPacket(adapter, 'send', null, data, connectionInfo);
          }
          if (shouldProbe) {
            recordWsBridgeProbe({
              parseAttempted,
              parseSucceeded,
              handleMs: performance.now() - startedAt,
            });
          }
          return originalSend.call(this, data);
        };

        ws.addEventListener('message', function (event: MessageEvent) {
          if (!isWsCaptureEnabled()) return;
          const shouldProbe = isWsBridgeProbeEnabled();
          const startedAt = shouldProbe ? performance.now() : 0;
          let parseAttempted = false;
          let parseSucceeded = false;
          try {
            if (typeof event.data === 'string') {
              parseAttempted = true;
              const parsed = JSON.parse(event.data);
              parseSucceeded = true;
              postWsPacket(adapter, 'receive', parsed, undefined, connectionInfo);
            } else {
              postWsPacket(adapter, 'receive', null, event.data, connectionInfo);
            }
          } catch {
            postWsPacket(adapter, 'receive', null, event.data, connectionInfo);
          }
          if (shouldProbe) {
            recordWsBridgeProbe({
              parseAttempted,
              parseSucceeded,
              handleMs: performance.now() - startedAt,
            });
          }
        });

        return ws;
      } as unknown as typeof WebSocket;

      Object.setPrototypeOf(WrappedWebSocket, BaseWebSocket);
      WrappedWebSocket.prototype = BaseWebSocket.prototype;
      return WrappedWebSocket;
    }

    function installWebSocketHook() {
      const g = globalThis as any;

      let BaseWebSocket = g.WebSocket as typeof WebSocket;
      let WrappedWebSocket = createWrappedWebSocket(BaseWebSocket);
      Object.defineProperty(g, 'WebSocket', {
        configurable: true,
        enumerable: true,
        get() {
          return WrappedWebSocket;
        },
        set(next: typeof WebSocket) {
          BaseWebSocket = next;
          WrappedWebSocket = createWrappedWebSocket(BaseWebSocket);
        },
      });
    }

    function resolveWorkerScriptUrl(input: string | URL): string {
      try {
        return new URL(String(input), window.location.href).toString();
      } catch {
        return String(input);
      }
    }

    type SharedWorkerOptionsLike = {
      name?: string;
      type?: 'classic' | 'module';
      credentials?: 'omit' | 'same-origin' | 'include';
    };

    function shouldWrapWorkerScriptUrl(scriptUrl: string): boolean {
      const url = scriptUrl.toLowerCase();
      if (url.startsWith('blob:') || url.startsWith('data:')) return true;

      const host = window.location.hostname.toLowerCase();
      if (host && url.includes(host)) return true;

      return ADAPTERS.some((adapter) => adapter.supportsWorker && adapter.shouldWrapWorkerScriptUrl(url));
    }

    function buildWorkerPatch() {
      return function (originUrl: string) {
        const g = globalThis as any;
        if (g.__DAGOBANG_WORKER_WS_HOOKED__) return;
        g.__DAGOBANG_WORKER_WS_HOOKED__ = true;

        const resolveUrlLike = (value: any): any => {
          if (typeof value !== 'string' && !(value instanceof URL)) return value;
          try {
            return new URL(String(value), originUrl).toString();
          } catch {
            return value;
          }
        };

        const rawFetch = (self as any).fetch as undefined | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>);
        if (typeof rawFetch === 'function') {
          (self as any).fetch = (input: RequestInfo | URL, init?: RequestInit) => {
            const resolvedInput = resolveUrlLike(input);
            return rawFetch.call(self, resolvedInput, init);
          };
        }

        const rawXhr = (self as any).XMLHttpRequest as undefined | { prototype?: any };
        const rawXhrOpen = rawXhr?.prototype?.open as undefined | ((...args: any[]) => any);
        if (rawXhr?.prototype && typeof rawXhrOpen === 'function') {
          rawXhr.prototype.open = function (...args: any[]) {
            if (args.length >= 2) {
              args[1] = resolveUrlLike(args[1]);
            }
            return rawXhrOpen.apply(this, args);
          };
        }

        const rawImportScripts = (self as any).importScripts as undefined | ((...urls: string[]) => void);
        if (typeof rawImportScripts === 'function') {
          (self as any).importScripts = (...urls: string[]) => {
            const resolved = urls.map((url) => {
              try {
                return new URL(String(url), originUrl).toString();
              } catch {
                return String(url);
              }
            });
            return rawImportScripts(...resolved);
          };
        }

        const ports: MessagePort[] = [];
        const attachPort = (port: MessagePort) => {
          ports.push(port);
          try {
            if (typeof port.start === 'function') port.start();
          } catch {
          }
        };
        const originalOnConnect = (self as any).onconnect;
        const onConnectHandler = (event: MessageEvent) => {
          const port = (event as any).ports?.[0];
          if (port) attachPort(port);
        };
        if (typeof (self as any).addEventListener === 'function') {
          (self as any).addEventListener('connect', onConnectHandler);
        }
        (self as any).onconnect = (event: MessageEvent) => {
          onConnectHandler(event);
          if (typeof originalOnConnect === 'function') return originalOnConnect.call(self, event);
        };

        type WsSite = 'gmgn' | 'axiom';
        const getSiteByWsUrl = (url: string): WsSite | null => {
          if (url.includes('gmgn.ai')) return 'gmgn';
          if (url.includes('axiom.trade')) return 'axiom';
          return null;
        };
        const getConnectionInfo = (url: string): { device_id?: string | null; client_id?: string | null; uuid?: string | null } => {
          try {
            const urlObj = new URL(url);
            const params = new URLSearchParams(urlObj.search);
            return {
              device_id: params.get('device_id'),
              client_id: params.get('client_id'),
              uuid: params.get('uuid'),
            };
          } catch {
            return {};
          }
        };
        const parseGmgnEnvelope = (data: any): { channel?: string; payload?: any } => {
          if (Array.isArray(data) && typeof data[0] === 'string') {
            return { channel: data[0], payload: data[1] };
          }
          if (data && typeof data === 'object') {
            const channel =
              typeof (data as any).channel === 'string'
                ? (data as any).channel
                : typeof (data as any).event === 'string'
                  ? (data as any).event
                  : typeof (data as any).type === 'string'
                    ? (data as any).type
                    : undefined;
            if (channel) {
              const payload = (data as any).data ?? (data as any).payload ?? (data as any).body ?? (data as any).msg;
              return { channel, payload: payload ?? data };
            }
          }
          return { payload: data };
        };
        let wsCaptureEnabledCache = true;
        let wsCaptureEnabledLoaded = false;
        const isWsCaptureEnabled = (): boolean => {
          if (wsCaptureEnabledLoaded) return wsCaptureEnabledCache;
          wsCaptureEnabledLoaded = true;
          try {
            const rawEnabled = window.localStorage.getItem('dagobang_ws_monitor_enabled_v1');
            if (rawEnabled === '0') {
              wsCaptureEnabledCache = false;
              return false;
            }
            if (rawEnabled === '1') {
              wsCaptureEnabledCache = true;
              return true;
            }
          } catch {
          }
          wsCaptureEnabledCache = true;
          return true;
        };
        const normalizeWsChannel = (channel: unknown): string => {
          if (typeof channel !== 'string') return '';
          return channel.trim().toLowerCase();
        };
        const shouldForwardWsPacket = (site: WsSite, direction: 'send' | 'receive', channel: unknown): boolean => {
          if (site !== 'gmgn') return true;
          if (direction !== 'receive') return false;
          const normalized = normalizeWsChannel(channel);
          if (!normalized) return false;
          return normalized === 'public_broadcast'
            || normalized === 'new_pool_info'
            || normalized === 'trenches_update'
            || normalized === 'twitter_user_monitor_basic'
            || normalized === 'twitter_monitor_basic'
            || normalized === 'twitter_monitor_token'
            || normalized === 'twitter_monitor_translation';
        };
        const postWsPacket = (site: WsSite, direction: 'send' | 'receive', parsed: any, raw: any, connectionInfo: any): boolean => {
          if (!isWsCaptureEnabled()) return false;
          const gmgnParsed = site === 'gmgn' ? parseGmgnEnvelope(parsed) : { payload: parsed };
          if (!shouldForwardWsPacket(site, direction, gmgnParsed.channel)) return false;
          const packetPayload: any = {
            site,
            direction,
            channel: gmgnParsed.channel ?? null,
            payload: gmgnParsed.payload ?? null,
            timestamp: Date.now(),
          };
          if (site !== 'gmgn' && raw !== undefined) {
            packetPayload.raw = raw;
          }
          if (site !== 'gmgn' && connectionInfo && Object.keys(connectionInfo).length) {
            packetPayload.connectionInfo = connectionInfo;
          }
          const message = {
            __DAGOBANG_WORKER_WS__: true,
            payload: packetPayload,
          };

          const target = self as any;
          if (typeof target.postMessage === 'function') {
            target.postMessage(message);
            return true;
          }
          if (ports.length) {
            for (const port of ports) {
              try {
                port.postMessage(message);
              } catch {
              }
            }
            return true;
          }
          return false;
        };
        const createWrappedWebSocket = (BaseWebSocket: typeof WebSocket) => {
          const WrappedWebSocket = function (this: unknown, url: string | URL, protocols?: string | string[]) {
            const urlStr = String(url);
            const ws = new BaseWebSocket(url, protocols);
            const site = getSiteByWsUrl(urlStr);
            if (!site) return ws;

            const connectionInfo = site === 'gmgn' ? getConnectionInfo(urlStr) : {};
            const originalSend = ws.send;

            ws.send = function (data: any) {
              if (site === 'gmgn') return originalSend.call(this, data);
              if (!isWsCaptureEnabled()) return originalSend.call(this, data);
              try {
                if (typeof data === 'string') {
                  const parsed = JSON.parse(data);
                  postWsPacket(site, 'send', parsed, undefined, connectionInfo);
                } else {
                  postWsPacket(site, 'send', null, data, connectionInfo);
                }
              } catch {
                postWsPacket(site, 'send', null, data, connectionInfo);
              }
              return originalSend.call(this, data);
            };

            ws.addEventListener('message', function (event: MessageEvent) {
              if (!isWsCaptureEnabled()) return;
              try {
                if (typeof event.data === 'string') {
                  const parsed = JSON.parse(event.data);
                  postWsPacket(site, 'receive', parsed, undefined, connectionInfo);
                } else {
                  postWsPacket(site, 'receive', null, event.data, connectionInfo);
                }
              } catch {
                postWsPacket(site, 'receive', null, event.data, connectionInfo);
              }
            });

            return ws;
          } as unknown as typeof WebSocket;

          Object.setPrototypeOf(WrappedWebSocket, BaseWebSocket);
          WrappedWebSocket.prototype = BaseWebSocket.prototype;
          return WrappedWebSocket;
        };

        let BaseWebSocket = (self as any).WebSocket as typeof WebSocket;
        let WrappedWebSocket = createWrappedWebSocket(BaseWebSocket);
        Object.defineProperty(self, 'WebSocket', {
          configurable: true,
          enumerable: true,
          get() {
            return WrappedWebSocket;
          },
          set(next: typeof WebSocket) {
            BaseWebSocket = next;
            WrappedWebSocket = createWrappedWebSocket(BaseWebSocket);
          },
        });
      };
    }

    function createWorkerProxyUrl(resolvedUrl: string, options?: WorkerOptions | SharedWorkerOptionsLike) {
      const isModule = !!options && (options as WorkerOptions).type === 'module';
      const patchSource = `(${buildWorkerPatch().toString()})(${JSON.stringify(resolvedUrl)});`;
      const loader = isModule
        ? `${patchSource}import(${JSON.stringify(resolvedUrl)});`
        : `${patchSource}importScripts(${JSON.stringify(resolvedUrl)});`;
      const blob = new Blob([loader], { type: 'text/javascript' });
      return URL.createObjectURL(blob);
    }

    function attachWorkerBridge(worker: Worker | SharedWorker) {
      const target = (worker as any).port ?? worker;
      try {
        target.addEventListener('message', (event: MessageEvent) => {
          const data = (event as any).data as any;
          if (!data || !data.__DAGOBANG_WORKER_WS__ || !data.payload) return;
          const shouldProbe = isWsBridgeProbeEnabled();
          const startedAt = shouldProbe ? performance.now() : 0;
          window.postMessage(
            {
              type: 'DAGOBANG_WS_PACKET',
              ...data.payload,
            },
            '*',
          );
          if (shouldProbe) {
            recordWsBridgeProbe({
              parseAttempted: false,
              parseSucceeded: false,
              handleMs: performance.now() - startedAt,
            });
          }
        });
        if ((worker as any).port && typeof (worker as any).port.start === 'function') {
          (worker as any).port.start();
        }
      } catch {
      }
    }

    function installWorkerHook() {
      const g = globalThis as any;

      if (typeof g.Worker === 'function') {
        const OriginalWorker = g.Worker as typeof Worker;
        const WrappedWorker = function (this: unknown, scriptURL: string | URL, options?: WorkerOptions) {
          const resolved = resolveWorkerScriptUrl(scriptURL);
          const shouldWrap = shouldWrapWorkerScriptUrl(resolved);
          const finalUrl = shouldWrap ? createWorkerProxyUrl(resolved, options) : scriptURL;
          const worker = new OriginalWorker(finalUrl, options);
          if (shouldWrap) attachWorkerBridge(worker);
          return worker;
        } as unknown as typeof Worker;

        Object.setPrototypeOf(WrappedWorker, OriginalWorker);
        WrappedWorker.prototype = OriginalWorker.prototype;
        g.Worker = WrappedWorker;
      }

      if (typeof g.SharedWorker === 'function') {
        const OriginalSharedWorker = g.SharedWorker as typeof SharedWorker;
        const WrappedSharedWorker = function (this: unknown, scriptURL: string | URL, options?: string | SharedWorkerOptionsLike) {
          const resolved = resolveWorkerScriptUrl(scriptURL);
          const opts = typeof options === 'string' ? { name: options } : options;
          const shouldWrap = shouldWrapWorkerScriptUrl(resolved);
          const finalUrl = shouldWrap ? createWorkerProxyUrl(resolved, opts) : scriptURL;
          const worker = new OriginalSharedWorker(finalUrl, options as any);
          if (shouldWrap) attachWorkerBridge(worker);
          return worker;
        } as unknown as typeof SharedWorker;

        Object.setPrototypeOf(WrappedSharedWorker, OriginalSharedWorker);
        WrappedSharedWorker.prototype = OriginalSharedWorker.prototype;
        g.SharedWorker = WrappedSharedWorker;
      }
    }
  },
});
