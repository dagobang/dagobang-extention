import { TokenAPI } from "#imports";
import { getChainIdByName } from "@/constants/chains";
import { MEME_SUFFIXS } from "@/constants/meme";
import { getBridgeTokenAddresses } from "@/constants/tokens";

export interface SiteInfo {
  chain: string;
  tokenAddress: string;
  platform: 'gmgn' | 'axiom' | 'flap' | 'fourmeme' | 'binance' | 'okx' | 'xxyy' | 'dexscreener';
  walletAddress?: string;
}

export async function parseCurrentUrl(href: string): Promise<SiteInfo | null> {
  try {
    const u = new URL(href);

    // gmgn.ai
    // https://gmgn.ai/<chain>/token/<tokenAddress>
    if (u.hostname.includes('gmgn.ai')) {
      const parts = u.pathname.split('/').filter(Boolean);
      // Expected: [chain, 'token', address]
      // Example: /bsc/token/0x... -> ['bsc', 'token', '0x...']
      if (parts.length >= 3 && parts[1] === 'token') {
        return {
          chain: parts[0].toLowerCase(),
          tokenAddress: parts[2],
          platform: 'gmgn'
        };
      }
      if (parts.length >= 3 && parts[1] === 'address') {
        return {
          chain: parts[0].toLowerCase(),
          tokenAddress: '',
          walletAddress: parts[2],
          platform: 'gmgn'
        };
      }
    }

    // axiom.trade
    // https://axiom.trade/meme/<tokenAddress>?chain=<chain>
    if (u.hostname.includes('axiom.trade')) {
      const parts = u.pathname.split('/').filter(Boolean);
      // Expected: ['meme', address]
      if (parts.length >= 2 && parts[0] === 'meme') {
        const chain = u.searchParams.get('chain');
        if (chain) {

          const tokenInfo = await AxiomAPI.getTokenInfo(chain === 'bnb' ? 'bsc' : chain.toLowerCase(), parts[1]);
          if (!tokenInfo) return null;

          return {
            chain: chain === 'bnb' ? 'bsc' : chain.toLowerCase(),
            tokenAddress: tokenInfo.address,
            platform: 'axiom'
          };
        }
      }
    }

    // https://four.meme/zh-TW/token/0x0e0c758e613b36f4fade84b889300084f3ba4444
    if (u.hostname.includes('four.meme')) {
      const parts = u.pathname.split('/').filter(Boolean);
      // Expected: ['zh-TW', 'token', address]
      if (parts.length >= 3 && parts[1] === 'token') {
        return {
          chain: 'bsc',
          tokenAddress: parts[2],
          platform: 'fourmeme'
        };
      }
    }

    // https://flap.sh/bnb/0x36f2fd027f5f27c59b8c6d64df64bcc8e8c97777
    if (u.hostname.includes('flap.sh')) {
      const parts = u.pathname.split('/').filter(Boolean);
      // Expected: ['bnb', address]
      const chain = parts[0].toLowerCase();
      if (parts.length >= 2) {
        return {
          chain: chain === 'bnb' ? 'bsc' : chain,
          tokenAddress: parts[1],
          platform: 'flap'
        };
      }
    }

    // web3.binance.com
    // https://web3.binance.com/<lang?:zh-TC>/token/<chain>/<tokenAddress>
    if (u.hostname.includes('web3.binance.com')) {
      const parts = u.pathname.split('/').filter(Boolean);
      // Expected: ['token', chain, address]
      if (parts.length >= 3 && parts[1] === 'token') {
        const chain = parts[2];
        if (chain) {
          return {
            chain: chain === 'bnb' ? 'bsc' : chain.toLowerCase(),
            tokenAddress: parts[3],
            platform: 'binance'
          };
        }
      }
    }

    // web3.okx.com
    // https://web3.okx.com/zh-hans/token/bsc/0x2fa65d6b141ee6ad8d8c4e769a4ff231b5884444
    if (u.hostname.includes('web3.okx.com')) {
      const parts = u.pathname.split('/').filter(Boolean);
      // Expected: ['token', chain, address]
      if (parts.length >= 3 && parts[1] === 'token') {
        const chain = parts[2];
        if (chain) {
          return {
            chain: chain === 'bnb' ? 'bsc' : chain.toLowerCase(),
            tokenAddress: parts[3],
            platform: 'okx'
          };
        }
      }
    }

    // https://www.xxyy.io/bsc/0xa7b0db4ad13e8cd5f642be09b00bed308ddd4444
    if (u.hostname.includes('xxyy.io')) {
      const parts = u.pathname.split('/').filter(Boolean);
      // Expected: [chain, address]
      if (parts.length >= 2) {
        const info = {
          chain: parts[0].toLowerCase(),
          tokenAddress: parts[1],
          platform: 'xxyy'
        };

        if (!MEME_SUFFIXS.includes(info.tokenAddress.substring(info.tokenAddress.length - 4))) {

          const poolPair = await TokenAPI.getPoolPair(info.chain, info.tokenAddress);
          if (poolPair) {
            if (MEME_SUFFIXS.includes(poolPair.token0.substring(poolPair.token0.length - 4))) {
              info.tokenAddress = poolPair.token0;
            }
            else if (getBridgeTokenAddresses(getChainIdByName(info.chain)).find((addr) => addr.toLowerCase() === poolPair.token0.toLowerCase())) {
              info.tokenAddress = poolPair.token1;
            }
          }
        }

        return info as any;
      }
    }

    // https://dexscreener.com/bsc/0x8892138836eb5ec0f9c9e810efd19d542cf566b8
    if (u.hostname.includes('dexscreener.com')) {
      const parts = u.pathname.split('/').filter(Boolean);
      // Expected: [chain, address]
      if (parts.length >= 2) {
        const info = {
          chain: parts[0].toLowerCase(),
          tokenAddress: parts[1],
          platform: 'dexscreener'
        };

        if (!MEME_SUFFIXS.includes(info.tokenAddress.substring(info.tokenAddress.length - 4))) {

          const poolPair = await TokenAPI.getPoolPair(info.chain, info.tokenAddress);
          if (poolPair) {
            if (MEME_SUFFIXS.includes(poolPair.token0.substring(poolPair.token0.length - 4))) {
              info.tokenAddress = poolPair.token0;
            }
            else if (getBridgeTokenAddresses(getChainIdByName(info.chain)).find((addr) => addr.toLowerCase() === poolPair.token0.toLowerCase())) {
              info.tokenAddress = poolPair.token1;
            }
          }
        }

        return info as any;
      }
    }

    return null;
  } catch (e) {
    console.error('Failed to parse URL', e);
    return null;
  }
}
