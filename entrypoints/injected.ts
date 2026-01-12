export default defineUnlistedScript(() => {
  (function () {
    function isGMGNConnection(url: string): boolean {
      return Boolean(url && url.includes('gmgn.ai'));
    }

    function getConnectionInfo(url: string): { device_id?: string | null; client_id?: string | null; uuid?: string | null } {
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
    }

    function postWSMessage(direction: string, data: any, raw: any, connectionInfo: any): void {
      const message = {
        type: 'GMGN_WEBSOCKET_DATA',
        direction,
        data,
        raw,
        timestamp: Date.now(),
        connectionInfo,
      };
      window.postMessage(message, '*');
    }

    const OriginalWebSocket = window.WebSocket;

    (window as any).WebSocket = function (url: string | URL, protocols?: string | string[]) {
      const ws = new OriginalWebSocket(url, protocols);

      if (isGMGNConnection(url.toString())) {
        const connectionInfo = getConnectionInfo(url.toString());

        const originalSend = ws.send;
        ws.send = function (data: any) {
          try {
            const parsed = JSON.parse(data);
            postWSMessage('send', parsed, data, connectionInfo);
          } catch {
            postWSMessage('send', null, data, connectionInfo);
          }
          return originalSend.call(this, data);
        };

        ws.addEventListener('message', function (event: MessageEvent) {
          try {
            const parsed = JSON.parse(event.data);
            postWSMessage('receive', parsed, event.data, connectionInfo);
          } catch {
            postWSMessage('receive', null, event.data, connectionInfo);
          }
        });
      }

      return ws;
    };

    Object.setPrototypeOf((window as any).WebSocket, OriginalWebSocket);
    (window as any).WebSocket.prototype = OriginalWebSocket.prototype;
  })();
});

