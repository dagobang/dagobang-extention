/**
 * GMGN API Class
 * Handles API calls to GMGN with proper authentication and headers
 */
import { PancakeFactoryV2, PancakeFactoryV3 } from "@/constants/contracts/address";

const BSC_UNISWAP_V3_FACTORY = '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7';
import { ChainId } from "@/constants/chains/chainId";
import { toGmgnChainName } from "@/constants/chains";
import { getChainIdByName } from "@/constants/chains/chainName";
import { TokenStat, TokenInfo } from "@/types/token";
import { getConfiguredPancakeInfinityClPoolManager } from "@/services/trade/tradePancakeInfinity";
import { isBytes32PoolId } from "@/utils/dexUtils";
import { resolveMutilWindowLineageHop } from "@/utils/mutilWindowTokenInfo";
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
    migrated_pool?: string;
    launch_quote_address?: string;
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

export interface FlapQuoteSupportResult {
  supported: boolean;
  symbol: string;
  name: string;
  decimals: number;
}

export interface GmgnTokenPoolFeeInfo {
  address: string;
  exchange?: string;
  liquidity?: number;
  fee_ratio?: number;
  is_dynamic_fee?: boolean;
  pool_type?: string;
  meteora_virtual_curve_fee_config?: unknown;
  meteora_damm_v2_base_fee_config?: unknown;
  fee_params?: string[] | null;
}

interface GmgnTokenPoolFeeInfoResponse {
  code: number;
  reason?: string;
  message?: string;
  data?: {
    list?: GmgnTokenPoolFeeInfo[] | null;
  } | null;
}

interface FlapQuoteSupportResponse {
  code: number;
  reason?: string;
  message?: string;
  data?: FlapQuoteSupportResult;
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

export type GmgnPageFetchRequest = {
  url: string;
  init: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    credentials: 'include';
    mode: 'cors';
  };
};

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
  private static readonly XAPI_BASE_URL = 'https://gmgn.ai/xapi/v1';
  private static readonly TOKEN_TRADE_INFO_CACHE_MS = 5 * 60_000;
  private static readonly TOKEN_POOL_FEE_INFO_CACHE_MS = 60_000;
  private static readonly tokenTradeInfoCache = new Map<string, { ts: number; value: TokenInfo | null }>();
  private static readonly tokenTradeInfoInFlight = new Map<string, Promise<TokenInfo | null>>();
  private static readonly tokenPoolFeeInfoCache = new Map<string, { ts: number; value: GmgnTokenPoolFeeInfo[] }>();
  private static readonly tokenPoolFeeInfoInFlight = new Map<string, Promise<GmgnTokenPoolFeeInfo[]>>();

  private static normalizeChainName(chain: string): string {
    return toGmgnChainName(chain);
  }

  public static async getTokenTradeInfo(chain: string, address: string): Promise<TokenInfo | null> {
    const normalizedChain = this.normalizeChainName(chain);
    const normalizedAddress = this.normalizeQueryAddress(normalizedChain, address);
    if (!normalizedChain || !normalizedAddress) return null;

    const key = `${normalizedChain}:${normalizedAddress}`;
    const now = Date.now();
    const cached = this.tokenTradeInfoCache.get(key);
    if (cached && now - cached.ts < this.TOKEN_TRADE_INFO_CACHE_MS) {
      return cached.value;
    }

    const inFlight = this.tokenTradeInfoInFlight.get(key);
    if (inFlight) return await inFlight;

    const task = (async (): Promise<TokenInfo | null> => {
      try {
        const mergedInfo = await this.fetchMergedGmgnTokenInfo(normalizedChain, normalizedAddress);
        this.tokenTradeInfoCache.set(key, { ts: Date.now(), value: mergedInfo });
        return mergedInfo;
      } finally {
        this.tokenTradeInfoInFlight.delete(key);
      }
    })();

    this.tokenTradeInfoInFlight.set(key, task);
    return await task;
  }

  private static normalizeQueryAddress(chain: string, address: string): string {
    const trimmed = String(address || '').trim();
    if (!trimmed) return '';
    return this.normalizeChainName(chain) === 'sol' ? trimmed : trimmed.toLowerCase();
  }

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

  private static async postJson<T = any>(
    endpoint: string,
    payload: unknown,
    baseUrl: string = this.CANDLES_BASE_URL
  ): Promise<T> {
    const url = await this.buildApiUrl(endpoint, {}, baseUrl);
    const headers = await this.getHeaders();
    const response = await this.makeRequest(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload ?? {}),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(text || `GMGN request failed: ${response.status}`);
    }
    const data = await response.json().catch(() => null);
    if (!data || typeof data !== 'object') {
      throw new Error('GMGN response invalid');
    }
    if (typeof (data as any).code === 'number' && (data as any).code !== 0) {
      throw new Error(String((data as any).message || (data as any).reason || 'GMGN request failed'));
    }
    return data as T;
  }

  private static toPageFetchHeaders(headers: HeadersInit): Record<string, string> {
    const entries = headers instanceof Headers
      ? Array.from(headers.entries())
      : Array.isArray(headers)
        ? headers
        : Object.entries(headers || {});
    const safe = new Map<string, string>();
    for (const [rawKey, rawValue] of entries) {
      const key = String(rawKey || '').trim().toLowerCase();
      const value = String(rawValue || '').trim();
      if (!key || !value) continue;
      if (
        key === 'cookie' ||
        key.startsWith('sec-') ||
        key === 'host' ||
        key === 'origin' ||
        key === 'referer' ||
        key === 'content-length' ||
        key === 'user-agent'
      ) {
        continue;
      }
      safe.set(key, value);
    }
    return Object.fromEntries(safe.entries());
  }

  private static async buildPagePostJsonRequest(
    endpoint: string,
    payload: unknown,
    baseUrl: string = this.CANDLES_BASE_URL
  ): Promise<GmgnPageFetchRequest> {
    const url = await this.buildApiUrl(endpoint, {}, baseUrl);
    const headers = this.toPageFetchHeaders(await this.getHeaders());
    return {
      url,
      init: {
        method: 'POST',
        headers,
        body: JSON.stringify(payload ?? {}),
        credentials: 'include',
        mode: 'cors',
      },
    };
  }

  private static async buildPageGetRequest(
    endpoint: string,
    queryParams: Record<string, string | number | boolean | undefined> = {},
    baseUrl: string = this.CANDLES_BASE_URL,
  ): Promise<GmgnPageFetchRequest> {
    const url = await this.buildApiUrl(endpoint, queryParams, baseUrl);
    const headers = this.toPageFetchHeaders(await this.getHeaders());
    return {
      url,
      init: {
        method: 'GET',
        headers,
        credentials: 'include',
        mode: 'cors',
      },
    };
  }

  public static parseTokenPoolFeeInfoPayload(payload: unknown): GmgnTokenPoolFeeInfo[] {
    const result = payload as GmgnTokenPoolFeeInfoResponse;
    if (!result || typeof result !== 'object' || result.code !== 0 || !Array.isArray(result.data?.list)) {
      return [];
    }
    return result.data.list
      .filter((item): item is GmgnTokenPoolFeeInfo => !!item && typeof item.address === 'string' && !!item.address.trim())
      .map((item) => ({
        ...item,
        address: String(item.address).trim(),
        fee_ratio: item.fee_ratio == null ? item.fee_ratio : Number(item.fee_ratio),
      }));
  }

  /** Page-world GET for token_pool_fee_info (cookies + CF). Call from gmgn content script only. */
  public static async buildTokenPoolFeeInfoPageRequest(
    chain: string,
    tokenAddress: string,
  ): Promise<GmgnPageFetchRequest> {
    const normalizedChain = this.normalizeChainName(chain);
    const normalizedAddress = this.normalizeQueryAddress(normalizedChain, tokenAddress);
    if (!normalizedChain || !normalizedAddress) {
      throw new Error('Invalid GMGN token_pool_fee_info params');
    }
    return await this.buildPageGetRequest(
      `/token_pool_fee_info/${normalizedChain}/${normalizedAddress}`,
      { worker: '0' },
      this.CANDLES_BASE_URL,
    );
  }

  public static async followTokens(
    chain: string,
    tokens: Array<{ tokenAddress: string; groupId?: string }>
  ): Promise<any> {
    const normalizedChain = this.normalizeChainName(chain);
    const normalizedTokens = tokens
      .map((item) => ({
        token_address: this.normalizeQueryAddress(normalizedChain, item.tokenAddress),
        group_id: String(item.groupId || 'default').trim() || 'default',
      }))
      .filter((item) => !!item.token_address);
    if (!normalizedChain || normalizedTokens.length <= 0) {
      throw new Error('Invalid GMGN follow params');
    }
    return await this.postJson('/follow_token/token/follow_tokens', {
      tokens: normalizedTokens,
      chain: normalizedChain,
    }, this.CANDLES_BASE_URL);
  }

  public static async buildFollowTokensPageRequest(
    chain: string,
    tokens: Array<{ tokenAddress: string; groupId?: string }>
  ): Promise<GmgnPageFetchRequest> {
    const normalizedChain = this.normalizeChainName(chain);
    const normalizedTokens = tokens
      .map((item) => ({
        token_address: this.normalizeQueryAddress(normalizedChain, item.tokenAddress),
        group_id: String(item.groupId || 'default').trim() || 'default',
      }))
      .filter((item) => !!item.token_address);
    if (!normalizedChain || normalizedTokens.length <= 0) {
      throw new Error('Invalid GMGN follow params');
    }
    return await this.buildPagePostJsonRequest('/follow_token/token/follow_tokens', {
      tokens: normalizedTokens,
      chain: normalizedChain,
    }, this.CANDLES_BASE_URL);
  }

  /**
   * Page-world POST builder for /mutil_window_token_info. Call from the gmgn
   * content script only (via requestGmgnPageFetch) — the service worker cannot
   * fetch this endpoint directly (CORS + GMGN auth cookies only available in
   * the page main world). Returns the request descriptor; the caller performs
   * the fetch and parses payload.data.
   */
  public static async buildMultiWindowTokenInfoPageRequest(
    chain: string,
    addresses: string[]
  ): Promise<GmgnPageFetchRequest> {
    const normalizedChain = this.normalizeChainName(chain);
    const normalized = Array.from(new Set(
      addresses.map((a) => String(a || '').trim().toLowerCase()).filter((a) => /^0x[a-f0-9]{40}$/.test(a))
    ));
    if (!normalizedChain || normalized.length <= 0) {
      throw new Error('Invalid GMGN mutil_window_token_info params');
    }
    return await this.buildPagePostJsonRequest('/mutil_window_token_info', {
      chain: normalizedChain,
      addresses: normalized,
    }, this.CANDLES_BASE_URL);
  }

  /**
   * Page-world POST builder for /multi_token_info (launchpad/tpool metadata).
   * Pair with buildMultiWindowTokenInfoPageRequest — routing needs both APIs.
   */
  public static async buildMultiTokenInfoPageRequest(
    chain: string,
    addresses: string[]
  ): Promise<GmgnPageFetchRequest> {
    const normalizedChain = this.normalizeChainName(chain);
    const normalized = Array.from(new Set(
      addresses.map((a) => String(a || '').trim().toLowerCase()).filter((a) => /^0x[a-f0-9]{40}$/.test(a))
    ));
    if (!normalizedChain || normalized.length <= 0) {
      throw new Error('Invalid GMGN multi_token_info params');
    }
    return await this.buildPagePostJsonRequest('/multi_token_info', {
      chain: normalizedChain,
      addresses: normalized,
    }, this.TOKEN_INFO_BASE_URL);
  }


  public static async unfollowTokens(
    chain: string,
    tokens: Array<{ tokenAddress: string; groupId?: string }>
  ): Promise<any> {
    const normalizedChain = this.normalizeChainName(chain);
    const normalizedTokens = tokens
      .map((item) => ({
        token_address: this.normalizeQueryAddress(normalizedChain, item.tokenAddress),
        group_id: String(item.groupId || 'all_group').trim() || 'all_group',
      }))
      .filter((item) => !!item.token_address);
    if (!normalizedChain || normalizedTokens.length <= 0) {
      throw new Error('Invalid GMGN unfollow params');
    }
    return await this.postJson('/follow_token/token/unfollow_tokens', {
      tokens: normalizedTokens,
      chain: normalizedChain,
    }, this.CANDLES_BASE_URL);
  }

  public static async buildUnfollowTokensPageRequest(
    chain: string,
    tokens: Array<{ tokenAddress: string; groupId?: string }>
  ): Promise<GmgnPageFetchRequest> {
    const normalizedChain = this.normalizeChainName(chain);
    const normalizedTokens = tokens
      .map((item) => ({
        token_address: this.normalizeQueryAddress(normalizedChain, item.tokenAddress),
        group_id: String(item.groupId || 'all_group').trim() || 'all_group',
      }))
      .filter((item) => !!item.token_address);
    if (!normalizedChain || normalizedTokens.length <= 0) {
      throw new Error('Invalid GMGN unfollow params');
    }
    return await this.buildPagePostJsonRequest('/follow_token/token/unfollow_tokens', {
      tokens: normalizedTokens,
      chain: normalizedChain,
    }, this.CANDLES_BASE_URL);
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
    const endpoint = `/token_candles/${this.normalizeChainName(chain)}/${tokenAddress}`;
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
    const normalizedChain = this.normalizeChainName(chain);
    try {
      const [mergedInfo, linkInfo] = await Promise.all([
        this.fetchMergedGmgnTokenInfo(normalizedChain, address),
        this.fetchTokenLinkInfo(normalizedChain, address).catch((error) => {
          console.warn('Failed to fetch GMGN token link info:', error);
          return null;
        }),
      ]);
      if (!mergedInfo) return null;
      return {
        ...mergedInfo,
        description: linkInfo?.description || mergedInfo.description,
        website: linkInfo?.website || mergedInfo.website,
        gmgnUrl: linkInfo?.gmgnUrl || mergedInfo.gmgnUrl,
        geckoTerminalUrl: linkInfo?.geckoTerminalUrl || mergedInfo.geckoTerminalUrl,
        twitterUrl: linkInfo?.twitterUrl || mergedInfo.twitterUrl,
        telegramUrl: linkInfo?.telegramUrl || mergedInfo.telegramUrl,
        discordUrl: linkInfo?.discordUrl || mergedInfo.discordUrl,
        githubUrl: linkInfo?.githubUrl || mergedInfo.githubUrl,
        youtubeUrl: linkInfo?.youtubeUrl || mergedInfo.youtubeUrl,
        mediumUrl: linkInfo?.mediumUrl || mergedInfo.mediumUrl,
        redditUrl: linkInfo?.redditUrl || mergedInfo.redditUrl,
        linkedinUrl: linkInfo?.linkedinUrl || mergedInfo.linkedinUrl,
        instagramUrl: linkInfo?.instagramUrl || mergedInfo.instagramUrl,
        facebookUrl: linkInfo?.facebookUrl || mergedInfo.facebookUrl,
        tiktokUrl: linkInfo?.tiktokUrl || mergedInfo.tiktokUrl,
        bitbucketUrl: linkInfo?.bitbucketUrl || mergedInfo.bitbucketUrl,
        farcasterUrl: linkInfo?.farcasterUrl || mergedInfo.farcasterUrl,
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
    const endpoint = `/mutil_window_token_link_rug_vote/${this.normalizeChainName(chain)}/${address}`;
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

  /**
   * Authoritative routing fields from /mutil_window_token_info; launchpad metadata
   * from /multi_token_info when available. Never use launch_quote_address for hops.
   */
  private static async fetchMergedGmgnTokenInfo(chain: string, address: string): Promise<TokenInfo | null> {
    const normalizedChain = this.normalizeChainName(chain);
    const [windowInfo, metaInfo] = await Promise.all([
      this.fetchTokenInfoByEndpoint(
        '/mutil_window_token_info',
        this.CANDLES_BASE_URL,
        normalizedChain,
        address,
      ).catch(() => null),
      this.fetchTokenInfoByEndpoint(
        '/multi_token_info',
        this.TOKEN_INFO_BASE_URL,
        normalizedChain,
        address,
      ).catch(() => null),
    ]);
    let mergedInfo = windowInfo ?? metaInfo;
    if (windowInfo && metaInfo) {
      mergedInfo = this.mergeGmgnTokenInfo(windowInfo, metaInfo);
    }
    return mergedInfo;
  }

  /** Merge raw GMGN rows: mutil_window (routing) + multi_token_info (launchpad/tpool). */
  public static mergeGmgnApiTokenRows(
    windowRow: Record<string, unknown> | null | undefined,
    metaRow: Record<string, unknown> | null | undefined,
  ): Record<string, unknown> | null {
    if (!windowRow && !metaRow) return null;
    if (!windowRow) return metaRow ?? null;
    if (!metaRow) return windowRow;
    const windowPool = windowRow.pool as Record<string, unknown> | undefined;
    const metaPool = metaRow.pool as Record<string, unknown> | undefined;
    const windowTpool = windowRow.tpool as Record<string, unknown> | undefined;
    const metaTpool = metaRow.tpool as Record<string, unknown> | undefined;
    return {
      ...metaRow,
      ...windowRow,
      pool: windowPool ?? metaPool,
      tpool: metaTpool ?? windowTpool,
      launchpad: metaRow.launchpad ?? windowRow.launchpad,
      launchpad_platform: metaRow.launchpad_platform ?? windowRow.launchpad_platform,
      launchpad_status: metaRow.launchpad_status ?? windowRow.launchpad_status,
      launchpad_progress: metaRow.launchpad_progress ?? windowRow.launchpad_progress,
    };
  }

  private static mergeGmgnTokenInfo(primary: TokenInfo, secondary: TokenInfo): TokenInfo {
    return {
      ...secondary,
      ...primary,
      symbol: primary.symbol || secondary.symbol,
      name: primary.name || secondary.name,
      decimals: primary.decimals > 0 ? primary.decimals : secondary.decimals,
      logo: primary.logo || secondary.logo,
      // /mutil_window_token_info — authoritative routing quote/pool
      quote_token: primary.quote_token || secondary.quote_token,
      quote_token_address: primary.quote_token_address || secondary.quote_token_address,
      pool_pair: primary.pool_pair || secondary.pool_pair,
      biggest_pool_address: primary.biggest_pool_address || secondary.biggest_pool_address,
      pool_factory: primary.pool_factory || secondary.pool_factory,
      pool_exchange: primary.pool_exchange || secondary.pool_exchange,
      dex_type: primary.dex_type || secondary.dex_type,
      tokenPrice: primary.tokenPrice ?? secondary.tokenPrice,
      totalSupply: primary.totalSupply || secondary.totalSupply,
      // /multi_token_info — authoritative launchpad / inner-pool metadata
      launchpad: secondary.launchpad || primary.launchpad,
      launchpad_platform: secondary.launchpad_platform || primary.launchpad_platform,
      launchpad_status: Number.isFinite(Number(secondary.launchpad_status))
        ? Number(secondary.launchpad_status)
        : primary.launchpad_status,
      launchpad_progress: secondary.launchpad_progress ?? primary.launchpad_progress,
      tpool_exchange: secondary.tpool_exchange || primary.tpool_exchange,
      tpool_launch_type: secondary.tpool_launch_type || primary.tpool_launch_type,
      tpool_pool_address: secondary.tpool_pool_address || primary.tpool_pool_address,
    };
  }

  private static async fetchTokenInfoByEndpoint(
    endpoint: string,
    baseUrl: string,
    chain: string,
    address: string
  ): Promise<TokenInfo | null> {
    const extraParams = endpoint === '/mutil_window_token_info' ? { worker: '0' } : {};
    const normalizedChain = this.normalizeChainName(chain);
    const url = await this.buildApiUrl(endpoint, extraParams, baseUrl);
    const headers = await this.getHeaders();
    const payload = {
      chain: normalizedChain,
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
      return this.normalizeTokenInfo(result.data[0], normalizedChain);
    }
    return null;
  }

  /**
   * Batch-query the /mutil_window_token_info endpoint for multiple addresses.
   * Returns the authoritative biggest-pool quote + pool address for each token,
   * which is the root-cause data source for quote-lineage routing (no heuristics,
   * no BNC4 fallback guessing). Used to resolve multi-hop quote chains like
   * ABS→BNCB→BNC4→USDT in one iterative walk with real pool addresses.
   */
  public static async getMultiWindowTokenInfoBatch(
    chain: string,
    addresses: string[]
  ): Promise<Map<string, { quoteAddress: string; poolAddress: string; quoteSymbol: string; exchange: string }>> {
    const out = new Map<string, { quoteAddress: string; poolAddress: string; quoteSymbol: string; exchange: string }>();
    const normalizedChain = this.normalizeChainName(chain);
    const normalized = Array.from(new Set(
      addresses.map((a) => String(a || '').trim().toLowerCase()).filter((a) => /^0x[a-f0-9]{40}$/.test(a))
    ));
    if (!normalized.length) return out;
    const url = await this.buildApiUrl('/mutil_window_token_info', { worker: '0' }, this.CANDLES_BASE_URL);
    const headers = await this.getHeaders();
    const payload = { chain: normalizedChain, addresses: normalized };
    const response = await this.makeRequest(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!response.ok) return out;
    const result = await response.json() as MultiTokenInfoResponse;
    if (result.code !== 0 || !Array.isArray(result.data)) return out;
    const chainId = getChainIdByName(normalizedChain) ?? ChainId.BNB;
    for (const item of result.data) {
      const self = String(item.address || '').trim().toLowerCase();
      if (!self) continue;
      const hop = resolveMutilWindowLineageHop(chainId, self, item);
      if (!hop) continue;
      const quoteSymbol = String(item.pool?.quote_symbol || item.tpool?.quote_address || '').trim();
      const exchange = String(item.pool?.exchange || item.tpool?.exchange || '').trim();
      out.set(self, {
        quoteAddress: hop.quote,
        poolAddress: hop.poolAddress,
        quoteSymbol,
        exchange,
      });
    }
    return out;
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

  private static normalizeTotalSupply(value: unknown): string | undefined {
    const raw = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
    if (!raw) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return raw;
  }

  private static normalizeOptionalNumberString(value: unknown): string | undefined {
    const raw = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
    if (!raw) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return raw;
  }

  private static normalizeTokenInfo(tokenData: MultiTokenInfoResponse['data'][number], chain: string): TokenInfo {
      const selfAddress = String(tokenData.address || '').trim().toLowerCase();
      const chainId = getChainIdByName(this.normalizeChainName(chain)) ?? 56;
      const lineageHop = resolveMutilWindowLineageHop(chainId, selfAddress, tokenData);
      const poolQuoteAddress = String(
        (tokenData.pool as { quote_address?: string | null } | undefined)?.quote_address
        || tokenData.tpool?.quote_address
        || '',
      ).trim().toLowerCase();
      const quoteTokenAddress = (
        (/^0x[a-f0-9]{40}$/.test(poolQuoteAddress) && poolQuoteAddress !== selfAddress
          ? poolQuoteAddress
          : null)
        ?? lineageHop?.quote
        ?? undefined
      );
      const poolRefAddress = String(
        (tokenData.pool as { pool_address?: string | null } | undefined)?.pool_address
        || tokenData.biggest_pool_address
        || tokenData.tpool?.pool_address
        || '',
      ).trim();
      const hopPoolAddress = lineageHop?.poolAddress
        || (/^0x[a-f0-9]{40}$/i.test(poolRefAddress) || /^0x[a-f0-9]{64}$/i.test(poolRefAddress)
          ? poolRefAddress.toLowerCase()
          : undefined);
    const quoteToken = lineageHop
      ? (tokenData.pool?.quote_symbol || tokenData.tpool?.quote_address || '')
      : (tokenData.migration_market_cap_quote || tokenData.pool?.quote_symbol || '');
    const poolExchange = String(tokenData.pool?.exchange || '').trim();
    const exchange = poolExchange || tokenData.tpool?.exchange;
    const poolFactory = String(
      (tokenData.pool as { factory?: string | null } | undefined)?.factory || '',
    ).trim().toLowerCase() || undefined;
    const launchType = String(tokenData.tpool?.launch_type || '').trim().toLowerCase();
    const isMigrated = launchType === 'migrated' || Number(tokenData.launchpad_status || 0) === 1;
    const biggestPoolAddress = tokenData.biggest_pool_address || undefined;
    const migratedPoolAddress = String(tokenData.migrated_pool || '').trim() || undefined;
    const tpoolPoolAddress = tokenData.tpool?.pool_address || tokenData.pool?.pool_address || migratedPoolAddress || undefined;
    const launchpadPlatform = String(tokenData.launchpad_platform || tokenData.launchpad || '').trim().toLowerCase();
    const looksV4Pool = isBytes32PoolId(biggestPoolAddress || migratedPoolAddress || tpoolPoolAddress || hopPoolAddress || '');
    const isPancakeInfinityFactory = poolFactory === getConfiguredPancakeInfinityClPoolManager().toLowerCase();
    const dexType = this.getDexType(exchange)
      || (isPancakeInfinityFactory && looksV4Pool ? 'PANCAKE_INFINITY_V4' : undefined)
      || (((isMigrated && looksV4Pool && !isPancakeInfinityFactory) || launchpadPlatform === 'o1' || launchpadPlatform.startsWith('o1_')
        || launchpadPlatform === 'long' || launchpadPlatform === 'longxyz' || launchpadPlatform === 'long.xyz')
        ? 'UNISWAP_V4'
        : undefined);
    const totalSupply = this.normalizeTotalSupply(
      tokenData.totalSupply
      ?? tokenData.total_supply
      ?? tokenData.base_token_info?.totalSupply
      ?? tokenData.base_token_info?.total_supply
      ?? tokenData.token?.totalSupply
      ?? tokenData.token?.total_supply
    );
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
    const normalizedPriceRaw =
      tokenData.price
      ?? tokenData.token?.price
      ?? tokenData.base_token_info?.price
      ?? '';
    const normalizedLiquidityRaw =
      tokenData.liquidity
      ?? tokenData.token?.liquidity
      ?? tokenData.base_token_info?.liquidity
      ?? '';
    const normalizedMarketCapRaw =
      tokenData.market_cap
      ?? tokenData.marketCap
      ?? tokenData.base_token_info?.market_cap
      ?? tokenData.base_token_info?.marketCap
      ?? '';
    const normalizedName = this.pickFirstString(
      tokenData.name,
      tokenData.base_token_info?.name,
      tokenData.token?.name,
      tokenData.token_basic_stats?.name,
    ) ?? '';
    const normalizedSymbol = this.pickFirstString(
      tokenData.symbol,
      tokenData.token_symbol,
      tokenData.s,
      tokenData.base_token_info?.symbol,
      tokenData.base_token_info?.token_symbol,
      tokenData.token?.symbol,
      tokenData.token?.token_symbol,
      tokenData.token_basic_stats?.symbol,
    ) ?? '';
    const normalizedDecimals =
      tokenData.decimals
      ?? tokenData.base_token_info?.decimals
      ?? tokenData.token?.decimals
      ?? tokenData.token_basic_stats?.decimals
      ?? 0;
    const normalizedLogo =
      tokenData.logo
      ?? tokenData.base_token_info?.logo
      ?? tokenData.token?.logo
      ?? tokenData.token_basic_stats?.logo
      ?? '';

    return {
      chain: tokenData.chain || chain,
      address: tokenData.address,
      name: normalizedName,
      symbol: normalizedSymbol,
      decimals: Number(normalizedDecimals || 0),
      logo: normalizedLogo || '',
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
      pool_pair: hopPoolAddress || (isMigrated ? (migratedPoolAddress || tpoolPoolAddress || biggestPoolAddress) : undefined),
      biggest_pool_address: biggestPoolAddress,
      tpool_exchange: exchange,
      tpool_launch_type: launchType || undefined,
      tpool_pool_address: tpoolPoolAddress,
      pool_factory: poolFactory,
      pool_exchange: poolExchange || undefined,
      dex_type: dexType,
      tokenPrice: this.normalizeOptionalNumberString(normalizedPriceRaw)
        ? {
            price: this.normalizeOptionalNumberString(normalizedPriceRaw)!,
            marketCap: this.normalizeOptionalNumberString(normalizedMarketCapRaw) ?? '',
            liquidity: this.normalizeOptionalNumberString(normalizedLiquidityRaw),
            timestamp: Date.now(),
          }
        : undefined,
      totalSupply,
    };
  }

  public static getDexType(exchange?: string): string | undefined {
    if (!exchange) return undefined;
    const lower = exchange.toLowerCase();
    if (
      lower === PancakeFactoryV3.toLowerCase()
      || lower === 'pancake_v3'
      || lower === 'pancakeswap_v3'
    ) {
      return 'PANCAKE_SWAP_V3';
    }
    if (
      lower === PancakeFactoryV2.toLowerCase()
      || lower === 'pancake_v2'
      || lower === 'pancakeswap_v2'
    ) {
      return 'PANCAKE_SWAP';
    }
    if (
      lower === BSC_UNISWAP_V3_FACTORY.toLowerCase()
      || lower === 'uniswap_v3'
    ) {
      return 'UNISWAP_V3';
    }
    if (lower === 'uniswap_v4' || lower === 'uniswapv4') {
      return 'UNISWAP_V4';
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

    const normalizedChain = this.normalizeChainName(chain);
    const normalizedWalletAddress = this.normalizeQueryAddress(normalizedChain, walletAddress);
    const endpoint = `/wallet/${normalizedChain}/${normalizedWalletAddress}/holdings`;
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
              const tokenAddr = this.normalizeQueryAddress(chain, String(item?.token?.token_address || item?.token_address || ''));
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

    const normalizedChain = this.normalizeChainName(chain);
    const normalizedWalletAddress = this.normalizeQueryAddress(normalizedChain, walletAddress);
    const normalizedTokenAddress = this.normalizeQueryAddress(normalizedChain, tokenAddress);
    const endpoint = `/wallet/${normalizedChain}/${normalizedWalletAddress}/holding`;
    const queryParams = {
      worker: '0',
      token_address: normalizedTokenAddress
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
      chain: this.normalizeChainName(chain),
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
    const normalizedChain = this.normalizeChainName(chain);
    const normalizedWallets = walletAddresses
      .map((item) => this.normalizeQueryAddress(normalizedChain, item))
      .filter(Boolean);
    const normalizedTokenAddress = this.normalizeQueryAddress(normalizedChain, tokenAddress);
    if (!normalizedChain || !normalizedTokenAddress || normalizedWallets.length <= 0) return [];

    const endpoint = '/wallets/holding';
    const url = await this.buildApiUrlWithArrayParams(
      endpoint,
      {
        worker: '0',
        chain: normalizedChain,
        token_address: normalizedTokenAddress,
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
          const tokenAddr = this.normalizeQueryAddress(normalizedChain, String(item?.token_address || ''));
          if (!tokenAddr) return null;
          return {
            chain_wallet: String(item?.chain_wallet || ''),
            token_address: tokenAddr,
            wallet_address: this.normalizeQueryAddress(normalizedChain, String(item?.wallet_address || '')),
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
    const endpoint = `/wallets/${this.normalizeChainName(chain)}/daily_profits`;
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

  /**
   * Coin ATH market cap from GMGN token info.
   * Prefers history_highest_market_cap, otherwise ath_price × supply.
   */
  public static async getTokenAthMarketCap(chain: string, address: string): Promise<number | null> {
    const normalizedChain = this.normalizeChainName(chain);
    const normalizedAddress = this.normalizeQueryAddress(normalizedChain, address);
    if (!normalizedChain || !normalizedAddress) return null;
    const rows = await Promise.all([
      this.fetchRawTokenRow('/mutil_window_token_info', this.CANDLES_BASE_URL, normalizedChain, normalizedAddress).catch(() => null),
      this.fetchRawTokenRow('/multi_token_info', this.TOKEN_INFO_BASE_URL, normalizedChain, normalizedAddress).catch(() => null),
    ]);
    let best = 0;
    for (const row of rows) {
      const ath = this.readAthMarketCap(row);
      if (ath != null && ath > best) best = ath;
    }
    return best > 0 ? best : null;
  }

  private static async fetchRawTokenRow(
    endpoint: string,
    baseUrl: string,
    chain: string,
    address: string,
  ): Promise<Record<string, any> | null> {
    const extraParams = endpoint === '/mutil_window_token_info' ? { worker: '0' } : {};
    const url = await this.buildApiUrl(endpoint, extraParams, baseUrl);
    const headers = await this.getHeaders();
    const response = await this.makeRequest(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ chain, addresses: [address] }),
    });
    if (!response.ok) return null;
    const result = await response.json() as MultiTokenInfoResponse;
    if (result.code !== 0 || !Array.isArray(result.data) || result.data.length === 0) return null;
    return result.data[0];
  }

  private static readAthMarketCap(row: Record<string, any> | null): number | null {
    if (!row) return null;
    const direct = [
      row.history_highest_market_cap,
      row.ath_market_cap,
      row.ath_mc,
      row.price?.history_highest_market_cap,
      row.price?.ath_market_cap,
    ];
    for (const value of direct) {
      const num = Number(value);
      if (Number.isFinite(num) && num > 0) return num;
    }
    const athPrice = Number(row.ath_price ?? row.price?.ath_price ?? row.highest_price);
    const supply = Number(
      row.total_supply
      ?? row.totalSupply
      ?? row.circulating_supply
      ?? row.max_supply
      ?? row.token?.total_supply,
    );
    if (Number.isFinite(athPrice) && athPrice > 0 && Number.isFinite(supply) && supply > 0) {
      return athPrice * supply;
    }
    return null;
  }

  public static async getTokenHoldingDetail(
    chain: string,
    walletAddress: string,
    tokenAddress: string
  ): Promise<TokenHoldingDetail | null> {
    if (!walletAddress || !tokenAddress || !chain) return null;
    const normalizedChain = this.normalizeChainName(chain);
    const normalizedWalletAddress = this.normalizeQueryAddress(normalizedChain, walletAddress);
    const normalizedTokenAddress = this.normalizeQueryAddress(normalizedChain, tokenAddress);
    const endpoint = `/wallet/${normalizedChain}/${normalizedWalletAddress}/holding`;
    const queryParams = {
      worker: '0',
      token_address: normalizedTokenAddress
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

  /**
   * Check whether an ERC20 can be used as a Flap quote/base pool token.
   * GET /xapi/v1/{chain}/flap/quote_support
   */
  public static async checkFlapQuoteSupport(
    chain: string,
    tokenAddress: string,
  ): Promise<FlapQuoteSupportResult> {
    const unsupported: FlapQuoteSupportResult = {
      supported: false,
      symbol: '',
      name: '',
      decimals: 0,
    };
    const normalizedChain = this.normalizeChainName(chain) || 'bsc';
    const normalizedAddress = this.normalizeQueryAddress(normalizedChain, tokenAddress);
    if (!normalizedAddress) return unsupported;

    const endpoint = `/${normalizedChain}/flap/quote_support`;
    const url = await this.buildApiUrl(endpoint, {
      worker: '0',
      token: normalizedAddress,
    }, this.XAPI_BASE_URL);
    const headers = await this.getHeaders();
    try {
      const response = await this.makeRequest(url, {
        method: 'GET',
        headers,
      });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const result = await response.json() as FlapQuoteSupportResponse;
      if (result.code !== 0 || !result.data) return unsupported;
      return {
        supported: Boolean(result.data.supported),
        symbol: String(result.data.symbol || ''),
        name: String(result.data.name || ''),
        decimals: Number(result.data.decimals) || 0,
      };
    } catch (error) {
      console.error('Failed to check Flap quote support:', error);
      throw error;
    }
  }

  /**
   * Pool fee list for a token (includes Uniswap v4 poolId + fee_ratio).
   * GET /api/v1/token_pool_fee_info/{chain}/{token}
   * @see docs/gmgn-api-token_pool_fee_info.md
   */
  public static async getTokenPoolFeeInfo(
    chain: string,
    tokenAddress: string,
    options?: { timeoutMs?: number },
  ): Promise<GmgnTokenPoolFeeInfo[]> {
    const normalizedChain = this.normalizeChainName(chain);
    const normalizedAddress = this.normalizeQueryAddress(normalizedChain, tokenAddress);
    if (!normalizedChain || !normalizedAddress) return [];

    const key = `${normalizedChain}:${normalizedAddress.toLowerCase()}`;
    const now = Date.now();
    const cached = this.tokenPoolFeeInfoCache.get(key);
    if (cached && now - cached.ts < this.TOKEN_POOL_FEE_INFO_CACHE_MS) {
      return cached.value;
    }
    const inFlight = this.tokenPoolFeeInfoInFlight.get(key);
    if (inFlight) return await inFlight;

    const timeoutMs = Math.max(300, Math.min(options?.timeoutMs ?? 900, 2_000));
    const task = (async (): Promise<GmgnTokenPoolFeeInfo[]> => {
      const endpoint = `/token_pool_fee_info/${normalizedChain}/${normalizedAddress}`;
      const url = await this.buildApiUrl(endpoint, { worker: '0' }, this.CANDLES_BASE_URL);
      const headers = await this.getHeaders();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await this.makeRequest(url, {
          method: 'GET',
          headers,
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const result = await response.json() as GmgnTokenPoolFeeInfoResponse;
        if (result.code !== 0 || !Array.isArray(result.data?.list)) {
          // Short negative cache so a transient miss does not stick for a full minute.
          this.tokenPoolFeeInfoCache.set(key, { ts: Date.now() - this.TOKEN_POOL_FEE_INFO_CACHE_MS + 3_000, value: [] });
          return [];
        }
        const list = this.parseTokenPoolFeeInfoPayload(result);
        this.tokenPoolFeeInfoCache.set(key, { ts: Date.now(), value: list });
        return list;
      } catch (error) {
        console.error('Failed to fetch token pool fee info:', error);
        this.tokenPoolFeeInfoCache.set(key, { ts: Date.now() - this.TOKEN_POOL_FEE_INFO_CACHE_MS + 3_000, value: [] });
        return [];
      } finally {
        clearTimeout(timer);
        this.tokenPoolFeeInfoInFlight.delete(key);
      }
    })();

    this.tokenPoolFeeInfoInFlight.set(key, task);
    return await task;
  }

  public static findTokenPoolFeeInfo(
    list: GmgnTokenPoolFeeInfo[] | null | undefined,
    poolAddress?: string | null,
  ): GmgnTokenPoolFeeInfo | null {
    const want = String(poolAddress || '').trim().toLowerCase();
    if (!want || !Array.isArray(list) || !list.length) return null;
    return list.find((item) => String(item.address || '').trim().toLowerCase() === want) ?? null;
  }

  /** Uniswap fee units: 0.003 → 3000 (0.3%), 0.01 → 10000 (1%). */
  public static feeRatioToUniswapFee(feeRatio: number, isDynamicFee?: boolean): number | null {
    const ratio = Number(feeRatio);
    if (!Number.isFinite(ratio) || ratio < 0) return null;
    const fee = Math.round(ratio * 1_000_000);
    if (!Number.isFinite(fee) || fee < 0) return null;
    // fee_ratio=0 is valid for RH hook launchpads (o1 etc. encode PoolKey.fee=0).
    // Dynamic pools still use the 0x800000 flag.
    return isDynamicFee ? (fee | 0x800000) : fee;
  }

  public static tickSpacingFromPoolFeeParams(feeParams?: string[] | null): number | null {
    const raw = Array.isArray(feeParams) ? feeParams[0] : null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0 || value > 2000 || !Number.isInteger(value)) return null;
    return value;
  }
}

// Export the class directly
export default GmgnAPI;
