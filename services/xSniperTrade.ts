import { parseEther } from 'viem';
import { browser } from 'wxt/browser';
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
  tokenSymbol?: string;
  marketCapUsd?: number;
  liquidityUsd?: number;
  holders?: number;
  kol?: number;
  createdAtMs?: number;
  devAddress?: `0x${string}`;
  devHoldPercent?: number;
  devHasSold?: boolean;
  priceUsd?: number;
};

type XSniperBuyRecord = {
  id: string;
  side?: 'buy' | 'sell';
  tsMs: number;
  chainId: number;
  tokenAddress: `0x${string}`;
  tokenSymbol?: string;
  tokenName?: string;
  buyAmountBnb?: number;
  sellPercent?: number;
  sellTokenAmountWei?: string;
  txHash?: `0x${string}`;
  entryPriceUsd?: number;
  dryRun?: boolean;
  marketCapUsd?: number;
  liquidityUsd?: number;
  holders?: number;
  kol?: number;
  createdAtMs?: number;
  devAddress?: `0x${string}`;
  devHoldPercent?: number;
  devHasSold?: boolean;
  userScreen?: string;
  userName?: string;
  tweetType?: string;
  channel?: string;
  signalId?: string;
  signalEventId?: string;
  signalTweetId?: string;
  reason?: string;
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

const computeTickerLen = (symbol: string) => {
  let total = 0;
  for (const ch of symbol) {
    const cp = ch.codePointAt(0) ?? 0;
    const isCjk =
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0x20000 && cp <= 0x2a6df) ||
      (cp >= 0x2a700 && cp <= 0x2b73f) ||
      (cp >= 0x2b740 && cp <= 0x2b81f) ||
      (cp >= 0x2b820 && cp <= 0x2ceaf) ||
      (cp >= 0x2ceb0 && cp <= 0x2ebef) ||
      (cp >= 0x2f800 && cp <= 0x2fa1f);
    total += isCjk ? 2 : 1;
  }
  return total;
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

  const minTickerLenRaw = parseNumber(config.minTickerLen);
  const maxTickerLenRaw = parseNumber(config.maxTickerLen);
  const minTickerLen = minTickerLenRaw != null ? Math.max(0, Math.floor(minTickerLenRaw)) : null;
  const maxTickerLen = maxTickerLenRaw != null ? Math.max(0, Math.floor(maxTickerLenRaw)) : null;
  if (minTickerLen != null || maxTickerLen != null) {
    const symbol = typeof metrics.tokenSymbol === 'string' ? metrics.tokenSymbol.trim() : '';
    if (!symbol) return false;
    const len = computeTickerLen(symbol);
    if (minTickerLen != null && len < minTickerLen) return false;
    if (maxTickerLen != null && len > maxTickerLen) return false;
  }

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
  const BOUGHT_ONCE_TTL_MS = 6 * 60 * 60 * 1000;
  const BOUGHT_ONCE_STORAGE_KEY = 'dagobang_xsniper_bought_once_v1';
  const HISTORY_STORAGE_KEY = 'dagobang_xsniper_order_history_v1';
  const HISTORY_LIMIT = 200;

  let boughtOnceLoaded = false;
  const boughtOnceAtMs = new Map<string, number>();
  const buyInFlight = new Set<string>();

  const loadBoughtOnceIfNeeded = async () => {
    if (boughtOnceLoaded) return;
    boughtOnceLoaded = true;
    try {
      const res = await browser.storage.local.get(BOUGHT_ONCE_STORAGE_KEY);
      const raw = (res as any)?.[BOUGHT_ONCE_STORAGE_KEY];
      if (!raw || typeof raw !== 'object') return;
      const now = Date.now();
      for (const [key, ts] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof key !== 'string') continue;
        const n = typeof ts === 'number' ? ts : Number(ts);
        if (!Number.isFinite(n)) continue;
        if (now - n > BOUGHT_ONCE_TTL_MS) continue;
        boughtOnceAtMs.set(key, n);
      }
    } catch {
    }
  };

  const persistBoughtOnce = async () => {
    try {
      const now = Date.now();
      const obj: Record<string, number> = {};
      for (const [k, ts] of boughtOnceAtMs) {
        if (now - ts > BOUGHT_ONCE_TTL_MS) continue;
        obj[k] = ts;
      }
      await browser.storage.local.set({ [BOUGHT_ONCE_STORAGE_KEY]: obj } as any);
    } catch {
    }
  };

  const pushHistory = async (record: XSniperBuyRecord) => {
    try {
      const res = await browser.storage.local.get(HISTORY_STORAGE_KEY);
      const raw = (res as any)?.[HISTORY_STORAGE_KEY];
      const list = Array.isArray(raw) ? raw.slice() : [];
      list.unshift(record);
      await browser.storage.local.set({ [HISTORY_STORAGE_KEY]: list.slice(0, HISTORY_LIMIT) } as any);
    } catch {
    }
  };

  const loadHistory = async (): Promise<XSniperBuyRecord[]> => {
    try {
      const res = await browser.storage.local.get(HISTORY_STORAGE_KEY);
      const raw = (res as any)?.[HISTORY_STORAGE_KEY];
      return Array.isArray(raw) ? (raw as XSniperBuyRecord[]) : [];
    } catch {
      return [];
    }
  };

  const broadcastToTabs = async (message: any) => {
    try {
      const tabs = await browser.tabs.query({});
      for (const tab of tabs) {
        if (!tab.id) continue;
        browser.tabs.sendMessage(tab.id, message).catch(() => { });
      }
    } catch {
    }
  };

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

  const getKey = (chainId: number, tokenAddress: `0x${string}`, type?: 'dry') =>
    `${type === 'dry' ? 'dry:' : ''}${chainId}:${tokenAddress.toLowerCase()}`;

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
    signal?: UnifiedTwitterSignal;
  }) => {
    await loadBoughtOnceIfNeeded();
    const dryRun = input.strategy?.dryRun === true;
    const key = getKey(input.chainId, input.tokenAddress, dryRun ? 'dry' : undefined);
    if (boughtOnceAtMs.has(key)) return;
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

      if (dryRun) {
        const entryPriceUsd = await getFreshPriceUsd(input.chainId, input.tokenAddress, tokenInfo, refreshedMetrics.priceUsd ?? null);
        boughtOnceAtMs.set(key, Date.now());
        void persistBoughtOnce();
        deps.onStateChanged();

        const now = Date.now();
        const record: XSniperBuyRecord = {
          id: `${now}-${Math.random().toString(16).slice(2)}`,
          side: 'buy',
          tsMs: now,
          chainId: input.chainId,
          tokenAddress: input.tokenAddress,
          tokenSymbol: tokenInfo.symbol ? String(tokenInfo.symbol) : undefined,
          tokenName: tokenInfo.name ? String(tokenInfo.name) : undefined,
          buyAmountBnb: amountNumber,
          txHash: undefined,
          entryPriceUsd: entryPriceUsd ?? undefined,
          dryRun: true,
          marketCapUsd: refreshedMetrics.marketCapUsd,
          liquidityUsd: refreshedMetrics.liquidityUsd,
          holders: refreshedMetrics.holders,
          kol: refreshedMetrics.kol,
          createdAtMs: refreshedMetrics.createdAtMs,
          devAddress: refreshedMetrics.devAddress,
          devHoldPercent: refreshedMetrics.devHoldPercent,
          devHasSold: refreshedMetrics.devHasSold,
          userScreen: input.signal?.userScreen ? String(input.signal.userScreen) : undefined,
          userName: input.signal?.userName ? String(input.signal.userName) : undefined,
          tweetType: input.signal?.tweetType ? String(input.signal.tweetType) : undefined,
          channel: input.signal?.channel ? String(input.signal.channel) : undefined,
          signalId: input.signal?.id ? String(input.signal.id) : undefined,
          signalEventId: input.signal?.eventId ? String(input.signal.eventId) : undefined,
          signalTweetId: input.signal?.tweetId ? String(input.signal.tweetId) : undefined,
        };
        void pushHistory(record);
        void broadcastToTabs({ type: 'bg:xsniper:buy', record });
        return;
      }

      const amountWei = parseEther(String(amountNumber));
      const rsp = await TradeService.buy({
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        bnbAmountWei: amountWei.toString(),
        tokenInfo,
      } as any);

      const entryPriceUsd = await getFreshPriceUsd(input.chainId, input.tokenAddress, tokenInfo, refreshedMetrics.priceUsd ?? null);
      boughtOnceAtMs.set(key, Date.now());
      void persistBoughtOnce();
      deps.onStateChanged();

      const now = Date.now();
      const record: XSniperBuyRecord = {
        id: `${now}-${Math.random().toString(16).slice(2)}`,
        side: 'buy',
        tsMs: now,
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        tokenSymbol: tokenInfo.symbol ? String(tokenInfo.symbol) : undefined,
        tokenName: tokenInfo.name ? String(tokenInfo.name) : undefined,
        buyAmountBnb: amountNumber,
        txHash: typeof (rsp as any)?.txHash === 'string' ? ((rsp as any).txHash as any) : undefined,
        entryPriceUsd: entryPriceUsd ?? undefined,
        dryRun: false,
        marketCapUsd: refreshedMetrics.marketCapUsd,
        liquidityUsd: refreshedMetrics.liquidityUsd,
        holders: refreshedMetrics.holders,
        kol: refreshedMetrics.kol,
        createdAtMs: refreshedMetrics.createdAtMs,
        devAddress: refreshedMetrics.devAddress,
        devHoldPercent: refreshedMetrics.devHoldPercent,
        devHasSold: refreshedMetrics.devHasSold,
        userScreen: input.signal?.userScreen ? String(input.signal.userScreen) : undefined,
        userName: input.signal?.userName ? String(input.signal.userName) : undefined,
        tweetType: input.signal?.tweetType ? String(input.signal.tweetType) : undefined,
        channel: input.signal?.channel ? String(input.signal.channel) : undefined,
        signalId: input.signal?.id ? String(input.signal.id) : undefined,
        signalEventId: input.signal?.eventId ? String(input.signal.eventId) : undefined,
        signalTweetId: input.signal?.tweetId ? String(input.signal.tweetId) : undefined,
      };
      void pushHistory(record);
      void broadcastToTabs({ type: 'bg:xsniper:buy', record });

      if (input.strategy?.autoSellEnabled && entryPriceUsd != null && entryPriceUsd > 0) {
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
    const type = (() => {
      const raw = signal.tweetType === 'delete_post' ? (signal.sourceTweetType ?? null) : signal.tweetType;
      if (raw === 'repost') return 'retweet';
      if (raw === 'tweet') return 'tweet';
      if (raw === 'reply') return 'reply';
      if (raw === 'quote') return 'quote';
      if (raw === 'follow') return 'follow';
      return '';
    })();
    const allowedTypes = Array.isArray(strategy?.interactionTypes) ? strategy.interactionTypes.map((x: any) => String(x).toLowerCase()) : [];
    if (allowedTypes.length && !allowedTypes.includes(type)) return false;

    const targetUsers = Array.isArray(strategy?.targetUsers) ? strategy.targetUsers.map((x: any) => String(x).toLowerCase()).filter(Boolean) : [];
    if (!targetUsers.length) return true;

    const screen = String(signal.userScreen ?? '').replace(/^@/, '').toLowerCase();
    const name = String(signal.userName ?? '').toLowerCase();
    return targetUsers.some((u: string) => u === screen || u === name);
  };

  const metricsFromUnifiedToken = (t: UnifiedSignalToken): TokenMetrics | null => {
    const tokenAddress = normalizeAddress(t.tokenAddress);
    if (!tokenAddress) return null;
    return {
      tokenAddress,
      tokenSymbol: typeof (t as any).tokenSymbol === 'string' ? String((t as any).tokenSymbol) : undefined,
      marketCapUsd: typeof (t as any).marketCapUsd === 'number' ? (t as any).marketCapUsd : undefined,
      liquidityUsd: typeof (t as any).liquidityUsd === 'number' ? (t as any).liquidityUsd : undefined,
      holders: typeof (t as any).holders === 'number' ? (t as any).holders : undefined,
      kol: typeof (t as any).kol === 'number' ? (t as any).kol : undefined,
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
    const perTweetMax = Math.max(0, Math.floor(parseNumber(strategy?.buyNewCaCount) ?? 0));
    if (perTweetMax <= 0) return [];
    const unique: UnifiedSignalToken[] = [];
    const seen = new Set<string>();
    for (const t of tokens) {
      const addr = typeof (t as any)?.tokenAddress === 'string' ? String((t as any).tokenAddress).trim() : '';
      const key = addr.toLowerCase();
      if (!addr) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(t);
      if (unique.length >= Math.max(5, perTweetMax)) break;
    }

    const candidates = unique
      .map((t) => ({ t, m: metricsFromUnifiedToken(t) }))
      .filter((x) => x.m && x.m.tokenAddress && shouldBuyByConfig(x.m, strategy));

    const ogCount = Math.max(0, Math.floor(parseNumber(strategy?.buyOgCount) ?? 0));
    const maxCount = perTweetMax;
    let leftNew = perTweetMax;
    let leftOg = ogCount;

    const picked: typeof candidates = [];
    const pickedKey = new Set<string>();
    for (const c of candidates) {
      if (picked.length >= maxCount) break;
      const key = String(c.m!.tokenAddress).toLowerCase();
      if (pickedKey.has(key)) continue;
      const first = typeof (c.t as any).firstSeenAtMs === 'number' ? (c.t as any).firstSeenAtMs : now;
      const isNew = now - first <= 60_000;
      if (isNew && leftNew > 0) {
        leftNew -= 1;
        picked.push(c);
        pickedKey.add(key);
      } else if (!isNew && leftOg > 0) {
        leftOg -= 1;
        picked.push(c);
        pickedKey.add(key);
      }
    }

    for (const c of candidates) {
      if (picked.length >= maxCount) break;
      const key = String(c.m!.tokenAddress).toLowerCase();
      if (pickedKey.has(key)) continue;
      picked.push(c);
      pickedKey.add(key);
    }

    return picked;
  };

  const deleteSellInFlight = new Set<string>();

  const tryDeleteTweetSellOnce = async (input: {
    chainId: number;
    tokenAddress: `0x${string}`;
    percent: number;
    signal: UnifiedTwitterSignal;
    relatedBuy?: XSniperBuyRecord;
    dryRun: boolean;
  }) => {
    const percent = Math.max(0, Math.min(100, Number(input.percent)));
    if (!Number.isFinite(percent) || percent <= 0) return;
    const bps = Math.floor(percent * 100);
    if (!(bps > 0)) return;

    const dedupeKey = `${input.chainId}:${input.tokenAddress.toLowerCase()}:${String(input.signal.eventId ?? '')}:${String(input.signal.tweetId ?? '')}:${bps}`;
    if (deleteSellInFlight.has(dedupeKey)) return;
    deleteSellInFlight.add(dedupeKey);
    try {
      const now = Date.now();
      const baseRecord: XSniperBuyRecord = {
        id: `${now}-${Math.random().toString(16).slice(2)}`,
        side: 'sell',
        tsMs: now,
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        tokenSymbol: input.relatedBuy?.tokenSymbol,
        tokenName: input.relatedBuy?.tokenName,
        sellPercent: percent,
        sellTokenAmountWei: undefined,
        txHash: undefined,
        dryRun: input.dryRun,
        tweetType: input.signal.tweetType,
        channel: input.signal.channel,
        signalId: input.signal.id,
        signalEventId: input.signal.eventId,
        signalTweetId: input.signal.tweetId,
      };

      if (input.dryRun) {
        const record = { ...baseRecord, reason: 'dry_run' };
        void pushHistory(record);
        void broadcastToTabs({ type: 'bg:xsniper:buy', record });
        return;
      }

      const status = await WalletService.getStatus();
      if (status.locked || !status.address) {
        const record = { ...baseRecord, dryRun: false, reason: 'wallet_locked' };
        void pushHistory(record);
        void broadcastToTabs({ type: 'bg:xsniper:buy', record });
        return;
      }

      const tokenInfo =
        (await fetchTokenInfoFresh(input.chainId, input.tokenAddress)) ??
        (await buildGenericTokenInfo(input.chainId, input.tokenAddress));
      if (!tokenInfo) {
        const record = { ...baseRecord, dryRun: false, reason: 'token_info_missing' };
        void pushHistory(record);
        void broadcastToTabs({ type: 'bg:xsniper:buy', record });
        return;
      }

      const settings = await SettingsService.get();
      const isTurbo = (settings as any).chains?.[input.chainId]?.executionMode === 'turbo';
      let balanceWei = 0n;
      try {
        balanceWei = BigInt(await TokenService.getBalance(input.tokenAddress, status.address));
      } catch {
        balanceWei = 0n;
      }

      if (balanceWei <= 0n) {
        const record = { ...baseRecord, dryRun: false, sellTokenAmountWei: '0', reason: 'no_balance' };
        void pushHistory(record);
        void broadcastToTabs({ type: 'bg:xsniper:buy', record });
        return;
      }

      let amountWei = (balanceWei * BigInt(bps)) / 10000n;
      if (amountWei > balanceWei) amountWei = balanceWei;
      const platform = tokenInfo?.launchpad_platform?.toLowerCase() || '';
      const isInnerFourMeme = !!(tokenInfo as any)?.launchpad && platform.includes('fourmeme') && (tokenInfo as any).launchpad_status !== 1;
      if (!isTurbo && isInnerFourMeme && amountWei > 0n) {
        amountWei = (amountWei / 1000000000n) * 1000000000n;
      }
      if (!isTurbo && amountWei <= 0n) {
        const record = { ...baseRecord, dryRun: false, sellTokenAmountWei: '0', reason: 'invalid_amount' };
        void pushHistory(record);
        void broadcastToTabs({ type: 'bg:xsniper:buy', record });
        return;
      }

      try {
        await TradeService.approveMaxForSellIfNeeded(input.chainId, input.tokenAddress, tokenInfo);
      } catch {}
      const rsp = await TradeService.sell({
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        tokenAmountWei: amountWei.toString(),
        tokenInfo,
        sellPercentBps: bps,
      } as any);

      const record: XSniperBuyRecord = {
        ...baseRecord,
        dryRun: false,
        tokenSymbol: tokenInfo.symbol ? String(tokenInfo.symbol) : baseRecord.tokenSymbol,
        tokenName: tokenInfo.name ? String(tokenInfo.name) : baseRecord.tokenName,
        sellTokenAmountWei: amountWei.toString(),
        txHash: typeof (rsp as any)?.txHash === 'string' ? ((rsp as any).txHash as any) : undefined,
      };
      void pushHistory(record);
      void broadcastToTabs({ type: 'bg:xsniper:buy', record });
    } finally {
      deleteSellInFlight.delete(dedupeKey);
    }
  };

  const handleTwitterSignal = async (signal: UnifiedTwitterSignal) => {
    try {
      const settings = await SettingsService.get();
      const config = normalizeAutoTrade((settings as any).autoTrade);
      if (!config) return;
      if (config.wsMonitorEnabled === false) return;
      const strategy = config.twitterSnipe;
      if (!strategy) return;
      if (strategy.enabled === false) return;
      if (!matchesTwitterFilters(signal, strategy)) return;

      if (signal.tweetType === 'delete_post') {
        const pct = parseNumber(strategy.deleteTweetSellPercent) ?? 0;
        const percent = Math.max(0, Math.min(100, pct));
        if (!(percent > 0)) return;

        const delEventId = String(signal.eventId ?? '').trim();
        const delTweetId = String(signal.tweetId ?? '').trim();
        if (!delEventId && !delTweetId) return;

        const history = await loadHistory();
        const matchedBuys = history.filter((r) => {
          if (!r) return false;
          if (r.side && r.side !== 'buy') return false;
          const ev = typeof r.signalEventId === 'string' ? r.signalEventId.trim() : '';
          const tw = typeof r.signalTweetId === 'string' ? r.signalTweetId.trim() : '';
          if (delEventId && ev && ev === delEventId) return true;
          if (delTweetId && tw && tw === delTweetId) return true;
          return false;
        });
        for (const r of matchedBuys) {
          const addr = normalizeAddress(r.tokenAddress);
          if (!addr) continue;
          await tryDeleteTweetSellOnce({
            chainId: r.chainId ?? settings.chainId,
            tokenAddress: addr,
            percent,
            signal,
            relatedBuy: r,
            dryRun: strategy.dryRun === true,
          });
        }
        return;
      }

      const picked = pickTokensToBuyFromSignal(signal, strategy);
      for (const { m } of picked) {
        if (!m?.tokenAddress) continue;
        await tryAutoBuyOnce({ chainId: settings.chainId, tokenAddress: m.tokenAddress, metrics: m, strategy, signal });
      }
    } catch (e) {
      console.error('XSniperTrade twitter signal handler error', e);
    }
  };

  return { handleTwitterSignal };
};
