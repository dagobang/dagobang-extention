import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Dagobang 打狗棒',
    description: 'Dagobang non-custodial Meme Trading Tool',
    version: '0.1.1',
    permissions: ['storage', 'alarms'],
    host_permissions: [
      'https://*.gmgn.ai/*',
      'https://gmgn.ai/*',
      'https://*.axiom.trade/*',
      'https://axiom.trade/*',
      'https://*.four.meme/*',
      'https://four.meme/*',
      'https://*.flap.sh/*',
      'https://flap.sh/*',
      'https://web3.binance.com/*',
      'https://web3.okx.com/*',
      'https://*.dexscreener.com/*',
      'https://dexscreener.com/*',
      'https://*.xxyy.io/*',
      'https://xxyy.io/*',
      // 'https://ark.cn-beijing.volces.com/*',
      'https://api.blxrbdn.com/*',
    ],
    action: {
      default_title: 'Dagobang 打狗棒',
    },
  },
});
