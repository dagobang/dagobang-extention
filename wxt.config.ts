import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Dagobang 打狗棒',
    description: 'Dagobang non-custodial Meme Trading Tool',
    version: '0.1.34',
    permissions: ['storage', 'alarms', 'sidePanel'],
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
      'https://*.debot.ai/*',
      'https://debot.ai/*',
      'https://api.blxrbdn.com/*',
    ],
    web_accessible_resources: [
      {
        resources: ['sounds/*.mp3'],
        matches: [
          '*://axiom.trade/*',
          '*://*.axiom.trade/*',
          '*://debot.ai/*',
          '*://*.debot.ai/*',
          '*://dexscreener.com/*',
          '*://*.dexscreener.com/*',
          '*://flap.sh/*',
          '*://*.flap.sh/*',
          '*://four.meme/*',
          '*://*.four.meme/*',
          '*://gmgn.ai/*',
          '*://*.gmgn.ai/*',
          '*://web3.binance.com/*',
          '*://web3.okx.com/*',
          '*://xxyy.io/*',
          '*://*.xxyy.io/*',
        ],
      },
    ],
    action: {
      default_title: 'Dagobang 打狗棒',
    },
    side_panel: {
      default_path: 'sidepanel.html',
    },
  },
});
