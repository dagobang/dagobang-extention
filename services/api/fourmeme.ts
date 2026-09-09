import { getChainIdByName } from "@/constants/chains/chainName";
import { getQuoteTokenAddress } from "@/constants/tokens/allTokens";
import { TokenInfo } from "@/types/token";
import { getChainId } from "viem/actions";
import { browser } from "wxt/browser";

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
  aiCreator?: boolean;
}

export interface FourmemeTokenInfoResponse {
  code: number;
  msg: string;
  data: FourmemeTokenData | null;
}

export function isFourmemeRateLimitError(message: unknown): boolean {
  return /too many requests|banned for/i.test(String(message || ''));
}

export function parseFourmemeRateLimitRemainSec(message: string): number | null {
  const text = String(message || '');
  if (!isFourmemeRateLimitError(text)) return null;
  const remain = Number((text.match(/remain\s+(\d+)\s*s/i) || [])[1]);
  if (Number.isFinite(remain) && remain > 0) return remain;
  const minutes = Number((text.match(/banned for\s+(\d+)\s*minutes?/i) || [])[1]);
  if (Number.isFinite(minutes) && minutes > 0) return minutes * 60;
  return null;
}

export class FourmemeAPI {
  private static readonly BASE_URL = "https://four.meme/meme-api/v1";
  private static readonly BAN_STORAGE_KEY = "dagobang_fourmeme_banned_until_v2";
  private static bannedUntil = 0;
  private static banSetAt = 0;
  private static banHydrated = false;
  private static banHydratePromise: Promise<void> | null = null;
  private static readonly loginCache = new Map<string, { token: string; ts: number }>();
  private static readonly LOGIN_CACHE_MS = 10 * 60 * 1000;

  private static clearExpiredBan() {
    if (this.bannedUntil > 0 && this.bannedUntil <= Date.now()) {
      this.bannedUntil = 0;
      this.banSetAt = 0;
    }
  }

  private static async hydrateBan() {
    if (this.banHydrated) return;
    if (this.banHydratePromise) {
      await this.banHydratePromise;
      return;
    }
    const pending = (async () => {
      try {
        const res = await browser.storage.local.get(this.BAN_STORAGE_KEY as any);
        const row = (res as any)?.[this.BAN_STORAGE_KEY];
        const until = Number(row?.until ?? row ?? 0);
        const setAt = Number(row?.setAt ?? 0);
        if (Number.isFinite(until) && until > Date.now()) {
          this.banSetAt = Number.isFinite(setAt) && setAt > 0 ? setAt : Date.now();
          this.bannedUntil = until;
        }
        this.clearExpiredBan();
      } catch {
      } finally {
        this.banHydrated = true;
      }
    })();
    this.banHydratePromise = pending;
    try {
      await pending;
    } finally {
      if (this.banHydratePromise === pending) this.banHydratePromise = null;
    }
  }

  private static persistBan() {
    void browser.storage.local.set({
      [this.BAN_STORAGE_KEY]: {
        until: this.bannedUntil,
        setAt: this.banSetAt,
      },
    } as any).catch(() => undefined);
  }

  private static rememberRateLimit(message: string) {
    const remain = parseFourmemeRateLimitRemainSec(message);
    if (remain == null) return false;
    const now = Date.now();
    const nextUntil = now + remain * 1000;
    if (nextUntil <= this.bannedUntil) return true;
    this.banSetAt = now;
    this.bannedUntil = nextUntil;
    this.persistBan();
    return true;
  }

  private static wrapNetworkError(error: unknown, label: string): never {
    const msg = String((error as any)?.message || error || '');
    if (/failed to fetch|networkerror|load failed|err_connection|err_failed|err_timed_out/i.test(msg)) {
      throw new Error(`${label}连接失败。请确认能打开 four.meme，或等待限流冷却后再试`);
    }
    throw error instanceof Error ? error : new Error(msg || label);
  }

  private static async throwIfBanned() {
    await this.hydrateBan();
    this.clearExpiredBan();
    const remain = Math.ceil((this.bannedUntil - Date.now()) / 1000);
    if (remain > 0) {
      throw new Error(`Four.Meme 接口限流中，剩余 ${remain}s。冷却结束前不会再发请求`);
    }
  }

  public static async assertNotRateLimited() {
    await this.throwIfBanned();
  }

  private static noteErrorPayload(result: any, fallback: string) {
    const msg = String(result?.msg || result?.message || fallback || '');
    this.rememberRateLimit(msg);
    throw new Error(msg || fallback);
  }

  private static dataUrlToBlob(dataUrl: string): Blob {
    const raw = String(dataUrl || '').trim();
    const commaIndex = raw.indexOf(',');
    if (!raw.startsWith('data:') || commaIndex <= 5) {
      throw new Error('Invalid data url');
    }
    const meta = raw.slice(5, commaIndex);
    const payload = raw.slice(commaIndex + 1);
    const isBase64 = /;base64/i.test(meta);
    const mime = (meta.split(';')[0] || 'application/octet-stream').trim() || 'application/octet-stream';
    if (isBase64) {
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    }
    return new Blob([decodeURIComponent(payload)], { type: mime });
  }

  private static extFromMime(mime: string): string {
    const m = String(mime || '').toLowerCase();
    if (m.includes('png')) return 'png';
    if (m.includes('webp')) return 'webp';
    if (m.includes('gif')) return 'gif';
    if (m.includes('bmp')) return 'bmp';
    if (m.includes('svg')) return 'svg';
    if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
    return 'png';
  }

  private static async makeRequest(url: string, options: RequestInit): Promise<Response> {
    await this.throwIfBanned();
    const headers = { ...(options.headers || {}) } as Record<string, string>;
    delete headers["content-length"];
    delete headers["accept-encoding"];
    delete headers["origin"];
    delete headers["referer"];
    delete headers["user-agent"];

    const requestOptions: RequestInit = {
      ...options,
      headers,
      credentials: "include",
    };

    try {
      return await fetch(url, requestOptions);
    } catch (error) {
      console.error("FourmemeAPI request failed:", url, error);
      this.wrapNetworkError(error, "Four.Meme 接口");
    }
  }

  private static getHeaders(): HeadersInit {
    return {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
    };
  }

  public static async generateNonce(accountAddress: string, networkCode: string): Promise<string> {
    await this.throwIfBanned();
    const endpoint = "/private/user/nonce/generate";
    const url = `${this.BASE_URL}${endpoint}`;
    const body = {
      accountAddress,
      verifyType: "LOGIN",
      networkCode,
    };
    const headers = this.getHeaders();
    const response = await this.makeRequest(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      this.noteErrorPayload(result, `Fourmeme generate nonce failed: ${response.status}`);
    }
    if (!result || (result.code !== "0" && result.code !== 0)) {
      this.noteErrorPayload(result, "Fourmeme generate nonce failed");
    }
    return String(result.data ?? "");
  }

  public static async loginDex(input: {
    address: string;
    signature: string;
    networkCode: string;
    walletName?: string;
    region?: string;
    langType?: string;
  }): Promise<string> {
    await this.throwIfBanned();
    const endpoint = "/private/user/login/dex";
    const url = `${this.BASE_URL}${endpoint}`;
    const body = {
      region: input.region || "WEB",
      langType: input.langType || "EN",
      loginIp: "",
      inviteCode: "",
      verifyInfo: {
        address: input.address,
        networkCode: input.networkCode,
        signature: input.signature,
        verifyType: "LOGIN",
      },
      walletName: input.walletName || "gmgn",
    };
    const headers = this.getHeaders();
    const response = await this.makeRequest(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      this.noteErrorPayload(result, `Fourmeme login failed: ${response.status}`);
    }
    if (!result || (result.code !== "0" && result.code !== 0)) {
      this.noteErrorPayload(result, "Fourmeme login failed");
    }
    const token = String(result.data ?? "");
    const key = String(input.address || "").trim().toLowerCase();
    if (key && token) {
      this.loginCache.set(key, { token, ts: Date.now() });
    }
    return token;
  }

  public static async getAccessToken(input: {
    address: string;
    networkCode: string;
    walletName?: string;
    signMessage: (message: string) => Promise<string>;
  }): Promise<string> {
    const key = String(input.address || "").trim().toLowerCase();
    const cached = key ? this.loginCache.get(key) : undefined;
    if (cached && Date.now() - cached.ts < this.LOGIN_CACHE_MS && cached.token) {
      return cached.token;
    }
    const nonce = await this.generateNonce(input.address, input.networkCode);
    const signature = await input.signMessage(`You are sign in Meme ${nonce}`);
    return this.loginDex({
      address: input.address,
      signature,
      networkCode: input.networkCode,
      walletName: input.walletName,
    });
  }

  public static async uploadImageFromUrl(imgUrl: string | string[], accessToken: string): Promise<string> {
    const candidates = (Array.isArray(imgUrl) ? imgUrl : [imgUrl])
      .map((x) => String(x || '').trim())
      .filter(Boolean);
    if (candidates.length <= 0) throw new Error('Image url is empty');

    let lastError: unknown = null;
    let blob: Blob | null = null;
    for (const inputUrl of candidates) {
      try {
        blob = inputUrl.startsWith('data:')
          ? this.dataUrlToBlob(inputUrl)
          : await (async () => {
            const downloadResp = await fetch(inputUrl);
            if (!downloadResp.ok) {
              throw new Error(`Failed to download image: ${downloadResp.status}`);
            }
            return await downloadResp.blob();
          })();
        if (blob) break;
      } catch (e) {
        lastError = e;
      }
    }
    if (!blob) {
      const msg = (lastError as any)?.message ? String((lastError as any).message) : 'Failed to download image from all candidates';
      if (/failed to fetch|networkerror|load failed/i.test(msg)) {
        throw new Error('代币图片下载失败，请换一张可访问的图片后重试');
      }
      throw new Error(msg);
    }
    await this.throwIfBanned();
    const formData = new FormData();
    const ext = this.extFromMime(blob.type);
    formData.append("file", blob, `logo.${ext}`);

    const endpoint = "/private/token/upload";
    const url = `${this.BASE_URL}${endpoint}`;
    const headers = this.getHeaders() as Record<string, string>;
    delete headers["content-type"];
    headers["meme-web-access"] = accessToken;

    const response = await this.makeRequest(url, {
      method: "POST",
      headers,
      body: formData,
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      this.noteErrorPayload(result, `Fourmeme upload image failed: ${response.status}`);
    }
    if (!result || (result.code !== "0" && result.code !== 0)) {
      this.noteErrorPayload(result, "Fourmeme upload image failed");
    }
    return String(result.data ?? "");
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
      const rateLimitMsg = String((result as any)?.msg || (result as any)?.message || '');
      if (this.rememberRateLimit(rateLimitMsg)) {
        return null;
      }

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
          description: data.descr || undefined,
          website: data.webUrl || undefined,
          twitterUrl: data.twitterUrl || undefined,
          telegramUrl: (data as any).telegramUrl || undefined,
          launchpad: "fourmeme",
          launchpad_progress: Number.isFinite(progress) ? progress : 0,
          launchpad_platform: "fourmeme",
          launchpad_status: status === "TRADE" ? 1 : 0,
          quote_token: data.symbol,
          quote_token_address: getQuoteTokenAddress(getChainIdByName(chainNormalized), data.symbol),
          pool_pair: data.dexPair?.pairAddress,
          dex_type: `${data.dexType}${data.dexPair?.pancakeVersion ? `_V${data.dexPair?.pancakeVersion}` : ""}`,
          tokenPrice: {
            price: data.tokenPrice?.price || "0",
            marketCap: data.tokenPrice?.marketCap || "0",
            timestamp: Number(data.tokenPrice?.modifyDate || 0),
          },
          totalSupply: data.totalAmount || undefined,
          aiCreator: data.aiCreator, // is ai agent
        };
      }

      return null;
    } catch (error) {
      console.error("Failed to fetch token info from Fourmeme:", error);
      return null;
    }
  }

  public static async createToken(input: {
    name: string;
    shortName: string;
    desc: string;
    imgUrl: string;
    launchTime?: number;
    label?: "Meme" | "AI" | "Defi" | "Games" | "Infra" | "De-Sci" | "Social" | "Depin" | "Charity" | "Others";
    lpTradingFee?: number;
    webUrl?: string;
    twitterUrl?: string;
    telegramUrl?: string;
    preSale: string;
    onlyMPC: boolean;
    feePlan?: boolean;
    tokenTaxInfo?: {
      burnRate: number;
      divideRate: number;
      feeRate: 1 | 3 | 5 | 10;
      liquidityRate: number;
      minSharing: number;
      recipientAddress: string;
      recipientRate: number;
    };
    raisedAmount?: number | string;
    totalSupply?: number | string;
    saleRate?: number | string;
    reserveRate?: number | string;
    funGroup?: boolean;
    clickFun?: boolean;
    raisedToken?: {
      symbol?: string;
      nativeSymbol?: string;
      symbolAddress?: string;
      deployCost?: string;
      buyFee?: string;
      sellFee?: string;
      minTradeFee?: string;
      b0Amount?: string;
      totalBAmount?: string;
      totalAmount?: string;
      logoUrl?: string;
      tradeLevel?: string[];
      status?: string;
      buyTokenLink?: string;
      reservedNumber?: number;
      saleRate?: string;
      networkCode?: string;
      platform?: string;
    };
  }, accessToken: string): Promise<any> {
    const endpoint = "/private/token/create";
    const url = `${this.BASE_URL}${endpoint}`;
    const defaultRaisedToken = {
      symbol: "BNB",
      nativeSymbol: "BNB",
      symbolAddress: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
      deployCost: "0",
      buyFee: "0.01",
      sellFee: "0.01",
      minTradeFee: "0",
      b0Amount: "8",
      totalBAmount: "24",
      totalAmount: "1000000000",
      logoUrl: "https://static.four.meme/market/68b871b6-96f7-408c-b8d0-388d804b34275092658264263839640.png",
      tradeLevel: ["0.1", "0.5", "1"],
      status: "PUBLISH",
      buyTokenLink: "https://pancakeswap.finance/swap",
      reservedNumber: 10,
      saleRate: "0.8",
      networkCode: "BSC",
      platform: "MEME",
    };
    const body = {
      name: input.name,
      shortName: input.shortName,
      symbol: (input.raisedToken?.symbol || "BNB").toUpperCase(),
      desc: input.desc,
      imgUrl: input.imgUrl,
      launchTime: input.launchTime,
      label: input.label,
      lpTradingFee: input.lpTradingFee,
      webUrl: input.webUrl,
      twitterUrl: input.twitterUrl,
      telegramUrl: input.telegramUrl,
      preSale: input.preSale,
      onlyMPC: input.onlyMPC,
      feePlan: input.feePlan,
      tokenTaxInfo: input.tokenTaxInfo,
      raisedAmount: input.raisedAmount ?? 24,
      totalSupply: input.totalSupply ?? 1000000000,
      saleRate: input.saleRate ?? 0.8,
      reserveRate: input.reserveRate ?? 0,
      funGroup: input.funGroup ?? false,
      clickFun: input.clickFun ?? false,
      raisedToken: {
        ...defaultRaisedToken,
        ...(input.raisedToken || {}),
      },
    };
    const headers = {
      ...this.getHeaders(),
      "meme-web-access": accessToken,
    };
    const response = await this.makeRequest(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      this.noteErrorPayload(result, `Fourmeme create token failed: ${response.status}`);
    }
    if (!result || (result.code !== "0" && result.code !== 0)) {
      this.noteErrorPayload(result, "Fourmeme create token failed");
    }
    return result.data;
  }

  public static async searchTokenTemplates(sort = "LAST"): Promise<FourmemeTokenTemplate[]> {
    await this.throwIfBanned();
    const endpoint = "/public/token_template/search";
    const url = `${this.BASE_URL}${endpoint}`;
    const response = await this.makeRequest(url, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({ sort }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      this.noteErrorPayload(result, `OpenFour template search failed: ${response.status}`);
    }
    if (!result || (result.code !== "0" && result.code !== 0)) {
      this.noteErrorPayload(result, "OpenFour template search failed");
    }
    return Array.isArray(result.data) ? result.data : [];
  }

  public static async getTokenTemplateConfig(templateId: number | string): Promise<FourmemeTokenTemplateConfig[]> {
    await this.throwIfBanned();
    const endpoint = `/public/token_template/config?templateId=${encodeURIComponent(String(templateId))}`;
    const url = `${this.BASE_URL}${endpoint}`;
    const response = await this.makeRequest(url, {
      method: "GET",
      headers: this.getHeaders(),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      this.noteErrorPayload(result, `OpenFour template config failed: ${response.status}`);
    }
    if (!result || (result.code !== "0" && result.code !== 0)) {
      this.noteErrorPayload(result, "OpenFour template config failed");
    }
    return Array.isArray(result.data) ? result.data : [];
  }

  public static async createOpenFourToken(
    input: {
      templateId: number | string;
      name: string;
      shortName: string;
      symbol: string;
      desc: string;
      imgUrl: string;
      webUrl?: string;
      telegramUrl?: string;
      twitterUrl?: string;
      presaleQuote: number | string;
      feePlan: boolean;
      antiSniperEnabled?: boolean;
      raisedAmount?: number | string;
      saleAmount?: number | string;
      totalSupply?: number | string;
      quoteAsset?: string;
      initParams: OpenFourCreateInitParams;
    },
    accessToken: string,
  ): Promise<OpenFourCreateApiResult> {
    await this.throwIfBanned();
    const endpoint = "/private/token_template/token/create";
    const url = `${this.BASE_URL}${endpoint}`;
    const body = {
      presetId: input.templateId,
      templateId: input.templateId,
      name: input.name,
      shortName: input.shortName,
      symbol: input.symbol,
      desc: input.desc,
      imgUrl: input.imgUrl,
      tokenUri: input.imgUrl,
      webUrl: input.webUrl,
      telegramUrl: input.telegramUrl,
      twitterUrl: input.twitterUrl,
      presaleQuote: input.presaleQuote,
      preSale: input.presaleQuote,
      feePlan: input.feePlan,
      antiSniperEnabled: input.antiSniperEnabled,
      raisedAmount: input.raisedAmount,
      raiseAmount: input.raisedAmount,
      saleAmount: input.saleAmount,
      totalSupply: input.totalSupply,
      maxSupply: input.totalSupply,
      quoteAsset: input.quoteAsset,
      symbolAddress: input.quoteAsset,
      initParams: input.initParams,
    };
    const headers = {
      ...this.getHeaders(),
      "meme-web-access": accessToken,
    };
    const response = await this.makeRequest(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      this.noteErrorPayload(result, `OpenFour create token failed: ${response.status}`);
    }
    if (!result || (result.code !== "0" && result.code !== 0)) {
      this.noteErrorPayload(result, "OpenFour create token failed");
    }
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!row) {
      throw new Error("OpenFour create token returned empty data");
    }
    return row as OpenFourCreateApiResult;
  }
}

export interface FourmemeTokenTemplate {
  id: number | string;
  name?: string;
  tag?: string;
  descr?: string;
  status?: string;
  imgUrl?: string;
  amount?: string;
  deploys?: number;
}

export interface FourmemeTokenTemplateConfig {
  id?: number;
  symbol?: string;
  symbolAddress?: string;
  fullName?: string;
  totalSupply?: string;
  saleAmount?: string;
  raisedAmount?: string;
  createFee?: string;
  decimals?: number;
}

export interface OpenFourCreateInitParams {
  tokenParams: string;
  vaultParams: string;
  curveParams: string;
  tradeParams: string;
  migrateParams: string;
  customDataParams: string;
}

export interface OpenFourCreateApiResult {
  tokenId?: string | number;
  tokenAddress?: string;
  createArg?: string;
  signature?: string;
  sign?: string;
  createFee?: string | number;
}

export default FourmemeAPI;
