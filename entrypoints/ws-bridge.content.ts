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
    let wsCaptureEnabledCacheExpireAt = 0;
    let wsBridgeProbeEnabledCache = false;
    let wsBridgeProbeEnabledCacheExpireAt = 0;
    type WsBridgeProbeWindow = {
      scope: 'main';
      windowStartAt: number;
      packets: number;
      mainPackets: number;
      workerForwardPackets: number;
      receivePackets: number;
      sendPackets: number;
      parseAttempts: number;
      parseSuccess: number;
      parseFail: number;
      postCount: number;
      textBytes: number;
      handleTotalMs: number;
      handleMaxMs: number;
      lastAt: number;
      gmgnPackets: number;
      axiomPackets: number;
    };
    const createWsBridgeProbeWindow = (now: number): WsBridgeProbeWindow => ({
      scope: 'main',
      windowStartAt: now,
      packets: 0,
      mainPackets: 0,
      workerForwardPackets: 0,
      receivePackets: 0,
      sendPackets: 0,
      parseAttempts: 0,
      parseSuccess: 0,
      parseFail: 0,
      postCount: 0,
      textBytes: 0,
      handleTotalMs: 0,
      handleMaxMs: 0,
      lastAt: now,
      gmgnPackets: 0,
      axiomPackets: 0,
    });
    let wsBridgeProbeWindow = createWsBridgeProbeWindow(Date.now());

    function isWsCaptureEnabled(): boolean {
      const now = Date.now();
      if (now < wsCaptureEnabledCacheExpireAt) return wsCaptureEnabledCache;
      try {
        const raw = window.localStorage.getItem(WS_MONITOR_ENABLED_KEY);
        if (raw === '0') {
          wsCaptureEnabledCache = false;
          wsCaptureEnabledCacheExpireAt = now + 3000;
          return false;
        }
        if (raw === '1') {
          wsCaptureEnabledCache = true;
          wsCaptureEnabledCacheExpireAt = now + 3000;
          return true;
        }
      } catch {
      }
      wsCaptureEnabledCache = true;
      wsCaptureEnabledCacheExpireAt = now + 3000;
      return true;
    }

    function isWsBridgeProbeEnabled(): boolean {
      const now = Date.now();
      if (now < wsBridgeProbeEnabledCacheExpireAt) return wsBridgeProbeEnabledCache;
      try {
        const raw = window.localStorage.getItem(WS_BRIDGE_PROBE_ENABLED_KEY);
        if (raw === '1') {
          wsBridgeProbeEnabledCache = true;
          wsBridgeProbeEnabledCacheExpireAt = now + 3000;
          return true;
        }
      } catch {
      }
      wsBridgeProbeEnabledCache = false;
      wsBridgeProbeEnabledCacheExpireAt = now + 3000;
      return false;
    }

    function estimateTextBytes(raw: unknown): number {
      if (typeof raw === 'string') return raw.length;
      if (raw instanceof ArrayBuffer) return raw.byteLength;
      if (ArrayBuffer.isView(raw)) return raw.byteLength;
      return 0;
    }

    function flushWsBridgeProbe(now: number): void {
      const duration = now - wsBridgeProbeWindow.windowStartAt;
      if (duration < 3000) return;
      const packetsPerSec = duration > 0 ? (wsBridgeProbeWindow.packets * 1000) / duration : 0;
      const avgHandleMs = wsBridgeProbeWindow.packets > 0 ? wsBridgeProbeWindow.handleTotalMs / wsBridgeProbeWindow.packets : 0;
      const parseFailRate = wsBridgeProbeWindow.parseAttempts > 0 ? wsBridgeProbeWindow.parseFail / wsBridgeProbeWindow.parseAttempts : 0;
      const textKbps = duration > 0 ? (wsBridgeProbeWindow.textBytes / 1024) / (duration / 1000) : 0;
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
        textKbps,
        likelyCause,
      };
      (window as any).__DAGOBANG_WS_BRIDGE_PROBE__ = snapshot;
      window.postMessage({ type: 'DAGOBANG_WS_BRIDGE_PROBE', payload: snapshot }, '*');
      wsBridgeProbeWindow = createWsBridgeProbeWindow(now);
    }

    function recordWsBridgeProbe(entry: {
      packetSource: 'main' | 'worker_forward';
      site: WsSite;
      direction: 'send' | 'receive';
      parseAttempted: boolean;
      parseSucceeded: boolean;
      textBytes: number;
      posted: boolean;
      handleMs: number;
    }): void {
      if (!isWsBridgeProbeEnabled()) return;
      const now = Date.now();
      const next = wsBridgeProbeWindow;
      next.packets += 1;
      if (entry.packetSource === 'main') next.mainPackets += 1;
      if (entry.packetSource === 'worker_forward') next.workerForwardPackets += 1;
      if (entry.direction === 'receive') next.receivePackets += 1;
      if (entry.direction === 'send') next.sendPackets += 1;
      if (entry.site === 'gmgn') next.gmgnPackets += 1;
      if (entry.site === 'axiom') next.axiomPackets += 1;
      if (entry.parseAttempted) next.parseAttempts += 1;
      if (entry.parseSucceeded) next.parseSuccess += 1;
      if (entry.parseAttempted && !entry.parseSucceeded) next.parseFail += 1;
      if (entry.posted) next.postCount += 1;
      next.textBytes += entry.textBytes;
      next.handleTotalMs += entry.handleMs;
      if (entry.handleMs > next.handleMaxMs) next.handleMaxMs = entry.handleMs;
      next.lastAt = now;
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

    function postWsPacket(adapter: WsAdapter, direction: 'send' | 'receive', parsed: any, raw: any, connectionInfo: any): void {
      if (!isWsCaptureEnabled()) return;
      const normalized = adapter.parseEnvelope(parsed);
      window.postMessage(
        {
          type: 'DAGOBANG_WS_PACKET',
          site: adapter.site,
          direction,
          channel: normalized.channel ?? null,
          payload: normalized.payload ?? null,
          raw,
          fromWorker: false,
          timestamp: Date.now(),
          connectionInfo,
        },
        '*',
      );
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
          let posted = false;
          const textBytes = estimateTextBytes(data);
          try {
            if (typeof data === 'string') {
              parseAttempted = true;
              const parsed = JSON.parse(data);
              parseSucceeded = true;
              postWsPacket(adapter, 'send', parsed, undefined, connectionInfo);
              posted = true;
            } else {
              postWsPacket(adapter, 'send', null, data, connectionInfo);
              posted = true;
            }
          } catch {
            postWsPacket(adapter, 'send', null, data, connectionInfo);
            posted = true;
          }
          if (shouldProbe) {
            recordWsBridgeProbe({
              packetSource: 'main',
              site: adapter.site,
              direction: 'send',
              parseAttempted,
              parseSucceeded,
              textBytes,
              posted,
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
          let posted = false;
          const textBytes = estimateTextBytes(event.data);
          try {
            if (typeof event.data === 'string') {
              parseAttempted = true;
              const parsed = JSON.parse(event.data);
              parseSucceeded = true;
              postWsPacket(adapter, 'receive', parsed, undefined, connectionInfo);
              posted = true;
            } else {
              postWsPacket(adapter, 'receive', null, event.data, connectionInfo);
              posted = true;
            }
          } catch {
            postWsPacket(adapter, 'receive', null, event.data, connectionInfo);
            posted = true;
          }
          if (shouldProbe) {
            recordWsBridgeProbe({
              packetSource: 'main',
              site: adapter.site,
              direction: 'receive',
              parseAttempted,
              parseSucceeded,
              textBytes,
              posted,
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
        let wsCaptureEnabledCacheExpireAt = 0;
        const isWsCaptureEnabled = (): boolean => {
          const now = Date.now();
          if (now < wsCaptureEnabledCacheExpireAt) return wsCaptureEnabledCache;
          try {
            const rawEnabled = window.localStorage.getItem('dagobang_ws_monitor_enabled_v1');
            if (rawEnabled === '0') {
              wsCaptureEnabledCache = false;
              wsCaptureEnabledCacheExpireAt = now + 3000;
              return false;
            }
            if (rawEnabled === '1') {
              wsCaptureEnabledCache = true;
              wsCaptureEnabledCacheExpireAt = now + 3000;
              return true;
            }
          } catch {
          }
          wsCaptureEnabledCache = true;
          wsCaptureEnabledCacheExpireAt = now + 3000;
          return true;
        };
        const postWsPacket = (site: WsSite, direction: 'send' | 'receive', parsed: any, raw: any, connectionInfo: any): void => {
          if (!isWsCaptureEnabled()) return;
          const gmgnParsed = site === 'gmgn' ? parseGmgnEnvelope(parsed) : { payload: parsed };
          const message = {
            __DAGOBANG_WORKER_WS__: true,
            payload: {
              site,
              direction,
              channel: gmgnParsed.channel ?? null,
              payload: gmgnParsed.payload ?? null,
              raw,
              fromWorker: true,
              timestamp: Date.now(),
              connectionInfo,
            },
          };

          const target = self as any;
          if (typeof target.postMessage === 'function') {
            target.postMessage(message);
            return;
          }
          if (ports.length) {
            for (const port of ports) {
              try {
                port.postMessage(message);
              } catch {
              }
            }
          }
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
          const workerSite = data.payload.site === 'axiom' ? 'axiom' : 'gmgn';
          const workerDirection = data.payload.direction === 'send' ? 'send' : 'receive';
          const shouldProbe = isWsBridgeProbeEnabled();
          const startedAt = shouldProbe ? performance.now() : 0;
          let posted = false;
          window.postMessage(
            {
              type: 'DAGOBANG_WS_PACKET',
              ...data.payload,
            },
            '*',
          );
          posted = true;
          if (shouldProbe) {
            recordWsBridgeProbe({
              packetSource: 'worker_forward',
              site: workerSite,
              direction: workerDirection,
              parseAttempted: false,
              parseSucceeded: false,
              textBytes: estimateTextBytes(data.payload.raw),
              posted,
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
