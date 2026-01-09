import { getQuoteTokenSymbol } from "@/constants/tokens";
import { getChainIdByName } from "@/constants/chains";

import { TokenInfo } from "@/types/token";

interface FlapCoinMetadata {
  description?: string;
  image?: string;
  buy?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
}

interface FlapCoin {
  name: string;
  address: string;
  symbol: string;
  creator: string;
  meta: string;
  merged: boolean;
  messagesCount: number;
  sequence: number | null;
  listed: boolean;
  tax: string;
  mode: number;
  r: string;
  h: string;
  k: string;
  version: number;
  dexThreshSupply: string;
  reserve: string;
  marketcap: string;
  supply: string;
  calldata: string;
  pool: string;
  createdAt: number;
  quoteToken: string;
  tweet: string | null;
  beneficiary: string | null;
  author?: {
    name: string | null;
    pfp: string | null;
  } | null;
  surrenderTo?: {
    address: string;
    name: string;
    symbol: string;
    metadata?: {
      image?: string;
      sell?: string;
    };
  } | null;
  metadata?: FlapCoinMetadata;
  posts: {
    duel: string | null;
    block: number;
    timestamp: number;
    author: string;
    target: string | null;
    content: string;
    tx: string | null;
    image: string | null;
    profile?: {
      address: string;
      name: string | null;
      pfp: string | null;
      bio: string | null;
    } | null;
  }[];
}

interface FlapTokenInfoResponse {
  data: {
    coin: FlapCoin | null;
  };
}

export class FlapAPI {
  private static readonly BASE_URL = "https://0pi75kmgw9.execute-api.eu-west-3.amazonaws.com/v1";

  private static async makeRequest(url: string, options: RequestInit): Promise<Response> {
    const headers = { ...options.headers } as Record<string, string>;

    if (options.method === "POST" && options.body) {
      headers["content-length"] = new Blob([options.body as string]).size.toString();
    }

    const requestOptions: RequestInit = {
      ...options,
      headers,
      credentials: "include",
      mode: "cors",
    };

    const response = await fetch(url, requestOptions);
    return response;
  }

  private static getHeaders(): HeadersInit {
    return {
      accept: "application/json, text/plain, */*",
      "accept-encoding": "gzip, deflate, br, zstd",
      "accept-language": "zh-CN,zh;q=0.9,ru;q=0.8",
      "content-type": "application/json",
    };
  }

  private static buildQuery(): string {
    return `
      query Coin($address:String) {
        coin(address: $address) {
          name
          address
          symbol
          creator
          meta
          merged
          messagesCount
          sequence
          listed
          tax
          mode
          r(round: 3)
          h(round: 3)
          k(round: 3)
          version
          dexThreshSupply
          reserve(round: 18)
          marketcap(round: 18)
          supply(round: 18)
          calldata
          pool
          createdAt
          quoteToken
          tweet
          beneficiary
          author {
            name
            pfp
          }
          surrenderTo {
            address
            name
            symbol
            metadata {
              image
              sell
            }
          }
          metadata {
            description
            image
            buy
            website
            twitter
            telegram
          }
          posts {
            duel
            block
            timestamp
            author
            target
            content
            tx
            image
            profile {
              address
              name
              pfp
              bio
            }
          }
        }
      }
    `;
  }

  public static async getTokenInfo(chain: string, address: string): Promise<TokenInfo | null> {
    const query = this.buildQuery();

    const payload = {
      query,
      variables: {
        address: address.toLowerCase(),
        ticks: 60,
        interval: 3600000,
      },
    };

    try {
      const headers = this.getHeaders();
      const response = await this.makeRequest(this.BASE_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = (await response.json()) as FlapTokenInfoResponse;
      const coin = result.data?.coin;

      if (!coin) {
        return null;
      }

      const chainNormalized = (chain || "bsc").toLowerCase();
      const metadata = coin.metadata || {};
      const logo = metadata.image || "";
      const zeroAddress = "0x0000000000000000000000000000000000000000";

      let launchpadProgress = 0;
      const supply = Number(coin.supply);
      const dexThreshSupply = Number(coin.dexThreshSupply);
      if (Number.isFinite(supply) && Number.isFinite(dexThreshSupply) && dexThreshSupply > 0) {
        launchpadProgress = Math.min(1, supply / dexThreshSupply);
      }

      const quoteTokenAddress = coin.quoteToken && coin.quoteToken.toLowerCase() !== zeroAddress.toLowerCase()
        ? coin.quoteToken
        : undefined;

      let quoteTokenSymbol = "BNB";
      if (quoteTokenAddress) {
        quoteTokenSymbol = getQuoteTokenSymbol(getChainIdByName(chainNormalized), quoteTokenAddress);
        if (quoteTokenSymbol === 'UNKNOWN' || quoteTokenSymbol === 'WBNB') {
          quoteTokenSymbol = 'BNB';
        }
      }

      const launchpadStatus = coin.listed ? 1 : 0;

      const tokenInfo: TokenInfo = {
        chain: chainNormalized,
        address: coin.address,
        name: coin.name,
        symbol: coin.symbol,
        decimals: 18,
        logo,
        launchpad: "flap",
        launchpad_progress: launchpadProgress,
        launchpad_platform: "flap",
        launchpad_status: launchpadStatus,
        quote_token: quoteTokenSymbol,
        quote_token_address: quoteTokenAddress,
        pool_pair: coin.pool,
        dex_type: "PANCAKE_SWAP",
      };

      return tokenInfo;
    } catch (error) {
      console.error("Failed to fetch token info from Flap:", error);
      return null;
    }
  }
}

export default FlapAPI;
