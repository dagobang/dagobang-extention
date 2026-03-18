import { parseEther } from 'viem';
import { WalletService } from '@/services/wallet';
import { SettingsService } from '@/services/settings';
import { TradeService } from '@/services/trade';
import { buildStrategySellOrderInputs, buildStrategyTrailingSellOrderInputs } from '@/services/limitOrders/advancedAutoSell';
import { cancelAllSellLimitOrdersForToken, createLimitOrder } from '@/services/limitOrders/store';
import { buildTweetUrl, getSignalTimeMs, isRepostOrQuoteSignal, parseNumber, sanitizeMarketCapUsd, shouldBuyByConfig, type TokenMetrics } from '@/services/xSniper/engine/metrics';
import type { UnifiedTwitterSignal, XSniperBuyRecord } from '@/types/extention';
import type { TokenInfo } from '@/types/token';
import type { DryRunAutoSellPos } from '@/services/xSniper/engine/dryRunAutoSell';
import type { StagedPosition } from '@/services/xSniper/engine/stagedEntrySchedulers';

export const tryAutoBuyOnce = async (input: {
  chainId: number;
  tokenAddress: `0x${string}`;
  metrics: TokenMetrics;
  strategy: any;
  signal?: UnifiedTwitterSignal;
  stage?: 'full' | 'scout' | 'add';
  amountBnbOverride?: number;
  stagedPlan?: { scoutAmountBnb: number; addAmountBnb: number; openedAtMs: number };
  onStateChanged: () => void;
  loadBoughtOnceIfNeeded: () => Promise<void>;
  persistBoughtOnce: () => Promise<void>;
  getKey: (chainId: number, tokenAddress: `0x${string}`, opts?: { dry?: boolean; stage?: 'full' | 'scout' | 'add' }) => string;
  boughtOnceAtMs: Map<string, number>;
  buyInFlight: Set<string>;
  computeWsConfirm: (tokenAddress: `0x${string}`, nowMs: number, strategy: any) => {
    pass: boolean;
    windowMs: number;
    stats?: { mcapChangePct?: number; holdersDelta?: number; buySellRatio?: number };
  };
  shouldLogWsConfirmFail: (key: string, nowMs: number) => boolean;
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
  scheduleStagedAddIfEnabled: (posKey: string, strategy: any) => void;
  scheduleTimeStopIfEnabled: (posKey: string, strategy: any) => void;
  stagedPositions: Map<string, StagedPosition>;
  dryRunAutoSellByPosKey: Map<string, DryRunAutoSellPos>;
}) => {
  await input.loadBoughtOnceIfNeeded();
  const dryRun = input.strategy?.dryRun === true;
  const stage = input.stage ?? 'full';
  const key = input.getKey(input.chainId, input.tokenAddress, { dry: dryRun, stage });
  if (input.boughtOnceAtMs.has(key)) return false;
  if (input.buyInFlight.has(key)) return false;
  input.buyInFlight.add(key);
  try {
    const amountNumber = (typeof input.amountBnbOverride === 'number' && Number.isFinite(input.amountBnbOverride)
      ? input.amountBnbOverride
      : (parseNumber(input.strategy.buyAmountBnb) ?? 0));
    if (amountNumber <= 0) return false;

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
      return false;
    }

    const status = await WalletService.getStatus();
    if (!dryRun && (status.locked || !status.address)) return false;

    const tokenInfo = (await input.fetchTokenInfoFresh(input.chainId, input.tokenAddress)) ?? (await input.buildGenericTokenInfo(input.chainId, input.tokenAddress));
    if (!tokenInfo) return false;

    const refreshedMcap = Number(tokenInfo?.tokenPrice?.marketCap ?? 0);
    const sanitizedRefreshedMcap = sanitizeMarketCapUsd(refreshedMcap);
    const sanitizedInputMcap = sanitizeMarketCapUsd(input.metrics.marketCapUsd);
    const refreshedMetrics: TokenMetrics = {
      ...input.metrics,
      tokenAddress: input.tokenAddress,
      marketCapUsd: sanitizedRefreshedMcap ?? sanitizedInputMcap ?? undefined,
      priceUsd: input.metrics.priceUsd,
    };
    const signalAtMs = getSignalTimeMs(input.signal);
    const skipTokenCreatedAtWindowCheck = isRepostOrQuoteSignal(input.signal);
    if (!shouldBuyByConfig(refreshedMetrics, input.strategy, signalAtMs, Date.now(), { skipTokenCreatedAtWindowCheck })) return false;

    if (dryRun) {
      const entryPriceUsd = await input.getEntryPriceUsd(
        input.chainId,
        input.tokenAddress,
        tokenInfo,
        refreshedMetrics.priceUsd ?? null,
        refreshedMetrics.marketCapUsd ?? null,
      );
      input.boughtOnceAtMs.set(key, Date.now());
      void input.persistBoughtOnce();
      input.onStateChanged();

      const posKey = `${input.chainId}:${input.tokenAddress.toLowerCase()}`;

      if (stage === 'scout' && input.stagedPlan) {
        input.stagedPositions.set(posKey, {
          chainId: input.chainId,
          tokenAddress: input.tokenAddress,
          dryRun: true,
          openedAtMs: input.stagedPlan.openedAtMs,
          scoutAmountBnb: input.stagedPlan.scoutAmountBnb,
          addAmountBnb: input.stagedPlan.addAmountBnb,
          lastMetrics: refreshedMetrics,
          entryMcapUsd: refreshedMetrics.marketCapUsd,
          entryPriceUsd: entryPriceUsd ?? undefined,
          tweetAtMs: getSignalTimeMs(input.signal) ?? undefined,
          tweetUrl: buildTweetUrl(input.signal),
          tweetType: input.signal?.tweetType ? String(input.signal.tweetType) : undefined,
          channel: input.signal?.channel ? String(input.signal.channel) : undefined,
          signalId: input.signal?.id ? String(input.signal.id) : undefined,
          signalEventId: input.signal?.eventId ? String(input.signal.eventId) : undefined,
          signalTweetId: input.signal?.tweetId ? String(input.signal.tweetId) : undefined,
        });
        input.scheduleStagedAddIfEnabled(posKey, input.strategy);
        input.scheduleTimeStopIfEnabled(posKey, input.strategy);
      } else if (stage === 'full' && input.strategy?.timeStopEnabled === true) {
        input.stagedPositions.set(posKey, {
          chainId: input.chainId,
          tokenAddress: input.tokenAddress,
          dryRun: true,
          openedAtMs: Date.now(),
          scoutAmountBnb: amountNumber,
          addAmountBnb: 0,
          lastMetrics: refreshedMetrics,
          entryMcapUsd: refreshedMetrics.marketCapUsd,
          entryPriceUsd: entryPriceUsd ?? undefined,
          tweetAtMs: getSignalTimeMs(input.signal) ?? undefined,
          tweetUrl: buildTweetUrl(input.signal),
          tweetType: input.signal?.tweetType ? String(input.signal.tweetType) : undefined,
          channel: input.signal?.channel ? String(input.signal.channel) : undefined,
          signalId: input.signal?.id ? String(input.signal.id) : undefined,
          signalEventId: input.signal?.eventId ? String(input.signal.eventId) : undefined,
          signalTweetId: input.signal?.tweetId ? String(input.signal.tweetId) : undefined,
        });
        input.scheduleTimeStopIfEnabled(posKey, input.strategy);
      }

      if (input.strategy?.autoSellEnabled === true && stage !== 'scout') {
        try {
          const settings = await SettingsService.get();
          const cfg = (settings as any).advancedAutoSell as any;
          if (cfg?.enabled) {
            const rawEntryMcap = refreshedMetrics.marketCapUsd;
            let entryMcapUsd =
              typeof rawEntryMcap === 'number' && Number.isFinite(rawEntryMcap) && rawEntryMcap > 0 ? rawEntryMcap : null;

            if (stage === 'add') {
              const existing = input.stagedPositions.get(posKey);
              const scoutAmt = existing?.dryRun === true ? Number(existing.scoutAmountBnb) : null;
              const scoutMcap = existing?.dryRun === true ? Number(existing.entryMcapUsd) : null;
              const addAmt = amountNumber;
              const addMcap = entryMcapUsd;
              if (
                scoutAmt != null &&
                scoutMcap != null &&
                addAmt > 0 &&
                addMcap != null &&
                Number.isFinite(scoutAmt) &&
                Number.isFinite(scoutMcap) &&
                scoutAmt > 0 &&
                scoutMcap > 0
              ) {
                const denom = scoutAmt / scoutMcap + addAmt / addMcap;
                if (Number.isFinite(denom) && denom > 0) {
                  entryMcapUsd = (scoutAmt + addAmt) / denom;
                  let entryPriceBlend = entryPriceUsd;
                  const scoutEntryPrice = existing?.dryRun === true ? Number(existing.entryPriceUsd) : null;
                  if (
                    scoutEntryPrice != null &&
                    Number.isFinite(scoutEntryPrice) &&
                    scoutEntryPrice > 0 &&
                    entryPriceUsd != null &&
                    entryPriceUsd > 0
                  ) {
                    const priceDenom = scoutAmt / scoutEntryPrice + addAmt / entryPriceUsd;
                    if (Number.isFinite(priceDenom) && priceDenom > 0) {
                      entryPriceBlend = (scoutAmt + addAmt) / priceDenom;
                    }
                  }
                  if (existing) {
                    input.stagedPositions.set(posKey, {
                      ...existing,
                      scoutAmountBnb: scoutAmt + addAmt,
                      entryMcapUsd,
                      entryPriceUsd: entryPriceBlend ?? undefined,
                    });
                  }
                }
              }
            }

            if (entryMcapUsd != null && entryMcapUsd > 0) {
              const rules = Array.isArray(cfg.rules) ? (cfg.rules as any[]) : [];
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
              const trailing =
                trailingRaw?.enabled === true
                  ? {
                      enabled: true,
                      callbackPercent: Number.isFinite(Number(trailingRaw?.callbackPercent))
                        ? clamp(Number(trailingRaw?.callbackPercent), 0.1, 99.9)
                        : 15,
                      activationMode:
                        trailingRaw?.activationMode === 'after_first_take_profit' || trailingRaw?.activationMode === 'after_last_take_profit'
                          ? trailingRaw.activationMode
                          : 'immediate',
                      active: false,
                      peakMcapUsd: entryMcapUsd,
                    }
                  : null;

              const meta = input.stagedPositions.get(posKey);
              input.dryRunAutoSellByPosKey.set(posKey, {
                chainId: input.chainId,
                tokenAddress: input.tokenAddress,
                openedAtMs: meta?.openedAtMs ?? Date.now(),
                entryMcapUsd,
                remainingBps: 10000,
                takeProfits,
                stopLosses,
                trailing,
                takeProfitTotal: takeProfits.length,
                takeProfitExecuted: 0,
                executedIds: new Set<string>(),
                tweetAtMs: meta?.tweetAtMs ?? (getSignalTimeMs(input.signal) ?? undefined),
                tweetUrl: meta?.tweetUrl ?? buildTweetUrl(input.signal),
                tweetType: meta?.tweetType ?? (input.signal?.tweetType ? String(input.signal.tweetType) : undefined),
                channel: meta?.channel ?? (input.signal?.channel ? String(input.signal.channel) : undefined),
                signalId: meta?.signalId ?? (input.signal?.id ? String(input.signal.id) : undefined),
                signalEventId: meta?.signalEventId ?? (input.signal?.eventId ? String(input.signal.eventId) : undefined),
                signalTweetId: meta?.signalTweetId ?? (input.signal?.tweetId ? String(input.signal.tweetId) : undefined),
              });
            }
          }
        } catch {
        }
      }

      const now = Date.now();
      const tweetAtMs = getSignalTimeMs(input.signal) ?? undefined;
      const tweetUrl = buildTweetUrl(input.signal);
      input.emitRecord({
        id: `${now}-${Math.random().toString(16).slice(2)}`,
        side: 'buy',
        tsMs: now,
        tweetAtMs,
        tweetUrl,
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        tokenSymbol: tokenInfo.symbol ? String(tokenInfo.symbol) : undefined,
        tokenName: tokenInfo.name ? String(tokenInfo.name) : undefined,
        buyAmountBnb: amountNumber,
        txHash: undefined,
        entryPriceUsd: entryPriceUsd ?? undefined,
        dryRun: true,
        marketCapUsd: refreshedMetrics.marketCapUsd,
        athMarketCapUsd: refreshedMetrics.marketCapUsd,
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
        tweetType: input.signal?.tweetType ? String(input.signal.tweetType) : undefined,
        channel: input.signal?.channel ? String(input.signal.channel) : undefined,
        signalId: input.signal?.id ? String(input.signal.id) : undefined,
        signalEventId: input.signal?.eventId ? String(input.signal.eventId) : undefined,
        signalTweetId: input.signal?.tweetId ? String(input.signal.tweetId) : undefined,
        reason: stage === 'scout' ? 'staged_scout' : (stage === 'add' ? 'staged_add' : undefined),
      });
      return true;
    }

    const amountWei = parseEther(String(amountNumber));
    const rsp = await TradeService.buy({
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      bnbAmountWei: amountWei.toString(),
      tokenInfo,
    } as any);
    void input.broadcastToActiveTabs({
      type: 'bg:tradeSuccess',
      source: 'xsniper',
      side: 'buy',
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      txHash: (rsp as any)?.txHash,
    });

    const entryPriceUsd = await input.getEntryPriceUsd(
      input.chainId,
      input.tokenAddress,
      tokenInfo,
      refreshedMetrics.priceUsd ?? null,
      refreshedMetrics.marketCapUsd ?? null,
    );
    input.boughtOnceAtMs.set(key, Date.now());
    void input.persistBoughtOnce();
    input.onStateChanged();
    const posKey = `${input.chainId}:${input.tokenAddress.toLowerCase()}`;

    if (stage === 'scout' && input.stagedPlan) {
      input.stagedPositions.set(posKey, {
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        dryRun: false,
        openedAtMs: input.stagedPlan.openedAtMs,
        scoutAmountBnb: input.stagedPlan.scoutAmountBnb,
        addAmountBnb: input.stagedPlan.addAmountBnb,
        lastMetrics: refreshedMetrics,
        entryMcapUsd: refreshedMetrics.marketCapUsd,
        entryPriceUsd: entryPriceUsd ?? undefined,
        tweetAtMs: getSignalTimeMs(input.signal) ?? undefined,
        tweetUrl: buildTweetUrl(input.signal),
        tweetType: input.signal?.tweetType ? String(input.signal.tweetType) : undefined,
        channel: input.signal?.channel ? String(input.signal.channel) : undefined,
        signalId: input.signal?.id ? String(input.signal.id) : undefined,
        signalEventId: input.signal?.eventId ? String(input.signal.eventId) : undefined,
        signalTweetId: input.signal?.tweetId ? String(input.signal.tweetId) : undefined,
      });
      input.scheduleStagedAddIfEnabled(posKey, input.strategy);
      input.scheduleTimeStopIfEnabled(posKey, input.strategy);
    } else if (stage === 'full' && input.strategy?.timeStopEnabled === true) {
      input.stagedPositions.set(posKey, {
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        dryRun: false,
        openedAtMs: Date.now(),
        scoutAmountBnb: amountNumber,
        addAmountBnb: 0,
        lastMetrics: refreshedMetrics,
        entryMcapUsd: refreshedMetrics.marketCapUsd,
        entryPriceUsd: entryPriceUsd ?? undefined,
        tweetAtMs: getSignalTimeMs(input.signal) ?? undefined,
        tweetUrl: buildTweetUrl(input.signal),
        tweetType: input.signal?.tweetType ? String(input.signal.tweetType) : undefined,
        channel: input.signal?.channel ? String(input.signal.channel) : undefined,
        signalId: input.signal?.id ? String(input.signal.id) : undefined,
        signalEventId: input.signal?.eventId ? String(input.signal.eventId) : undefined,
        signalTweetId: input.signal?.tweetId ? String(input.signal.tweetId) : undefined,
      });
      input.scheduleTimeStopIfEnabled(posKey, input.strategy);
    }
    let effectiveEntryPriceUsd = entryPriceUsd;
    if (stage === 'add') {
      const existing = input.stagedPositions.get(posKey);
      const scoutAmt = Number(existing?.scoutAmountBnb);
      const scoutEntryPrice = Number(existing?.entryPriceUsd);
      if (
        Number.isFinite(scoutAmt) &&
        scoutAmt > 0 &&
        Number.isFinite(scoutEntryPrice) &&
        scoutEntryPrice > 0 &&
        effectiveEntryPriceUsd != null &&
        effectiveEntryPriceUsd > 0
      ) {
        const denom = scoutAmt / scoutEntryPrice + amountNumber / effectiveEntryPriceUsd;
        if (Number.isFinite(denom) && denom > 0) {
          effectiveEntryPriceUsd = (scoutAmt + amountNumber) / denom;
          if (existing) {
            input.stagedPositions.set(posKey, {
              ...existing,
              scoutAmountBnb: scoutAmt + amountNumber,
              entryPriceUsd: effectiveEntryPriceUsd,
            });
          }
        }
      }
    }

    const now = Date.now();
    const tweetAtMs = getSignalTimeMs(input.signal) ?? undefined;
    const tweetUrl = buildTweetUrl(input.signal);
    input.emitRecord({
      id: `${now}-${Math.random().toString(16).slice(2)}`,
      side: 'buy',
      tsMs: now,
      tweetAtMs,
      tweetUrl,
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      tokenSymbol: tokenInfo.symbol ? String(tokenInfo.symbol) : undefined,
      tokenName: tokenInfo.name ? String(tokenInfo.name) : undefined,
      buyAmountBnb: amountNumber,
      txHash: typeof (rsp as any)?.txHash === 'string' ? ((rsp as any).txHash as any) : undefined,
      entryPriceUsd: effectiveEntryPriceUsd ?? undefined,
      dryRun: false,
      marketCapUsd: refreshedMetrics.marketCapUsd,
      athMarketCapUsd: refreshedMetrics.marketCapUsd,
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
      tweetType: input.signal?.tweetType ? String(input.signal.tweetType) : undefined,
      channel: input.signal?.channel ? String(input.signal.channel) : undefined,
      signalId: input.signal?.id ? String(input.signal.id) : undefined,
      signalEventId: input.signal?.eventId ? String(input.signal.eventId) : undefined,
      signalTweetId: input.signal?.tweetId ? String(input.signal.tweetId) : undefined,
      reason: stage === 'scout' ? 'staged_scout' : (stage === 'add' ? 'staged_add' : undefined),
    });

    if (stage !== 'scout' && input.strategy?.autoSellEnabled && effectiveEntryPriceUsd != null && effectiveEntryPriceUsd > 0) {
      try {
        await TradeService.approveMaxForSellIfNeeded(input.chainId, input.tokenAddress, tokenInfo);
        await cancelAllSellLimitOrdersForToken(input.chainId, input.tokenAddress);
        const settings = await SettingsService.get();
        const cfg = (settings as any).advancedAutoSell;
        if (cfg?.enabled) {
          const orders = buildStrategySellOrderInputs({
            config: cfg,
            chainId: input.chainId,
            tokenAddress: input.tokenAddress,
            tokenSymbol: tokenInfo.symbol,
            tokenInfo,
            basePriceUsd: effectiveEntryPriceUsd,
          });
          const trailing = buildStrategyTrailingSellOrderInputs({
            config: cfg,
            chainId: input.chainId,
            tokenAddress: input.tokenAddress,
            tokenSymbol: tokenInfo.symbol,
            tokenInfo,
            basePriceUsd: effectiveEntryPriceUsd,
          });
          const all = trailing ? [...orders, trailing] : orders;
          if (all.length) await Promise.all(all.map((o) => createLimitOrder(o)));
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
