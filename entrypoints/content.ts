import './shared/style.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './content-ui/App';

export default defineContentScript({
  matches: ['*://gmgn.ai/*', '*://axiom.trade/*', '*://web3.binance.com/*',
    "*://web3.okx.com/*", "*://www.xxyy.io/*", "*://dexscreener.com/*",
    "*://four.meme/**", "*://flap.sh/**"
  ],
  cssInjectionMode: 'ui',
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
  },
});
