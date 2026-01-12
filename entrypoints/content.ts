import './shared/style.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { browser } from 'wxt/browser';
import App from './content-ui/App';
import { call } from '@/utils/messaging';

export default defineContentScript({
  matches: ['*://gmgn.ai/*', '*://axiom.trade/*', '*://web3.binance.com/*',
    "*://web3.okx.com/*", "*://www.xxyy.io/*", "*://dexscreener.com/*",
    "*://four.meme/**", "*://flap.sh/**"
  ],
  cssInjectionMode: 'ui',
  async main(ctx) {
    // const injectWebSocketInterceptor = () => {
    //   if (!window.location.hostname.includes('gmgn.ai')) return;
    //   const script = document.createElement('script');
    //   script.src = browser.runtime.getURL('/injected.js');
    //   script.onload = () => {
    //     script.remove();
    //   };
    //   script.onerror = () => {
    //     script.remove();
    //   };
    //   const target = document.head || document.documentElement || document.body;
    //   if (target) {
    //     target.appendChild(script);
    //   }
    // };

    // injectWebSocketInterceptor();

    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const data = event.data as any;
      if (!data || data.type !== 'GMGN_WEBSOCKET_DATA') return;
      void call({ type: 'autotrade:ws', payload: data });
    });

    const ui = await createShadowRootUi(ctx, {
      name: 'dagobang-widget',
      position: 'inline',
      anchor: 'body',
      onMount: (container: HTMLElement) => {
        const rootEl = document.createElement('div');
        container.append(rootEl);
        const root = ReactDOM.createRoot(rootEl);
        root.render(React.createElement(App));
        return root;
      },
      onRemove: (root: ReactDOM.Root | undefined) => {
        root?.unmount();
      },
    });

    ui.mount();
  },
});
