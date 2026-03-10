import { parseEther } from 'viem';
import { WalletService } from '@/services/wallet';
import { SettingsService } from '@/services/settings';
import { TradeService } from '@/services/trade';
import { defaultSettings } from '@/utils/defaults';
import { chainNames } from '@/constants/chains/chainName';
import type { UnifiedSignalToken, UnifiedTwitterSignal } from '@/types/extention';
import type { TokenInfo } from '@/types/token';
import { FourmemeAPI } from '@/services/api/fourmeme';
import { TokenFourmemeService } from '@/services/token/fourmeme';
import { TokenFlapService } from '@/services/token/flap';
import { TokenService } from '@/services/token';
import { buildStrategySellOrderInputs, buildStrategyTrailingSellOrderInputs } from '@/services/limitOrders/advancedAutoSell';
import { cancelAllSellLimitOrdersForToken, createLimitOrder } from '@/services/limitOrders/store';

type TokenMetrics = {
  tokenAddress?: `0x${string}`;
  marketCapUsd?: number;
  liquidityUsd?: number;
  holders?: number;
  createdAtMs?: number;
  devAddress?: `0x${string}`;
  devHoldPercent?: number;
  devHasSold?: boolean;
  priceUsd?: number;
};

const parseNumber = (v: string | null | undefined) => {
  if (!v) return null;
  const n = Number(v.trim());
  if (!Number.isFinite(n)) return null;
  return n;
};

const parseKNumber = (v: string | null | undefined) => {
  const n = parseNumber(v);
  if (n == null) return null;
  return n * 1000;
};

const normalizeAddress = (addr: string | null | undefined): `0x${string}` | null => {
  if (!addr) return null;
  const trimmed = addr.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) return null;
  return trimmed as `0x${string}`;
};

const shouldBuyByConfig = (metrics: TokenMetrics, config: any) => {
  if (!metrics || !config) return false;
  const minMcap = parseKNumber(config.minMarketCapUsd);
  const maxMcap = parseKNumber(config.maxMarketCapUsd);
  if (minMcap != null && metrics.marketCapUsd == null) return false;
  if (maxMcap != null && metrics.marketCapUsd == null) return false;
  if (minMcap != null && metrics.marketCapUsd != null && metrics.marketCapUsd < minMcap) return false;
  if (maxMcap != null && metrics.marketCapUsd != null && metrics.marketCapUsd > maxMcap) return false;

  const minHolders = parseKNumber(config.minHolders);
  const maxHolders = parseKNumber(config.maxHolders);
  if (minHolders != null && metrics.holders == null) return false;
  if (maxHolders != null && metrics.holders == null) return false;
  if (minHolders != null && metrics.holders != null && metrics.holders < minHolders) return false;
  if (maxHolders != null && metrics.holders != null && metrics.holders > maxHolders) return false;

  const minAgeMin = parseNumber(config.minTokenAgeMinutes);
  const maxAgeMin = parseNumber(config.maxTokenAgeMinutes);
  if ((minAgeMin != null || maxAgeMin != null) && metrics.createdAtMs == null) return false;
  if (minAgeMin != null && metrics.createdAtMs != null) {
    const ageMin = (Date.now() - metrics.createdAtMs) / 60000;
    if (ageMin < minAgeMin) return false;
  }
  if (maxAgeMin != null && metrics.createdAtMs != null) {
    const ageMin = (Date.now() - metrics.createdAtMs) / 60000;
    if (ageMin > maxAgeMin) return false;
  }

  const minDevPct = parseNumber(config.minDevHoldPercent);
  const maxDevPct = parseNumber(config.maxDevHoldPercent);
  if (minDevPct != null && metrics.devHoldPercent == null) return false;
  if (maxDevPct != null && metrics.devHoldPercent == null) return false;
  if (minDevPct != null && metrics.devHoldPercent != null && metrics.devHoldPercent < minDevPct) return false;
  if (maxDevPct != null && metrics.devHoldPercent != null && metrics.devHoldPercent > maxDevPct) return false;
  if (config.blockIfDevSell && metrics.devHasSold === true) return false;
  return true;
};

export const createXSniperTrade = (deps: { onStateChanged: () => void }) => {
  const boughtOnce = new Set<string>();
  const buyInFlight = new Set<string>();

  const normalizeAutoTrade = (input: any) => {
    const defaults = defaultSettings().autoTrade;
    if (!input) return defaults;
    return {
      ...defaults,
      ...input,
      triggerSound: {
        ...defaults.triggerSound,
        ...(input as any).triggerSound,
      },
      twitterSnipe: {
        ...defaults.twitterSnipe,
        ...(input as any).twitterSnipe,
      },
    };
  };

  const getKey = (chainId: number, tokenAddress: `0x${string}`) => `${chainId}:${tokenAddress.toLowerCase()}`;

  const isFlapAddress = (addr: string) => {
    const low = addr.toLowerCase();
    return low.endsWith('7777') || low.endsWith('8888');
  };

  const fetchTokenInfoFresh = async (chainId: number, tokenAddress: `0x${string}`): Promise<TokenInfo | null> => {
    const chain = chainNames[chainId as any] ?? 'bsc';

    if (isFlapAddress(tokenAddress)) {
      try {
        const state = await TokenFlapService.getTokenInfo(chainId, tokenAddress);
        const meta = await TokenService.getMeta(tokenAddress);
        const quote = state.quoteTokenAddress && state.quoteTokenAddress !== '0x0000000000000000000000000000000000000000'
          ? state.quoteTokenAddress
          : '';
        return {
          chain,
          address: tokenAddress,
          name: '',
          symbol: String(meta.symbol ?? ''),
          decimals: Number(meta.decimals ?? 18),
          logo: '',
          launchpad: 'flap',
          launchpad_progress: Number(state.progress ?? 0),
          launchpad_platform: 'flap',
          launchpad_status: Number(state.status ?? 0),
          quote_token: '',
          quote_token_address: quote,
          pool_pair: state.pool || '',
          dex_type: 'flap',
          tokenPrice: {
            price: '0',
            marketCap: '0',
            timestamp: Date.now(),
          },
        };
      } catch {
        return null;
      }
    }

    try {
      const info = await FourmemeAPI.getTokenInfo(chain, tokenAddress);
      if (!info) return null;
      try {
        const onchain = await TokenFourmemeService.getTokenInfo(chainId, tokenAddress);
        if (onchain?.quote) info.quote_token_address = String(onchain.quote);
        if (onchain?.aiCreator !== undefined) (info as any).aiCreator = onchain.aiCreator;
      } catch {}
      return info;
    } catch {
      return null;
    }
  };

  const buildGenericTokenInfo = async (chainId: number, tokenAddress: `0x${string}`): Promise<TokenInfo | null> => {
    try {
      const chain = chainNames[chainId as any] ?? 'bsc';
      const meta = await TokenService.getMeta(tokenAddress);
      return {
        chain,
        address: tokenAddress,
        name: '',
        symbol: String(meta.symbol ?? ''),
        decimals: Number(meta.decimals ?? 18),
        logo: '',
        launchpad: '',
        launchpad_progress: 0,
        launchpad_platform: '',
        launchpad_status: 1,
        quote_token: '',
        quote_token_address: '',
        pool_pair: '',
        dex_type: '',
        tokenPrice: {
          price: '0',
          marketCap: '0',
          timestamp: Date.now(),
        },
      };
    } catch {
      return null;
    }
  };

  const getFreshPriceUsd = async (chainId: number, tokenAddress: `0x${string}`, tokenInfo: TokenInfo, fallback: number | null) => {
    if (fallback != null && Number.isFinite(fallback) && fallback > 0) return fallback;
    const p = Number(tokenInfo?.tokenPrice?.price ?? 0);
    if (Number.isFinite(p) && p > 0) return p;
    try {
      const q = await TokenService.getTokenPriceUsdFromRpc({
        chainId,
        tokenAddress,
        tokenInfo,
        cacheTtlMs: 0,
      } as any);
      const n = typeof q === 'number' ? q : Number(q);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  };

  const placeAutoSellOrdersIfEnabled = async (chainId: number, tokenAddress: `0x${string}`, tokenInfo: TokenInfo, basePriceUsd: number) => {
    const settings = await SettingsService.get();
    const cfg = (settings as any).advancedAutoSell;
    if (!cfg?.enabled) return;

    await cancelAllSellLimitOrdersForToken(chainId, tokenAddress);
    const orders = buildStrategySellOrderInputs({
      config: cfg,
      chainId,
      tokenAddress,
      tokenSymbol: tokenInfo.symbol,
      tokenInfo,
      basePriceUsd,
    });
    const trailing = buildStrategyTrailingSellOrderInputs({
      config: cfg,
      chainId,
      tokenAddress,
      tokenSymbol: tokenInfo.symbol,
      tokenInfo,
      basePriceUsd,
    });

    const all = trailing ? [...orders, trailing] : orders;
    if (!all.length) return;
    await Promise.all(all.map((o) => createLimitOrder(o)));
  };

  const tryAutoBuyOnce = async (input: {
    chainId: number;
    tokenAddress: `0x${string}`;
    metrics: TokenMetrics;
    strategy: any;
  }) => {
    const key = getKey(input.chainId, input.tokenAddress);
    if (boughtOnce.has(key)) return;
    if (buyInFlight.has(key)) return;
    buyInFlight.add(key);
    try {
      const amountNumber = parseNumber(input.strategy.buyAmountBnb) ?? 0;
      if (amountNumber <= 0) return;

      const status = await WalletService.getStatus();
      if (status.locked || !status.address) return;

      const tokenInfo = (await fetchTokenInfoFresh(input.chainId, input.tokenAddress)) ?? (await buildGenericTokenInfo(input.chainId, input.tokenAddress));
      if (!tokenInfo) return;

      const refreshedMcap = Number(tokenInfo?.tokenPrice?.marketCap ?? 0);
      const refreshedPrice = Number(tokenInfo?.tokenPrice?.price ?? 0);
      const refreshedMetrics: TokenMetrics = {
        ...input.metrics,
        tokenAddress: input.tokenAddress,
        marketCapUsd: Number.isFinite(refreshedMcap) && refreshedMcap > 0 ? refreshedMcap : input.metrics.marketCapUsd,
        priceUsd: Number.isFinite(refreshedPrice) && refreshedPrice > 0 ? refreshedPrice : input.metrics.priceUsd,
      };
      if (!shouldBuyByConfig(refreshedMetrics, input.strategy)) return;

      const amountWei = parseEther(String(amountNumber));
      const rsp = await TradeService.buy({
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        bnbAmountWei: amountWei.toString(),
        tokenInfo,
      } as any);

      const entryPriceUsd = await getFreshPriceUsd(input.chainId, input.tokenAddress, tokenInfo, refreshedMetrics.priceUsd ?? null);
      boughtOnce.add(key);
      deps.onStateChanged();

      if (entryPriceUsd != null && entryPriceUsd > 0) {
        try {
          await TradeService.approveMaxForSellIfNeeded(input.chainId, input.tokenAddress, tokenInfo);
          await placeAutoSellOrdersIfEnabled(input.chainId, input.tokenAddress, tokenInfo, entryPriceUsd);
        } catch {}
      }

      console.log('XSniperTrade buy tx', (rsp as any)?.txHash ?? '');
    } finally {
      buyInFlight.delete(key);
    }
  };

  const matchesTwitterFilters = (signal: UnifiedTwitterSignal, strategy: any) => {
    const type = String((signal as any).interactionType ?? '').toLowerCase();
    const allowedTypes = Array.isArray(strategy?.interactionTypes) ? strategy.interactionTypes.map((x: any) => String(x).toLowerCase()) : [];
    if (allowedTypes.length && !allowedTypes.includes(type)) return false;

    const targetUsers = Array.isArray(strategy?.targetUsers) ? strategy.targetUsers.map((x: any) => String(x).toLowerCase()).filter(Boolean) : [];
    if (!targetUsers.length) return true;

    const screen = String((signal as any).userScreenName ?? '').toLowerCase();
    const name = String((signal as any).userName ?? '').toLowerCase();
    const author = String((signal as any).author ?? '').toLowerCase();
    return targetUsers.some((u: string) => u === screen || u === name || u === author);
  };

  const metricsFromUnifiedToken = (t: UnifiedSignalToken): TokenMetrics | null => {
    const tokenAddress = normalizeAddress(t.tokenAddress);
    if (!tokenAddress) return null;
    return {
      tokenAddress,
      marketCapUsd: typeof (t as any).marketCapUsd === 'number' ? (t as any).marketCapUsd : undefined,
      liquidityUsd: typeof (t as any).liquidityUsd === 'number' ? (t as any).liquidityUsd : undefined,
      holders: typeof (t as any).holders === 'number' ? (t as any).holders : undefined,
      createdAtMs: typeof (t as any).createdAtMs === 'number' ? (t as any).createdAtMs : undefined,
      devAddress: normalizeAddress((t as any).devAddress) ?? undefined,
      devHoldPercent: typeof (t as any).devHoldPercent === 'number' ? (t as any).devHoldPercent : undefined,
      devHasSold: typeof (t as any).devHasSold === 'boolean'
        ? (t as any).devHasSold
        : (typeof (t as any).devTokenStatus === 'string' ? String((t as any).devTokenStatus).toLowerCase().includes('sell') : undefined),
      priceUsd: typeof (t as any).priceUsd === 'number' ? (t as any).priceUsd : undefined,
    };
  };

  const pickTokensToBuyFromSignal = (signal: UnifiedTwitterSignal, strategy: any) => {
    const tokens = Array.isArray(signal.tokens) ? (signal.tokens as UnifiedSignalToken[]) : [];
    const now = Date.now();
    const candidates = tokens
      .map((t) => ({ t, m: metricsFromUnifiedToken(t) }))
      .filter((x) => x.m && x.m.tokenAddress && shouldBuyByConfig(x.m, strategy));

    const newCa: typeof candidates = [];
    const og: typeof candidates = [];
    for (const c of candidates) {
      const first = typeof (c.t as any).firstSeenAtMs === 'number' ? (c.t as any).firstSeenAtMs : now;
      if (now - first <= 60_000) newCa.push(c);
      else og.push(c);
    }

    const newCount = Math.max(0, Math.floor(parseNumber(strategy?.buyNewCaCount) ?? 0));
    const ogCount = Math.max(0, Math.floor(parseNumber(strategy?.buyOgCount) ?? 0));
    const take = (list: typeof candidates, n: number) => (n > 0 ? list.slice(0, n) : []);

    const picked = [...take(newCa, newCount), ...take(og, ogCount)];
    if (picked.length) return picked;
    if (!candidates.length) return [];
    return [candidates[0]];
  };

  const handleTwitterSignal = async (signal: UnifiedTwitterSignal) => {
    try {
      const settings = await SettingsService.get();
      const config = normalizeAutoTrade((settings as any).autoTrade);
      if (!config) return;
      const strategy = config.twitterSnipe;
      if (!strategy || !strategy.autoSellEnabled) return;
      if (!matchesTwitterFilters(signal, strategy)) return;

      const picked = pickTokensToBuyFromSignal(signal, strategy);
      for (const { m } of picked) {
        if (!m?.tokenAddress) continue;
        await tryAutoBuyOnce({ chainId: settings.chainId, tokenAddress: m.tokenAddress, metrics: m, strategy });
      }
    } catch (e) {
      console.error('XSniperTrade twitter signal handler error', e);
    }
  };

  return { handleTwitterSignal };
};
