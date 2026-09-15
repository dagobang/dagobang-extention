import GmgnAPI from "./GmgnAPI";
import DexScreenerAPI, { DexScreenerPair } from "./DexScreenerAPI";
import { FlapTokenStateV7, FourmemeTokenInfo, TokenInfo } from "@/types/token";
import { call } from "@/utils/messaging";
import { parseEther } from "viem";
import { getChainIdByName, toGmgnChainName } from "@/constants/chains";
import { ChainId } from "@/constants/chains/chainId";
import { MEME_SUFFIXS } from "@/constants/meme";
import { getSupportedLaunchpads, isLongLaunchpadPlatform, isO1LaunchpadPlatform, normalizeLaunchpadPlatform } from "@/constants/launchpad";
import { classifyFlapRoute, hasConfirmedFlapOuterRoute, hasNonTerminalFlapOuterQuote, isUsableFlapDexPoolAddress, normalizeFlapLaunchpadStatus, resolveFlapPlatform, resolveFlapPlatformByQuoteLineage } from "@/utils/flap";
import { inferLaunchpadFamilyByAddress, resolveTokenLaunchpadPlatform } from "@/utils/launchpadFamily";
import { preferRouteTokenSymbol } from "@/utils/quoteTokenLabels";
import { isTradeRouteTerminalQuote } from "@/utils/tradeRouteTerminals";

const FOUR_MEME_LIKE_LAUNCHPADS = new Set([
    'fourmeme',
    'fourmeme_agent',
    'xmode',
    'xmode_agent',
]);

const FLAP_LIKE_LAUNCHPADS = new Set([
    'flap',
    'flap_stocks',
    'flap_aioracle',
]);

export class TokenAPI {
    private static balanceCache = new Map<string, { ts: number; value: string | null }>();
    private static balanceInFlight = new Map<string, Promise<string | null>>();
    private static tokenInfoCache = new Map<string, { ts: number; value: TokenInfo | null }>();
    private static tokenInfoInFlight = new Map<string, Promise<TokenInfo | null>>();
    private static flapEnrichInFlight = new Map<string, Promise<void>>();
    private static readonly altfunGraduatedTokenInfoCacheTtlMs = 15000;
    private static shouldDebugAltfunTokenInfo() {
        return (window as any).__DAGOBANG_SETTINGS__?.ui?.consoleLogsEnabled === true;
    }
    private static toBalanceKey(platform: string, chain: string, address: string, tokenAddress: string) {
        const chainId = getChainIdByName(chain);
        const addressKey = chainId === ChainId.SOL ? address : address.toLowerCase();
        const tokenKey = chainId === ChainId.SOL ? tokenAddress : tokenAddress.toLowerCase();
        return `${platform}:${chain}:${addressKey}:${tokenKey}`;
    }
    private static toTokenInfoKey(platform: string, chain: string, tokenAddress: string) {
        const chainId = getChainIdByName(chain);
        const tokenKey = chainId === ChainId.SOL ? tokenAddress : tokenAddress.toLowerCase();
        return `${platform}:${chain}:${tokenKey}`;
    }

    private static resolveTokenInfoCacheTtlMs(platform: string, requestedTtlMs: number, value: TokenInfo | null | undefined) {
        if (!(requestedTtlMs > 0)) return 0;
        if (platform === 'altfun' && value?.launchpad_status === 1) {
            return Math.max(requestedTtlMs, this.altfunGraduatedTokenInfoCacheTtlMs);
        }
        return requestedTtlMs;
    }

    private static mergeFlapEnrichedTokenInfo(base: TokenInfo | null | undefined, enriched: TokenInfo | null | undefined): TokenInfo | null {
        if (!base && !enriched) return null;
        if (!base) return enriched ?? null;
        if (!enriched) return base;

        const merged: TokenInfo = {
            ...base,
            ...enriched,
            chain: base.chain || enriched.chain,
            address: base.address || enriched.address,
            name: base.name || enriched.name,
            symbol: base.symbol || enriched.symbol,
            decimals: base.decimals || enriched.decimals,
            logo: base.logo || enriched.logo,
            website: base.website || enriched.website,
            twitterUrl: base.twitterUrl || enriched.twitterUrl,
            gmgnUrl: base.gmgnUrl || enriched.gmgnUrl,
            launchpad: base.launchpad || enriched.launchpad,
            launchpad_platform: enriched.launchpad_platform || base.launchpad_platform,
            launchpad_status: base.launchpad_status ?? enriched.launchpad_status,
            launchpad_progress: base.launchpad_progress ?? enriched.launchpad_progress,
            quote_token: base.quote_token || enriched.quote_token,
            quote_token_address: enriched.quote_token_address || base.quote_token_address,
            pool_pair: enriched.pool_pair || base.pool_pair,
            biggest_pool_address: enriched.biggest_pool_address || base.biggest_pool_address,
            tpool_pool_address: enriched.tpool_pool_address || base.tpool_pool_address,
            dex_type: enriched.dex_type || base.dex_type,
            nativeToQuoteSwapEnabled: enriched.nativeToQuoteSwapEnabled ?? base.nativeToQuoteSwapEnabled,
            tokenVersion: enriched.tokenVersion ?? base.tokenVersion,
            extensionID: enriched.extensionID ?? base.extensionID,
            dexId: enriched.dexId ?? base.dexId,
            flap_dividend_token: enriched.flap_dividend_token || base.flap_dividend_token,
            flap_vault_address: enriched.flap_vault_address || base.flap_vault_address,
            flap_vault_factory: enriched.flap_vault_factory || base.flap_vault_factory,
            flap_vault_is_official: enriched.flap_vault_is_official ?? base.flap_vault_is_official,
            flap_vault_is_vault: enriched.flap_vault_is_vault ?? base.flap_vault_is_vault,
            flap_vault_is_ai_consumer: enriched.flap_vault_is_ai_consumer ?? base.flap_vault_is_ai_consumer,
            flap_stocks_vault_version: enriched.flap_stocks_vault_version ?? base.flap_stocks_vault_version,
            flap_outer_quote_is_stocks: enriched.flap_outer_quote_is_stocks ?? base.flap_outer_quote_is_stocks,
            flap_basket_token: enriched.flap_basket_token || base.flap_basket_token,
            flap_supported_assets: enriched.flap_supported_assets ?? base.flap_supported_assets,
            tokenPrice: base.tokenPrice ?? enriched.tokenPrice,
        };

        const chainId = getChainIdByName(merged.chain);
        const requestedPlatform = resolveTokenLaunchpadPlatform({
            address: merged.address,
            launchpad: merged.launchpad,
            launchpad_platform: base.launchpad_platform || enriched.launchpad_platform,
            requestedPlatform: enriched.launchpad_platform || base.launchpad_platform,
        });
        if (Number.isFinite(chainId) && (FLAP_LIKE_LAUNCHPADS.has(requestedPlatform) || inferLaunchpadFamilyByAddress(merged.address) === 'flap')) {
            merged.launchpad_platform = resolveFlapPlatform(chainId, merged, requestedPlatform || 'flap');
        }

        return merged;
    }

    private static mergePonsEnrichedTokenInfo(base: TokenInfo | null | undefined, pons: TokenInfo | null | undefined): TokenInfo | null {
        if (!base && !pons) return null;
        if (!pons) return base ?? null;
        if (!base) return pons;
        return {
            ...base,
            ...pons,
            chain: base.chain || pons.chain,
            address: base.address || pons.address,
            name: base.name || pons.name,
            symbol: base.symbol || pons.symbol,
            decimals: base.decimals || pons.decimals,
            logo: base.logo || pons.logo,
            website: base.website || pons.website,
            twitterUrl: base.twitterUrl || pons.twitterUrl,
            telegramUrl: base.telegramUrl || pons.telegramUrl,
            gmgnUrl: base.gmgnUrl || pons.gmgnUrl,
            launchpad: pons.launchpad || base.launchpad,
            launchpad_platform: pons.launchpad_platform || base.launchpad_platform,
            launchpad_status: pons.launchpad_status ?? base.launchpad_status,
            launchpad_progress: pons.launchpad_progress ?? base.launchpad_progress,
            quote_token: preferRouteTokenSymbol(pons.quote_token, base.quote_token) || pons.quote_token || base.quote_token,
            quote_token_address: pons.quote_token_address || base.quote_token_address,
            pool_pair: pons.pool_pair || base.pool_pair,
            biggest_pool_address: base.biggest_pool_address || pons.biggest_pool_address,
            dex_type: pons.dex_type || base.dex_type,
            tokenPrice: base.tokenPrice ?? pons.tokenPrice,
        };
    }

    private static mergeO1EnrichedTokenInfo(base: TokenInfo | null | undefined, o1: TokenInfo | null | undefined): TokenInfo | null {
        if (!base && !o1) return null;
        if (!o1) return base ?? null;
        if (!base) return o1;
        return {
            ...base,
            ...o1,
            chain: base.chain || o1.chain,
            address: base.address || o1.address,
            name: base.name || o1.name,
            symbol: base.symbol || o1.symbol,
            decimals: base.decimals || o1.decimals,
            logo: base.logo || o1.logo,
            website: base.website || o1.website,
            twitterUrl: base.twitterUrl || o1.twitterUrl,
            telegramUrl: base.telegramUrl || o1.telegramUrl,
            gmgnUrl: base.gmgnUrl || o1.gmgnUrl,
            launchpad: o1.launchpad || base.launchpad,
            launchpad_platform: o1.launchpad_platform || base.launchpad_platform,
            launchpad_status: 1,
            launchpad_progress: Math.max(Number(base.launchpad_progress || 0), Number(o1.launchpad_progress || 0), 1),
            quote_token: preferRouteTokenSymbol(o1.quote_token, base.quote_token) || o1.quote_token || base.quote_token,
            quote_token_address: o1.quote_token_address || base.quote_token_address,
            pool_pair: o1.pool_pair || base.pool_pair,
            biggest_pool_address: o1.biggest_pool_address || base.biggest_pool_address,
            tpool_pool_address: o1.tpool_pool_address || base.tpool_pool_address,
            dex_type: o1.dex_type || base.dex_type || 'UNISWAP_V4',
            tokenPrice: base.tokenPrice ?? o1.tokenPrice,
            totalSupply: base.totalSupply || o1.totalSupply,
        };
    }

    private static mergeLongEnrichedTokenInfo(base: TokenInfo | null | undefined, longInfo: TokenInfo | null | undefined): TokenInfo | null {
        if (!base && !longInfo) return null;
        if (!longInfo) return base ?? null;
        if (!base) return longInfo;
        return {
            ...base,
            ...longInfo,
            chain: base.chain || longInfo.chain,
            address: base.address || longInfo.address,
            name: base.name || longInfo.name,
            symbol: base.symbol || longInfo.symbol,
            decimals: base.decimals || longInfo.decimals,
            logo: base.logo || longInfo.logo,
            website: base.website || longInfo.website,
            twitterUrl: base.twitterUrl || longInfo.twitterUrl,
            telegramUrl: base.telegramUrl || longInfo.telegramUrl,
            gmgnUrl: base.gmgnUrl || longInfo.gmgnUrl,
            launchpad: longInfo.launchpad || base.launchpad,
            launchpad_platform: longInfo.launchpad_platform || base.launchpad_platform,
            // Keep GMGN epoch progress; routing treats long as outer V4 regardless.
            launchpad_status: base.launchpad_status ?? longInfo.launchpad_status,
            launchpad_progress: Math.max(Number(base.launchpad_progress || 0), Number(longInfo.launchpad_progress || 0)),
            quote_token: preferRouteTokenSymbol(longInfo.quote_token, base.quote_token) || longInfo.quote_token || base.quote_token,
            quote_token_address: longInfo.quote_token_address || base.quote_token_address,
            pool_pair: longInfo.pool_pair || base.pool_pair,
            biggest_pool_address: longInfo.biggest_pool_address || base.biggest_pool_address,
            tpool_pool_address: longInfo.tpool_pool_address || base.tpool_pool_address,
            dex_type: longInfo.dex_type || base.dex_type || 'UNISWAP_V4',
            tokenPrice: base.tokenPrice ?? longInfo.tokenPrice,
            totalSupply: base.totalSupply || longInfo.totalSupply,
        };
    }

    private static async getTokenInfoByPons(chain: string, address: string): Promise<TokenInfo | null> {
        const res = await call({
            type: 'token:getTokenInfo:pons',
            chainId: getChainIdByName(chain) || ChainId.RH,
            tokenAddress: address as `0x${string}`,
        } as any) as { tokenInfo: TokenInfo | null };
        return res.tokenInfo ?? null;
    }

    private static async getTokenInfoByO1(chain: string, address: string, seed?: TokenInfo | null): Promise<TokenInfo | null> {
        const res = await call({
            type: 'token:getTokenInfo:o1',
            chainId: getChainIdByName(chain) || ChainId.RH,
            tokenAddress: address as `0x${string}`,
            tokenInfo: seed ?? null,
        } as any) as { tokenInfo: TokenInfo | null };
        return res.tokenInfo ?? null;
    }

    private static async getTokenInfoByLong(chain: string, address: string, seed?: TokenInfo | null): Promise<TokenInfo | null> {
        const res = await call({
            type: 'token:getTokenInfo:long',
            chainId: getChainIdByName(chain) || ChainId.RH,
            tokenAddress: address as `0x${string}`,
            tokenInfo: seed ?? null,
        } as any) as { tokenInfo: TokenInfo | null };
        return res.tokenInfo ?? null;
    }

    private static rhLaunchpadEnrichInFlight = new Map<string, Promise<TokenInfo | null>>();

    private static isRhPonsPlatform(platform: string): boolean {
        const value = String(platform || '').trim().toLowerCase();
        return value === 'pons' || value.startsWith('pons_');
    }

    private static async enrichRhTokenInfoForRoute(
        key: string,
        chain: string,
        address: string,
        seed: TokenInfo,
        platformNow?: string,
    ): Promise<TokenInfo> {
        const existing = this.rhLaunchpadEnrichInFlight.get(key);
        if (existing) return (await existing) ?? seed;
        const task = (async (): Promise<TokenInfo | null> => {
            let current = seed;
            const platform = resolveTokenLaunchpadPlatform({
                address,
                launchpad: seed.launchpad,
                launchpad_platform: seed.launchpad_platform,
                requestedPlatform: platformNow,
            }) || String(platformNow || '').trim().toLowerCase();
            try {
                if (isO1LaunchpadPlatform(platform)) {
                    const o1Info = await this.getTokenInfoByO1(chain, address, current).catch(() => null);
                    if (o1Info) current = this.mergeO1EnrichedTokenInfo(current, o1Info) ?? current;
                } else if (isLongLaunchpadPlatform(platform)) {
                    const longInfo = await this.getTokenInfoByLong(chain, address, current).catch(() => null);
                    if (longInfo) current = this.mergeLongEnrichedTokenInfo(current, longInfo) ?? current;
                } else if (this.isRhPonsPlatform(platform)) {
                    const ponsInfo = await this.getTokenInfoByPons(chain, address).catch(() => null);
                    if (ponsInfo) current = this.mergePonsEnrichedTokenInfo(current, ponsInfo) ?? current;
                }
                if (!String(current.quote_token_address || '').trim()) {
                    const dex = await this.buildDexTokenInfoFromDexScreener(chain, address).catch(() => null);
                    if (dex?.quote_token_address) {
                        current = {
                            ...current,
                            quote_token: current.quote_token || dex.quote_token,
                            quote_token_address: dex.quote_token_address,
                            pool_pair: current.pool_pair || dex.pool_pair,
                            biggest_pool_address: current.biggest_pool_address || dex.biggest_pool_address,
                            tpool_pool_address: current.tpool_pool_address || dex.tpool_pool_address,
                            dex_type: current.dex_type || dex.dex_type,
                        };
                    }
                }
            } catch {
            }
            return current;
        })();
        this.rhLaunchpadEnrichInFlight.set(key, task);
        try {
            return (await task) ?? seed;
        } finally {
            this.rhLaunchpadEnrichInFlight.delete(key);
        }
    }

    private static prewarmFlapEnrichedTokenInfo(
        key: string,
        platform: string,
        chain: string,
        address: string,
        seed?: TokenInfo | null,
        flapInfoPromise?: Promise<TokenInfo | null> | null,
    ) {
        if (this.flapEnrichInFlight.has(key)) return;
        const task = (async () => {
            try {
                const flapTokenInfo = flapInfoPromise
                    ? await flapInfoPromise
                    : await this.getTokenInfoByFlap(platform, chain, address);
                if (!flapTokenInfo) return;
                const current = this.tokenInfoCache.get(key)?.value ?? seed ?? null;
                const merged = this.mergeFlapEnrichedTokenInfo(current, flapTokenInfo);
                this.tokenInfoCache.set(key, { ts: Date.now(), value: merged });
            } catch {
            }
        })().finally(() => {
            this.flapEnrichInFlight.delete(key);
        });
        this.flapEnrichInFlight.set(key, task);
    }

    private static prewarmFlapOuterQuoteToken(chain: string, tokenInfo?: TokenInfo | null) {
        if (!this.shouldPrewarmFlapOuterQuote(chain, tokenInfo) || !tokenInfo?.quote_token_address) return;
        void this.getTokenInfoByFlapHttp('flap', chain, tokenInfo.quote_token_address).catch(() => null);
    }

    private static shouldPrewarmFlapOuterQuote(chain: string, tokenInfo?: TokenInfo | null): boolean {
        if (!tokenInfo) return false;
        const chainId = getChainIdByName(chain);
        if (chainId !== ChainId.BNB) return false;
        return hasNonTerminalFlapOuterQuote(chainId, tokenInfo)
            && classifyFlapRoute(chainId, tokenInfo).isFlapStocks;
    }

    private static hasDexRouteMinimum(tokenInfo?: Pick<TokenInfo, 'quote_token_address' | 'pool_pair' | 'biggest_pool_address' | 'tpool_pool_address'> | null): boolean {
        if (!tokenInfo?.quote_token_address) return false;
        return !!(tokenInfo.pool_pair || tokenInfo.biggest_pool_address || tokenInfo.tpool_pool_address);
    }

    private static isFlapOuterStatus(
        tokenInfo?: Partial<Pick<TokenInfo, 'launchpad_status'>> | null,
    ): boolean {
        return Number(tokenInfo?.launchpad_status ?? Number.NaN) === 1;
    }

    private static hasFlapQuoteRouteMinimum(
        tokenInfo?: Partial<Pick<TokenInfo, 'address' | 'quote_token_address'>> | null,
    ): boolean {
        const tokenAddress = String(tokenInfo?.address || '').trim().toLowerCase();
        const quote = String(tokenInfo?.quote_token_address || '').trim();
        if (!/^0x[a-fA-F0-9]{40}$/.test(quote)) return false;
        return quote.toLowerCase() !== tokenAddress;
    }

    private static normalizeFlapThirdPartyTokenInfo(
        chainId: number,
        requestedPlatform: string,
        address: string,
        tokenInfo: TokenInfo,
    ): TokenInfo {
        return {
            ...tokenInfo,
            address,
            launchpad: 'flap',
            launchpad_platform: resolveFlapPlatform(chainId, {
                address,
                launchpad_platform: tokenInfo.launchpad_platform,
                launchpad_status: tokenInfo.launchpad_status,
                quote_token_address: tokenInfo.quote_token_address,
                pool_pair: tokenInfo.pool_pair,
                biggest_pool_address: tokenInfo.biggest_pool_address,
                tpool_pool_address: tokenInfo.tpool_pool_address,
                flap_pool_model: tokenInfo.flap_pool_model,
                flap_pool_compat_address: tokenInfo.flap_pool_compat_address,
                flap_cl_pool_id: tokenInfo.flap_cl_pool_id,
                flap_v4_fee: tokenInfo.flap_v4_fee,
                flap_v4_tick_spacing: tokenInfo.flap_v4_tick_spacing,
                flap_stocks_vault_version: tokenInfo.flap_stocks_vault_version,
                flap_dividend_token: tokenInfo.flap_dividend_token,
                flap_vault_address: tokenInfo.flap_vault_address,
                flap_vault_factory: tokenInfo.flap_vault_factory,
                flap_vault_is_official: tokenInfo.flap_vault_is_official,
                flap_vault_is_vault: tokenInfo.flap_vault_is_vault,
                flap_basket_token: tokenInfo.flap_basket_token,
                flap_supported_assets: tokenInfo.flap_supported_assets,
            }, requestedPlatform),
        };
    }

    private static hasFlapRouteReadyMinimum(
        chain: string,
        requestedPlatform: string,
        tokenInfo?: Partial<Pick<TokenInfo,
            'address'
            | 'launchpad_platform'
            | 'launchpad_status'
            | 'quote_token_address'
            | 'pool_pair'
            | 'biggest_pool_address'
            | 'tpool_pool_address'
            | 'flap_pool_model'
            | 'flap_pool_compat_address'
            | 'flap_cl_pool_id'
            | 'flap_v4_fee'
            | 'flap_v4_tick_spacing'
            | 'flap_stocks_vault_version'
            | 'flap_dividend_token'
            | 'flap_vault_address'
            | 'flap_vault_factory'
            | 'flap_vault_is_official'
            | 'flap_vault_is_vault'
            | 'flap_basket_token'
            | 'flap_supported_assets'
        >> | null,
    ): boolean {
        if (!tokenInfo?.address || !this.hasFlapQuoteRouteMinimum(tokenInfo)) return false;
        const chainId = getChainIdByName(chain);
        const launchpadStatus = Number(tokenInfo.launchpad_status ?? Number.NaN);
        if (!Number.isFinite(launchpadStatus)) return false;

        const flapRoute = classifyFlapRoute(chainId, {
            ...(tokenInfo ?? {}),
            launchpad_platform: resolveFlapPlatform(chainId, tokenInfo as TokenInfo, requestedPlatform),
        } as TokenInfo);
        const isStocks = flapRoute.isFlapStocks;

        if (launchpadStatus === 1) {
            if (!hasConfirmedFlapOuterRoute(tokenInfo as TokenInfo) && !this.hasDexRouteMinimum(tokenInfo as TokenInfo)) {
                return false;
            }
              return !isStocks || hasNonTerminalFlapOuterQuote(chainId, tokenInfo as Pick<TokenInfo, 'launchpad_status' | 'quote_token_address'>);
        }

        return true;
    }

    private static resolveFlapTokenInfoCandidate(input: {
        key: string;
        chain: string;
        requestedPlatform: string;
        address: string;
        thirdPartyInfo?: TokenInfo | null;
        flapInfoPromise?: Promise<TokenInfo | null> | null;
    }): Promise<TokenInfo | null> | TokenInfo | null {
        const chainId = getChainIdByName(input.chain);
        const normalizedThirdParty = input.thirdPartyInfo
            ? this.normalizeFlapThirdPartyTokenInfo(chainId, input.requestedPlatform, input.address, input.thirdPartyInfo)
            : null;

        if (normalizedThirdParty && this.hasFlapRouteReadyMinimum(input.chain, input.requestedPlatform, normalizedThirdParty)) {
            if (!this.isFlapOuterStatus(normalizedThirdParty)) {
                if (input.flapInfoPromise) {
                    this.prewarmFlapEnrichedTokenInfo(
                        input.key,
                        input.requestedPlatform || normalizedThirdParty.launchpad_platform || 'flap',
                        input.chain,
                        input.address,
                        normalizedThirdParty,
                        input.flapInfoPromise,
                    );
                }
                return normalizedThirdParty;
            }
        }

        if (!input.flapInfoPromise) return normalizedThirdParty;

        return (async () => {
            const flapTokenInfo = await input.flapInfoPromise;
            const merged = this.mergeFlapEnrichedTokenInfo(normalizedThirdParty, flapTokenInfo);
            if (merged && this.hasFlapRouteReadyMinimum(input.chain, input.requestedPlatform, merged)) {
                return merged;
            }
            if (flapTokenInfo && this.hasFlapRouteReadyMinimum(input.chain, input.requestedPlatform, flapTokenInfo)) {
                return flapTokenInfo;
            }
            return merged ?? normalizedThirdParty;
        })();
    }

    private static mapDexScreenerPairDexType(pair: DexScreenerPair | null | undefined): string | undefined {
        if (!pair) return undefined;
        const labels = Array.isArray(pair.labels) ? pair.labels.map((item) => String(item).toLowerCase()) : [];
        if (labels.some((item) => item.includes('v4'))) {
            return 'UNISWAP_V4';
        }
        if (labels.some((item) => item.includes('v3') || item.includes('cl'))) {
            return 'PANCAKE_SWAP_V3';
        }
        return 'PANCAKE_SWAP';
    }

    private static async buildDexTokenInfoFromDexScreener(chain: string, tokenAddress: string): Promise<TokenInfo | null> {
        const chainId = getChainIdByName(chain);
        if (!Number.isFinite(chainId) || chainId === ChainId.SOL) return null;
        const tokenLower = tokenAddress.toLowerCase();
        const pairs = await DexScreenerAPI.getPairsByToken(chain, tokenAddress);
        const selected = pairs
            .filter((pair) => {
                const base = String(pair.baseToken?.address || '').toLowerCase();
                const quote = String(pair.quoteToken?.address || '').toLowerCase();
                return (base === tokenLower || quote === tokenLower)
                    && DexScreenerAPI.effectiveLiquidityUsd(pair) > 0;
            })
            .sort((a, b) => DexScreenerAPI.effectiveLiquidityUsd(b) - DexScreenerAPI.effectiveLiquidityUsd(a))[0];
        if (!selected?.pairAddress) return null;

        const baseAddress = String(selected.baseToken?.address || '');
        const quoteAddress = String(selected.quoteToken?.address || '');
        const counterpartyAddress = baseAddress.toLowerCase() === tokenLower ? quoteAddress : baseAddress;
        if (!counterpartyAddress) return null;

        const meta = await call({
            type: 'token:getMeta',
            tokenAddress: tokenAddress as `0x${string}`,
            chainId,
        } as const).catch(() => null);

        const tokenRef = baseAddress.toLowerCase() === tokenLower ? selected.baseToken : selected.quoteToken;
        const counterpartyRef = baseAddress.toLowerCase() === tokenLower ? selected.quoteToken : selected.baseToken;

        return {
            chain,
            address: tokenAddress,
            name: String((meta as any)?.name || tokenRef?.name || tokenAddress),
            symbol: String((meta as any)?.symbol || tokenRef?.symbol || tokenAddress.slice(0, 6)),
            decimals: Number((meta as any)?.decimals ?? 18),
            logo: selected.info?.imageUrl || '',
            launchpad: 'dex',
            launchpad_progress: 1,
            launchpad_platform: 'dex',
            launchpad_status: 1,
            quote_token: String(counterpartyRef?.symbol || counterpartyAddress),
            quote_token_address: counterpartyAddress,
            pool_pair: selected.pairAddress,
            biggest_pool_address: selected.pairAddress,
            tpool_pool_address: selected.pairAddress,
            tpool_launch_type: 'migrated',
            dex_type: this.mapDexScreenerPairDexType(selected),
            tokenPrice: selected.priceUsd
                ? {
                    price: String(selected.priceUsd),
                    marketCap: String(selected.marketCap ?? selected.fdv ?? 0),
                    liquidity: String(selected.liquidity?.usd ?? 0),
                    timestamp: Date.now(),
                }
                : undefined,
        };
    }

    static async getTokenInfo(
        platform: string,
        chain: string,
        tokenAddress: string,
        opts?: { cacheTtlMs?: number }
    ): Promise<TokenInfo | null> {
        const key = this.toTokenInfoKey(platform, chain, tokenAddress);
        const normalizedRequestedPlatform = normalizeLaunchpadPlatform(platform) ?? platform.trim().toLowerCase();
        const now = Date.now();
        const requestedTtl = typeof opts?.cacheTtlMs === 'number' && opts.cacheTtlMs >= 0
            ? opts.cacheTtlMs
            : 0;
        const cached = this.tokenInfoCache.get(key);
        const effectiveCachedTtl = this.resolveTokenInfoCacheTtlMs(platform, requestedTtl, cached?.value);
        if (effectiveCachedTtl > 0 && cached && now - cached.ts < effectiveCachedTtl) {
            if (platform === 'altfun' && this.shouldDebugAltfunTokenInfo()) {
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
            if (platform === 'altfun' && this.shouldDebugAltfunTokenInfo()) {
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
            const shouldDebugAltfun = platform === 'altfun' && this.shouldDebugAltfunTokenInfo();
            if (shouldDebugAltfun) {
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
            } else if (platform === 'pons' || platform === 'pons_v1' || platform === 'pons_v2') {
                nextValue = await this.getTokenInfoByPons(chain, tokenAddress).catch(() => null);
                if (nextValue == null) {
                    nextValue = await this.buildDexTokenInfoFromDexScreener(chain, tokenAddress);
                }
            } else if (isO1LaunchpadPlatform(platform)) {
                nextValue = await this.getTokenInfoByO1(chain, tokenAddress).catch(() => null);
                if (nextValue == null) {
                    nextValue = await this.buildDexTokenInfoFromDexScreener(chain, tokenAddress);
                }
            } else if (isLongLaunchpadPlatform(platform)) {
                nextValue = await this.getTokenInfoByLong(chain, tokenAddress).catch(() => null);
                if (nextValue == null) {
                    nextValue = await this.buildDexTokenInfoFromDexScreener(chain, tokenAddress);
                }
            } else {
                let address = tokenAddress;
                const suffixLaunchpadFamily = inferLaunchpadFamilyByAddress(address);
                const shouldParallelFlapLookup = FLAP_LIKE_LAUNCHPADS.has(normalizedRequestedPlatform) || suffixLaunchpadFamily === 'flap';
                const parallelFlapInfoPromise = shouldParallelFlapLookup
                    ? this.getTokenInfoByFlap(normalizedRequestedPlatform || 'flap', chain, address).catch(() => null)
                    : null;
                if (platform === 'gmgn' || platform === 'axiom') {
                    try {
                        const tokenInfo = platform === 'gmgn'
                            ? await GmgnAPI.getTokenInfo(chain, address)
                            : (await call({
                                type: 'thirdParty:getTokenInfo',
                                platform,
                                chain,
                                address,
                            } as const)).tokenInfo;
                        if (tokenInfo) {
                            const chainId = getChainIdByName(chain);
                            if (platform === 'gmgn' && chainId === ChainId.SOL) {
                                nextValue = tokenInfo;
                            } else {
                            const normalizedLaunchpad = resolveTokenLaunchpadPlatform({
                                address,
                                launchpad: tokenInfo.launchpad,
                                launchpad_platform: tokenInfo.launchpad_platform,
                                requestedPlatform: normalizedRequestedPlatform,
                            });
                            const supportedLaunchpads = Number.isFinite(chainId)
                                ? new Set(getSupportedLaunchpads(chainId))
                                : new Set<string>();
                            const isFourMemeLike = FOUR_MEME_LIKE_LAUNCHPADS.has(normalizedLaunchpad);
                            const isFlapLike = FLAP_LIKE_LAUNCHPADS.has(normalizedLaunchpad);
                            const isSupportedLaunchpad = normalizedLaunchpad !== '' && supportedLaunchpads.has(normalizedLaunchpad);

                            if (isFourMemeLike && tokenInfo.quote_token != "BNB") {
                                const fourmemeTokenInfo = await this.getTokenInfoByFourmeme(platform, chain, address);
                                if (fourmemeTokenInfo) {
                                    nextValue = fourmemeTokenInfo;
                                } else {
                                    nextValue = tokenInfo;
                                }
                              } else if (isFlapLike) {
                                  const flapCandidate = this.resolveFlapTokenInfoCandidate({
                                      key,
                                      chain,
                                      requestedPlatform: normalizedRequestedPlatform || normalizedLaunchpad || 'flap',
                                      address,
                                      thirdPartyInfo: tokenInfo,
                                      flapInfoPromise: parallelFlapInfoPromise,
                                  });
                                  nextValue = flapCandidate instanceof Promise ? await flapCandidate : flapCandidate;
                            } else if (
                                MEME_SUFFIXS.includes(address.substring(address.length - 4)) ||
                                isFourMemeLike ||
                                isSupportedLaunchpad ||
                                chainId === ChainId.RH
                            ) {
                                nextValue = tokenInfo;
                                if (parallelFlapInfoPromise) {
                                    this.prewarmFlapEnrichedTokenInfo(
                                        key,
                                        normalizedRequestedPlatform || 'flap',
                                        chain,
                                        address,
                                        tokenInfo,
                                        parallelFlapInfoPromise,
                                    );
                                }
                            } else {
                                nextValue = parallelFlapInfoPromise ? await parallelFlapInfoPromise : null;
                            }
                            }
                        }
                    } catch {
                        // Fallback to Fourmeme/Flap resolvers when third-party platform API is unavailable.
                    }
                }

                if (getChainIdByName(chain) === ChainId.RH && nextValue) {
                    const platformNow = resolveTokenLaunchpadPlatform({
                        address,
                        launchpad: nextValue.launchpad,
                        launchpad_platform: nextValue.launchpad_platform,
                        requestedPlatform: normalizedRequestedPlatform,
                    });
                    const hasQuote = /^0x[a-fA-F0-9]{40}$/.test(String(nextValue.quote_token_address || '').trim());
                    if (hasQuote) {
                        void this.enrichRhTokenInfoForRoute(key, chain, address, nextValue, platformNow)
                            .then((enriched) => {
                                if (enriched) this.tokenInfoCache.set(key, { ts: Date.now(), value: enriched });
                            })
                            .catch(() => undefined);
                    } else {
                        nextValue = await this.enrichRhTokenInfoForRoute(key, chain, address, nextValue, platformNow);
                    }
                }

                if (nextValue == null) {
                    if (FLAP_LIKE_LAUNCHPADS.has(normalizedRequestedPlatform) || suffixLaunchpadFamily === 'flap') {
                        nextValue = await this.getTokenInfoByFlap(platform, chain, address);
                    } else if (FOUR_MEME_LIKE_LAUNCHPADS.has(normalizedRequestedPlatform) || suffixLaunchpadFamily === 'fourmeme') {
                        nextValue = await this.getTokenInfoByFourmeme(platform, chain, address);
                    } else {
                        nextValue = await this.buildDexTokenInfoFromDexScreener(chain, address);
                    }
                }
            }
            if (nextValue && getChainIdByName(chain) === ChainId.BNB) {
                nextValue = await this.applyFourmemeOfficialQuote(chain, tokenAddress, nextValue);
            }
            this.tokenInfoCache.set(key, { ts: Date.now(), value: nextValue });
            if (shouldDebugAltfun) {
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
                const tokenAddressNormalized = chainId === ChainId.SOL
                    ? tokenAddress
                    : tokenAddress.toLowerCase();
                const bal = await call({
                    type: 'token:getBalance',
                    tokenAddress: tokenAddressNormalized,
                    address,
                    chainId,
                });
                return bal?.balanceWei ?? null;
            };

            const chainId = getChainIdByName(chain);

            if (platform !== 'gmgn' || chainId === ChainId.SOL) {
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
        return await this.getBalance(platform, chain, walletAddress, tokenAddress, opts);
    }

    private static isUsableFourmemeOfficialQuote(
        chainId: number,
        tokenAddress: string,
        quote?: string | null,
        version?: number | null,
    ): quote is `0x${string}` {
        if (!(Number(version) > 0)) return false;
        if (!/^0x[a-fA-F0-9]{40}$/.test(String(quote || ''))) return false;
        const lower = quote.toLowerCase();
        if (lower === tokenAddress.toLowerCase()) return false;
        if (lower === '0x0000000000000000000000000000000000000000') return false;
        return !isTradeRouteTerminalQuote(chainId, quote);
    }

    private static async applyFourmemeOfficialQuote(
        chain: string,
        address: string,
        tokenInfo: TokenInfo,
    ): Promise<TokenInfo> {
        const chainId = getChainIdByName(chain);
        if (chainId !== ChainId.BNB) return tokenInfo;
        const declared = String(tokenInfo.quote_token_address || '').trim();
        if (/^0x[a-fA-F0-9]{40}$/.test(declared)
            && declared.toLowerCase() !== address.toLowerCase()
            && declared.toLowerCase() !== '0x0000000000000000000000000000000000000000') {
            return tokenInfo;
        }
        const contractInfo = await this.getTokenInfoByFourmemeContract(chain, address).catch(() => null);
        const quote = contractInfo?.quote;
        if (!this.isUsableFourmemeOfficialQuote(chainId, address, quote, contractInfo?.version)) {
            return tokenInfo;
        }
        return {
            ...tokenInfo,
            quote_token_address: quote,
        };
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
            address,
        });
        return res.tokenInfo;
    }

    static async getTokenInfoByFlapHttp(platform: string, chain: string, address: string): Promise<TokenInfo | null> {
        const res = await call({
            type: 'token:getTokenInfo:flapHttp',
            platform,
            chain,
            address,
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
        const contractInfo = await this.getTokenInfoByFlapContract(chain, address);
        const httpInfo = contractInfo
            ? null
            : await this.getTokenInfoByFlapHttp(platform, chain, address).catch(() => null);
        const rawLaunchpadStatus = Number(contractInfo?.status ?? Number.NaN);
        const hasUsableDexPool = !!contractInfo && isUsableFlapDexPoolAddress(address, contractInfo.pool);
        const isListedOnDex = !!contractInfo && hasConfirmedFlapOuterRoute({
            address,
            flap_pool_model: contractInfo.poolModel,
            flap_pool_compat_address: contractInfo.poolCompatAddress,
            flap_cl_pool_id: contractInfo.clPoolId,
            flap_v4_fee: contractInfo.v4Fee,
            flap_v4_tick_spacing: contractInfo.v4TickSpacing,
            pool_pair: hasUsableDexPool ? contractInfo.pool : undefined,
            biggest_pool_address: hasUsableDexPool ? contractInfo.pool : undefined,
            tpool_pool_address: hasUsableDexPool ? contractInfo.pool : undefined,
        });
        const baseFlapTokenInfo = {
            address,
            launchpad_platform: httpInfo?.launchpad_platform,
            launchpad_status: Number.isFinite(rawLaunchpadStatus) ? rawLaunchpadStatus : httpInfo?.launchpad_status,
            quote_token_address: contractInfo?.quoteTokenAddress || httpInfo?.quote_token_address,
            pool_pair: hasUsableDexPool ? contractInfo?.pool : httpInfo?.pool_pair,
            biggest_pool_address: hasUsableDexPool ? contractInfo?.pool : httpInfo?.biggest_pool_address,
            tpool_pool_address: hasUsableDexPool ? contractInfo?.pool : httpInfo?.tpool_pool_address,
            flap_pool_model: contractInfo?.poolModel,
            flap_pool_compat_address: contractInfo?.poolCompatAddress,
            flap_cl_pool_id: contractInfo?.clPoolId,
            flap_v4_fee: contractInfo?.v4Fee,
            flap_v4_tick_spacing: contractInfo?.v4TickSpacing,
            flap_stocks_vault_version: contractInfo?.stocksVaultVersion,
            flap_dividend_token: contractInfo?.dividendToken,
            flap_vault_address: contractInfo?.vaultAddress,
            flap_vault_factory: contractInfo?.vaultFactory,
            flap_vault_is_official: contractInfo?.vaultIsOfficial,
            flap_vault_is_vault: contractInfo?.vaultIsVault,
            flap_basket_token: contractInfo?.basketToken,
            flap_supported_assets: contractInfo?.supportedAssets,
        };
        const directResolvedPlatform = resolveFlapPlatform(getChainIdByName(chain), baseFlapTokenInfo, platform);
        const resolvedPlatform = await resolveFlapPlatformByQuoteLineage(getChainIdByName(chain), baseFlapTokenInfo, platform, async (quoteTokenAddress) => {
            if (quoteTokenAddress.toLowerCase() === address.toLowerCase()) return null;
            return await this.getTokenInfoByFlap('flap', chain, quoteTokenAddress);
        });
        const resolvedOuterQuoteIsStocks = directResolvedPlatform !== 'flap_stocks' && resolvedPlatform === 'flap_stocks';
        const normalizedLaunchpadStatus = normalizeFlapLaunchpadStatus(getChainIdByName(chain), {
            ...baseFlapTokenInfo,
        });
        if (contractInfo && httpInfo) {
            httpInfo.quote_token_address = contractInfo.quoteTokenAddress;
            httpInfo.nativeToQuoteSwapEnabled = contractInfo.nativeToQuoteSwapEnabled;
            httpInfo.tokenVersion = contractInfo.tokenVersion;
            httpInfo.extensionID = contractInfo.extensionID;
            httpInfo.dexId = contractInfo.dexId;
            httpInfo.flap_lp_fee_profile = contractInfo.lpFeeProfile;
            httpInfo.flap_pool_model = contractInfo.poolModel;
            httpInfo.flap_pool_compat_address = contractInfo.poolCompatAddress;
            httpInfo.flap_cl_pool_id = contractInfo.clPoolId;
            httpInfo.flap_v4_fee = contractInfo.v4Fee;
            httpInfo.flap_v4_tick_spacing = contractInfo.v4TickSpacing;
            httpInfo.flap_v4_hooks = contractInfo.v4Hooks;
            httpInfo.flap_dividend_token = contractInfo.dividendToken;
            httpInfo.flap_vault_address = contractInfo.vaultAddress;
            httpInfo.flap_vault_factory = contractInfo.vaultFactory;
            httpInfo.flap_vault_is_official = contractInfo.vaultIsOfficial;
            httpInfo.flap_vault_is_vault = contractInfo.vaultIsVault;
            httpInfo.flap_vault_is_ai_consumer = contractInfo.vaultIsAIConsumer;
            httpInfo.flap_stocks_vault_version = contractInfo.stocksVaultVersion;
            httpInfo.flap_outer_quote_is_stocks = resolvedOuterQuoteIsStocks || undefined;
            httpInfo.flap_basket_token = contractInfo.basketToken;
            httpInfo.flap_supported_assets = contractInfo.supportedAssets;
            httpInfo.launchpad = 'flap';
            httpInfo.launchpad_platform = resolvedPlatform;
            httpInfo.launchpad_status = normalizedLaunchpadStatus;
            httpInfo.tpool_launch_type = normalizedLaunchpadStatus === 1 ? 'migrated' : (httpInfo.tpool_launch_type || 'launching');
            if (contractInfo.poolModel === 'classic' && hasUsableDexPool) {
                httpInfo.pool_pair = httpInfo.pool_pair || contractInfo.pool;
                httpInfo.biggest_pool_address = httpInfo.biggest_pool_address || contractInfo.pool;
                httpInfo.tpool_pool_address = httpInfo.tpool_pool_address || contractInfo.pool;
            }
            this.prewarmFlapOuterQuoteToken(chain, httpInfo);
            return httpInfo;
        }
        if (contractInfo) {
            const progress = (() => {
                const v = Number(contractInfo.progress);
                const n = Number.isFinite(v) && v > 0 ? v / 1e18 : 0;
                return Number.isFinite(n) ? n : 0;
            })();
            const contractOnlyInfo = {
                chain,
                address,
                name: contractInfo.symbol,
                symbol: contractInfo.symbol,
                decimals: contractInfo.decimals,
                logo: '',
                launchpad: 'flap',
                launchpad_progress: progress,
                launchpad_platform: resolvedPlatform,
                launchpad_status: normalizedLaunchpadStatus,
                quote_token: contractInfo.quoteTokenAddress,
                quote_token_address: contractInfo.quoteTokenAddress,
                pool_pair: contractInfo.poolModel === 'classic' && hasUsableDexPool ? contractInfo.pool : undefined,
                biggest_pool_address: contractInfo.poolModel === 'classic' && hasUsableDexPool ? contractInfo.pool : undefined,
                tpool_pool_address: contractInfo.poolModel === 'classic' && hasUsableDexPool ? contractInfo.pool : undefined,
                tpool_launch_type: isListedOnDex ? 'migrated' : 'launching',
                nativeToQuoteSwapEnabled: contractInfo.nativeToQuoteSwapEnabled,
                tokenVersion: contractInfo.tokenVersion,
                extensionID: contractInfo.extensionID,
                dexId: contractInfo.dexId,
                flap_lp_fee_profile: contractInfo.lpFeeProfile,
                flap_pool_model: contractInfo.poolModel,
                flap_pool_compat_address: contractInfo.poolCompatAddress,
                flap_cl_pool_id: contractInfo.clPoolId,
                flap_v4_fee: contractInfo.v4Fee,
                flap_v4_tick_spacing: contractInfo.v4TickSpacing,
                flap_v4_hooks: contractInfo.v4Hooks,
                flap_dividend_token: contractInfo.dividendToken,
                flap_vault_address: contractInfo.vaultAddress,
                flap_vault_factory: contractInfo.vaultFactory,
                flap_vault_is_official: contractInfo.vaultIsOfficial,
                flap_vault_is_vault: contractInfo.vaultIsVault,
                flap_vault_is_ai_consumer: contractInfo.vaultIsAIConsumer,
                flap_stocks_vault_version: contractInfo.stocksVaultVersion,
                flap_outer_quote_is_stocks: resolvedOuterQuoteIsStocks || undefined,
                flap_basket_token: contractInfo.basketToken,
                flap_supported_assets: contractInfo.supportedAssets,
                // tokenPrice: {
                //     price: contractInfo.price,
                //     marketCap: contractInfo.circulatingSupply,
                //     timestamp: Date.now(),
                // }
            } as TokenInfo;
            this.prewarmFlapOuterQuoteToken(chain, contractOnlyInfo);
            return contractOnlyInfo;
        }
        this.prewarmFlapOuterQuoteToken(chain, httpInfo);
        return httpInfo;
    }

    static async previewQuickTradeRoute(input: {
        chainId: number;
        tokenAddress: string;
        tokenInfo?: TokenInfo | null;
        baseTokenAddress?: string;
    }) {
        if (!input.tokenAddress || !input.tokenInfo || input.chainId === ChainId.SOL || input.chainId === ChainId.HYPER) {
            return null;
        }
        const res = await call({
            type: 'trade:previewRoute',
            input: {
                chainId: input.chainId,
                tokenAddress: input.tokenAddress,
                tokenInfo: input.tokenInfo ?? undefined,
                baseTokenAddress: input.baseTokenAddress,
            },
        });
        return res.route ?? null;
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
        const infoPrice = Number(
            (tokenInfo as any)?.priceUsd
            ?? tokenInfo?.tokenPrice?.price
            ?? (tokenInfo as any)?.price
            ?? 0
        );

        if (platform === 'gmgn' && chainId === ChainId.SOL && Number.isFinite(infoPrice) && infoPrice > 0) {
            return infoPrice;
        }

        try {
            // Try to get price from GMGN
            const res = platform === 'gmgn'
                ? await GmgnAPI.getTokenPrice(toGmgnChainName(chainId), tokenAddress)
                : null;
            if (res?.price) {
                const gmgnPrice = Number(res.price);
                if (Number.isFinite(gmgnPrice) && gmgnPrice > 0) {
                    if (platform === 'gmgn' && chainId === ChainId.SOL) {
                        return gmgnPrice;
                    }
                    return gmgnPrice;
                }
            }
        } catch {

        }

        if (Number.isFinite(infoPrice) && infoPrice > 0) {
            return infoPrice;
        }

        try {
            // Try to get price from DEX
            const res = await call({
                type: 'token:getPriceUsd',
                chainId,
                tokenAddress,
                tokenInfo: tokenInfo ?? null,
            });
            const v = Number(res.priceUsd);
            return Number.isFinite(v) && v > 0 ? v : null;
        } catch {
            return null;
        }
    }
}
