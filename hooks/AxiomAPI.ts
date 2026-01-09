import { getAxiomLaunchpad } from "@/constants/launchpad";
import { TokenInfo } from "@/types/token";

// Axiom API Response Interface
export interface AxiomPairInfoResponse {
  status: string;
  data: {
    pairAddress: string;
    factory: string;
    token0: string;
    token1: string;
    fee: number;
    pairCreatedBlockHash: string;
    pairCreatedBlockNumber: number;
    protocol: string;
    pairCreatedAt: string;
    pairFinalizedAt: string;
    openTrading: string;
    initialLiquidityToken: string;
    initialLiquidityQuote: string;
    initialLiquidityUsd: string | null;
    initialLiquidityBnb: string | null;
    tokenAddress: string;
    quoteTokenAddress: string;
    creator: string;
    decimals: number;
    tokenCreatedBlockHash: string;
    tokenName: string;
    tokenTicker: string;
    uri: string | null;
    tokenImage: string;
    tokenCreatedAt: string;
    tokenFinalizedAt: string;
    website: string | null;
    twitter: string | null;
    telegram: string | null;
    discord: string | null;
    mintAuthority: string | null;
    freezeAuthority: string | null;
    supply: string;
    extra: any;
    dexPaid: boolean;
  };
}

export class AxiomAPI {
  private static readonly BASE_URL_BNB = 'https://api2-bnb.axiom.trade';

  /**
   * Make HTTP request using fetch API with proper headers
   */
  private static async makeRequest(url: string, options: RequestInit): Promise<Response> {
    // Calculate content-length for POST requests
    const headers = { ...options.headers } as Record<string, string>;

    if (options.method === 'POST' && options.body) {
      headers['content-length'] = new Blob([options.body as string]).size.toString();
    }

    const requestOptions: RequestInit = {
      ...options,
      headers,
      // Ensure credentials are included for authentication
      credentials: 'include',
      // Set mode to 'cors' explicitly
      mode: 'cors'
    };

    try {
      const response = await fetch(url, requestOptions);
      return response;
    } catch (error) {
      console.error('Request failed:', error);
      throw error;
    }
  }

  /**
   * Get common request headers
   */
  private static getHeaders(): HeadersInit {
    return {
      'accept': 'application/json, text/plain, */*',
      'accept-encoding': 'gzip, deflate, br, zstd',
      'accept-language': 'zh-CN,zh;q=0.9,ru;q=0.8',

      'content-type': 'application/json',
      'cookie': document.cookie,
      'origin': 'https://axiom.trade',
      'referer': 'https://axiom.trade/',
      'sec-ch-ua': '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': 'Windows',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
    }
  }

  /**
   * Helper to determine quote token symbol from address
   */
  private static getQuoteTokenSymbol(address: string): string {
    const addr = address.toLowerCase();
    if (addr === '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c') return 'BNB'; // WBNB
    if (addr === '0x55d398326f99059ff775485246999027b3197955') return 'USDT'; // BSC-USD
    return 'UNKNOWN';
  }

  /**
   * Get token information
   * @param chain Blockchain chain (currently only supports 'bsc'/'bnb')
   * @param address Token address
   */
  public static async getTokenInfo(chain: string, address: string): Promise<TokenInfo | null> {
    // Currently only supporting BSC/BNB based on provided examples
    if (chain.toLowerCase() !== 'bsc' && chain.toLowerCase() !== 'bnb') {
      console.warn(`AxiomAPI: Chain ${chain} not supported`);
      return null;
    }

    const endpoint = '/pair-info';
    const params = new URLSearchParams({
      pairAddress: address // Using token address as pair address based on examples
    });

    const url = `${this.BASE_URL_BNB}${endpoint}?${params.toString()}`;

    try {
      const headers = this.getHeaders();
      const response = await this.makeRequest(url, {
        method: 'GET',
        headers
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json() as AxiomPairInfoResponse;

      if (result.status === 'Success' && result.data) {
        const data = result.data;
        const quoteTokenSymbol = this.getQuoteTokenSymbol(data.quoteTokenAddress);

        const platform = getAxiomLaunchpad(data);
        console.log('axiom data', data);
        return {
          chain: 'bsc',
          address: data.tokenAddress,
          name: data.tokenName,
          symbol: data.tokenTicker,
          decimals: data.decimals,
          logo: data.tokenImage,
          launchpad: platform,
          launchpad_progress: 0, // Not available in Axiom response
          launchpad_platform: platform,
          launchpad_status: (data.extra?.migratedFrom || data.extra?.migratedTo) ? 1 : 0,
          quote_token: quoteTokenSymbol,
          quote_token_address: data.quoteTokenAddress,
          pool_pair: data.pairAddress,
        };
      }

      return null;
    } catch (error) {
      console.error('Failed to fetch token info from Axiom:', error);
      // Fallback or rethrow depending on requirements. For now, returning null to be safe.
      return null;
    }
  }
}

export default AxiomAPI;
