import { parseEther } from 'viem';
import { browser } from 'wxt/browser';
import { WalletService } from '@/services/wallet';
import { SettingsService } from '@/services/settings';
import { TradeService } from '@/services/trade';
import { defaultSettings } from '@/utils/defaults';
import { chainNames } from '@/constants/chains/chainName';
import type { UnifiedSignalToken, UnifiedTwitterSignal, XSniperBuyRecord } from '@/types/extention';
import type { TokenInfo } from '@/types/token';
import { FourmemeAPI } from '@/services/api/fourmeme';
import { TokenFourmemeService } from '@/services/token/fourmeme';
import { TokenFlapService } from '@/services/token/flap';
import { TokenService } from '@/services/token';
import { buildStrategySellOrderInputs, buildStrategyTrailingSellOrderInputs } from '@/services/limitOrders/advancedAutoSell';
import { cancelAllSellLimitOrdersForToken, createLimitOrder } from '@/services/limitOrders/store';
import { loadXSniperHistory, pushXSniperHistory, XSNIPER_HISTORY_LIMIT, XSNIPER_HISTORY_STORAGE_KEY } from '@/services/xSniper/xSniperHistory';
import { type TokenMetrics, buildTweetUrl, getSignalTimeMs, normalizeAddress, normalizeEpochMs, parseKNumber, parseNumber, sanitizeMarketCapUsd, shouldBuyByConfig } from '@/services/xSniper/xSniperTradeUtils';
import { computeWsConfirm as computeWsConfirmFromWs, getWsDrawdownPctSince as getWsDrawdownPctSinceFromWs, pushWsSnapshot as pushWsSnapshotFromWs, shouldLogWsConfirmFail as shouldLogWsConfirmFailFromWs, type WsSnapshot } from '@/services/xSniper/xSniperTradeWs';
import { maybeEvaluateDryRunAutoSell as maybeEvaluateDryRunAutoSellFromMod, type DryRunAutoSellPos } from '@/services/xSniper/xSniperTradeDryRun';
import { scheduleStagedAddIfEnabled as scheduleStagedAddIfEnabledFromMod, scheduleTimeStopIfEnabled as scheduleTimeStopIfEnabledFromMod, type StagedPosition } from '@/services/xSniper/xSniperTradeSchedulers';
import { maybeUpdateXSniperHistoryEvaluations } from '@/services/xSniper/xSniperHistory';

export const createXSniperTrade = (deps: { onStateChanged: () => void }) => {
  const BOUGHT_ONCE_TTL_MS = 6 * 60 * 60 * 1000;
  const BOUGHT_ONCE_STORAGE_KEY = 'dagobang_xsniper_bought_once_v1';

  let boughtOnceLoaded = false;
  const boughtOnceAtMs = new Map<string, number>();
  const buyInFlight = new Set<string>();
  const wsConfirmFailDedupe = new Map<string, number>();
  const wsSnapshotsByAddr = new Map<string, WsSnapshot[]>();
  const dryRunAutoSellByPosKey = new Map<string, DryRunAutoSellPos>();
  const stagedPositions = new Map<string, StagedPosition>();
  const stagedAddTimers = new Map<string, number>();
  const timeStopTimers = new Map<string, number>();

  const cleanupPosKey = (posKey: string) => {
    stagedPositions.delete(posKey);
    const tid = stagedAddTimers.get(posKey);
    if (tid) clearInterval(tid as any);
    stagedAddTimers.delete(posKey);
    const t2 = timeStopTimers.get(posKey);
    if (t2) clearTimeout(t2 as any);
    timeStopTimers.delete(posKey);
    dryRunAutoSellByPosKey.delete(posKey);
  };

  const shouldLogWsConfirmFail = (key: string, nowMs: number) => shouldLogWsConfirmFailFromWs(wsConfirmFailDedupe, key, nowMs);

  const emitRecord = (record: XSniperBuyRecord) => {
    void pushXSniperHistory(record);
    void broadcastToTabs({ type: 'bg:xsniper:buy', record });
  };

  const computeWsConfirm = (tokenAddress: `0x${string}`, nowMs: number, strategy: any) =>
    computeWsConfirmFromWs(wsSnapshotsByAddr, tokenAddress, nowMs, strategy);

  const getWsDrawdownPctSince = (tokenAddress: `0x${string}`, sinceMs: number) =>
    getWsDrawdownPctSinceFromWs(wsSnapshotsByAddr, tokenAddress, sinceMs);

  async function onWsSnapshotUpdated(tokenAddress: `0x${string}`, nowMs: number) {
    const snapshots = wsSnapshotsByAddr.get(tokenAddress) ?? [];
    const cur = snapshots.length ? snapshots[snapshots.length - 1] : null;
    if (cur) {
      void maybeUpdateXSniperHistoryEvaluations({
        tokenAddress,
        nowMs,
        marketCapUsd: cur.marketCapUsd,
        holders: cur.holders,
      });
    }
    void maybeEvaluateDryRunAutoSellFromMod({
      tokenAddress,
      nowMs,
      wsSnapshotsByAddr,
      dryRunAutoSellByPosKey,
      cleanupPosKey,
      emitRecord,
    });
  }

  const pushWsSnapshot = (tokenAddress: `0x${string}`, metrics: TokenMetrics) => {
    pushWsSnapshotFromWs({
      tokenAddress,
      metrics,
      wsSnapshotsByAddr,
      onUpdated: onWsSnapshotUpdated,
    });
  };

  const scheduleTimeStopIfEnabled = (posKey: string, strategy: any) => {
    scheduleTimeStopIfEnabledFromMod({
      posKey,
      strategy,
      stagedPositions,
      timeStopTimers,
      wsSnapshotsByAddr,
      tryTimeStopSellOnce,
    });
  };

  const scheduleStagedAddIfEnabled = (posKey: string, strategy: any) => {
    scheduleStagedAddIfEnabledFromMod({
      posKey,
      strategy,
      stagedPositions,
      stagedAddTimers,
      computeWsConfirm,
      getWsDrawdownPctSince,
      tryAutoBuyOnce,
      tryTimeStopSellOnce,
      emitRecord,
    });
  };

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

  const broadcastToActiveTabs = async (message: any) => {
    try {
      const tabs = await browser.tabs.query({ active: true });
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

  const getKey = (chainId: number, tokenAddress: `0x${string}`, opts?: { dry?: boolean; stage?: 'full' | 'scout' | 'add' }) => {
    const dry = opts?.dry === true;
    const stage = opts?.stage ?? 'full';
    return `${dry ? 'dry:' : ''}${chainId}:${tokenAddress.toLowerCase()}:${stage}`;
  };

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

  const getEntryPriceUsd = async (
    chainId: number,
    tokenAddress: `0x${string}`,
    tokenInfo: TokenInfo,
    fallback: number | null,
    fallbackMcapUsd: number | null,
  ) => {
    try {
      const q = await TokenService.getTokenPriceUsdFromRpc({
        chainId,
        tokenAddress,
        tokenInfo,
        cacheTtlMs: 0,
      } as any);
      const n = typeof q === 'number' ? q : Number(q);
      if (Number.isFinite(n) && n > 0) return n;
    } catch {
    }
    if (fallback != null && Number.isFinite(fallback) && fallback > 0) return fallback;
    const p = Number(tokenInfo?.tokenPrice?.price ?? 0);
    const mcap = Number(fallbackMcapUsd ?? tokenInfo?.tokenPrice?.marketCap ?? 0);
    if (Number.isFinite(p) && p > 0) {
      if (Number.isFinite(mcap) && mcap > 0) {
        const impliedSupply = mcap / p;
        if (Number.isFinite(impliedSupply) && impliedSupply > 0 && impliedSupply <= 1e15) return p;
      } else {
        return p;
      }
    }
    return null;
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
    stage?: 'full' | 'scout' | 'add';
    amountBnbOverride?: number;
    stagedPlan?: { scoutAmountBnb: number; addAmountBnb: number; openedAtMs: number };
  }) => {
    await loadBoughtOnceIfNeeded();
    const dryRun = input.strategy?.dryRun === true;
    const stage = input.stage ?? 'full';
    const key = getKey(input.chainId, input.tokenAddress, { dry: dryRun, stage });
    if (boughtOnceAtMs.has(key)) return false;
    if (buyInFlight.has(key)) return false;
    buyInFlight.add(key);
    try {
      const amountNumber = (typeof input.amountBnbOverride === 'number' && Number.isFinite(input.amountBnbOverride)
        ? input.amountBnbOverride
        : (parseNumber(input.strategy.buyAmountBnb) ?? 0));
      if (amountNumber <= 0) return false;

      const confirmNowMs = Date.now();
      const confirm = computeWsConfirm(input.tokenAddress, confirmNowMs, input.strategy);
      if (!confirm.pass) {
        if (dryRun) {
          const sigKey = typeof input.signal?.id === 'string' && input.signal.id.trim() ? input.signal.id.trim() : '';
          const dedupe = `${sigKey}:${input.chainId}:${input.tokenAddress.toLowerCase()}`;
          if (shouldLogWsConfirmFail(dedupe, confirmNowMs)) {
            const tweetAtMs = getSignalTimeMs(input.signal) ?? undefined;
            const tweetUrl = buildTweetUrl(input.signal);
            const record: XSniperBuyRecord = {
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
            };
            void pushXSniperHistory(record);
            void broadcastToTabs({ type: 'bg:xsniper:buy', record });
          }
        }
        return false;
      }

      const status = await WalletService.getStatus();
      if (!dryRun && (status.locked || !status.address)) return false;

      const tokenInfo = (await fetchTokenInfoFresh(input.chainId, input.tokenAddress)) ?? (await buildGenericTokenInfo(input.chainId, input.tokenAddress));
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
      if (!shouldBuyByConfig(refreshedMetrics, input.strategy, signalAtMs, Date.now())) return false;

      if (dryRun) {
        const entryPriceUsd = await getEntryPriceUsd(
          input.chainId,
          input.tokenAddress,
          tokenInfo,
          refreshedMetrics.priceUsd ?? null,
          refreshedMetrics.marketCapUsd ?? null,
        );
        boughtOnceAtMs.set(key, Date.now());
        void persistBoughtOnce();
        deps.onStateChanged();

        const posKey = `${input.chainId}:${input.tokenAddress.toLowerCase()}`;

        if (stage === 'scout' && input.stagedPlan) {
          stagedPositions.set(posKey, {
            chainId: input.chainId,
            tokenAddress: input.tokenAddress,
            dryRun: true,
            openedAtMs: input.stagedPlan.openedAtMs,
            scoutAmountBnb: input.stagedPlan.scoutAmountBnb,
            addAmountBnb: input.stagedPlan.addAmountBnb,
            lastMetrics: refreshedMetrics,
            entryMcapUsd: refreshedMetrics.marketCapUsd,
            tweetAtMs: getSignalTimeMs(input.signal) ?? undefined,
            tweetUrl: buildTweetUrl(input.signal),
            tweetType: input.signal?.tweetType ? String(input.signal.tweetType) : undefined,
            channel: input.signal?.channel ? String(input.signal.channel) : undefined,
            signalId: input.signal?.id ? String(input.signal.id) : undefined,
            signalEventId: input.signal?.eventId ? String(input.signal.eventId) : undefined,
            signalTweetId: input.signal?.tweetId ? String(input.signal.tweetId) : undefined,
          });
          scheduleStagedAddIfEnabled(posKey, input.strategy);
          scheduleTimeStopIfEnabled(posKey, input.strategy);
        } else if (stage === 'full' && input.strategy?.timeStopEnabled === true) {
          stagedPositions.set(posKey, {
            chainId: input.chainId,
            tokenAddress: input.tokenAddress,
            dryRun: true,
            openedAtMs: Date.now(),
            scoutAmountBnb: amountNumber,
            addAmountBnb: 0,
            lastMetrics: refreshedMetrics,
            entryMcapUsd: refreshedMetrics.marketCapUsd,
            tweetAtMs: getSignalTimeMs(input.signal) ?? undefined,
            tweetUrl: buildTweetUrl(input.signal),
            tweetType: input.signal?.tweetType ? String(input.signal.tweetType) : undefined,
            channel: input.signal?.channel ? String(input.signal.channel) : undefined,
            signalId: input.signal?.id ? String(input.signal.id) : undefined,
            signalEventId: input.signal?.eventId ? String(input.signal.eventId) : undefined,
            signalTweetId: input.signal?.tweetId ? String(input.signal.tweetId) : undefined,
          });
          scheduleTimeStopIfEnabled(posKey, input.strategy);
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
                const existing = stagedPositions.get(posKey);
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
                    if (existing) {
                      stagedPositions.set(posKey, {
                        ...existing,
                        scoutAmountBnb: scoutAmt + addAmt,
                        entryMcapUsd,
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

                const meta = stagedPositions.get(posKey);
                dryRunAutoSellByPosKey.set(posKey, {
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
        const record: XSniperBuyRecord = {
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
        };
        void pushXSniperHistory(record);
        void broadcastToTabs({ type: 'bg:xsniper:buy', record });
        return true;
      }

      const amountWei = parseEther(String(amountNumber));
      const rsp = await TradeService.buy({
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        bnbAmountWei: amountWei.toString(),
        tokenInfo,
      } as any);
      void broadcastToActiveTabs({
        type: 'bg:tradeSuccess',
        source: 'xsniper',
        side: 'buy',
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        txHash: (rsp as any)?.txHash,
      });

      const entryPriceUsd = await getEntryPriceUsd(
        input.chainId,
        input.tokenAddress,
        tokenInfo,
        refreshedMetrics.priceUsd ?? null,
        refreshedMetrics.marketCapUsd ?? null,
      );
      boughtOnceAtMs.set(key, Date.now());
      void persistBoughtOnce();
      deps.onStateChanged();

      if (stage === 'scout' && input.stagedPlan) {
        const posKey = `${input.chainId}:${input.tokenAddress.toLowerCase()}`;
        stagedPositions.set(posKey, {
          chainId: input.chainId,
          tokenAddress: input.tokenAddress,
          dryRun: false,
          openedAtMs: input.stagedPlan.openedAtMs,
          scoutAmountBnb: input.stagedPlan.scoutAmountBnb,
          addAmountBnb: input.stagedPlan.addAmountBnb,
          lastMetrics: refreshedMetrics,
          entryMcapUsd: refreshedMetrics.marketCapUsd,
          tweetAtMs: getSignalTimeMs(input.signal) ?? undefined,
          tweetUrl: buildTweetUrl(input.signal),
          tweetType: input.signal?.tweetType ? String(input.signal.tweetType) : undefined,
          channel: input.signal?.channel ? String(input.signal.channel) : undefined,
          signalId: input.signal?.id ? String(input.signal.id) : undefined,
          signalEventId: input.signal?.eventId ? String(input.signal.eventId) : undefined,
          signalTweetId: input.signal?.tweetId ? String(input.signal.tweetId) : undefined,
        });
        scheduleStagedAddIfEnabled(posKey, input.strategy);
        scheduleTimeStopIfEnabled(posKey, input.strategy);
      } else if (stage === 'full' && input.strategy?.timeStopEnabled === true) {
        const posKey = `${input.chainId}:${input.tokenAddress.toLowerCase()}`;
        stagedPositions.set(posKey, {
          chainId: input.chainId,
          tokenAddress: input.tokenAddress,
          dryRun: false,
          openedAtMs: Date.now(),
          scoutAmountBnb: amountNumber,
          addAmountBnb: 0,
          lastMetrics: refreshedMetrics,
          entryMcapUsd: refreshedMetrics.marketCapUsd,
          tweetAtMs: getSignalTimeMs(input.signal) ?? undefined,
          tweetUrl: buildTweetUrl(input.signal),
          tweetType: input.signal?.tweetType ? String(input.signal.tweetType) : undefined,
          channel: input.signal?.channel ? String(input.signal.channel) : undefined,
          signalId: input.signal?.id ? String(input.signal.id) : undefined,
          signalEventId: input.signal?.eventId ? String(input.signal.eventId) : undefined,
          signalTweetId: input.signal?.tweetId ? String(input.signal.tweetId) : undefined,
        });
        scheduleTimeStopIfEnabled(posKey, input.strategy);
      }

      const now = Date.now();
      const tweetAtMs = getSignalTimeMs(input.signal) ?? undefined;
      const tweetUrl = buildTweetUrl(input.signal);
      const record: XSniperBuyRecord = {
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
        entryPriceUsd: entryPriceUsd ?? undefined,
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
      };
      void pushXSniperHistory(record);
      void broadcastToTabs({ type: 'bg:xsniper:buy', record });

      if (stage !== 'scout' && input.strategy?.autoSellEnabled && entryPriceUsd != null && entryPriceUsd > 0) {
        try {
          await TradeService.approveMaxForSellIfNeeded(input.chainId, input.tokenAddress, tokenInfo);
          await placeAutoSellOrdersIfEnabled(input.chainId, input.tokenAddress, tokenInfo, entryPriceUsd);
        } catch {}
      }

      console.log('XSniperTrade buy tx', (rsp as any)?.txHash ?? '');
      return true;
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
    const now = Date.now();
    const createdAtMs = normalizeEpochMs((t as any).createdAtMs) ?? undefined;
    const firstSeenAtMs = normalizeEpochMs((t as any).firstSeenAtMs) ?? undefined;
    const tokenAtMs = firstSeenAtMs ?? createdAtMs;
    const tokenAgeMsForDev = tokenAtMs != null ? now - tokenAtMs : null;

    const devHoldPercentRaw = typeof (t as any).devHoldPercent === 'number' ? (t as any).devHoldPercent : undefined;
    let devHoldPercent =
      typeof devHoldPercentRaw === 'number' && Number.isFinite(devHoldPercentRaw)
        ? devHoldPercentRaw >= 0 && devHoldPercentRaw <= 1
          ? devHoldPercentRaw * 100
          : devHoldPercentRaw
        : undefined;
    if (devHoldPercent == null && tokenAgeMsForDev != null && tokenAgeMsForDev > 3000) devHoldPercent = 0;
    return {
      tokenAddress,
      tokenSymbol: typeof (t as any).tokenSymbol === 'string' ? String((t as any).tokenSymbol) : undefined,
      marketCapUsd: sanitizeMarketCapUsd((t as any).marketCapUsd) ?? undefined,
      liquidityUsd: typeof (t as any).liquidityUsd === 'number' ? (t as any).liquidityUsd : undefined,
      holders: typeof (t as any).holders === 'number' ? (t as any).holders : undefined,
      kol: typeof (t as any).kol === 'number' ? (t as any).kol : undefined,
      vol24hUsd: typeof (t as any).vol24hUsd === 'number' ? (t as any).vol24hUsd : undefined,
      netBuy24hUsd: typeof (t as any).netBuy24hUsd === 'number' ? (t as any).netBuy24hUsd : undefined,
      buyTx24h: typeof (t as any).buyTx24h === 'number' ? (t as any).buyTx24h : undefined,
      sellTx24h: typeof (t as any).sellTx24h === 'number' ? (t as any).sellTx24h : undefined,
      smartMoney: typeof (t as any).smartMoney === 'number' ? (t as any).smartMoney : undefined,
      createdAtMs,
      firstSeenAtMs,
      updatedAtMs: normalizeEpochMs((t as any).updatedAtMs) ?? undefined,
      devAddress: normalizeAddress((t as any).devAddress) ?? undefined,
      devHoldPercent,
      devHasSold: typeof (t as any).devHasSold === 'boolean'
        ? (t as any).devHasSold
        : (typeof (t as any).devTokenStatus === 'string' ? String((t as any).devTokenStatus).toLowerCase().includes('sell') : undefined),
      priceUsd: typeof (t as any).priceUsd === 'number' ? (t as any).priceUsd : undefined,
    };
  };

  const pickTokensToBuyFromSignal = (signal: UnifiedTwitterSignal, strategy: any) => {
    const tokens = Array.isArray(signal.tokens) ? (signal.tokens as UnifiedSignalToken[]) : [];
    const now = Date.now();
    const signalAtMs = getSignalTimeMs(signal) ?? now;
    const perTweetMax = Math.max(0, Math.floor(parseNumber(strategy?.buyNewCaCount) ?? 0));
    if (perTweetMax <= 0) return [];
    const scanLimit = Math.min(500, tokens.length);
    const unique: UnifiedSignalToken[] = [];
    const seen = new Set<string>();
    for (const t of tokens) {
      const addr = typeof (t as any)?.tokenAddress === 'string' ? String((t as any).tokenAddress).trim() : '';
      const key = addr.toLowerCase();
      if (!addr) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(t);
      if (unique.length >= scanLimit) break;
    }

    const candidates = unique
      .map((t) => {
        const m = metricsFromUnifiedToken(t);
        if (m?.tokenAddress) {
          pushWsSnapshot(m.tokenAddress, m);
        }
        return { t, m };
      })
      .filter((x) => {
        if (!x.m?.tokenAddress) return false;
        if (!shouldBuyByConfig(x.m, strategy, signalAtMs, now)) return false;
        const confirm = computeWsConfirm(x.m.tokenAddress, now, strategy);
        return confirm.pass;
      });

    candidates.sort((a, b) => {
      const ma = typeof a.m?.marketCapUsd === 'number' ? a.m.marketCapUsd : 0;
      const mb = typeof b.m?.marketCapUsd === 'number' ? b.m.marketCapUsd : 0;
      if (mb !== ma) return mb - ma;
      const ta = normalizeEpochMs((a.t as any).firstSeenAtMs) ?? 0;
      const tb = normalizeEpochMs((b.t as any).firstSeenAtMs) ?? 0;
      return ta - tb;
    });

    if (strategy?.dryRun === true) {
      return candidates;
    }
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
      const first = normalizeEpochMs((c.t as any).firstSeenAtMs) ?? now;
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
  const timeStopSellInFlight = new Set<string>();

  const tryTimeStopSellOnce = async (input: {
    chainId: number;
    tokenAddress: `0x${string}`;
    percent: number;
    pos: (typeof stagedPositions extends Map<any, infer V> ? V : never);
    reason: 'time_stop' | 'staged_abort';
  }) => {
    const percent = Math.max(0, Math.min(100, Number(input.percent)));
    if (!Number.isFinite(percent) || percent <= 0) return;
    const bps = Math.floor(percent * 100);
    if (!(bps > 0)) return;

    const dedupeKey = `${input.chainId}:${input.tokenAddress.toLowerCase()}:${bps}:${input.reason}`;
    if (timeStopSellInFlight.has(dedupeKey)) return;
    timeStopSellInFlight.add(dedupeKey);
    try {
      const now = Date.now();
      const baseRecord: XSniperBuyRecord = {
        id: `${now}-${Math.random().toString(16).slice(2)}`,
        side: 'sell',
        tsMs: now,
        tweetAtMs: input.pos.tweetAtMs,
        tweetUrl: input.pos.tweetUrl,
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        sellPercent: percent,
        sellTokenAmountWei: undefined,
        txHash: undefined,
        dryRun: input.pos.dryRun,
        tweetType: input.pos.tweetType,
        channel: input.pos.channel,
        signalId: input.pos.signalId,
        signalEventId: input.pos.signalEventId,
        signalTweetId: input.pos.signalTweetId,
        reason: input.reason,
      };

      if (input.pos.dryRun) {
        void pushXSniperHistory(baseRecord);
        void broadcastToTabs({ type: 'bg:xsniper:buy', record: baseRecord });
        cleanupPosKey(`${input.chainId}:${input.tokenAddress.toLowerCase()}`);
        return;
      }

      const status = await WalletService.getStatus();
      if (status.locked || !status.address) {
        const record = { ...baseRecord, dryRun: false, reason: 'wallet_locked' };
        void pushXSniperHistory(record);
        void broadcastToTabs({ type: 'bg:xsniper:buy', record });
        return;
      }

      const tokenInfo =
        (await fetchTokenInfoFresh(input.chainId, input.tokenAddress)) ??
        (await buildGenericTokenInfo(input.chainId, input.tokenAddress));
      if (!tokenInfo) {
        const record = { ...baseRecord, dryRun: false, reason: 'token_info_missing' };
        void pushXSniperHistory(record);
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
        void pushXSniperHistory(record);
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
        void pushXSniperHistory(record);
        void broadcastToTabs({ type: 'bg:xsniper:buy', record });
        return;
      }

      try {
        await cancelAllSellLimitOrdersForToken(input.chainId, input.tokenAddress);
      } catch {}
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
      void broadcastToActiveTabs({
        type: 'bg:tradeSuccess',
        source: 'xsniper',
        side: 'sell',
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        txHash: (rsp as any)?.txHash,
      });

      const record: XSniperBuyRecord = {
        ...baseRecord,
        dryRun: false,
        sellTokenAmountWei: amountWei.toString(),
        txHash: typeof (rsp as any)?.txHash === 'string' ? ((rsp as any).txHash as any) : undefined,
      };
      void pushXSniperHistory(record);
      void broadcastToTabs({ type: 'bg:xsniper:buy', record });
    } finally {
      timeStopSellInFlight.delete(dedupeKey);
    }
  };

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
      const tweetAtMs = getSignalTimeMs(input.signal) ?? undefined;
      const tweetUrl = buildTweetUrl(input.signal);
      const baseRecord: XSniperBuyRecord = {
        id: `${now}-${Math.random().toString(16).slice(2)}`,
        side: 'sell',
        tsMs: now,
        tweetAtMs,
        tweetUrl,
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
        void pushXSniperHistory(record);
        void broadcastToTabs({ type: 'bg:xsniper:buy', record });
        return;
      }

      const status = await WalletService.getStatus();
      if (status.locked || !status.address) {
        const record = { ...baseRecord, dryRun: false, reason: 'wallet_locked' };
        void pushXSniperHistory(record);
        void broadcastToTabs({ type: 'bg:xsniper:buy', record });
        return;
      }

      const tokenInfo =
        (await fetchTokenInfoFresh(input.chainId, input.tokenAddress)) ??
        (await buildGenericTokenInfo(input.chainId, input.tokenAddress));
      if (!tokenInfo) {
        const record = { ...baseRecord, dryRun: false, reason: 'token_info_missing' };
        void pushXSniperHistory(record);
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
        void pushXSniperHistory(record);
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
        void pushXSniperHistory(record);
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
      void broadcastToActiveTabs({
        type: 'bg:tradeSuccess',
        source: 'xsniper',
        side: 'sell',
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        txHash: (rsp as any)?.txHash,
      });

      const record: XSniperBuyRecord = {
        ...baseRecord,
        dryRun: false,
        tokenSymbol: tokenInfo.symbol ? String(tokenInfo.symbol) : baseRecord.tokenSymbol,
        tokenName: tokenInfo.name ? String(tokenInfo.name) : baseRecord.tokenName,
        sellTokenAmountWei: amountWei.toString(),
        txHash: typeof (rsp as any)?.txHash === 'string' ? ((rsp as any).txHash as any) : undefined,
      };
      void pushXSniperHistory(record);
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

        const history = await loadXSniperHistory();
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
        if (strategy?.stagedEntryEnabled === true) {
          const total = parseNumber(strategy?.buyAmountBnb) ?? 0;
          const scoutPct = Math.max(1, Math.min(99, parseNumber(strategy?.stagedEntryScoutPercent) ?? 25));
          const scoutAmount = total > 0 ? (total * scoutPct) / 100 : 0;
          const addAmount = total > 0 ? Math.max(0, total - scoutAmount) : 0;
          const openedAtMs = Date.now();
          if (scoutAmount > 0 && addAmount > 0) {
            await tryAutoBuyOnce({
              chainId: settings.chainId,
              tokenAddress: m.tokenAddress,
              metrics: m,
              strategy,
              signal,
              stage: 'scout',
              amountBnbOverride: scoutAmount,
              stagedPlan: { scoutAmountBnb: scoutAmount, addAmountBnb: addAmount, openedAtMs },
            });
          } else {
            await tryAutoBuyOnce({ chainId: settings.chainId, tokenAddress: m.tokenAddress, metrics: m, strategy, signal });
          }
        } else {
          await tryAutoBuyOnce({ chainId: settings.chainId, tokenAddress: m.tokenAddress, metrics: m, strategy, signal });
        }
      }
    } catch (e) {
      console.error('XSniperTrade twitter signal handler error', e);
    }
  };

  return { handleTwitterSignal };
};
