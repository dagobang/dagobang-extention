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

      const host = window.location.hostname;
      if (!shouldMonitorWsOnHost(host)) return;

      installWebSocketHook();
      if (ADAPTERS.some((adapter) => adapter.supportsWorker)) {
        installWorkerHook();
      }
    })();

    function isWsCaptureEnabled(): boolean {
      try {
        const raw = window.localStorage.getItem('dagobang_ws_monitor_enabled_v1');
        if (raw === '0') return false;
        if (raw === '1') return true;
      } catch {
      }
      return true;
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
          if (!isWsCaptureEnabled()) return originalSend.call(this, data);
          try {
            const parsed = JSON.parse(data);
            postWsPacket(adapter, 'send', parsed, data, connectionInfo);
          } catch {
            postWsPacket(adapter, 'send', null, data, connectionInfo);
          }
          return originalSend.call(this, data);
        };

        ws.addEventListener('message', function (event: MessageEvent) {
          if (!isWsCaptureEnabled()) return;
          try {
            const parsed = JSON.parse(event.data);
            postWsPacket(adapter, 'receive', parsed, event.data, connectionInfo);
          } catch {
            postWsPacket(adapter, 'receive', null, event.data, connectionInfo);
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
        const postWsPacket = (site: WsSite, direction: 'send' | 'receive', parsed: any, raw: any, connectionInfo: any): void => {
          try {
            const rawEnabled = window.localStorage.getItem('dagobang_ws_monitor_enabled_v1');
            if (rawEnabled === '0') return;
          } catch {
          }
          const gmgnParsed = site === 'gmgn' ? parseGmgnEnvelope(parsed) : { payload: parsed };
          const message = {
            __DAGOBANG_WORKER_WS__: true,
            payload: {
              site,
              direction,
              channel: gmgnParsed.channel ?? null,
              payload: gmgnParsed.payload ?? null,
              raw,
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
              try {
                const rawEnabled = window.localStorage.getItem('dagobang_ws_monitor_enabled_v1');
                if (rawEnabled === '0') return originalSend.call(this, data);
              } catch {
              }
              try {
                const parsed = JSON.parse(data);
                postWsPacket(site, 'send', parsed, data, connectionInfo);
              } catch {
                postWsPacket(site, 'send', null, data, connectionInfo);
              }
              return originalSend.call(this, data);
            };

            ws.addEventListener('message', function (event: MessageEvent) {
              try {
                const rawEnabled = window.localStorage.getItem('dagobang_ws_monitor_enabled_v1');
                if (rawEnabled === '0') return;
              } catch {
              }
              try {
                const parsed = JSON.parse(event.data);
                postWsPacket(site, 'receive', parsed, event.data, connectionInfo);
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
          window.postMessage(
            {
              type: 'DAGOBANG_WS_PACKET',
              ...data.payload,
            },
            '*',
          );
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
