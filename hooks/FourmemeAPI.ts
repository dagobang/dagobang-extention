import { TokenInfo } from "@/types/token";

export interface FourmemeTokenPrice {
  price: string;
  maxPrice?: string;
  increase: string;
  amount: string;
  marketCap: string;
  trading: string;
  dayIncrease: string;
  dayTrading: string;
  raisedAmount?: string;
  progress: string;
  liquidity?: string;
  tradingUsd?: string;
  holderCount?: number;
  createDate?: string;
  modifyDate?: string;
  bamount: string;
  tamount: string;
}

export interface FourmemeTokenData {
  id: number;
  address: string;
  image: string;
  name: string;
  shortName: string;
  symbol: string;
  descr: string;
  webUrl?: string;
  twitterUrl?: string;
  totalAmount: string;
  saleAmount: string;
  b0: string;
  t0: string;
  launchTime: number;
  minBuy: string;
  maxBuy: string;
  userId: number;
  userAddress: string;
  userName: string;
  userAvatar?: string;
  status: string;
  showStatus: string;
  tradeUrl?: string;
  tokenPrice: FourmemeTokenPrice;
  oscarStatus: string;
  version: string;
  progressTag?: boolean;
  ctoTag?: boolean;
  reserveAmount?: string;
  raisedAmount?: string;
  networkCode?: string;
  label?: string;
  createDate: string;
  modifyDate?: string;
  isRush?: boolean;
  dexType: string;
  dexPair?: {
    pairAddress: string;
    pancakeVersion: number;
  };
  lastId?: number;
}

export interface FourmemeTokenInfoResponse {
  code: number;
  msg: string;
  data: FourmemeTokenData | null;
}

export class FourmemeAPI {
  private static readonly BASE_URL = "https://four.meme/meme-api/v1";

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

    try {
      const response = await fetch(url, requestOptions);
      return response;
    } catch (error) {
      console.error("FourmemeAPI request failed:", error);
      throw error;
    }
  }

  private static getHeaders(): HeadersInit {
    return {
      accept: "application/json, text/plain, */*",
      "accept-encoding": "gzip, deflate, br, zstd",
      "accept-language": "zh-CN,zh;q=0.9,ru;q=0.8",
      "content-type": "application/json",
      origin: "https://four.meme",
      referer: "https://four.meme/",
      "sec-ch-ua": '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": "Windows",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    };
  }

  public static async getTokenInfo(chain: string, address: string): Promise<TokenInfo | null> {
    const endpoint = "/private/token/get/v2";
    const params = new URLSearchParams({
      address,
    });

    const url = `${this.BASE_URL}${endpoint}?${params.toString()}`;

    try {
      const headers = this.getHeaders();
      const response = await this.makeRequest(url, {
        method: "GET",
        headers,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = (await response.json()) as FourmemeTokenInfoResponse;

      if (result.code === 0 && result.data) {
        const data = result.data;
        const chainSource = data.networkCode || chain || "bsc";
        const chainNormalized = chainSource.toLowerCase();
        const progress = Number(data.tokenPrice?.progress ?? 0);
        const status = data.status;

        return {
          chain: chainNormalized,
          address: data.address,
          name: data.name,
          symbol: data.shortName || data.name,
          decimals: 18,
          logo: data.image,
          launchpad: "fourmeme",
          launchpad_progress: Number.isFinite(progress) ? progress : 0,
          launchpad_platform: "fourmeme",
          launchpad_status: status === "TRADE" ? 1 : 0,
          quote_token: data.symbol,
          quote_token_address: undefined,
          pool_pair: data.dexPair?.pairAddress,
          dex_type: `${data.dexType}${data.dexPair?.pancakeVersion ? `_V${data.dexPair?.pancakeVersion}` : ""}`,
        };
      }

      return null;
    } catch (error) {
      console.error("Failed to fetch token info from Fourmeme:", error);
      return null;
    }
  }
}

export default FourmemeAPI;
