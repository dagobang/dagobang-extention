import GmgnAPI from "./GmgnAPI";
import AxiomAPI from "./AxiomAPI";
import { TokenInfo } from "@/types/token";
import { call } from "@/utils/messaging";

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
                    const fourmemeTokenInfo = await this.getTokenInfoByFourmemeHttp(platform, chain, address);
                    if (fourmemeTokenInfo) {
                        return fourmemeTokenInfo;
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
            return await this.getTokenInfoByFourmemeHttp(platform, chain, address);
        }
        return null;
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
