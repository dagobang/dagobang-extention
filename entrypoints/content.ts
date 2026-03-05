import './shared/style.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './content-ui/App';
import { call } from '@/utils/messaging';
import { setupQuickBuyButtonsForCurrentSite } from './content/quickbuy/index';

export default defineContentScript({
  matches: ['*://gmgn.ai/*', '*://*.gmgn.ai/*', '*://axiom.trade/*', '*://*.axiom.trade/*', '*://web3.binance.com/*',
    "*://web3.okx.com/*", "*://xxyy.io/*", "*://*.xxyy.io/*", "*://dexscreener.com/*", "*://*.dexscreener.com/*",
    "*://four.meme/*", "*://*.four.meme/*", "*://flap.sh/*", "*://*.flap.sh/*", "*://debot.ai/*", "*://*.debot.ai/*",
  ],
  cssInjectionMode: 'ui',
  runAt: 'document_end',
  async main(ctx) {
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

    try {
      const state = await call({ type: 'bg:getState' } as const);
      (window as any).__DAGOBANG_SETTINGS__ = state.settings;
    } catch {
    }

    setupQuickBuyButtonsForCurrentSite();
  },
});
