import { getChainIdByName } from "@/constants/chains";
import { MEME_SUFFIXS } from "@/constants/meme";
import { getBridgeTokenAddresses } from "@/constants/tokens";
import { TokenAPI } from '@/hooks/TokenAPI';

export interface SiteInfo {
  chain: string;
  tokenAddress: string;
  platform: 'gmgn' | 'axiom' | 'flap' | 'fourmeme' | 'binance' | 'okx' | 'xxyy' | 'debot' | 'dexscreener';
  walletAddress?: string;
}

export function parseCurrentUrl(href: string): SiteInfo | null {
  try {
    const u = new URL(href);
    const parts = u.pathname.split('/').filter(Boolean);

    // gmgn.ai
    // https://gmgn.ai/<chain>/token/<tokenAddress>
    if (u.hostname.includes('gmgn.ai')) {
      if (parts.length >= 3 && parts[1] === 'token') {
        return {
          chain: parts[0].toLowerCase(),
          tokenAddress: parts[2],
          platform: 'gmgn',
        };
      }
      if (parts.length >= 3 && parts[1] === 'address') {
        return {
          chain: parts[0].toLowerCase(),
          tokenAddress: '',
          walletAddress: parts[2],
          platform: 'gmgn',
        };
      }
    }

    // axiom.trade
    // https://axiom.trade/meme/<tokenAddress>?chain=<chain>
    // Fast path: return the address from URL; async parse will resolve actual token address if needed.
    if (u.hostname.includes('axiom.trade')) {
      if (parts.length >= 2 && parts[0] === 'meme') {
        const chain = u.searchParams.get('chain');
        if (chain) {
          return {
            chain: chain === 'bnb' ? 'bsc' : chain.toLowerCase(),
            tokenAddress: parts[1],
            platform: 'axiom',
          };
        }
      }
    }

    // https://four.meme/zh-TW/token/0x...
    if (u.hostname.includes('four.meme')) {
      if (parts.length >= 3 && parts[1] === 'token') {
        return {
          chain: 'bsc',
          tokenAddress: parts[2],
          platform: 'fourmeme',
        };
      }
    }

    // https://flap.sh/bnb/0x...
    if (u.hostname.includes('flap.sh')) {
      if (parts.length >= 2) {
        const chain = parts[0].toLowerCase();
        return {
          chain: chain === 'bnb' ? 'bsc' : chain,
          tokenAddress: parts[1],
          platform: 'flap',
        };
      }
    }

    // web3.binance.com
    // https://web3.binance.com/<lang?>/token/<chain>/<tokenAddress>
    if (u.hostname.includes('web3.binance.com')) {
      const idx = parts.indexOf('token');
      if (idx >= 0 && parts.length >= idx + 3) {
        const chain = parts[idx + 1];
        return {
          chain: chain === 'bnb' ? 'bsc' : chain.toLowerCase(),
          tokenAddress: parts[idx + 2],
          platform: 'binance',
        };
      }
    }

    // web3.okx.com
    // https://web3.okx.com/<lang?>/token/<chain>/<tokenAddress>
    if (u.hostname.includes('web3.okx.com')) {
      const idx = parts.indexOf('token');
      if (idx >= 0 && parts.length >= idx + 3) {
        const chain = parts[idx + 1];
        return {
          chain: chain === 'bnb' ? 'bsc' : chain.toLowerCase(),
          tokenAddress: parts[idx + 2],
          platform: 'okx',
        };
      }
    }

    // https://www.xxyy.io/<chain>/<address>
    if (u.hostname.includes('xxyy.io')) {
      if (parts.length >= 2) {
        return {
          chain: parts[0].toLowerCase(),
          tokenAddress: parts[1],
          platform: 'xxyy',
        };
      }
    }

    // https://debot.ai/token/<chain>/<address>
    if (u.hostname.includes('debot.ai')) {
      if (parts.length >= 3 && parts[0] === 'token') {
        const token = parts[2].indexOf("_") > 0 ? parts[2].split("_")[1] : parts[2]
        return {
          chain: parts[1].toLowerCase(),
          tokenAddress: token,
          platform: 'debot',
        };
      }
    }

    // https://dexscreener.com/<chain>/<address>
    if (u.hostname.includes('dexscreener.com')) {
      if (parts.length >= 2) {
        return {
          chain: parts[0].toLowerCase(),
          tokenAddress: parts[1],
          platform: 'dexscreener',
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

async function resolveMemeTokenAddress(chain: string, tokenAddress: string): Promise<string> {
  if (MEME_SUFFIXS.includes(tokenAddress.substring(tokenAddress.length - 4))) {
    return tokenAddress;
  }

  const poolPair = await TokenAPI.getPoolPair(chain, tokenAddress);
  if (!poolPair) return tokenAddress;

  if (MEME_SUFFIXS.includes(poolPair.token0.substring(poolPair.token0.length - 4))) {
    return poolPair.token0;
  }

  const bridgeAddrs = getBridgeTokenAddresses(getChainIdByName(chain));
  if (bridgeAddrs.find((addr) => addr.toLowerCase() === poolPair.token0.toLowerCase())) {
    return poolPair.token1;
  }

  return tokenAddress;
}

export async function parseCurrentUrlFull(href: string): Promise<SiteInfo | null> {
  try {
    const base = parseCurrentUrl(href);
    if (!base) return null;

    if (base.platform === 'axiom') {
      const tokenInfo = await AxiomAPI.getTokenInfo(base.chain, base.tokenAddress);
      if (!tokenInfo) return null;
      return {
        ...base,
        tokenAddress: tokenInfo.address,
      };
    }

    if (base.platform === 'xxyy' || base.platform === 'dexscreener') {
      const resolved = await resolveMemeTokenAddress(base.chain, base.tokenAddress);
      if (resolved === base.tokenAddress) return base;
      return {
        ...base,
        tokenAddress: resolved,
      };
    }

    return base;
  } catch (e) {
    console.error('Failed to parse URL', e);
    return null;
  }
}
