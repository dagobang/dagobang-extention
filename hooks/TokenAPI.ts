import GmgnAPI from "./GmgnAPI";
import DexScreenerAPI, { DexScreenerPair } from "./DexScreenerAPI";
import { FlapTokenStateV7, FourmemeTokenInfo, TokenInfo } from "@/types/token";
import { call } from "@/utils/messaging";
import { parseEther, zeroAddress } from "viem";
import { chainNames, getChainIdByName } from "@/constants/chains";
import { ChainId } from "@/constants/chains/chainId";
import { MEME_SUFFIXS } from "@/constants/meme";
import { getSupportedLaunchpads, normalizeLaunchpadPlatform } from "@/constants/launchpad";
import { hasConfirmedFlapOuterRoute, hasConfirmedFlapStocksIdentity, isUsableFlapDexPoolAddress } from "@/utils/flap";
import { inferLaunchpadFamilyByAddress, resolveTokenLaunchpadPlatform } from "@/utils/launchpadFamily";

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

const BSC_FLAP_TERMINAL_QUOTES = new Set([
    zeroAddress.toLowerCase(),
    '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
    '0x55d398326f99059ff775485246999027b3197955',
    '0xe9e7cea3dedca5984780bafc599bd69add087d56',
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
    '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d',
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

        return {
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
            flap_vault_is_ai_consumer: enriched.flap_vault_is_ai_consumer ?? base.flap_vault_is_ai_consumer,
            flap_stocks_vault_version: enriched.flap_stocks_vault_version ?? base.flap_stocks_vault_version,
            flap_basket_token: enriched.flap_basket_token || base.flap_basket_token,
            flap_supported_assets: enriched.flap_supported_assets ?? base.flap_supported_assets,
            tokenPrice: base.tokenPrice ?? enriched.tokenPrice,
        };
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
        if (Number(tokenInfo.launchpad_status ?? 0) !== 1) return false;
        const quote = String(tokenInfo.quote_token_address || '').trim().toLowerCase();
        if (!quote || BSC_FLAP_TERMINAL_QUOTES.has(quote)) return false;
        return hasConfirmedFlapStocksIdentity(chainId, tokenInfo);
    }

    private static hasNonTerminalFlapOuterQuote(chain: string, tokenInfo?: Pick<TokenInfo, 'launchpad_status' | 'quote_token_address'> | null): boolean {
        if (!tokenInfo) return false;
        const chainId = getChainIdByName(chain);
        if (chainId !== ChainId.BNB) return false;
        if (Number(tokenInfo.launchpad_status ?? 0) !== 1) return false;
        const quote = String(tokenInfo.quote_token_address || '').trim().toLowerCase();
        return !!quote && !BSC_FLAP_TERMINAL_QUOTES.has(quote);
    }

    private static resolveFlapLaunchpadPlatform(
        chainId: number,
        requestedPlatform: string,
        tokenInfo?: Partial<Pick<TokenInfo, 'address' | 'launchpad_platform' | 'flap_stocks_vault_version' | 'flap_dividend_token' | 'flap_vault_factory' | 'flap_basket_token' | 'flap_supported_assets'>> | null,
    ): string {
        if (hasConfirmedFlapStocksIdentity(chainId, tokenInfo)) return 'flap_stocks';
        return resolveTokenLaunchpadPlatform({
            address: tokenInfo?.address,
            launchpad_platform: tokenInfo?.launchpad_platform,
            requestedPlatform,
        }) || 'flap';
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
            launchpad_platform: this.resolveFlapLaunchpadPlatform(chainId, requestedPlatform, {
                address,
                launchpad_platform: tokenInfo.launchpad_platform,
                flap_stocks_vault_version: tokenInfo.flap_stocks_vault_version,
                flap_dividend_token: tokenInfo.flap_dividend_token,
                flap_vault_factory: tokenInfo.flap_vault_factory,
                flap_basket_token: tokenInfo.flap_basket_token,
                flap_supported_assets: tokenInfo.flap_supported_assets,
            }),
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
            | 'flap_vault_factory'
            | 'flap_basket_token'
            | 'flap_supported_assets'
        >> | null,
    ): boolean {
        if (!tokenInfo?.address || !this.hasFlapQuoteRouteMinimum(tokenInfo)) return false;
        const chainId = getChainIdByName(chain);
        const launchpadStatus = Number(tokenInfo.launchpad_status ?? Number.NaN);
        if (!Number.isFinite(launchpadStatus)) return false;

        const platform = this.resolveFlapLaunchpadPlatform(chainId, requestedPlatform, tokenInfo);
        const isStocks = platform === 'flap_stocks';

        if (launchpadStatus === 1) {
            if (!hasConfirmedFlapOuterRoute(tokenInfo as TokenInfo) && !this.hasDexRouteMinimum(tokenInfo as TokenInfo)) {
                return false;
            }
            return !isStocks || this.hasNonTerminalFlapOuterQuote(chain, tokenInfo as Pick<TokenInfo, 'launchpad_status' | 'quote_token_address'>);
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
                return base === tokenLower || quote === tokenLower;
            })
            .sort((a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0))[0];
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
                                isSupportedLaunchpad
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
        const resolvedPlatform = this.resolveFlapLaunchpadPlatform(getChainIdByName(chain), platform, {
            address,
            launchpad_platform: httpInfo?.launchpad_platform,
            flap_stocks_vault_version: contractInfo?.stocksVaultVersion,
            flap_dividend_token: contractInfo?.dividendToken,
            flap_vault_factory: contractInfo?.vaultFactory,
            flap_basket_token: contractInfo?.basketToken,
            flap_supported_assets: contractInfo?.supportedAssets,
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
            httpInfo.flap_vault_is_ai_consumer = contractInfo.vaultIsAIConsumer;
            httpInfo.flap_stocks_vault_version = contractInfo.stocksVaultVersion;
            httpInfo.flap_basket_token = contractInfo.basketToken;
            httpInfo.flap_supported_assets = contractInfo.supportedAssets;
            httpInfo.launchpad = 'flap';
            httpInfo.launchpad_platform = resolvedPlatform;
              httpInfo.launchpad_status = Number.isFinite(rawLaunchpadStatus)
                  ? rawLaunchpadStatus
                  : Number(httpInfo.launchpad_status ?? 0);
            httpInfo.tpool_launch_type = httpInfo.launchpad_status === 1 ? 'migrated' : (httpInfo.tpool_launch_type || 'launching');
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
                  launchpad_status: Number.isFinite(rawLaunchpadStatus) ? rawLaunchpadStatus : 0,
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
                flap_vault_is_ai_consumer: contractInfo.vaultIsAIConsumer,
                flap_stocks_vault_version: contractInfo.stocksVaultVersion,
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
                ? await GmgnAPI.getTokenPrice(chainNames[chainId], tokenAddress)
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
