/**
 * GMGN API Class
 * Handles API calls to GMGN with proper authentication and headers
 */
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
  [key: string]: string;
}

export interface SwapOrderRequest {
  token_in_chain: string;
  token_out_chain: string;
  from_address: string;
  slippage: number;
  token_in_address: string;
  token_out_address: string;
  token_in_price: string;
  token_out_price: string;
  is_anti_mev: boolean;
  web_from_source: string;
  fee: number;
  tip_fee: string;
  priority_fee: string;
  auto_slippage: boolean;
  chain: string;
  retry_on_submit_failed: number;
  simulate_before_submit: boolean;
  input_token: string;
  output_token: string;
  priority_gas_price: string;
  gas_price: string;
  auto_approve_after_buy?: boolean;
  source: string;
  swap_mode: string;
  input_amount: string;
  max_priority_fee_per_gas: string;
  max_fee_per_gas: string;
}

export interface SwapOrderResponse {
  code: number;
  reason: string;
  message: string;
  data: {
    code: number;
    state: number;
    hash: string;
    order_id: string;
    error_code: string;
    error_status: string;
    confirmation: {
      state: string;
      detail: any;
    };
  };
}

export interface BuyOrderParams {
  tokenAddress: string;
  amount: string;
  slippage?: number;
  tokenPrice?: string;
  nativePrice?: string;
}

export interface SellOrderParams {
  tokenAddress: string;
  amount: string;
  slippage?: number;
  tokenPrice?: string;
  nativePrice?: string;
}

// Candlestick Query Parameters
export interface TokenCandlesParams {
  chain: string;
  tokenAddress: string;
  resolution?: string;
  limit?: number;
}

export interface DailyProfit {
  date: number;
  total_profit: string;
  total_buys: number;
  total_sells: number;
  total_transfer_ins: number;
  total_transfer_outs: number;
  buy_amount_usd: string;
  sell_amount_usd: string;
  transfer_in_amount_usd: string;
  transfer_out_amount_usd: string;
  win_sells: number;
  loss_sells: number;
  win_profit: string;
  loss_profit: string;
}

export interface DailyProfitResponse {
  code: number;
  message: string;
  data: {
    list: DailyProfit[];
  };
}

export interface DailyProfitParams {
  chain: string;
  wallet_addresses: string[];
  start_at: number;
  end_at: number;
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
  private static readonly SWAP_URL = 'https://gmgn.ai/mrtapi/v2';
  private static readonly SWAP_ENDPOINT = '/swap_batch_order';
  private static readonly CANDLES_BASE_URL = 'https://gmgn.ai/api/v1';
  private static readonly TOKEN_INFO_BASE_URL = 'https://gmgn.ai/mrwapi/v1';
  private static readonly HOLDINGS_BASE_URL = 'https://gmgn.ai/td/api/v1';
  private static readonly PROFIT_BASE_URL = 'https://gmgn.ai/pf/api/v1';

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

  public static async buyToken(params: BuyOrderParams): Promise<SwapOrderResponse> {
    const {
      tokenAddress,
      amount,
      slippage = 4,
      tokenPrice = '0',
      nativePrice = '1000'
    } = params;

    const chain = await this.getChain();
    const fromAddress = await this.getWalletAddress();

    const requestPayload: SwapOrderRequest = {
      token_in_chain: chain,
      token_out_chain: chain,
      from_address: fromAddress,
      slippage,
      token_in_address: '0x0000000000000000000000000000000000000000',
      token_out_address: tokenAddress,
      token_in_price: nativePrice,
      token_out_price: tokenPrice,
      is_anti_mev: false,
      web_from_source: 'one_click_submit',
      fee: 55000000,
      tip_fee: '0',
      priority_fee: '0',
      auto_slippage: true,
      chain,
      retry_on_submit_failed: 0,
      simulate_before_submit: false,
      input_token: '0x0000000000000000000000000000000000000000',
      output_token: tokenAddress,
      priority_gas_price: '0.0002',
      gas_price: '55000000',
      auto_approve_after_buy: false,
      source: 'swap_web',
      swap_mode: 'ExactIn',
      input_amount: amount,
      max_priority_fee_per_gas: '100000000',
      max_fee_per_gas: '100000000'
    };

    const url = await this.buildApiUrl(this.SWAP_ENDPOINT, {}, this.SWAP_URL);
    const headers = await this.getHeaders();

    const response = await this.makeRequest(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestPayload)
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return await response.json() as SwapOrderResponse;
  }

  public static async sellToken(params: SellOrderParams): Promise<SwapOrderResponse> {
    const {
      tokenAddress,
      amount,
      slippage = 4,
      tokenPrice = '0',
      nativePrice = '1000'
    } = params;

    const chain = await this.getChain();
    const fromAddress = await this.getWalletAddress();

    const requestPayload: SwapOrderRequest = {
      token_in_chain: chain,
      token_out_chain: chain,
      from_address: fromAddress,
      slippage,
      token_in_address: tokenAddress,
      token_out_address: '0x0000000000000000000000000000000000000000',
      token_in_price: tokenPrice,
      token_out_price: nativePrice,
      is_anti_mev: false,
      web_from_source: 'one_click_submit',
      fee: 1100000000,
      tip_fee: '0.0001',
      priority_fee: '0.0001',
      auto_slippage: true,
      chain,
      retry_on_submit_failed: 0,
      simulate_before_submit: false,
      input_token: tokenAddress,
      output_token: '0x0000000000000000000000000000000000000000',
      priority_gas_price: '0.0002',
      gas_price: '1100000000',
      source: 'swap_web',
      swap_mode: 'ExactIn',
      input_amount: amount,
      max_priority_fee_per_gas: '1100000000',
      max_fee_per_gas: '1100000000'
    };

    const url = await this.buildApiUrl(this.SWAP_ENDPOINT, {}, this.SWAP_URL);
    const headers = await this.getHeaders();

    const response = await this.makeRequest(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestPayload)
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return await response.json() as SwapOrderResponse;
  }

  public static async getOrderStatus(chain: string, orderId: string): Promise<SwapOrderResponse> {
    const queryParams = {
      order_id: orderId,
      chain,
      tgTrade: 'true'
    };

    const url = await this.buildApiUrl('/query_order', queryParams);
    const headers = await this.getHeaders();

    const response = await this.makeRequest(url, {
      method: 'GET',
      headers
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return await response.json() as SwapOrderResponse;
  }

  public static async getOrderStatusWithRetry(
    orderId: string,
    chain: string,
    maxRetries: number = 5,
    retryInterval: number = 500,
    timeout: number = 30000
  ): Promise<SwapOrderResponse> {
    const startTime = Date.now();
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (Date.now() - startTime > timeout) {
        throw new Error(`Order status check timeout after ${timeout}ms`);
      }

      try {
        const orderStatus = await this.getOrderStatus(chain, orderId);
        if (orderStatus.message === 'success' && orderStatus.data) {
          const { state, hash, error_code } = orderStatus.data;
          if (state === 20 || hash) {
            return orderStatus;
          }
          if (error_code && error_code !== '') {
            return orderStatus;
          }
        }
      } catch (error) {
        lastError = error as Error;
      }

      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, retryInterval));
      }
    }

    const errorMessage = `Failed to get order status for ${orderId} after ${maxRetries} attempts`;
    throw new Error(errorMessage + (lastError ? `: ${lastError.message}` : ''));
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
      token_address: tokenAddress.toLowerCase(),
      wallet_addresses: walletAddress.toLowerCase()
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

  public static async getDailyProfits(params: DailyProfitParams): Promise<DailyProfitResponse> {
    const { chain, wallet_addresses, start_at, end_at } = params;
    const endpoint = `/wallets/${chain}/daily_profits`;
    const url = await this.buildApiUrl(endpoint, {}, this.PROFIT_BASE_URL);
    const headers = await this.getHeaders();

    const payload = {
      wallet_addresses,
      start_at,
      end_at
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

      return await response.json() as DailyProfitResponse;
    } catch (error) {
      console.error('Failed to fetch daily profits:', error);
      throw error;
    }
  }
}

// Export the class directly
export default GmgnAPI;
