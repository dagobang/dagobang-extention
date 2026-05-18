import GmgnAPI from "./GmgnAPI";
import AxiomAPI from "./AxiomAPI";
import { FlapTokenStateV7, FourmemeTokenInfo, TokenInfo } from "@/types/token";
import { call } from "@/utils/messaging";
import { parseEther, zeroAddress } from "viem";
import { chainNames, getChainIdByName } from "@/constants/chains";
import { MEME_SUFFIXS } from "@/constants/meme";
import FlapAPI from "./FlapAPI";

const PLATFORM_API: Record<string, { getTokenInfo: (chain: string, address: string) => Promise<TokenInfo | null> }> = {
    "gmgn": GmgnAPI,
    "axiom": AxiomAPI,
};


export class TokenAPI {
    private static balanceCache = new Map<string, { ts: number; value: string | null }>();
    private static balanceInFlight = new Map<string, Promise<string | null>>();
    private static tokenInfoCache = new Map<string, { ts: number; value: TokenInfo | null }>();
    private static tokenInfoInFlight = new Map<string, Promise<TokenInfo | null>>();
    private static readonly altfunGraduatedTokenInfoCacheTtlMs = 15000;
    private static toBalanceKey(platform: string, chain: string, address: string, tokenAddress: string) {
        return `${platform}:${chain}:${address.toLowerCase()}:${tokenAddress.toLowerCase()}`;
    }
    private static toTokenInfoKey(platform: string, chain: string, tokenAddress: string) {
        return `${platform}:${chain}:${tokenAddress.toLowerCase()}`;
    }
    private static resolveTokenInfoCacheTtlMs(platform: string, requestedTtlMs: number, value: TokenInfo | null | undefined) {
        if (!(requestedTtlMs > 0)) return 0;
        if (platform === 'altfun' && value?.launchpad_status === 1) {
            return Math.max(requestedTtlMs, this.altfunGraduatedTokenInfoCacheTtlMs);
        }
        return requestedTtlMs;
    }

    static async getTokenInfo(
        platform: string,
        chain: string,
        tokenAddress: string,
        opts?: { cacheTtlMs?: number }
    ): Promise<TokenInfo | null> {
        const key = this.toTokenInfoKey(platform, chain, tokenAddress);
        const now = Date.now();
        const requestedTtl = typeof opts?.cacheTtlMs === 'number' && opts.cacheTtlMs >= 0
            ? opts.cacheTtlMs
            : 0;
        const cached = this.tokenInfoCache.get(key);
        const effectiveCachedTtl = this.resolveTokenInfoCacheTtlMs(platform, requestedTtl, cached?.value);
        if (effectiveCachedTtl > 0 && cached && now - cached.ts < effectiveCachedTtl) {
            if (platform === 'altfun') {
                console.log('[tokenInfo.cache.hit]', {
                    platform,
                    chain,
                    tokenAddress: tokenAddress.toLowerCase(),
                    ageMs: now - cached.ts,
                    requestedTtlMs: requestedTtl,
                    effectiveTtlMs: effectiveCachedTtl,
                    graduated: cached.value?.launchpad_status === 1,
                });
            }
            return cached.value;
        }
        const inflight = this.tokenInfoInFlight.get(key);
        if (inflight) {
            if (platform === 'altfun') {
                console.log('[tokenInfo.inflight.reuse]', {
                    platform,
                    chain,
                    tokenAddress: tokenAddress.toLowerCase(),
                });
            }
            return await inflight;
        }

        const p = (async (): Promise<TokenInfo | null> => {
            const startedAt = Date.now();
            let nextValue: TokenInfo | null = null;
            if (platform === 'altfun') {
                console.log('[tokenInfo.fetch.start]', {
                    platform,
                    chain,
                    tokenAddress: tokenAddress.toLowerCase(),
                    requestedTtlMs: requestedTtl,
                });
            }
            if (platform === 'altfun') {
                const res = await call({
                    type: 'token:getTokenInfo:altfun',
                    chainId: getChainIdByName(chain),
                    tokenAddress: tokenAddress as `0x${string}`,
                } as any) as { tokenInfo: TokenInfo | null };
                nextValue = res.tokenInfo;
            } else {
                const api = PLATFORM_API[platform];
                let address = tokenAddress;
                if (api) {
                    try {
                        const tokenInfo = await api.getTokenInfo(chain, address);
                        if (tokenInfo) {
                            if (tokenInfo.launchpad_platform.includes('four') && tokenInfo.quote_token != "BNB") {
                                const fourmemeTokenInfo = await this.getTokenInfoByFourmeme(platform, chain, address);
                                if (fourmemeTokenInfo) {
                                    nextValue = fourmemeTokenInfo;
                                } else {
                                    nextValue = tokenInfo;
                                }
                            } else if (
                                MEME_SUFFIXS.includes(address.substring(address.length - 4)) ||
                                tokenInfo.launchpad_platform.includes('four')
                            ) {
                                nextValue = tokenInfo;
                            } else {
                                nextValue = null;
                            }
                        }
                    } catch {
                        // Fallback to Fourmeme/Flap resolvers when third-party platform API is unavailable.
                    }
                }

                if (nextValue == null) {
                    if (address.endsWith("7777") || address.endsWith("8888")) {
                        nextValue = await this.getTokenInfoByFlap(platform, chain, address);
                    } else {
                        nextValue = await this.getTokenInfoByFourmeme(platform, chain, address);
                    }
                }
            }
            this.tokenInfoCache.set(key, { ts: Date.now(), value: nextValue });
            if (platform === 'altfun') {
                const effectiveNextTtl = this.resolveTokenInfoCacheTtlMs(platform, requestedTtl, nextValue);
                console.log('[tokenInfo.fetch.done]', {
                    platform,
                    chain,
                    tokenAddress: tokenAddress.toLowerCase(),
                    elapsedMs: Date.now() - startedAt,
                    hasValue: !!nextValue,
                    requestedTtlMs: requestedTtl,
                    effectiveTtlMs: effectiveNextTtl,
                    graduated: nextValue?.launchpad_status === 1,
                });
            }
            return nextValue;
        })().finally(() => {
            this.tokenInfoInFlight.delete(key);
        });
        this.tokenInfoInFlight.set(key, p);
        return await p;
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
            const readOnchainWei = async (): Promise<string | null> => {
                const chainId = getChainIdByName(chain);
                if (tokenAddress === '0x0000000000000000000000000000000000000000') {
                    const bal = await call({ type: 'chain:getBalance', address: address as `0x${string}`, chainId });
                    return bal?.balanceWei ?? null;
                }
                const tokenAddressNormalized = tokenAddress.toLowerCase() as `0x${string}`;
                const bal = await call({
                    type: 'token:getBalance',
                    tokenAddress: tokenAddressNormalized,
                    address: address as `0x${string}`,
                    chainId,
                });
                return bal?.balanceWei ?? null;
            };

            if (platform !== 'gmgn') {
                const onchainWei = await readOnchainWei();
                this.balanceCache.set(key, { ts: Date.now(), value: onchainWei });
                return onchainWei;
            }

            const [gmgnWei, onchainWei] = await Promise.all([
                (async (): Promise<string | null> => {
                    try {
                        const balance = await GmgnAPI.getBalance(chain, address, tokenAddress);
                        if (balance == null || String(balance).trim() === '') return null;
                        return parseEther(String(balance)).toString();
                    } catch {
                        return null;
                    }
                })(),
                readOnchainWei().catch(() => null),
            ]);

            const gmgnBig = gmgnWei != null ? BigInt(gmgnWei) : null;
            const onchainBig = onchainWei != null ? BigInt(onchainWei) : null;
            const picked =
                gmgnBig != null && onchainBig != null
                    ? (gmgnBig > onchainBig ? gmgnBig : onchainBig).toString()
                    : (gmgnBig != null ? gmgnBig.toString() : (onchainBig != null ? onchainBig.toString() : null));
            this.balanceCache.set(key, { ts: Date.now(), value: picked });
            return picked;
        })().finally(() => {
            this.balanceInFlight.delete(key);
        });
        this.balanceInFlight.set(key, p);
        return p;
    }

    static async getTokenHolding(platform: string, chain: string, walletAddress: string, tokenAddress: string, opts?: { cacheTtlMs?: number }): Promise<string | null> {
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

    static async getTokenInfoByFlapContract(chain: string, address: string): Promise<FlapTokenStateV7 | null> {
        const res = await call({
            type: 'token:getTokenInfo:flap',
            chainId: getChainIdByName(chain), tokenAddress: address as `0x${string}`
        }) as FlapTokenStateV7
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
            if (contractInfo.aiCreator !== undefined) {
                httpInfo.aiCreator = contractInfo.aiCreator;
            }
            return httpInfo;
        }
        return null;
    }

    static async getTokenInfoByFlap(platform: string, chain: string, address: string): Promise<TokenInfo | null> {
        const [contractInfo, httpInfo] = await Promise.all([
            this.getTokenInfoByFlapContract(chain, address),
            platform === 'flap' ? FlapAPI.getTokenInfo(chain, address) : null,
        ]);
        if (contractInfo && httpInfo) {
            httpInfo.quote_token_address = contractInfo.quoteTokenAddress;
            return httpInfo;
        }
        if (contractInfo) {
            const progress = (() => {
                const v = Number(contractInfo.progress);
                const n = Number.isFinite(v) && v > 0 ? v / 1e18 : 0;
                return Number.isFinite(n) ? n : 0;
            })();

            return {
                chain,
                address,
                name: contractInfo.symbol,
                symbol: contractInfo.symbol,
                decimals: contractInfo.decimals,
                logo: '',
                launchpad: 'flap',
                launchpad_progress: progress,
                launchpad_platform: 'flap',
                launchpad_status: contractInfo.pool === zeroAddress ? 0 : 1,
                quote_token: contractInfo.quoteTokenAddress,
                pool_pair: contractInfo.pool === zeroAddress ? undefined : contractInfo.pool,
                // tokenPrice: {
                //     price: contractInfo.price,
                //     marketCap: contractInfo.circulatingSupply,
                //     timestamp: Date.now(),
                // }
            }
        }
        return null;
    }

    static async getPoolPair(chain: string, address: string): Promise<{ token0: string; token1: string } | null> {
        const chainId = getChainIdByName(chain);
        const res = await call({
            type: 'token:getPoolPair',
            chainId,
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
            const v = Number(res.priceUsd);
            return Number.isFinite(v) && v > 0 ? v : null;
        } catch {
            return null;
        }
    }
}
