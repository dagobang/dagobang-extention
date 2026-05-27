/**
 * GMGN API Class
 * Handles API calls to GMGN with proper authentication and headers
 */
import { PancakeFactoryV2, PancakeFactoryV3 } from "@/constants/contracts/address";
import { TokenStat, TokenInfo } from "@/types/token";
import { parseUnits } from "viem";
import { getSettings } from "@/services/storage";


export interface MultiTokenInfoResponse {
  code: number;
  reason: string;
  message: string;
  data: Array<{
    chain?: string;
    address: string;
    symbol: string;
    name: string;
    logo: string;
    decimals: number;
    launchpad?: string;
    launchpad_progress?: number;
    launchpad_status?: number;
    launchpad_platform?: string;
    migration_market_cap_quote?: string;
    biggest_pool_address?: string;
    pool?: {
      pool_address?: string;
      quote_address?: string;
      quote_symbol?: string;
      exchange?: string;
    };
    tpool?: {
      base_address: string; // tokenAddress
      exchange: string; // dex (pancake factory v2/v3), Curve
      launch_type: string; //  migrated, launching
      pool_address: string;
      quote_address: string;
    };
    [key: string]: any;
  }>;
}

export interface GmgnSearchTokenItem {
  chain?: string;
  address?: string;
  symbol?: string;
  name?: string;
  logo?: string;
  token_link?: {
    gmgn?: string;
    [key: string]: any;
  };
  [key: string]: any;
}

interface GmgnSearchResponse {
  code: number;
  reason?: string;
  message?: string;
  data?: GmgnSearchTokenItem[] | {
    list?: GmgnSearchTokenItem[];
    [key: string]: any;
  };
}

interface GmgnTokenLinkResponse {
  code: number;
  reason: string;
  message: string;
  data?: {
    address?: string;
    link?: {
      address?: string;
      gmgn?: string;
      geckoterminal?: string;
      twitter_username?: string;
      twitter?: string;
      twitter_url?: string;
      website?: string;
      telegram?: string;
      discord?: string;
      github?: string;
      youtube?: string;
      medium?: string;
      reddit?: string;
      linkedin?: string;
      instagram?: string;
      facebook?: string;
      tiktok?: string;
      bitbucket?: string;
      farcaster?: string | null;
      fracaster?: string | null;
      description?: string;
      [key: string]: any;
    } | null;
    [key: string]: any;
  } | null;
}

export interface GmgnTokenHolding {
  chain_wallet?: string;
  token_address: string;
  wallet_address?: string;
  symbol?: string;
  token_symbol?: string;
  balance: string;
  price?: string;
  usd_value?: string;
  total_profit?: string;
  unrealized_profit?: string;
  realized_profit?: string;
  total_profit_pnl?: string | null;
  unrealized_profit_pnl?: string | null;
  accu_amount?: string;
  accu_cost?: string;
  bought_cost?: string;
  sold_income?: string;
  history_bought_cost?: string;
  history_sold_income?: string;
  history_realized_profit?: string;
  history_bought_amount?: string;
  token_basic_stats?: {
    chain?: string;
    address?: string;
    name?: string;
    symbol?: string;
    decimals?: number;
    logo?: string;
    liquidity?: number | string;
    total_supply?: string;
    launchpad?: string;
    launchpad_platform?: string;
    [key: string]: any;
  };
  token?: {
    token_address?: string;
    symbol?: string;
    name?: string;
    decimals?: number;
    price?: string;
  };
  [key: string]: any;
}

interface TokenHoldingsResponse {
  code: number;
  reason: string;
  message: string;
  data?: any;
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

interface TdWalletsHoldingResponse {
  code: number;
  reason: string;
  message: string;
  data?: {
    holdings?: any[];
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
  gasGwei?: string;
}

export interface SellOrderParams {
  tokenAddress: string;
  amount: string;
  slippage?: number;
  tokenPrice?: string;
  nativePrice?: string;
  gasGwei?: string;
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

export interface TokenHoldingDetail {
  balance: string;
  usd_value: string;
  accu_amount: string;
  accu_cost: string;
  accu_fee: string;
  history_bought_amount: string;
  history_bought_cost: string;
  history_bought_fee: string;
  history_transfer_in_amount: string;
  history_transfer_in_cost: string;
  history_sold_amount: string;
  history_sold_income: string;
  history_sold_fee: string;
  history_transfer_out_amount: string;
  history_transfer_out_income: string;
  history_transfer_out_fee: string;
  history_total_buys: number;
  history_total_sells: number;
  history_total_transfer_ins: number;
  history_total_transfer_outs: number;
  realized_profit: string;
  realized_profit_pnl: string | null;
  unrealized_profit: string;
  unrealized_profit_pnl: string | null;
  total_profit: string;
  total_profit_pnl: string | null;
  start_holding_at: number | null;
  end_holding_at: number | null;
  last_active_timestamp: number | null;
  token: {
    token_address: string;
    symbol: string;
    name: string;
    decimals: number;
    logo?: string;
    creation_timestamp?: number;
    open_timestamp?: number;
    is_honeypot?: boolean;
    price?: string;
    total_supply?: string;
    max_supply?: string;
    liquidity?: string;
    launchpad?: string;
    launchpad_platform?: string;
  };
}

export interface TokenHoldingDetailResponse {
  code: number;
  reason: string;
  message: string;
  data: TokenHoldingDetail;
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
  private static readonly SEARCH_BASE_URL = 'https://gmgn.ai/vas/api/v1';

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

  private static async buildApiUrlWithArrayParams(
    endpoint: string,
    params: Record<string, string | number | boolean | undefined>,
    arrayParams: Record<string, string[]>,
    baseUrl: string = this.BASE_URL
  ): Promise<string> {
    const storageParams = await this.getStorageParams();
    const defaultParams: Record<string, string> = {
      web_from_source: 'one_click_submit',
      device_id: storageParams.device_id || '',
      fp_did: storageParams.fp_did || '',
      client_id: 'gmgn_web_20260110-9749-5a2a7f8',
      from_app: 'gmgn',
      app_ver: '20260110-9749-5a2a7f8',
      tz_name: 'Asia/Shanghai',
      tz_offset: '28800',
      app_lang: 'en-US',
      os: 'web',
    };
    const search = new URLSearchParams(defaultParams);
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      search.set(key, String(value));
    });
    Object.entries(arrayParams).forEach(([key, values]) => {
      values.forEach((value) => {
        if (!value) return;
        search.append(key, value);
      });
    });
    return `${baseUrl}${endpoint}?${search.toString()}`;
  }

  private static async resolveGasGwei(side: 'buy' | 'sell', overrideGasGwei?: string): Promise<string> {
    const fallback = { slow: '0.06', standard: '0.12', fast: '1', turbo: '5' } as const;
    const fromOverride = typeof overrideGasGwei === 'string' ? overrideGasGwei.trim() : '';
    if (fromOverride && Number(fromOverride) > 0) return fromOverride;
    try {
      const settings = await getSettings();
      const chainSettings = settings?.chains?.[settings?.chainId ?? 56];
      const preset = side === 'buy'
        ? (chainSettings?.buyGasPreset ?? chainSettings?.gasPreset ?? 'standard')
        : (chainSettings?.sellGasPreset ?? chainSettings?.gasPreset ?? 'standard');
      const gasConfig = side === 'buy' ? chainSettings?.buyGasGwei : chainSettings?.sellGasGwei;
      const presetValue = preset === 'slow'
        ? gasConfig?.slow
        : preset === 'fast'
          ? gasConfig?.fast
          : preset === 'turbo'
            ? gasConfig?.turbo
            : gasConfig?.standard;
      const normalized = typeof presetValue === 'string' ? presetValue.trim() : '';
      if (normalized && Number(normalized) > 0) return normalized;
    } catch {
    }
    return fallback.standard;
  }

  public static async buyToken(params: BuyOrderParams): Promise<SwapOrderResponse> {
    const {
      tokenAddress,
      amount,
      slippage = 4,
      tokenPrice = '0',
      nativePrice = '1000',
      gasGwei,
    } = params;
    const effectiveGasGwei = await this.resolveGasGwei('buy', gasGwei);
    const gasWei = parseUnits(effectiveGasGwei, 9).toString();

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
      priority_gas_price: effectiveGasGwei,
      gas_price: gasWei,
      auto_approve_after_buy: false,
      source: 'swap_web',
      swap_mode: 'ExactIn',
      input_amount: amount,
      max_priority_fee_per_gas: gasWei,
      max_fee_per_gas: gasWei
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
      nativePrice = '1000',
      gasGwei,
    } = params;
    const effectiveGasGwei = await this.resolveGasGwei('sell', gasGwei);
    const gasWei = parseUnits(effectiveGasGwei, 9).toString();

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
      priority_gas_price: effectiveGasGwei,
      gas_price: gasWei,
      source: 'swap_web',
      swap_mode: 'ExactIn',
      input_amount: amount,
      max_priority_fee_per_gas: gasWei,
      max_fee_per_gas: gasWei
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

  public static async searchTokens(query: string): Promise<GmgnSearchTokenItem[]> {
    const q = String(query || '').trim();
    if (!q) return [];
    const endpoint = '/search_v3';
    const queryParams = {
      worker: '0',
      q,
    };
    const url = await this.buildApiUrl(endpoint, queryParams, this.SEARCH_BASE_URL);
    const headers = await this.getHeaders();
    try {
      const response = await this.makeRequest(url, {
        method: 'GET',
        headers,
      });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const result = await response.json() as GmgnSearchResponse;
      if (result.code !== 0 || !result.data) return [];
      if (Array.isArray(result.data)) return result.data;
      if (Array.isArray(result.data.list)) return result.data.list;
      // Some search responses return grouped object payloads (e.g. { token: [], pair: [] }).
      if (typeof result.data === 'object') {
        const merged = Object.values(result.data)
          .filter((v) => Array.isArray(v))
          .flat() as GmgnSearchTokenItem[];
        return merged;
      }
      return [];
    } catch (error) {
      console.error('Failed to search tokens from GMGN:', error);
      throw error;
    }
  }

  /**
   * Get token information
   * @param chain Blockchain chain
   * @param address Token address
   */
  public static async getTokenInfo(chain: string, address: string): Promise<TokenInfo | null> {
    // try {
    //   const latest = await this.fetchTokenInfoByEndpoint(
    //     '/mutil_window_token_info',
    //     this.CANDLES_BASE_URL,
    //     chain,
    //     address
    //   );
    //   if (latest) return latest;
    // } catch (error) {
    //   console.warn('mutil_window_token_info failed, fallback to multi_token_info:', error);
    // }

    try {
      const [tokenInfo, linkInfo] = await Promise.all([
        this.fetchTokenInfoByEndpoint(
        '/multi_token_info',
        this.TOKEN_INFO_BASE_URL,
        chain,
        address
        ),
        this.fetchTokenLinkInfo(chain, address).catch((error) => {
          console.warn('Failed to fetch GMGN token link info:', error);
          return null;
        }),
      ]);
      if (!tokenInfo) return null;
      return {
        ...tokenInfo,
        description: linkInfo?.description || tokenInfo.description,
        website: linkInfo?.website || tokenInfo.website,
        gmgnUrl: linkInfo?.gmgnUrl || tokenInfo.gmgnUrl,
        geckoTerminalUrl: linkInfo?.geckoTerminalUrl || tokenInfo.geckoTerminalUrl,
        twitterUrl: linkInfo?.twitterUrl || tokenInfo.twitterUrl,
        telegramUrl: linkInfo?.telegramUrl || tokenInfo.telegramUrl,
        discordUrl: linkInfo?.discordUrl || tokenInfo.discordUrl,
        githubUrl: linkInfo?.githubUrl || tokenInfo.githubUrl,
        youtubeUrl: linkInfo?.youtubeUrl || tokenInfo.youtubeUrl,
        mediumUrl: linkInfo?.mediumUrl || tokenInfo.mediumUrl,
        redditUrl: linkInfo?.redditUrl || tokenInfo.redditUrl,
        linkedinUrl: linkInfo?.linkedinUrl || tokenInfo.linkedinUrl,
        instagramUrl: linkInfo?.instagramUrl || tokenInfo.instagramUrl,
        facebookUrl: linkInfo?.facebookUrl || tokenInfo.facebookUrl,
        tiktokUrl: linkInfo?.tiktokUrl || tokenInfo.tiktokUrl,
        bitbucketUrl: linkInfo?.bitbucketUrl || tokenInfo.bitbucketUrl,
        farcasterUrl: linkInfo?.farcasterUrl || tokenInfo.farcasterUrl,
      };
    } catch (error) {
      console.error('Failed to fetch token info from fallback endpoint:', error);
      throw error;
    }
  }

  private static async fetchTokenLinkInfo(
    chain: string,
    address: string
  ): Promise<Pick<
    TokenInfo,
    | 'description'
    | 'website'
    | 'gmgnUrl'
    | 'geckoTerminalUrl'
    | 'twitterUrl'
    | 'telegramUrl'
    | 'discordUrl'
    | 'githubUrl'
    | 'youtubeUrl'
    | 'mediumUrl'
    | 'redditUrl'
    | 'linkedinUrl'
    | 'instagramUrl'
    | 'facebookUrl'
    | 'tiktokUrl'
    | 'bitbucketUrl'
    | 'farcasterUrl'
  > | null> {
    const endpoint = `/mutil_window_token_link_rug_vote/${String(chain || '').toLowerCase()}/${address}`;
    const url = await this.buildApiUrl(endpoint, { worker: '0' }, this.CANDLES_BASE_URL);
    const headers = await this.getHeaders();
    const response = await this.makeRequest(url, {
      method: 'GET',
      headers,
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const result = await response.json() as GmgnTokenLinkResponse;
    const link = result?.code === 0 ? result.data?.link : null;
    if (!link) return null;
    return {
      description: this.pickFirstString(link.description),
      gmgnUrl: this.normalizeExternalLink(this.pickFirstString(link.gmgn), 'generic'),
      geckoTerminalUrl: this.normalizeExternalLink(this.pickFirstString(link.geckoterminal), 'generic'),
      website: this.normalizeExternalLink(this.pickFirstString(link.website), 'website'),
      twitterUrl: this.normalizeExternalLink(
        this.pickFirstString(link.twitter_username, link.twitter_url, link.twitter),
        'twitter'
      ),
      telegramUrl: this.normalizeExternalLink(
        this.pickFirstString(link.telegram, link.telegram_url, link.tg),
        'telegram'
      ),
      discordUrl: this.normalizeExternalLink(this.pickFirstString(link.discord), 'generic'),
      githubUrl: this.normalizeExternalLink(this.pickFirstString(link.github), 'generic'),
      youtubeUrl: this.normalizeExternalLink(this.pickFirstString(link.youtube), 'generic'),
      mediumUrl: this.normalizeExternalLink(this.pickFirstString(link.medium), 'generic'),
      redditUrl: this.normalizeExternalLink(this.pickFirstString(link.reddit), 'generic'),
      linkedinUrl: this.normalizeExternalLink(this.pickFirstString(link.linkedin), 'generic'),
      instagramUrl: this.normalizeExternalLink(this.pickFirstString(link.instagram), 'generic'),
      facebookUrl: this.normalizeExternalLink(this.pickFirstString(link.facebook), 'generic'),
      tiktokUrl: this.normalizeExternalLink(this.pickFirstString(link.tiktok), 'generic'),
      bitbucketUrl: this.normalizeExternalLink(this.pickFirstString(link.bitbucket), 'generic'),
      farcasterUrl: this.normalizeExternalLink(
        this.pickFirstString(link.farcaster, link.fracaster),
        'generic'
      ),
    };
  }

  private static async fetchTokenInfoByEndpoint(
    endpoint: string,
    baseUrl: string,
    chain: string,
    address: string
  ): Promise<TokenInfo | null> {
    const extraParams = endpoint === '/mutil_window_token_info' ? { worker: '0' } : {};
    const url = await this.buildApiUrl(endpoint, extraParams, baseUrl);
    const headers = await this.getHeaders();
    const payload = {
      chain,
      addresses: [address]
    };

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
      return this.normalizeTokenInfo(result.data[0], chain);
    }
    return null;
  }

  private static pickFirstString(...values: unknown[]): string | undefined {
    for (const value of values) {
      const text = typeof value === 'string' ? value.trim() : '';
      if (text) return text;
    }
    return undefined;
  }

  private static pickFromContainers(
    containers: Array<Record<string, any> | null | undefined>,
    keys: string[]
  ): string | undefined {
    for (const container of containers) {
      if (!container || typeof container !== 'object') continue;
      for (const key of keys) {
        const value = this.pickFirstString(container[key]);
        if (value) return value;
      }
    }
    return undefined;
  }

  private static normalizeExternalLink(
    value: string | undefined,
    kind: 'website' | 'twitter' | 'telegram' | 'generic'
  ): string | undefined {
    const raw = this.pickFirstString(value);
    if (!raw) return undefined;
    if (/^https?:\/\//i.test(raw)) return raw;

    if (kind === 'twitter') {
      const normalized = raw.replace(/^@/, '').trim();
      if (/^(twitter|x)\.com\//i.test(normalized)) return `https://${normalized}`;
      if (/^[A-Za-z0-9_]{1,32}\/.+$/.test(normalized)) return `https://twitter.com/${normalized}`;
      if (/^[A-Za-z0-9_]{1,32}$/.test(normalized)) return `https://twitter.com/${normalized}`;
      return raw;
    }

    if (kind === 'telegram') {
      const normalized = raw.replace(/^@/, '').trim();
      if (/^(t|telegram)\.me\//i.test(normalized)) return `https://${normalized}`;
      if (/^[A-Za-z0-9_]{3,}$/.test(normalized)) return `https://t.me/${normalized}`;
      return raw;
    }

    if (/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}(\/.*)?$/i.test(raw)) {
      return `https://${raw}`;
    }

    if (kind === 'generic' && /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}\/.+$/i.test(raw)) {
      return `https://${raw}`;
    }
    return raw;
  }

  private static normalizeTokenInfo(tokenData: MultiTokenInfoResponse['data'][number], chain: string): TokenInfo {
    const quoteTokenAddress = tokenData.tpool?.quote_address || tokenData.pool?.quote_address;
    const quoteToken = tokenData.migration_market_cap_quote || tokenData.pool?.quote_symbol || '';
    const exchange = tokenData.tpool?.exchange;
    const isMigrated = tokenData.tpool?.launch_type === 'migrated';
    const dexType = isMigrated ? this.getDexType(exchange) : undefined;
    const socialContainers = [
      tokenData,
      tokenData.links,
      tokenData.link,
      tokenData.social,
      tokenData.socials,
      tokenData.project,
      tokenData.project?.links,
      tokenData.base_token_info,
      tokenData.info,
      tokenData.metadata,
      tokenData.token,
    ];
    const description = this.pickFromContainers(socialContainers, [
      'description',
      'descr',
      'desc',
      'introduction',
      'intro',
      'bio',
    ]);
    const website = this.normalizeExternalLink(
      this.pickFromContainers(socialContainers, [
        'website',
        'website_url',
        'web_url',
        'webUrl',
        'websiteUrl',
        'official_website',
        'officialWebsite',
        'project_website',
        'projectWebsite',
        'home_url',
        'homeUrl',
      ]),
      'website'
    );
    const twitterUrl = this.normalizeExternalLink(
      this.pickFromContainers(socialContainers, [
        'twitterUrl',
        'twitter_url',
        'twitter',
        'twitter_link',
        'twitterLink',
        'x',
        'xUrl',
        'x_url',
      ]),
      'twitter'
    );
    const telegramUrl = this.normalizeExternalLink(
      this.pickFromContainers(socialContainers, [
        'telegramUrl',
        'telegram_url',
        'telegram',
        'telegram_link',
        'telegramLink',
        'tg',
        'tg_url',
        'tgUrl',
      ]),
      'telegram'
    );

    return {
      chain: tokenData.chain || chain,
      address: tokenData.address,
      name: tokenData.name,
      symbol: tokenData.symbol,
      decimals: Number(tokenData.decimals || 0),
      logo: tokenData.logo || '',
      description,
      website,
      twitterUrl,
      telegramUrl,
      launchpad: tokenData.launchpad || '',
      launchpad_progress: Number(tokenData.launchpad_progress || 0),
      launchpad_platform: tokenData.launchpad_platform || '',
      launchpad_status: Number(tokenData.launchpad_status || 0),
      quote_token: quoteToken,
      quote_token_address: quoteTokenAddress,
      pool_pair: tokenData.biggest_pool_address || tokenData.tpool?.pool_address || tokenData.pool?.pool_address,
      dex_type: dexType,
    };
  }

  public static getDexType(exchange?: string): string | undefined {
    if (!exchange) return undefined;
    if (exchange.toLowerCase() === PancakeFactoryV3.toLowerCase()) {
      return 'PANCAKE_SWAP_V3';
    }
    if (exchange.toLowerCase() === PancakeFactoryV2.toLowerCase()) {
      return 'PANCAKE_SWAP';
    }
    return undefined;
  }

  /**
   * Get token holding for a wallet
   * @param chain Blockchain chain
   * @param tokenAddress Token address
   * @returns Promise<string | undefined> Token balance or undefined if not found
   */
  public static async getTokenHoldings(chain: string, walletAddress: string): Promise<GmgnTokenHolding[]> {
    if (!walletAddress) {
      return [];
    }

    const endpoint = `/wallet/${chain.toLowerCase()}/${walletAddress.toLowerCase()}/holdings`;
    const queryParams = {
      worker: '0',
      hide_closed: true,
      hide_airdrop: true,
      hide_abnormal: false,
      limit: 20,
      showsmall: true,
      sellout: true,
      order_by: 'last_active_timestamp',
      direction: 'desc'
    };

    const url = await this.buildApiUrl(endpoint, queryParams as any, this.PROFIT_BASE_URL);
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
      if (result.code === 0 && result.data) {
        // 1) pf holdings: /wallet/{chain}/{wallet}/holdings => data.list[]
        if (Array.isArray((result.data as any)?.list)) {
          const list = (result.data as any).list as any[];
          return list
            .map((item) => {
              const tokenAddr = String(item?.token?.token_address || item?.token_address || '').toLowerCase();
              if (!tokenAddr) return null;
              return {
                token_address: tokenAddr,
                symbol: String(item?.token?.symbol || item?.symbol || ''),
                token_symbol: String(item?.token?.symbol || item?.symbol || ''),
                balance: String(item?.balance ?? '0'),
                price: String(item?.token?.price ?? item?.price ?? ''),
                usd_value: String(item?.usd_value ?? ''),
                total_profit: String(item?.total_profit ?? ''),
                unrealized_profit: String(item?.unrealized_profit ?? ''),
                realized_profit: String(item?.realized_profit ?? ''),
                total_profit_pnl: item?.total_profit_pnl ?? null,
                unrealized_profit_pnl: item?.unrealized_profit_pnl ?? null,
                accu_cost: String(item?.accu_cost ?? ''),
                history_bought_cost: String(item?.history_bought_cost ?? ''),
                history_sold_income: String(item?.history_sold_income ?? ''),
                history_bought_amount: String(item?.history_bought_amount ?? ''),
                token: item?.token,
              } as GmgnTokenHolding;
            })
            .filter(Boolean) as GmgnTokenHolding[];
        }
        // 2) fallback: old /wallets/holding style
        if (Array.isArray((result.data as any)?.holdings)) {
          return (result.data as any).holdings as GmgnTokenHolding[];
        }
      }

      return [];
    } catch (error) {
      console.error('Failed to fetch token holdings:', error);
      throw error;
    }
  }

  public static async getTokenHolding(chain: string, walletAddress: string, tokenAddress?: string): Promise<string | undefined> {
    if (!walletAddress) return undefined;
    if (!tokenAddress) {
      const holdings = await this.getTokenHoldings(chain, walletAddress);
      return holdings?.[0]?.balance;
    }

    const endpoint = `/wallet/${chain.toLowerCase()}/${walletAddress.toLowerCase()}/holding`;
    const queryParams = {
      worker: '0',
      token_address: tokenAddress.toLowerCase()
    };

    const url = await this.buildApiUrl(endpoint, queryParams as any, this.PROFIT_BASE_URL);
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
      if (result.code === 0 && result.data) {
        if (typeof result.data === 'object' && !Array.isArray(result.data)) {
          return String(result.data?.balance ?? '0');
        }
        if (Array.isArray((result.data as any)?.holdings) && (result.data as any).holdings.length > 0) {
          return (result.data as any).holdings[0].balance;
        }
      }

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

  public static async getWalletsHolding(chain: string, tokenAddress: string, walletAddresses: string[]): Promise<GmgnTokenHolding[]> {
    const normalizedWallets = walletAddresses
      .map((item) => String(item || '').trim().toLowerCase())
      .filter(Boolean);
    if (!chain || !tokenAddress || normalizedWallets.length <= 0) return [];

    const endpoint = '/wallets/holding';
    const url = await this.buildApiUrlWithArrayParams(
      endpoint,
      {
        worker: '0',
        chain: chain.toLowerCase(),
        token_address: tokenAddress.toLowerCase(),
      },
      { wallet_addresses: normalizedWallets },
      this.HOLDINGS_BASE_URL
    );
    const headers = await this.getHeaders();

    try {
      const response = await this.makeRequest(url, {
        method: 'GET',
        headers
      });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json() as TdWalletsHoldingResponse;
      const holdings = Array.isArray(result.data?.holdings) ? result.data!.holdings! : [];
      return holdings
        .map((item) => {
          const tokenAddr = String(item?.token_address || '').toLowerCase();
          if (!tokenAddr) return null;
          return {
            chain_wallet: String(item?.chain_wallet || ''),
            token_address: tokenAddr,
            wallet_address: String(item?.wallet_address || '').toLowerCase(),
            symbol: String(item?.token_basic_stats?.symbol || ''),
            token_symbol: String(item?.token_basic_stats?.symbol || ''),
            balance: String(item?.balance ?? '0'),
            price: String(item?.price ?? ''),
            usd_value: String(item?.usd_value ?? ''),
            total_profit: String(item?.total_profit ?? ''),
            unrealized_profit: String(item?.unrealized_profit ?? ''),
            realized_profit: String(item?.realized_profit ?? ''),
            total_profit_pnl: item?.total_profit_pnl ?? null,
            unrealized_profit_pnl: item?.unrealized_profit_pnl ?? null,
            accu_amount: String(item?.accu_amount ?? ''),
            accu_cost: String(item?.accu_cost ?? ''),
            bought_cost: String(item?.bought_cost ?? ''),
            sold_income: String(item?.sold_income ?? ''),
            history_bought_cost: String(item?.history_bought_cost ?? ''),
            history_sold_income: String(item?.history_sold_income ?? ''),
            history_realized_profit: String(item?.history_realized_profit ?? ''),
            history_bought_amount: String(item?.history_bought_amount ?? ''),
            token_basic_stats: item?.token_basic_stats,
          } as GmgnTokenHolding;
        })
        .filter(Boolean) as GmgnTokenHolding[];
    } catch (error) {
      console.error('Failed to fetch wallets holding:', error);
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

  public static async getTokenHoldingDetail(
    chain: string,
    walletAddress: string,
    tokenAddress: string
  ): Promise<TokenHoldingDetail | null> {
    if (!walletAddress || !tokenAddress || !chain) return null;
    const normalizedChain = chain.toLowerCase();
    const endpoint = `/wallet/${normalizedChain}/${walletAddress.toLowerCase()}/holding`;
    const queryParams = {
      worker: '0',
      token_address: tokenAddress.toLowerCase()
    };
    const url = await this.buildApiUrl(endpoint, queryParams as any, this.PROFIT_BASE_URL);
    const headers = await this.getHeaders();
    try {
      const response = await this.makeRequest(url, {
        method: 'GET',
        headers
      });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const result = await response.json() as TokenHoldingDetailResponse;
      if (result.code === 0 && result.data) return result.data;
      return null;
    } catch (error) {
      console.error('Failed to fetch token holding detail:', error);
      throw error;
    }
  }
}

// Export the class directly
export default GmgnAPI;
