import GmgnAPI from "./GmgnAPI";
import AxiomAPI from "./AxiomAPI";
import { FourmemeTokenInfo, TokenInfo } from "@/types/token";
import { call } from "@/utils/messaging";
import { parseEther } from "viem";
import { chainNames, getChainIdByName } from "@/constants/chains";
import { MEME_SUFFIXS } from "@/constants/meme";

const PLATFORM_API: Record<string, { getTokenInfo: (chain: string, address: string) => Promise<TokenInfo | null> }> = {
    "gmgn": GmgnAPI,
    "axiom": AxiomAPI,
};


export class TokenAPI {
    private static balanceCache = new Map<string, { ts: number; value: string | null }>();
    private static balanceInFlight = new Map<string, Promise<string | null>>();
    private static toBalanceKey(platform: string, chain: string, address: string, tokenAddress: string) {
        return `${platform}:${chain}:${address.toLowerCase()}:${tokenAddress.toLowerCase()}`;
    }

    static async getTokenInfo(platform: string, chain: string, tokenAddress: string): Promise<TokenInfo | null> {
        const api = PLATFORM_API[platform];
        let address = tokenAddress;
        if (api) {
            const tokenInfo = await api.getTokenInfo(chain, address);
            if (tokenInfo) {
                if (tokenInfo.launchpad_platform.includes('fourmeme') && tokenInfo.quote_token != "BNB") {
                    const fourmemeTokenInfo = await this.getTokenInfoByFourmeme(platform, chain, address);
                    if (fourmemeTokenInfo) {
                        return fourmemeTokenInfo
                    }
                }
                if (MEME_SUFFIXS.includes(address.substring(address.length - 4)) ||
                    tokenInfo.launchpad_platform.includes('fourmeme')) {
                    return tokenInfo;
                }
                return null;
            }
        }

        if (address.endsWith("7777") || address.endsWith("8888")) {
            return await this.getTokenInfoByFlapHttp(platform, chain, address);
        }

        return await this.getTokenInfoByFourmeme(platform, chain, address);
    }

    static async getBalance(platform: string, chain: string, address: string, tokenAddress: string, opts?: { cacheTtlMs?: number }): Promise<string | null> {
        const ttl = typeof opts?.cacheTtlMs === 'number' && opts.cacheTtlMs >= 0 ? opts.cacheTtlMs : 0;
        const key = this.toBalanceKey(platform, chain, address, tokenAddress);
        const now = Date.now();
        const cached = this.balanceCache.get(key);
        if (ttl > 0 && cached && now - cached.ts < ttl) return cached.value;
        const inflight = this.balanceInFlight.get(key);
        if (inflight) return inflight;

        const p = (async (): Promise<string | null> => {
        if (platform === 'gmgn') {
            const balance = await GmgnAPI.getBalance(chain, address, tokenAddress) ?? null;
            if (balance) {
                    const v = parseEther(balance).toString();
                    this.balanceCache.set(key, { ts: Date.now(), value: v });
                    return v;
            }
        }

        if (tokenAddress === '0x0000000000000000000000000000000000000000') {
            const bal = await call({ type: 'chain:getBalance', address: address as `0x${string}` });
                const v = bal?.balanceWei ?? null;
                this.balanceCache.set(key, { ts: Date.now(), value: v });
                return v;
        }

        const tokenAddressNormalized = tokenAddress.toLowerCase() as `0x${string}`;
        const bal = await call({ type: 'token:getBalance', tokenAddress: tokenAddressNormalized, address: address as `0x${string}` });
            const v = bal?.balanceWei ?? null;
            this.balanceCache.set(key, { ts: Date.now(), value: v });
            return v;
        })().finally(() => {
            this.balanceInFlight.delete(key);
        });
        this.balanceInFlight.set(key, p);
        return p;
    }

    static async getTokenHolding(platform: string, chain: string, walletAddress: string, tokenAddress: string, opts?: { cacheTtlMs?: number }): Promise<string | null> {
        if (platform === 'gmgn') {
            const holding = await GmgnAPI.getTokenHolding(chain, walletAddress, tokenAddress) ?? null;
            if (holding) {
                return parseEther(holding).toString();
            }
        }

        const tokenAddressNormalized = tokenAddress.toLowerCase() as `0x${string}`;
        return await this.getBalance(platform, chain, walletAddress, tokenAddressNormalized, opts);
    }

    static async getTokenInfoByFourmemeContract(chain: string, address: string): Promise<FourmemeTokenInfo | null> {
        const res = await call({
            type: 'token:getTokenInfo:fourmeme',
            chainId: getChainIdByName(chain), tokenAddress: address as `0x${string}`
        }) as FourmemeTokenInfo
        return res;
    }

    static async getTokenInfoByFourmemeHttp(platform: string, chain: string, address: string): Promise<TokenInfo | null> {
        const res = await call({
            type: 'token:getTokenInfo:fourmemeHttp',
            platform,
            chain,
            address: address as `0x${string}`,
        });
        return res.tokenInfo;
    }

    static async getTokenInfoByFourmeme(platform: string, chain: string, address: string): Promise<TokenInfo | null> {
        const [contractInfo, httpInfo] = await Promise.all([
            this.getTokenInfoByFourmemeContract(chain, address),
            this.getTokenInfoByFourmemeHttp(platform, chain, address),
        ]);
        if (contractInfo && httpInfo) {
            httpInfo.quote_token_address = contractInfo.quote;
            return httpInfo;
        }
        return null;
    }

    static async getTokenInfoByFlapHttp(platform: string, chain: string, address: string): Promise<TokenInfo | null> {
        const res = await call({
            type: 'token:getTokenInfo:flapHttp',
            platform,
            chain,
            address: address as `0x${string}`,
        });
        return res.tokenInfo;
    }

    static async getPoolPair(chain: string, address: string): Promise<{ token0: string; token1: string } | null> {
        const res = await call({
            type: 'token:getPoolPair',
            chain,
            pair: address as `0x${string}`,
        });
        return { token0: res.token0, token1: res.token1 };
    }

    static async getTokenPriceUsd(platform: string, chainId: number, tokenAddress: string, tokenInfo?: TokenInfo | null): Promise<number | null> {

        try {
            // Try to get price from GMGN
            const tokenStat = platform === 'gmgn' ? await GmgnAPI.getTokenPrice(chainNames[chainId], tokenAddress) : null;
            if (tokenStat && tokenStat.price) {
                return Number(tokenStat.price);
            }
        } catch {

        }

        try {
            // Try to get price from DEX
            const res = await call({
                type: 'token:getPriceUsd',
                chainId,
                tokenAddress: tokenAddress as `0x${string}`,
                tokenInfo: tokenInfo ?? null,
            });
            console.warn('getTokenPriceUsd', tokenAddress, res);
            const v = Number(res.priceUsd);
            return Number.isFinite(v) && v > 0 ? v : null;
        } catch {
            return null;
        }
    }
}
