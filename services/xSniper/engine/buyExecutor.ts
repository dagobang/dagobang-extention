import { parseEther } from 'viem';
import { WalletService } from '@/services/wallet';
import { SettingsService } from '@/services/settings';
import { TradeService } from '@/services/trade';
import {
  buildStrategyRollingTakeProfitOrderInputs,
  buildStrategySellOrderInputs,
  buildStrategyTrailingSellOrderInputs,
  getAdvancedAutoSellMode,
} from '@/services/limitOrders/advancedAutoSell';
import { cancelAllSellLimitOrdersForToken, createLimitOrder } from '@/services/limitOrders/store';
import { buildTweetUrl, getSignalTimeMs, isRepostOrQuoteSignal, parseNumber, sanitizeMarketCapUsd, shouldBuyByConfig, type TokenMetrics } from '@/services/xSniper/engine/metrics';
import type { UnifiedTwitterSignal, XSniperBuyRecord } from '@/types/extention';
import type { TokenInfo } from '@/types/token';
import type { DryRunAutoSellPos } from '@/services/xSniper/engine/dryRunAutoSell';

const resolveEntryMcapAnchor = (input: {
  postBuyMcapUsd?: number | null;
  entryPriceUsd?: number | null;
  referencePriceUsd?: number | null;
  referenceMcapUsd?: number | null;
  fallbackMcapUsd?: number | null;
}) => {
  const postBuyMcapUsd = sanitizeMarketCapUsd(input.postBuyMcapUsd);
  if (postBuyMcapUsd != null) return postBuyMcapUsd;
  const entryPriceUsd = Number(input.entryPriceUsd);
  const referencePriceUsd = Number(input.referencePriceUsd);
  const referenceMcapUsd = sanitizeMarketCapUsd(input.referenceMcapUsd);
  if (
    Number.isFinite(entryPriceUsd) && entryPriceUsd > 0
    && Number.isFinite(referencePriceUsd) && referencePriceUsd > 0
    && referenceMcapUsd != null
  ) {
    const impliedSupply = referenceMcapUsd / referencePriceUsd;
    if (Number.isFinite(impliedSupply) && impliedSupply > 0) {
      const estimatedMcap = sanitizeMarketCapUsd(entryPriceUsd * impliedSupply);
      if (estimatedMcap != null) return estimatedMcap;
    }
  }
  return sanitizeMarketCapUsd(input.fallbackMcapUsd);
};

const buildWsAutoSellPosition = (input: {
  cfg: any;
  chainId: number;
  tokenAddress: `0x${string}`;
  openedAtMs: number;
  entryMcapUsd: number;
  sellLatencyMs?: number;
  tweetAtMs?: number;
  tweetUrl?: string;
  tweetType?: string;
  channel?: string;
  signalId?: string;
  signalEventId?: string;
  signalTweetId?: string;
}): DryRunAutoSellPos | null => {
  const entryMcapUsd = Number(input.entryMcapUsd);
  if (!Number.isFinite(entryMcapUsd) || entryMcapUsd <= 0) return null;
  const cfg = input.cfg as any;
  const rules = Array.isArray(cfg?.rules) ? (cfg.rules as any[]) : [];
  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
  const takeProfits: Array<{ id: string; triggerMcapUsd: number; sellPercentBps: number; triggerPercent: number }> = [];
  const stopLosses: Array<{ id: string; triggerMcapUsd: number; sellPercentBps: number; triggerPercent: number }> = [];
  for (const r of rules) {
    const id = typeof r?.id === 'string' && r.id.trim() ? String(r.id).trim() : '';
    if (!id) continue;
    const rawTrigger = Number(r?.triggerPercent);
    const rawSell = Number(r?.sellPercent);
    if (!Number.isFinite(rawTrigger) || !Number.isFinite(rawSell)) continue;
    const baseTrigger = clamp(rawTrigger, -99.9, 100000);
    const triggerPercent = r?.type === 'stop_loss' ? -Math.abs(baseTrigger) : Math.abs(baseTrigger);
    const sellPercent = clamp(rawSell, 0, 100);
    const sellPercentBps = Math.round(sellPercent * 100);
    if (!(sellPercentBps > 0 && sellPercentBps <= 10000)) continue;
    const triggerMcapUsd = entryMcapUsd * (1 + triggerPercent / 100);
    if (!Number.isFinite(triggerMcapUsd) || triggerMcapUsd <= 0) continue;
    if (r?.type === 'stop_loss') stopLosses.push({ id, triggerMcapUsd, sellPercentBps, triggerPercent });
    else takeProfits.push({ id, triggerMcapUsd, sellPercentBps, triggerPercent });
  }
  const trailingRaw = cfg?.trailingStop as any;
  const trailingSellPercent = Number.isFinite(Number(trailingRaw?.sellPercent))
    ? clamp(Number(trailingRaw?.sellPercent), 1, 100)
    : 100;
  const trailing =
    trailingRaw?.enabled === true
      ? {
          enabled: true,
          callbackPercent: Number.isFinite(Number(trailingRaw?.callbackPercent))
            ? clamp(Number(trailingRaw?.callbackPercent), 0.1, 99.9)
            : 15,
          sellPercentBps: Math.round(trailingSellPercent * 100),
          activationMode:
            trailingRaw?.activationMode === 'after_first_take_profit' || trailingRaw?.activationMode === 'after_last_take_profit'
              ? trailingRaw.activationMode
              : 'immediate',
          active: false,
          peakMcapUsd: entryMcapUsd,
        }
      : null;
  const hasRules = takeProfits.length > 0 || stopLosses.length > 0 || !!trailing;
  if (!hasRules) return null;
  return {
    chainId: input.chainId,
    tokenAddress: input.tokenAddress,
    openedAtMs: input.openedAtMs,
    entryMcapUsd,
    remainingBps: 10000,
    sellLatencyMs: Number.isFinite(input.sellLatencyMs as any) ? Math.max(0, Math.floor(input.sellLatencyMs as number)) : 2000,
    takeProfits,
    stopLosses,
    trailing,
    takeProfitTotal: takeProfits.length,
    takeProfitExecuted: 0,
    executedIds: new Set<string>(),
    tweetAtMs: input.tweetAtMs,
    tweetUrl: input.tweetUrl,
    tweetType: input.tweetType,
    channel: input.channel,
    signalId: input.signalId,
    signalEventId: input.signalEventId,
    signalTweetId: input.signalTweetId,
  };
};

export const tryAutoBuyOnce = async (input: {
  chainId: number;
  tokenAddress: `0x${string}`;
  metrics: TokenMetrics;
  strategy: any;
  signal?: UnifiedTwitterSignal;
  amountBnbOverride?: number;
  gasPriceGweiOverride?: string;
  priorityFeeBnbOverride?: string;
  tokenAgeMode?: 'signal_delta' | 'now_age';
  onStateChanged: () => void;
  loadBoughtOnceIfNeeded: () => Promise<void>;
  persistBoughtOnce: () => Promise<void>;
  getKey: (chainId: number, tokenAddress: `0x${string}`, opts?: { dry?: boolean }) => string;
  boughtOnceAtMs: Map<string, number>;
  buyInFlight: Set<string>;
  computeWsConfirm: (tokenAddress: `0x${string}`, nowMs: number, strategy: any) => {
    pass: boolean;
    windowMs: number;
    stats?: { mcapChangePct?: number; holdersDelta?: number; buySellRatio?: number };
  };
  shouldLogWsConfirmFail: (key: string, nowMs: number) => boolean;
  shouldEmitBuyFailureRecord?: (input: {
    reason: string;
    chainId: number;
    tokenAddress: `0x${string}`;
    signal?: UnifiedTwitterSignal;
  }) => boolean;
  emitRecord: (record: XSniperBuyRecord) => void;
  broadcastToActiveTabs: (message: any) => Promise<void>;
  fetchTokenInfoFresh: (chainId: number, tokenAddress: `0x${string}`) => Promise<TokenInfo | null>;
  buildGenericTokenInfo: (chainId: number, tokenAddress: `0x${string}`) => Promise<TokenInfo | null>;
  getEntryPriceUsd: (
    chainId: number,
    tokenAddress: `0x${string}`,
    tokenInfo: TokenInfo,
    fallback: number | null,
    fallbackMcapUsd: number | null,
  ) => Promise<number | null>;
  registerRapidExitPosition: (input: {
    strategy: any;
    posKey: string;
    chainId: number;
    tokenAddress: `0x${string}`;
    dryRun: boolean;
    entryMcapUsd: number | null;
    buyAmountBnb: number;
    openedAtMs: number;
    tweetAtMs?: number;
    tweetUrl?: string;
    tweetType?: string;
    channel?: string;
    signalId?: string;
    signalEventId?: string;
    signalTweetId?: string;
    entryPriceUsd?: number | null;
  }) => void;
  dryRunAutoSellByPosKey: Map<string, DryRunAutoSellPos>;
}) => {
  await input.loadBoughtOnceIfNeeded();
  const dryRun = input.strategy?.dryRun === true;
  const key = input.getKey(input.chainId, input.tokenAddress, { dry: dryRun });
  const emitBuyFailure = (reason: string, extras?: {
    buyAmountBnb?: number;
    metrics?: TokenMetrics;
    tokenInfo?: TokenInfo | null;
    confirm?: { windowMs?: number; stats?: { mcapChangePct?: number; holdersDelta?: number; buySellRatio?: number } };
  }) => {
    if (reason === 'buy_skipped_recently_bought' || reason === 'buy_skipped_in_flight') return;
    if (dryRun) {
      const m = extras?.metrics ?? input.metrics;
      console.log('XSniperTrade dry-run buy skipped', {
        reason,
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        launchpadPlatform: m.launchpadPlatform,
        signalId: input.signal?.id ? String(input.signal.id) : undefined,
        signalEventId: input.signal?.eventId ? String(input.signal.eventId) : undefined,
        signalTweetId: input.signal?.tweetId ? String(input.signal.tweetId) : undefined,
        buyAmountBnb: extras?.buyAmountBnb,
        confirmWindowMs: extras?.confirm?.windowMs,
        confirmStats: extras?.confirm?.stats,
      });
      return;
    }
    if (input.shouldEmitBuyFailureRecord && !input.shouldEmitBuyFailureRecord({
      reason,
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      signal: input.signal,
    })) return;
    console.warn('XSniperTrade buy skipped', { reason, chainId: input.chainId, tokenAddress: input.tokenAddress });
    const now = Date.now();
    const tweetAtMs = getSignalTimeMs(input.signal) ?? undefined;
    const tweetUrl = buildTweetUrl(input.signal);
    const m = extras?.metrics ?? input.metrics;
    input.emitRecord({
      id: `${now}-${Math.random().toString(16).slice(2)}`,
      side: 'buy',
      tsMs: now,
      tweetAtMs,
      tweetUrl,
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      tokenSymbol: extras?.tokenInfo?.symbol ? String(extras.tokenInfo.symbol) : (m.tokenSymbol ? String(m.tokenSymbol) : undefined),
      tokenName: extras?.tokenInfo?.name ? String(extras.tokenInfo.name) : undefined,
      launchpadPlatform: m.launchpadPlatform,
      buyAmountBnb: extras?.buyAmountBnb,
      dryRun: false,
      reason,
      marketCapUsd: m.marketCapUsd,
      liquidityUsd: m.liquidityUsd,
      holders: m.holders,
      kol: m.kol,
      vol24hUsd: m.vol24hUsd,
      netBuy24hUsd: m.netBuy24hUsd,
      buyTx24h: m.buyTx24h,
      sellTx24h: m.sellTx24h,
      smartMoney: m.smartMoney,
      createdAtMs: m.createdAtMs,
      devAddress: m.devAddress,
      devHoldPercent: m.devHoldPercent,
      devHasSold: m.devHasSold,
      confirmWindowMs: extras?.confirm?.windowMs,
      confirmMcapChangePct: extras?.confirm?.stats?.mcapChangePct,
      confirmHoldersDelta: extras?.confirm?.stats?.holdersDelta,
      confirmBuySellRatio: extras?.confirm?.stats?.buySellRatio,
      userScreen: input.signal?.userScreen ? String(input.signal.userScreen) : undefined,
      userName: input.signal?.userName ? String(input.signal.userName) : undefined,
      tweetType: input.signal?.tweetType ? String(input.signal.tweetType) : undefined,
      channel: input.signal?.channel ? String(input.signal.channel) : undefined,
      signalId: input.signal?.id ? String(input.signal.id) : undefined,
      signalEventId: input.signal?.eventId ? String(input.signal.eventId) : undefined,
      signalTweetId: input.signal?.tweetId ? String(input.signal.tweetId) : undefined,
    });
  };
  if (input.boughtOnceAtMs.has(key)) {
    emitBuyFailure('buy_skipped_recently_bought');
    return false;
  }
  if (input.buyInFlight.has(key)) {
    emitBuyFailure('buy_skipped_in_flight');
    return false;
  }
  input.buyInFlight.add(key);
  try {
    const amountNumber = (typeof input.amountBnbOverride === 'number' && Number.isFinite(input.amountBnbOverride)
      ? input.amountBnbOverride
      : (parseNumber(input.strategy.buyAmountBnb) ?? 0));
    if (amountNumber <= 0) {
      emitBuyFailure('buy_invalid_amount', { buyAmountBnb: amountNumber });
      return false;
    }

    const confirmNowMs = Date.now();
    const confirm = input.computeWsConfirm(input.tokenAddress, confirmNowMs, input.strategy);
    if (!confirm.pass) {
      if (dryRun) {
        const sigKey = typeof input.signal?.id === 'string' && input.signal.id.trim() ? input.signal.id.trim() : '';
        const dedupe = `${sigKey}:${input.chainId}:${input.tokenAddress.toLowerCase()}`;
        if (input.shouldLogWsConfirmFail(dedupe, confirmNowMs)) {
          const tweetAtMs = getSignalTimeMs(input.signal) ?? undefined;
          const tweetUrl = buildTweetUrl(input.signal);
          input.emitRecord({
            id: `${confirmNowMs}-${Math.random().toString(16).slice(2)}`,
            side: 'buy',
            tsMs: confirmNowMs,
            tweetAtMs,
            tweetUrl,
            chainId: input.chainId,
            tokenAddress: input.tokenAddress,
            tokenSymbol: input.metrics.tokenSymbol,
            launchpadPlatform: input.metrics.launchpadPlatform,
            buyAmountBnb: amountNumber,
            dryRun: true,
            reason: 'ws_confirm_failed',
            marketCapUsd: input.metrics.marketCapUsd,
            liquidityUsd: input.metrics.liquidityUsd,
            holders: input.metrics.holders,
            kol: input.metrics.kol,
            vol24hUsd: input.metrics.vol24hUsd,
            netBuy24hUsd: input.metrics.netBuy24hUsd,
            buyTx24h: input.metrics.buyTx24h,
            sellTx24h: input.metrics.sellTx24h,
            smartMoney: input.metrics.smartMoney,
            createdAtMs: input.metrics.createdAtMs,
            devAddress: input.metrics.devAddress,
            devHoldPercent: input.metrics.devHoldPercent,
            devHasSold: input.metrics.devHasSold,
            confirmWindowMs: confirm.windowMs,
            confirmMcapChangePct: confirm.stats?.mcapChangePct ?? undefined,
            confirmHoldersDelta: confirm.stats?.holdersDelta ?? undefined,
            confirmBuySellRatio: confirm.stats?.buySellRatio ?? undefined,
            userScreen: input.signal?.userScreen ? String(input.signal.userScreen) : undefined,
            userName: input.signal?.userName ? String(input.signal.userName) : undefined,
            tweetType: input.signal?.tweetType ? String(input.signal.tweetType) : undefined,
            channel: input.signal?.channel ? String(input.signal.channel) : undefined,
            signalId: input.signal?.id ? String(input.signal.id) : undefined,
            signalEventId: input.signal?.eventId ? String(input.signal.eventId) : undefined,
            signalTweetId: input.signal?.tweetId ? String(input.signal.tweetId) : undefined,
          });
        }
      }
      emitBuyFailure('ws_confirm_failed', {
        buyAmountBnb: amountNumber,
        confirm,
      });
      return false;
    }

    const status = await WalletService.getStatus();
    if (!dryRun && (status.locked || !status.address)) {
      emitBuyFailure('wallet_locked', { buyAmountBnb: amountNumber, confirm });
      return false;
    }
    const tradeFromAddress =
      !dryRun && status.address
        ? (String(status.address) as `0x${string}`)
        : undefined;

    let settings: any = null;
    try {
      settings = await SettingsService.get();
    } catch {
      settings = null;
    }
    const tokenInfo =
      (await input.fetchTokenInfoFresh(input.chainId, input.tokenAddress)) ??
      (await input.buildGenericTokenInfo(input.chainId, input.tokenAddress));
    if (!tokenInfo) {
      emitBuyFailure('token_info_missing', { buyAmountBnb: amountNumber, confirm });
      return false;
    }

    const sanitizedInputMcap = sanitizeMarketCapUsd(input.metrics.marketCapUsd);
    const refreshedMcap = Number(tokenInfo?.tokenPrice?.marketCap ?? 0);
    const sanitizedRefreshedMcap = sanitizeMarketCapUsd(refreshedMcap);
    const refreshedMetrics: TokenMetrics = {
      ...input.metrics,
      tokenAddress: input.tokenAddress,
      marketCapUsd: sanitizedRefreshedMcap ?? sanitizedInputMcap ?? undefined,
      priceUsd: input.metrics.priceUsd,
    };
    const signalAtMs = getSignalTimeMs(input.signal);
    const skipTokenCreatedAtWindowCheck = isRepostOrQuoteSignal(input.signal);
    if (!shouldBuyByConfig(refreshedMetrics, input.strategy, signalAtMs, Date.now(), {
      skipTokenCreatedAtWindowCheck,
      tokenAgeMode: input.tokenAgeMode,
    })) {
      emitBuyFailure('buy_filter_mismatch_after_refresh', {
        buyAmountBnb: amountNumber,
        metrics: refreshedMetrics,
        tokenInfo,
        confirm,
      });
      return false;
    }

    if (dryRun) {
      const dryRunBuyDelayMs = Math.max(0, Math.min(10_000, Math.floor(parseNumber(input.strategy?.dryRunBuyDelayMs) ?? 1000)));
      const dryRunSellDelayMs = Math.max(0, Math.min(10_000, Math.floor(parseNumber(input.strategy?.dryRunSellDelayMs) ?? 2000)));
      if (dryRunBuyDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, dryRunBuyDelayMs));
      }
      const delayedRefreshed: any = (await input.fetchTokenInfoFresh(input.chainId, input.tokenAddress)) ?? {};
      const delayedTokenInfo = delayedRefreshed.tokenInfo ?? tokenInfo;
      const delayedRawMcap = Number(delayedTokenInfo?.tokenPrice?.marketCap ?? 0);
      const delayedMcap = sanitizeMarketCapUsd(delayedRawMcap);
      const dryRunMetrics: TokenMetrics = {
        ...refreshedMetrics,
        marketCapUsd: delayedMcap ?? refreshedMetrics.marketCapUsd,
      };
      const entryPriceUsd = await input.getEntryPriceUsd(
        input.chainId,
        input.tokenAddress,
        delayedTokenInfo,
        dryRunMetrics.priceUsd ?? null,
        dryRunMetrics.marketCapUsd ?? null,
      );
      const delayedTokenPriceUsd = Number(delayedTokenInfo?.tokenPrice?.price ?? 0);
      const dryRunEntryMcapAnchor = resolveEntryMcapAnchor({
        postBuyMcapUsd: delayedMcap,
        entryPriceUsd,
        referencePriceUsd: Number.isFinite(dryRunMetrics.priceUsd as any) ? Number(dryRunMetrics.priceUsd) : delayedTokenPriceUsd,
        referenceMcapUsd: dryRunMetrics.marketCapUsd ?? null,
        fallbackMcapUsd: dryRunMetrics.marketCapUsd ?? null,
      });
      input.boughtOnceAtMs.set(key, Date.now());
      void input.persistBoughtOnce();
      input.onStateChanged();

      const posKey = `${input.chainId}:${input.tokenAddress.toLowerCase()}`;
      const openedAtMs = Date.now();
      const tweetAtMs = getSignalTimeMs(input.signal) ?? undefined;
      const tweetUrl = buildTweetUrl(input.signal);
      const tweetType = input.signal?.tweetType ? String(input.signal.tweetType) : undefined;
      const channel = input.signal?.channel ? String(input.signal.channel) : undefined;
      const signalId = input.signal?.id ? String(input.signal.id) : undefined;
      const signalEventId = input.signal?.eventId ? String(input.signal.eventId) : undefined;
      const signalTweetId = input.signal?.tweetId ? String(input.signal.tweetId) : undefined;
      input.registerRapidExitPosition({
        strategy: input.strategy,
        posKey,
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        dryRun: true,
        entryMcapUsd: dryRunEntryMcapAnchor,
        buyAmountBnb: amountNumber,
        openedAtMs,
        tweetAtMs,
        tweetUrl,
        tweetType,
        channel,
        signalId,
        signalEventId,
        signalTweetId,
        entryPriceUsd,
      });

      if (input.strategy?.autoSellEnabled === true) {
        try {
          const settings = await SettingsService.get();
          const cfg = (settings as any).advancedAutoSell as any;
          if (cfg?.enabled) {
            const rawEntryMcap = dryRunMetrics.marketCapUsd;
            const entryMcapUsd = typeof rawEntryMcap === 'number' && Number.isFinite(rawEntryMcap) && rawEntryMcap > 0 ? rawEntryMcap : null;
            if (entryMcapUsd != null && entryMcapUsd > 0) {
              const wsPlan = buildWsAutoSellPosition({
                cfg,
                chainId: input.chainId,
                tokenAddress: input.tokenAddress,
                openedAtMs,
                entryMcapUsd,
                sellLatencyMs: dryRunSellDelayMs,
                tweetAtMs,
                tweetUrl,
                tweetType,
                channel,
                signalId,
                signalEventId,
                signalTweetId,
              });
              if (wsPlan) input.dryRunAutoSellByPosKey.set(posKey, wsPlan);
            }
          }
        } catch {
        }
      }

      const now = Date.now();
      input.emitRecord({
        id: `${now}-${Math.random().toString(16).slice(2)}`,
        side: 'buy',
        tsMs: now,
        tweetAtMs,
        tweetUrl,
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        tokenSymbol: delayedTokenInfo.symbol ? String(delayedTokenInfo.symbol) : undefined,
        tokenName: delayedTokenInfo.name ? String(delayedTokenInfo.name) : undefined,
        launchpadPlatform: dryRunMetrics.launchpadPlatform,
        buyAmountBnb: amountNumber,
        txHash: undefined,
        entryPriceUsd: entryPriceUsd ?? undefined,
        dryRun: true,
        marketCapUsd: dryRunEntryMcapAnchor ?? dryRunMetrics.marketCapUsd,
        athMarketCapUsd: dryRunEntryMcapAnchor ?? dryRunMetrics.marketCapUsd,
        liquidityUsd: dryRunMetrics.liquidityUsd,
        holders: dryRunMetrics.holders,
        kol: dryRunMetrics.kol,
        vol24hUsd: dryRunMetrics.vol24hUsd,
        netBuy24hUsd: dryRunMetrics.netBuy24hUsd,
        buyTx24h: dryRunMetrics.buyTx24h,
        sellTx24h: dryRunMetrics.sellTx24h,
        smartMoney: dryRunMetrics.smartMoney,
        createdAtMs: dryRunMetrics.createdAtMs,
        devAddress: dryRunMetrics.devAddress,
        devHoldPercent: dryRunMetrics.devHoldPercent,
        devHasSold: dryRunMetrics.devHasSold,
        confirmWindowMs: confirm.windowMs,
        confirmMcapChangePct: confirm.stats?.mcapChangePct ?? undefined,
        confirmHoldersDelta: confirm.stats?.holdersDelta ?? undefined,
        confirmBuySellRatio: confirm.stats?.buySellRatio ?? undefined,
        userScreen: input.signal?.userScreen ? String(input.signal.userScreen) : undefined,
        userName: input.signal?.userName ? String(input.signal.userName) : undefined,
        tweetType: input.signal?.tweetType ? String(input.signal.tweetType) : undefined,
        channel: input.signal?.channel ? String(input.signal.channel) : undefined,
        signalId: input.signal?.id ? String(input.signal.id) : undefined,
        signalEventId: input.signal?.eventId ? String(input.signal.eventId) : undefined,
        signalTweetId: input.signal?.tweetId ? String(input.signal.tweetId) : undefined,
      });
      return true;
    }

    const amountWei = parseEther(String(amountNumber));
    let rsp: any;
    let buySubmittedAtMs: number | undefined;
    let tokenInfoForTrade = tokenInfo;
    try {
      rsp = await TradeService.buyWithReceiptAndNonceRecovery({
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        bnbAmountWei: amountWei.toString(),
        fromAddress: tradeFromAddress,
        tokenInfo: tokenInfoForTrade,
        gasPriceGwei: input.gasPriceGweiOverride,
        priorityFeeBnb: input.priorityFeeBnbOverride,
      } as any, {
        maxRetry: 1,
        onSubmitted: async (ctx) => {
          buySubmittedAtMs = Date.now();
          await input.broadcastToActiveTabs({
            type: 'bg:tradeSubmitted',
            source: 'xsniper',
            side: 'buy',
            chainId: input.chainId,
            tokenAddress: input.tokenAddress,
            txHash: ctx.txHash,
            submitElapsedMs: ctx.submitElapsedMs,
          });
        },
      });
    } catch {
    }
    if (!rsp) {
      console.error('XSniperTrade buy submit failed', {
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
      });
      emitBuyFailure('buy_submit_failed', {
        buyAmountBnb: amountNumber,
        metrics: refreshedMetrics,
        tokenInfo: tokenInfoForTrade,
        confirm,
      });
      return false;
    }
    void input.broadcastToActiveTabs({
      type: 'bg:tradeSuccess',
      source: 'xsniper',
      side: 'buy',
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      txHash: (rsp as any)?.txHash,
      submitElapsedMs: (rsp as any)?.submitElapsedMs,
      receiptElapsedMs: (rsp as any)?.receiptElapsedMs,
      totalElapsedMs: (rsp as any)?.totalElapsedMs,
      broadcastVia: (rsp as any)?.broadcastVia,
      broadcastUrl: (rsp as any)?.broadcastUrl,
      isBundle: (rsp as any)?.isBundle,
    });

    const entryPriceUsd = await input.getEntryPriceUsd(
      input.chainId,
      input.tokenAddress,
      tokenInfoForTrade,
      refreshedMetrics.priceUsd ?? null,
      refreshedMetrics.marketCapUsd ?? null,
    );
    const postBuyTokenInfo =
      (await input.fetchTokenInfoFresh(input.chainId, input.tokenAddress)) ??
      tokenInfoForTrade;
    const postBuyRawMcap = Number(postBuyTokenInfo?.tokenPrice?.marketCap ?? 0);
    const postBuyMcapUsd = sanitizeMarketCapUsd(postBuyRawMcap);
    const postBuyPriceUsd = Number(postBuyTokenInfo?.tokenPrice?.price ?? 0);
    const entryMcapAnchor = resolveEntryMcapAnchor({
      postBuyMcapUsd,
      entryPriceUsd,
      referencePriceUsd: Number.isFinite(refreshedMetrics.priceUsd as any) ? Number(refreshedMetrics.priceUsd) : postBuyPriceUsd,
      referenceMcapUsd: refreshedMetrics.marketCapUsd ?? null,
      fallbackMcapUsd: refreshedMetrics.marketCapUsd ?? null,
    });
    input.boughtOnceAtMs.set(key, Date.now());
    void input.persistBoughtOnce();
    input.onStateChanged();
    const posKey = `${input.chainId}:${input.tokenAddress.toLowerCase()}`;
    const openedAtMs = Date.now();
    const tweetAtMs = getSignalTimeMs(input.signal) ?? undefined;
    const tweetUrl = buildTweetUrl(input.signal);
    const tweetType = input.signal?.tweetType ? String(input.signal.tweetType) : undefined;
    const channel = input.signal?.channel ? String(input.signal.channel) : undefined;
    const signalId = input.signal?.id ? String(input.signal.id) : undefined;
    const signalEventId = input.signal?.eventId ? String(input.signal.eventId) : undefined;
    const signalTweetId = input.signal?.tweetId ? String(input.signal.tweetId) : undefined;

    input.registerRapidExitPosition({
      strategy: input.strategy,
      posKey,
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      dryRun: false,
      entryMcapUsd: entryMcapAnchor,
      buyAmountBnb: amountNumber,
      openedAtMs,
      tweetAtMs,
      tweetUrl,
      tweetType,
      channel,
      signalId,
      signalEventId,
      signalTweetId,
      entryPriceUsd,
    });
    const effectiveEntryPriceUsd = entryPriceUsd;

    const now = Date.now();
    input.emitRecord({
      id: `${now}-${Math.random().toString(16).slice(2)}`,
      side: 'buy',
      tsMs: now,
      buySubmittedAtMs,
      tweetAtMs,
      tweetUrl,
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      tokenSymbol: tokenInfoForTrade.symbol ? String(tokenInfoForTrade.symbol) : undefined,
      tokenName: tokenInfoForTrade.name ? String(tokenInfoForTrade.name) : undefined,
      launchpadPlatform: refreshedMetrics.launchpadPlatform,
      buyAmountBnb: amountNumber,
      txHash: typeof (rsp as any)?.txHash === 'string' ? ((rsp as any).txHash as any) : undefined,
      entryPriceUsd: effectiveEntryPriceUsd ?? undefined,
      dryRun: false,
      marketCapUsd: entryMcapAnchor ?? refreshedMetrics.marketCapUsd,
      athMarketCapUsd: entryMcapAnchor ?? refreshedMetrics.marketCapUsd,
      liquidityUsd: refreshedMetrics.liquidityUsd,
      holders: refreshedMetrics.holders,
      kol: refreshedMetrics.kol,
      vol24hUsd: refreshedMetrics.vol24hUsd,
      netBuy24hUsd: refreshedMetrics.netBuy24hUsd,
      buyTx24h: refreshedMetrics.buyTx24h,
      sellTx24h: refreshedMetrics.sellTx24h,
      smartMoney: refreshedMetrics.smartMoney,
      createdAtMs: refreshedMetrics.createdAtMs,
      devAddress: refreshedMetrics.devAddress,
      devHoldPercent: refreshedMetrics.devHoldPercent,
      devHasSold: refreshedMetrics.devHasSold,
      confirmWindowMs: confirm.windowMs,
      confirmMcapChangePct: confirm.stats?.mcapChangePct ?? undefined,
      confirmHoldersDelta: confirm.stats?.holdersDelta ?? undefined,
      confirmBuySellRatio: confirm.stats?.buySellRatio ?? undefined,
      userScreen: input.signal?.userScreen ? String(input.signal.userScreen) : undefined,
      userName: input.signal?.userName ? String(input.signal.userName) : undefined,
      tweetType,
      channel,
      signalId,
      signalEventId,
      signalTweetId,
    });

    if (input.strategy?.autoSellEnabled && effectiveEntryPriceUsd != null && effectiveEntryPriceUsd > 0) {
      try {
        await TradeService.approveMaxForSellIfNeeded(input.chainId, input.tokenAddress, tokenInfoForTrade, {
          fromAddress: tradeFromAddress,
        });
        await cancelAllSellLimitOrdersForToken(input.chainId, input.tokenAddress, tradeFromAddress);
        const cfg = (settings as any).advancedAutoSell;
        if (cfg?.enabled) {
          const orders = buildStrategySellOrderInputs({
            config: cfg,
            chainId: input.chainId,
            tokenAddress: input.tokenAddress,
            tokenSymbol: tokenInfoForTrade.symbol,
            tokenInfo: tokenInfoForTrade,
            basePriceUsd: effectiveEntryPriceUsd,
          });
          const trailingMode = (cfg as any)?.trailingStop?.activationMode ?? 'after_first_take_profit';
          const isRolling = getAdvancedAutoSellMode(cfg) === 'rolling_take_profit';
          const special = trailingMode === 'immediate'
            ? (isRolling
              ? buildStrategyRollingTakeProfitOrderInputs({
                config: cfg,
                chainId: input.chainId,
                tokenAddress: input.tokenAddress,
                tokenSymbol: tokenInfoForTrade.symbol,
                tokenInfo: tokenInfoForTrade,
                basePriceUsd: effectiveEntryPriceUsd,
                entryPriceUsd: effectiveEntryPriceUsd,
              })
              : buildStrategyTrailingSellOrderInputs({
                config: cfg,
                chainId: input.chainId,
                tokenAddress: input.tokenAddress,
                tokenSymbol: tokenInfoForTrade.symbol,
                tokenInfo: tokenInfoForTrade,
                basePriceUsd: effectiveEntryPriceUsd,
              }))
            : null;
          const all = special ? [...orders, special] : orders;
          if (all.length) {
            await Promise.all(all.map((o) => createLimitOrder({ ...o, fromAddress: tradeFromAddress })));
          }
        }
      } catch {
      }
    }

    console.log('XSniperTrade buy tx', (rsp as any)?.txHash ?? '');
    return true;
  } finally {
    input.buyInFlight.delete(key);
  }
};
