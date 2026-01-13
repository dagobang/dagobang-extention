/**
 * GMGN API Class
 * Handles API calls to GMGN with proper authentication and headers
 */
import { TokenAPI } from "#imports";
import { TokenStat, TokenInfo } from "@/types/token";
import { zeroAddress } from "viem";


export interface MultiTokenInfoResponse {
  code: number;
  reason: string;
  message: string;
  data: Array<{
    chain: string;
    address: string;
    symbol: string;
    name: string;
    logo: string;
    decimals: number;
    launchpad: string;
    launchpad_progress: number;
    launchpad_status: number;
    launchpad_platform: string;
    migration_market_cap_quote: string;
    [key: string]: any;
  }>;
}

interface TokenHolding {
  chain_wallet: string;
  token_address: string;
  wallet_address: string;
  balance: string;
  price: string;
  [key: string]: any;
}

interface TokenHoldingsResponse {
  code: number;
  reason: string;
  message: string;
  data: {
    holdings: TokenHolding[];
  };
}

interface WalletBalance {
  chain_wallet: string;
  token_address: string;
  wallet_address: string;
  balance: string;
  decimals: number;
  height: number;
  tx_index: number;
  timestamp: number;
}

interface WalletBalancesResponse {
  code: number;
  reason: string;
  message: string;
  data: {
    balances: WalletBalance[];
  };
}

// Candlestick Data Interface
export interface TokenCandle {
  time: number;
  open: string;
  close: string;
  high: string;
  low: string;
  volume: string;
  source: string;
  amount: string;
}

export interface TokenCandlesResponse {
  code: number;
  reason: string;
  message: string;
  data: {
    list: TokenCandle[];
  };
}

// URL Parameters Interface
export interface ApiUrlParams {
  web_from_source: string;
  device_id: string;
  fp_did: string;
  client_id: string;
  from_app: string;
  app_ver: string;
  tz_name: string;
  tz_offset: string;
  app_lang: string;
  os: string;
  [key: string]: string; // Index signature for URLSearchParams compatibility
}

// Candlestick Query Parameters
export interface TokenCandlesParams {
  chain: string;
  tokenAddress: string;
  resolution?: string;
  limit?: number;
}

/**
 * Auto-extract GMGN authentication data when page loads
 */
export const extractGmgnAuthData = () => {
  try {
    // Only run on GMGN pages
    if (!window.location.hostname.includes('gmgn.ai')) {
      return;
    }

    const authData = {
      tgInfo: localStorage.getItem('tgInfo'),
      chain: localStorage.getItem('selected_chain'),
      deviceId: localStorage.getItem('key_device_id'),
      fpDid: localStorage.getItem('key_fp_did'),
      cookies: document.cookie,
      lastUpdated: Date.now()
    };

    return authData;
  } catch (error) {
    console.error('❌ Error extracting GMGN auth data:', error);
  }
};

/**
 * GMGN API Class
 * Handles API calls to GMGN with proper authentication and headers
 * Call on content script
 */
export class GmgnAPI {
  private static readonly BASE_URL = 'https://gmgn.ai/tapi/v1';
  private static readonly CANDLES_BASE_URL = 'https://gmgn.ai/api/v1';
  private static readonly TOKEN_INFO_BASE_URL = 'https://gmgn.ai/mrwapi/v1';
  private static readonly HOLDINGS_BASE_URL = 'https://gmgn.ai/td/api/v1';

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

  static async getChain(): Promise<string> {
    try {
      const result = await window.localStorage.getItem('selected_chain');
      return (result as string) || '';
    } catch (e) {
      return '';
    }
  }

  static async getWalletAddress(): Promise<string> {
    try {
      const chain = await this.getChain();
      const tgInfoStr = await window.localStorage.getItem('tgInfo');
      const tgInfo = JSON.parse(tgInfoStr || '{}');
      const addr = tgInfo[`${chain}_address`] || '';
      return addr;
    } catch (e) {
      return '';
    }
  }

  /**
   * Get cookies from chrome.storage
   * @returns Promise<string> - Cookie string
   */
  static async getCookies(): Promise<string> {
    try {
      const result = await window.localStorage.getItem('gmgn_cookies');
      return (result as string) || '';
    } catch (e) {
      return '';
    }
  }

  /**
   * Get authentication token from chrome.storage
   * @returns Promise<string> - Authentication token
   */
  static async getAuthToken(): Promise<string> {
    try {
      const tgInfoStr = await window.localStorage.getItem('tgInfo');
      const tgInfo = JSON.parse(tgInfoStr || '{}');
      return tgInfo.token?.access_token || '';
    } catch (e) {
      return '';
    }
  }

  /**
   * Get storage parameters from chrome.storage
   * @returns Promise<Partial<ApiUrlParams>> - Storage parameters
   */
  static async getStorageParams(): Promise<Partial<ApiUrlParams>> {
    try {
      return {
        device_id: window.localStorage.getItem('key_device_id') ?? '',
        fp_did: window.localStorage.getItem('key_fp_did') ?? '',
      };
    } catch (e) {
      return {
        device_id: '',
        fp_did: ''
      };
    }
  }

  /**
   * Get common request headers with all required headers for GMGN API
   */
  private static async getHeaders(): Promise<HeadersInit> {
    const cookies = await this.getCookies();
    const authToken = await this.getAuthToken();

    return {
      'accept': 'application/json, text/plain, */*',
      'accept-encoding': 'gzip, deflate, br, zstd',
      'accept-language': 'zh-CN,zh;q=0.9,ru;q=0.8',
      'authorization': authToken ? `Bearer ${authToken}` : '',
      'baggage': 'sentry-environment=production,sentry-release=20260110-9749-5a2a7f8,sentry-public_key=93c25bab7246077dc3eb85b59d6e7d40,sentry-trace_id=db9ecf0cd593448192de7e1ab1f26d77,sentry-sample_rate=0.01,sentry-sampled=false',
      'content-type': 'application/json',
      'cookie': cookies,
      'origin': 'https://gmgn.ai',
      'referer': 'https://gmgn.ai/',
      'sec-ch-ua': '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': 'Windows',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
    };
  }

  /**
   * Build API URL with required parameters
   * @param endpoint API endpoint path
   * @param params Additional URL parameters
   * @param baseUrl Optional base URL, defaults to BASE_URL
   * @returns Promise<string> Complete API URL with parameters
   */
  private static async buildApiUrl(
    endpoint: string,
    params: Partial<ApiUrlParams> = {},
    baseUrl: string = this.BASE_URL
  ): Promise<string> {
    const storageParams = await this.getStorageParams();
    console.log('storageParams', JSON.stringify(storageParams));
    const defaultParams: ApiUrlParams = {
      web_from_source: 'one_click_submit',
      device_id: storageParams.device_id!,
      fp_did: storageParams.fp_did!,
      client_id: 'gmgn_web_20260110-9749-5a2a7f8',
      from_app: 'gmgn',
      app_ver: '20260110-9749-5a2a7f8',
      tz_name: 'Asia/Shanghai',
      tz_offset: '28800',
      app_lang: 'en-US',
      os: 'web',
      ...params
    };

    const urlParams = new URLSearchParams(defaultParams);
    return `${baseUrl}${endpoint}?${urlParams.toString()}`;
  }

  /**
   * Get token candlestick data
   * @param params Candlestick query parameters
   * @returns Promise<TokenCandlesResponse> Candlestick data response
   */
  public static async getTokenCandles(params: TokenCandlesParams): Promise<TokenCandlesResponse> {
    const { chain, tokenAddress, resolution = '1m', limit = 1 } = params;
    const endpoint = `/token_candles/${chain}/${tokenAddress}`;
    const queryParams = { resolution, limit: limit.toString() };

    const url = await this.buildApiUrl(endpoint, queryParams, this.CANDLES_BASE_URL);
    const headers = await this.getHeaders();

    try {
      const response = await this.makeRequest(url, {
        method: 'GET',
        headers
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      return await response.json() as TokenCandlesResponse;
    } catch (error) {
      console.error('Failed to fetch candlestick data:', error);
      throw error;
    }
  }

  public static async getTokenPrice(chain: string, token: string): Promise<TokenStat | undefined> {
    const params = {
      chain,
      tokenAddress: token,
      resolution: '1m',
      limit: 1
    };
    const response = await this.getTokenCandles(params);
    if (!response.data.list || response.data.list.length === 0) {
      console.error('Failed to fetch getTokenPrice data:', response);
      return undefined;
    }
    return {
      chain,
      token,
      price: Number(response.data.list[0].close),
      timestamp: response.data.list[0].time
    }
  }

  /**
   * Get token information
   * @param chain Blockchain chain
   * @param address Token address
   */
  public static async getTokenInfo(chain: string, address: string): Promise<TokenInfo | null> {
    const endpoint = '/multi_token_info';
    const url = await this.buildApiUrl(endpoint, {}, this.TOKEN_INFO_BASE_URL);
    const headers = await this.getHeaders();

    const payload = {
      chain,
      addresses: [address]
    };

    try {
      const response = await this.makeRequest(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json() as MultiTokenInfoResponse;
      if (result.code === 0 && result.data && result.data.length > 0) {
        const tokenData = result.data[0];
        const info = {
          chain: tokenData.chain,
          address: tokenData.address,
          name: tokenData.name,
          symbol: tokenData.symbol,
          decimals: tokenData.decimals,
          logo: tokenData.logo,
          launchpad: tokenData.launchpad,
          launchpad_progress: tokenData.launchpad_progress,
          launchpad_platform: tokenData.launchpad_platform,
          launchpad_status: tokenData.launchpad_status,
          quote_token: tokenData.migration_market_cap_quote,
          // quote_token_address is not returned by the API
          quote_token_address: zeroAddress,
          pool_pair: tokenData.biggest_pool_address,
        };

        return info;
      }
      return null;
    } catch (error) {
      console.error('Failed to fetch token info:', error);
      throw error;
    }
  }

  /**
   * Get token holding for a wallet
   * @param chain Blockchain chain
   * @param tokenAddress Token address
   * @returns Promise<string | undefined> Token balance or undefined if not found
   */
  public static async getTokenHolding(chain: string, walletAddress: string, tokenAddress: string): Promise<string | undefined> {
    if (!walletAddress) {
      return undefined;
    }

    const endpoint = '/wallets/holding';
    const queryParams = {
      worker: '0',
      chain,
      token_address: tokenAddress,
      wallet_addresses: walletAddress
    };

    const url = await this.buildApiUrl(endpoint, queryParams, this.HOLDINGS_BASE_URL);
    const headers = await this.getHeaders();

    try {
      const response = await this.makeRequest(url, {
        method: 'GET',
        headers
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json() as TokenHoldingsResponse;
      if (
        result.code === 0 &&
        result.data &&
        Array.isArray(result.data.holdings) &&
        result.data.holdings.length > 0
      ) {
        return result.data.holdings[0].balance;
      }

      console.error('Failed to fetch token holding data:', result);
      return undefined;
    } catch (error) {
      console.error('Failed to fetch token holding:', error);
      throw error;
    }
  }

  public static async getBalance(chain: string, walletAddress: string, tokenAddress: string): Promise<string | undefined> {
    if (!walletAddress) {
      return undefined;
    }

    const endpoint = '/wallets/balances';
    const queryParams = {
      worker: '0',
      chain,
      token_address: tokenAddress,
      wallet_addresses: walletAddress
    };

    const url = await this.buildApiUrl(endpoint, queryParams, this.HOLDINGS_BASE_URL);
    const headers = await this.getHeaders();

    try {
      const response = await this.makeRequest(url, {
        method: 'GET',
        headers
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json() as WalletBalancesResponse;
      if (
        result.code === 0 &&
        result.data &&
        Array.isArray(result.data.balances) &&
        result.data.balances.length > 0
      ) {
        return result.data.balances[0].balance;
      }

      console.error('Failed to fetch wallet balance data:', result);
      return undefined;
    } catch (error) {
      console.error('Failed to fetch wallet balance:', error);
      throw error;
    }
  }
}

// Export the class directly
export default GmgnAPI;
