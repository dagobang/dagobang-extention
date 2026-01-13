import GmgnAPI from "./GmgnAPI";
import AxiomAPI from "./AxiomAPI";
import { FourmemeTokenInfo, TokenInfo } from "@/types/token";
import { call } from "@/utils/messaging";
import { parseEther } from "viem";
import { getChainIdByName } from "@/constants/chains";

const PLATFORM_API: Record<string, { getTokenInfo: (chain: string, address: string) => Promise<TokenInfo | null> }> = {
    "gmgn": GmgnAPI,
    "axiom": AxiomAPI,
};

export class TokenAPI {
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
                if (["4444", "7777", "8888"].includes(address.substring(address.length - 4))) {
                    return tokenInfo;
                }
                return null;
            }
        }

        if (address.endsWith("7777") || address.endsWith("8888")) {
            return await this.getTokenInfoByFlapHttp(platform, chain, address);
        }
        if (address.endsWith("4444")) {
            return await this.getTokenInfoByFourmeme(platform, chain, address);
        }
        return null;
    }

    static async getBalance(platform: string, chain: string, address: string, tokenAddress: string): Promise<string | null> {
        if (platform === 'gmgn') {
            const balance = await GmgnAPI.getBalance(chain, address, tokenAddress) ?? null;
            if (balance) {
                return parseEther(balance).toString();
            }
        }

        if (tokenAddress === '0x0000000000000000000000000000000000000000') {
            const bal = await call({ type: 'chain:getBalance', address: address as `0x${string}` });
            return bal?.balanceWei ?? null;
        }

        const tokenAddressNormalized = tokenAddress.toLowerCase() as `0x${string}`;
        const bal = await call({ type: 'token:getBalance', tokenAddress: tokenAddressNormalized, address: address as `0x${string}` });
        return bal?.balanceWei ?? null;
    }

    static async getTokenHolding(platform: string, chain: string, walletAddress: string, tokenAddress: string): Promise<string | null> {
        if (platform === 'gmgn') {
            const holding = await GmgnAPI.getTokenHolding(chain, walletAddress, tokenAddress) ?? null;
            if (holding) {
                return parseEther(holding).toString();
            }
        }
        const tokenAddressNormalized = tokenAddress.toLowerCase() as `0x${string}`;
        const bal = await call({ type: 'token:getBalance', tokenAddress: tokenAddressNormalized, address: walletAddress as `0x${string}` });
        return bal?.balanceWei ?? null;
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
}
