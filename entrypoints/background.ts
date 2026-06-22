import { browser } from 'wxt/browser';
import { WalletService } from '@/services/wallet';
import { SettingsService } from '@/services/settings';
import { TradeService } from '@/services/trade';
import { TokenService } from '@/services/token';
import { RpcService } from '@/services/rpc';
import {
  cancelAllLimitOrders, cancelLimitOrder,
  clearExecutedLimitOrders,
  createLimitOrder,
  listLimitOrders
} from '@/services/limitOrders/store';
import { debugLogTxError, extractRevertReasonFromError, serializeTxError, tryGetReceiptRevertReason } from '@/services/tx/errors';
import { createLimitOrderScanner } from './background/limitOrderScanner';
import { createXSniperTrade } from '@/services/xSniper/xSniperTrade';
import { createTokenSniperTrade } from '@/services/tokenSniper/tokenSniperTrade';
import { createNewCoinSniperTrade } from '@/services/newCoinSniper/newCoinSniperTrade';
import { createLimitOrderExecutor, tickLimitOrdersForToken } from '@/services/limitOrders/executor';
import type { BgRequest, GmgnTokenSnapshot, LimitOrderScanStatus, NewPoolMonitorUiDetail, SubmitChannel, TxSellInput, UnifiedMarketSignalSource } from '@/types/extention';
import { TokenFourmemeService } from '@/services/token/fourmeme';
import { TokenFlapService } from '@/services/token/flap';
import { TokenAltfunService } from '@/services/token/altfun';
import FourmemeAPI from '@/services/api/fourmeme';
import { chainNames } from '@/constants/chains';
import BloxRouterAPI from '@/services/api/bloxRouter';
import { isAddress, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getGasPriceWei, sendTransaction } from '@/services/trade/tradeTx';
import { classifyBroadcastError, collectErrorText } from '@/utils/txErrorClassify';
import type { TxBuyInput } from '@/types/extention';
import { createTelegramNotifier } from '@/services/telegram/notifier';
import { createTelegramController } from '@/services/telegram/controller';
import { getChainRuntime } from '@/constants/chains';
import { RpcReadBalancer } from '@/services/rpcReadBalancer';
import { shouldUseMergedTokenValue } from '@/utils/gmgnWs';

export default defineBackground(() => {
  console.log('Dagobang Background Service Started');
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
  const EIP7702_DELEGATION_PREFIX = '0xef0100';
  const STATE_CHANGE_BROADCAST_DEBOUNCE_MS = 250;
  const GMGN_TOKEN_SNAPSHOT_CACHE_LIMIT = 1500;
  const GMGN_TOKEN_SNAPSHOT_STORAGE_KEY = 'dagobang_gmgn_token_snapshot_v2';
  const GMGN_TOKEN_SNAPSHOT_PERSIST_DEBOUNCE_MS = 8000;
  const NEWPOOL_MONITOR_CACHE_LIMIT = 800;
  const NEWPOOL_MONITOR_BROADCAST_MS = 16;
  const parseEip7702Delegation = (code: string | null | undefined): { delegated: boolean; delegateAddress?: `0x${string}`; code: `0x${string}` } => {
    const normalized = (typeof code === 'string' && code.startsWith('0x') ? code.toLowerCase() : '0x') as `0x${string}`;
    if (!normalized.startsWith(EIP7702_DELEGATION_PREFIX) || normalized.length < 2 + 6 + 40) {
      return { delegated: false, code: normalized };
    }
    const delegateAddress = (`0x${normalized.slice(-40)}`) as `0x${string}`;
    if (!isAddress(delegateAddress)) return { delegated: false, code: normalized };
    return { delegated: true, delegateAddress, code: normalized };
  };
  let stateChangeSeq = 0;
  let stateChangeBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingStateChangeResolvers: Array<() => void> = [];
  let pendingStateChangeRejectors: Array<(error: unknown) => void> = [];
  const gmgnTokenSnapshotStore = new Map<string, GmgnTokenSnapshot>();
  let gmgnTokenSnapshotPersistTimer: ReturnType<typeof setTimeout> | null = null;
  const newPoolMonitorStore = new Map<string, NewPoolMonitorUiDetail>();
  const pendingNewPoolMonitorBroadcast = new Map<string, NewPoolMonitorUiDetail>();
  let newPoolMonitorBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
  const resolvePreferredMarketSignalSource = (
    prev: UnifiedMarketSignalSource,
    next: UnifiedMarketSignalSource,
  ): UnifiedMarketSignalSource => {
    const rank: Record<UnifiedMarketSignalSource, number> = {
      token_update: 0,
      near_complete: 1,
      complete: 2,
      new_pool: 3,
    };
    return (rank[next] ?? 0) >= (rank[prev] ?? 0) ? next : prev;
  };
  const isObject = (input: unknown): input is Record<string, any> => !!input && typeof input === 'object' && !Array.isArray(input);
  const pickFiniteNumber = (input: unknown): number | undefined => {
    const num = typeof input === 'number' ? input : Number(input);
    return Number.isFinite(num) ? num : undefined;
  };
  const normalizePercentValue = (input: unknown): number | undefined => {
    const num = pickFiniteNumber(input);
    if (num == null) return undefined;
    if (num >= 0 && num <= 1) return num * 100;
    return num;
  };
  const pickMaxPercentValue = (next: unknown, prev: unknown): number | undefined => {
    const nextPercent = normalizePercentValue(next);
    const prevPercent = normalizePercentValue(prev);
    if (nextPercent == null) return prevPercent;
    if (prevPercent == null) return nextPercent;
    return Math.max(nextPercent, prevPercent);
  };
  const mergeNewPoolMonitorTokenData = (prev: any, next: any): any => {
    if (!isObject(prev)) return isObject(next) ? { ...(next as any) } : next;
    if (!isObject(next)) return { ...(prev as any) };
    const merged: Record<string, any> = { ...(prev as any) };
    for (const [key, value] of Object.entries(next as Record<string, any>)) {
      if (!shouldUseMergedTokenValue(value)) continue;
      merged[key] = value;
    }
    const prevF = isObject((prev as any).f) ? (prev as any).f : null;
    const nextF = isObject((next as any).f) ? (next as any).f : null;
    if (prevF || nextF) {
      const mergedF: Record<string, any> = { ...(prevF ?? {}) };
      for (const [key, value] of Object.entries((nextF ?? {}) as Record<string, any>)) {
        if (!shouldUseMergedTokenValue(value)) continue;
        mergedF[key] = value;
      }
      merged.f = mergedF;
    }
    const prevDevBuyRatio = pickFiniteNumber((prev as any).d_br);
    const nextDevBuyRatio = pickFiniteNumber((next as any).d_br);
    const mergedDevBuyRatio = nextDevBuyRatio ?? prevDevBuyRatio;
    if (mergedDevBuyRatio != null) {
      merged.devHoldPercent = normalizePercentValue(mergedDevBuyRatio);
      merged.d_br = mergedDevBuyRatio;
      if (isObject(merged.f)) {
        (merged.f as Record<string, any>).d_br = pickFiniteNumber((nextF as any)?.d_br) ?? pickFiniteNumber((prevF as any)?.d_br) ?? mergedDevBuyRatio;
      }
    }
    const mergedDevMaxBuyPercent = pickMaxPercentValue(
      nextDevBuyRatio,
      pickFiniteNumber((prev as any).devMaxBuyPercent) ?? normalizePercentValue(prevDevBuyRatio ?? null),
    );
    if (mergedDevMaxBuyPercent != null) {
      merged.devMaxBuyPercent = mergedDevMaxBuyPercent;
    }
    return merged;
  };
  const getNewPoolMonitorKey = (detail: NewPoolMonitorUiDetail) => {
    const addr = typeof detail?.tokenData?.tokenAddress === 'string' ? detail.tokenData.tokenAddress.trim().toLowerCase() : '';
    return addr || `${detail.source}:${detail.channel}:${detail.receivedAtMs}`;
  };
  const mergeNewPoolMonitorDetail = (prev: NewPoolMonitorUiDetail | undefined, next: NewPoolMonitorUiDetail): NewPoolMonitorUiDetail => {
    if (!prev) return next;
    return {
      source: resolvePreferredMarketSignalSource(prev.source, next.source),
      channel: next.channel || prev.channel,
      tokenData: mergeNewPoolMonitorTokenData(prev.tokenData, next.tokenData),
      receivedAtMs: Math.max(prev.receivedAtMs, next.receivedAtMs),
    };
  };
  const normalizeTokenSnapshotKey = (input: unknown) =>
    typeof input === 'string' ? input.trim().toLowerCase() : '';
  const mergeGmgnTokenSnapshot = (prev: GmgnTokenSnapshot | undefined, next: GmgnTokenSnapshot): GmgnTokenSnapshot => {
    if (!prev) return next;
    const merged: Record<string, any> = { ...(prev as any) };
    for (const [key, value] of Object.entries(next as Record<string, any>)) {
      if (!shouldUseMergedTokenValue(value)) continue;
      merged[key] = value;
    }
    merged.tokenAddress = normalizeTokenSnapshotKey(next.tokenAddress || prev.tokenAddress);
    merged.receivedAtMs = Math.max(prev.receivedAtMs ?? 0, next.receivedAtMs ?? 0);
    return merged as GmgnTokenSnapshot;
  };
  const persistGmgnTokenSnapshotStore = async () => {
    const items = Array.from(gmgnTokenSnapshotStore.values())
      .sort((a, b) => ((a.receivedAtMs ?? 0) - (b.receivedAtMs ?? 0)))
      .slice(-GMGN_TOKEN_SNAPSHOT_CACHE_LIMIT);
    try {
      await browser.storage.local.set({ [GMGN_TOKEN_SNAPSHOT_STORAGE_KEY]: items } as any);
    } catch {
    }
  };
  const scheduleGmgnTokenSnapshotPersist = () => {
    if (gmgnTokenSnapshotPersistTimer != null) return;
    gmgnTokenSnapshotPersistTimer = setTimeout(() => {
      gmgnTokenSnapshotPersistTimer = null;
      void persistGmgnTokenSnapshotStore();
    }, GMGN_TOKEN_SNAPSHOT_PERSIST_DEBOUNCE_MS);
  };
  let gmgnTokenSnapshotStoreLoadPromise: Promise<void> | null = null;
  const ensureGmgnTokenSnapshotStoreLoaded = () => {
    if (gmgnTokenSnapshotStoreLoadPromise) return gmgnTokenSnapshotStoreLoadPromise;
    gmgnTokenSnapshotStoreLoadPromise = (async () => {
      try {
        const res = await browser.storage.local.get(GMGN_TOKEN_SNAPSHOT_STORAGE_KEY as any);
        const items = Array.isArray((res as any)?.[GMGN_TOKEN_SNAPSHOT_STORAGE_KEY])
          ? (res as any)[GMGN_TOKEN_SNAPSHOT_STORAGE_KEY] as GmgnTokenSnapshot[]
          : [];
        for (const item of items) {
          if (!item || typeof item !== 'object') continue;
          const key = normalizeTokenSnapshotKey(item.tokenAddress);
          if (!key) continue;
          const merged = mergeGmgnTokenSnapshot(gmgnTokenSnapshotStore.get(key), { ...item, tokenAddress: key });
          gmgnTokenSnapshotStore.set(key, merged);
        }
      } catch {
      }
    })();
    return gmgnTokenSnapshotStoreLoadPromise;
  };
  const upsertGmgnTokenSnapshots = (items: GmgnTokenSnapshot[]) => {
    let changed = false;
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const key = normalizeTokenSnapshotKey(item.tokenAddress);
      if (!key) continue;
      const prev = gmgnTokenSnapshotStore.get(key);
      const merged = mergeGmgnTokenSnapshot(prev, { ...item, tokenAddress: key });
      if (prev === merged) continue;
      gmgnTokenSnapshotStore.set(key, merged);
      changed = true;
    }
    if (!changed) return;
    while (gmgnTokenSnapshotStore.size > GMGN_TOKEN_SNAPSHOT_CACHE_LIMIT) {
      const oldestKey = gmgnTokenSnapshotStore.keys().next().value;
      if (!oldestKey) break;
      gmgnTokenSnapshotStore.delete(oldestKey);
    }
    scheduleGmgnTokenSnapshotPersist();
  };
  const buildGmgnTokenSnapshotFromDetail = (detail: NewPoolMonitorUiDetail): GmgnTokenSnapshot | null => {
    const tokenData = detail?.tokenData;
    const tokenAddress = normalizeTokenSnapshotKey(tokenData?.tokenAddress);
    if (!tokenAddress) return null;
    return {
      tokenAddress,
      source: detail.source,
      channel: detail.channel,
      chain: typeof tokenData?.chain === 'string' ? tokenData.chain : undefined,
      launchpadPlatform: typeof tokenData?.launchpadPlatform === 'string' ? tokenData.launchpadPlatform : undefined,
      tokenSymbol:
        (typeof tokenData?.tokenSymbol === 'string' && tokenData.tokenSymbol.trim() ? tokenData.tokenSymbol.trim() : undefined) ??
        (typeof tokenData?.symbol === 'string' && tokenData.symbol.trim() ? tokenData.symbol.trim() : undefined) ??
        (typeof tokenData?.s === 'string' && tokenData.s.trim() ? tokenData.s.trim() : undefined),
      tokenName:
        (typeof tokenData?.tokenName === 'string' && tokenData.tokenName.trim() ? tokenData.tokenName.trim() : undefined) ??
        (typeof tokenData?.name === 'string' && tokenData.name.trim() ? tokenData.name.trim() : undefined) ??
        (typeof tokenData?.nm === 'string' && tokenData.nm.trim() ? tokenData.nm.trim() : undefined),
      tokenLogo:
        (typeof tokenData?.tokenLogo === 'string' && tokenData.tokenLogo.trim() ? tokenData.tokenLogo.trim() : undefined) ??
        (typeof tokenData?.logo === 'string' && tokenData.logo.trim() ? tokenData.logo.trim() : undefined) ??
        (typeof tokenData?.l === 'string' && tokenData.l.trim() ? tokenData.l.trim() : undefined),
      marketCapUsd: pickFiniteNumber(tokenData?.marketCapUsd ?? tokenData?.mc),
      priceUsd: pickFiniteNumber(tokenData?.priceUsd ?? tokenData?.p),
      liquidityUsd: pickFiniteNumber(tokenData?.liquidityUsd ?? tokenData?.lqdt),
      holders: pickFiniteNumber(tokenData?.holders ?? tokenData?.hd),
      kol: pickFiniteNumber(tokenData?.kol),
      vol24hUsd: pickFiniteNumber(tokenData?.vol24hUsd ?? tokenData?.v24h),
      netBuy24hUsd: pickFiniteNumber(tokenData?.netBuy24hUsd ?? tokenData?.nba_24h),
      buyTx24h: pickFiniteNumber(tokenData?.buyTx24h ?? tokenData?.b24h),
      sellTx24h: pickFiniteNumber(tokenData?.sellTx24h ?? tokenData?.s24h),
      smartMoney: pickFiniteNumber(tokenData?.smartMoney ?? tokenData?.smt),
      devAddress: typeof tokenData?.devAddress === 'string' ? tokenData.devAddress : undefined,
      devHoldPercent: pickFiniteNumber(tokenData?.devHoldPercent ?? tokenData?.d_br),
      devMaxBuyPercent: pickFiniteNumber(tokenData?.devMaxBuyPercent),
      viewerCount: pickFiniteNumber(tokenData?.viewerCount ?? tokenData?.v_c),
      devCreatedTokenCount: pickFiniteNumber(tokenData?.devCreatedTokenCount ?? tokenData?.d_ccc),
      devHasSold: typeof tokenData?.devHasSold === 'boolean' ? tokenData.devHasSold : undefined,
      top10HoldRatio: pickFiniteNumber(tokenData?.top10HoldRatio ?? tokenData?.t10),
      devTokenStatus: typeof tokenData?.devTokenStatus === 'string' ? tokenData.devTokenStatus : undefined,
      createdAtMs: pickFiniteNumber(tokenData?.createdAtMs ?? tokenData?.ct),
      receivedAtMs: pickFiniteNumber(detail?.receivedAtMs) ?? Date.now(),
    };
  };
  const buildNewPoolMonitorDetailFromSnapshot = (snapshot: GmgnTokenSnapshot): NewPoolMonitorUiDetail | null => {
    const tokenAddress = normalizeTokenSnapshotKey(snapshot?.tokenAddress);
    if (!tokenAddress) return null;
    const createdAtMs = pickFiniteNumber(snapshot.createdAtMs);
    const tokenData = {
      tokenAddress,
      chain: snapshot.chain,
      launchpadPlatform: snapshot.launchpadPlatform,
      tokenSymbol: snapshot.tokenSymbol,
      symbol: snapshot.tokenSymbol,
      s: snapshot.tokenSymbol,
      tokenName: snapshot.tokenName,
      name: snapshot.tokenName,
      nm: snapshot.tokenName,
      tokenLogo: snapshot.tokenLogo,
      logo: snapshot.tokenLogo,
      l: snapshot.tokenLogo,
      marketCapUsd: snapshot.marketCapUsd,
      mc: snapshot.marketCapUsd,
      priceUsd: snapshot.priceUsd,
      p: snapshot.priceUsd,
      liquidityUsd: snapshot.liquidityUsd,
      lqdt: snapshot.liquidityUsd,
      holders: snapshot.holders,
      hd: snapshot.holders,
      kol: snapshot.kol,
      vol24hUsd: snapshot.vol24hUsd,
      v24h: snapshot.vol24hUsd,
      netBuy24hUsd: snapshot.netBuy24hUsd,
      nba_24h: snapshot.netBuy24hUsd,
      buyTx24h: snapshot.buyTx24h,
      b24h: snapshot.buyTx24h,
      sellTx24h: snapshot.sellTx24h,
      s24h: snapshot.sellTx24h,
      smartMoney: snapshot.smartMoney,
      smt: snapshot.smartMoney,
      devAddress: snapshot.devAddress,
      devHoldPercent: snapshot.devHoldPercent,
      d_br: snapshot.devHoldPercent,
      devMaxBuyPercent: snapshot.devMaxBuyPercent,
      viewerCount: snapshot.viewerCount,
      v_c: snapshot.viewerCount,
      devCreatedTokenCount: snapshot.devCreatedTokenCount,
      d_ccc: snapshot.devCreatedTokenCount,
      devHasSold: snapshot.devHasSold,
      top10HoldRatio: snapshot.top10HoldRatio,
      t10: snapshot.top10HoldRatio,
      devTokenStatus: snapshot.devTokenStatus,
      createdAtMs,
      ct: createdAtMs,
    };
    return {
      source: snapshot.source ?? 'token_update',
      channel: snapshot.channel ?? 'trenches_delta',
      tokenData,
      receivedAtMs: snapshot.receivedAtMs ?? 0,
    };
  };
  const getNewPoolMonitorSnapshotItems = (): NewPoolMonitorUiDetail[] => {
    const byKey = new Map<string, NewPoolMonitorUiDetail>();
    for (const snapshot of gmgnTokenSnapshotStore.values()) {
      const detail = buildNewPoolMonitorDetailFromSnapshot(snapshot);
      if (!detail) continue;
      byKey.set(getNewPoolMonitorKey(detail), detail);
    }
    for (const runtimeDetail of newPoolMonitorStore.values()) {
      const key = getNewPoolMonitorKey(runtimeDetail);
      const merged = mergeNewPoolMonitorDetail(byKey.get(key), runtimeDetail);
      byKey.set(key, merged);
    }
    const items = Array.from(byKey.values())
      .sort((a, b) => (a.receivedAtMs ?? 0) - (b.receivedAtMs ?? 0))
      .slice(-NEWPOOL_MONITOR_CACHE_LIMIT);
    // #region debug-point B:getsnapshot-age-devhold
    (() => {
      const sample = items
        .filter((item) => {
          const td = item?.tokenData;
          return td?.createdAtMs == null || td?.devHoldPercent == null;
        })
        .slice(0, 8)
        .map((item) => ({
          tokenAddress: item?.tokenData?.tokenAddress ?? null,
          source: item?.source ?? null,
          channel: item?.channel ?? null,
          createdAtMs: item?.tokenData?.createdAtMs ?? null,
          ct: item?.tokenData?.ct ?? null,
          devHoldPercent: item?.tokenData?.devHoldPercent ?? null,
          d_br: item?.tokenData?.d_br ?? null,
          receivedAtMs: item?.receivedAtMs ?? null,
        }));
      fetch('http://127.0.0.1:7777/event', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: 'newpool-age-devhold',
          runId: 'pre-fix',
          hypothesisId: 'B',
          location: 'background.ts:getNewPoolMonitorSnapshotItems',
          msg: '[DEBUG] background snapshot items age/devhold summary',
          data: {
            total: items.length,
            missingCreatedAt: items.filter((item) => item?.tokenData?.createdAtMs == null).length,
            missingDevHoldPercent: items.filter((item) => item?.tokenData?.devHoldPercent == null).length,
            sample,
          },
          ts: Date.now(),
        }),
      }).catch(() => { });
    })();
    // #endregion
    return items;
  };
  const scheduleNewPoolMonitorBroadcast = () => {
    if (newPoolMonitorBroadcastTimer != null) return;
    newPoolMonitorBroadcastTimer = setTimeout(() => {
      newPoolMonitorBroadcastTimer = null;
      const items = Array.from(pendingNewPoolMonitorBroadcast.values());
      // #region debug-point B:newpool-bg-broadcast
      (() => {
        const key = '__DBG_NEWPOOL_BG_BROADCAST_TS__';
        const nowTs = Date.now();
        const lastTs = typeof (globalThis as any)[key] === 'number' ? (globalThis as any)[key] : 0;
        (globalThis as any)[key] = nowTs;
        fetch('http://127.0.0.1:7777/event', {
          method: 'POST',
          body: JSON.stringify({
            sessionId: 'newpool-v2-crash',
            runId: 'post-fix',
            hypothesisId: 'B',
            location: 'background.ts:scheduleNewPoolMonitorBroadcast',
            msg: '[DEBUG] background newpool broadcast',
            data: {
              items: items.length,
              gapMs: lastTs > 0 ? nowTs - lastTs : null,
              pendingSize: pendingNewPoolMonitorBroadcast.size,
              storeSize: newPoolMonitorStore.size,
            },
            ts: nowTs,
          }),
        }).catch(() => { });
      })();
      // #endregion
      pendingNewPoolMonitorBroadcast.clear();
      if (!items.length) return;
      void broadcastToTabs({ type: 'bg:newpool:batch', items });
    }, NEWPOOL_MONITOR_BROADCAST_MS);
  };
  const upsertNewPoolMonitorItems = (items: NewPoolMonitorUiDetail[]) => {
    const beforeSize = newPoolMonitorStore.size;
    const snapshotItems: GmgnTokenSnapshot[] = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const snapshot = buildGmgnTokenSnapshotFromDetail(item);
      if (snapshot) snapshotItems.push(snapshot);
      const key = getNewPoolMonitorKey(item);
      const merged = mergeNewPoolMonitorDetail(newPoolMonitorStore.get(key), item);
      if (newPoolMonitorStore.has(key)) newPoolMonitorStore.delete(key);
      newPoolMonitorStore.set(key, merged);
      pendingNewPoolMonitorBroadcast.set(key, merged);
      maybeEnrichNewPoolMonitorItem(merged);
    }
    if (snapshotItems.length) upsertGmgnTokenSnapshots(snapshotItems);
    while (newPoolMonitorStore.size > NEWPOOL_MONITOR_CACHE_LIMIT) {
      const oldestKey = newPoolMonitorStore.keys().next().value;
      if (!oldestKey) break;
      newPoolMonitorStore.delete(oldestKey);
    }
    // #region debug-point B:newpool-bg-upsert
    (() => {
      fetch('http://127.0.0.1:7777/event', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: 'newpool-v2-crash',
          runId: 'post-fix',
          hypothesisId: 'B',
          location: 'background.ts:upsertNewPoolMonitorItems',
          msg: '[DEBUG] background newpool upsert',
          data: {
            incoming: items.length,
            beforeSize,
            afterSize: newPoolMonitorStore.size,
            pendingBroadcast: pendingNewPoolMonitorBroadcast.size,
          },
          ts: Date.now(),
        }),
      }).catch(() => { });
    })();
    // #endregion
    scheduleNewPoolMonitorBroadcast();
  };
  const resolveTradeSubmitChannel = async (chainId: number, preferred?: SubmitChannel): Promise<SubmitChannel> => {
    if (preferred === 'blox' || preferred === 'blockrazor' || preferred === 'protectRpcs' || preferred === 'mixed') return preferred;
    const settings = await SettingsService.get();
    const raw = settings?.chains?.[chainId]?.submitChannel;
    return raw === 'blox' || raw === 'blockrazor' || raw === 'protectRpcs' || raw === 'mixed' ? raw : 'protectRpcs';
  };
  browser.action.onClicked.addListener(async (tab) => {
    try {
      const api = (globalThis as any).chrome?.sidePanel;
      const tabId = typeof tab?.id === 'number' ? tab.id : undefined;
      if (api?.open && tabId != null) {
        await api.open({ tabId });
      }
    } catch (e) {
      console.error('Failed to open side panel:', e);
    }
  });

  const broadcastToTabs = async (payload: any) => {
    try {
      const tabs = await browser.tabs.query({});
      for (const tab of tabs) {
        if (tab.id) {
          browser.tabs.sendMessage(tab.id, payload).catch(() => { });
        }
      }
    } catch (e) {
      console.error('Broadcast failed', e);
    }
  };

  const broadcastStateChange = async () => {
    return await new Promise<void>((resolve, reject) => {
      pendingStateChangeResolvers.push(resolve);
      pendingStateChangeRejectors.push(reject);
      if (stateChangeBroadcastTimer) {
        clearTimeout(stateChangeBroadcastTimer);
      }
      stateChangeBroadcastTimer = setTimeout(() => {
        stateChangeBroadcastTimer = null;
        stateChangeSeq += 1;
        const payload = { type: 'bg:stateChanged', seq: stateChangeSeq, ts: Date.now() };
        const resolvers = pendingStateChangeResolvers;
        const rejectors = pendingStateChangeRejectors;
        pendingStateChangeResolvers = [];
        pendingStateChangeRejectors = [];
        console.log('[background.broadcastStateChange]', payload);
        void broadcastToTabs(payload)
          .then(() => {
            for (const done of resolvers) done();
          })
          .catch((error) => {
            for (const fail of rejectors) fail(error);
          });
      }, STATE_CHANGE_BROADCAST_DEBOUNCE_MS);
    });
  };

  const requestGmgnHoldingsFromContent = async (chain: string, walletAddress: string): Promise<any[]> => {
    try {
      const tabs = await browser.tabs.query({});
      for (const tab of tabs) {
        if (!tab.id) continue;
        try {
          const rsp = await browser.tabs.sendMessage(tab.id, {
            type: 'bg:gmgn:getTokenHoldings',
            chain,
            walletAddress,
          });
          if (rsp?.ok && Array.isArray(rsp?.holdings)) {
            return rsp.holdings;
          }
        } catch {
        }
      }
      return [];
    } catch {
      return [];
    }
  };

  const requestGmgnHoldingDetailFromContent = async (chain: string, walletAddress: string, tokenAddress: string): Promise<any | null> => {
    try {
      const tabs = await browser.tabs.query({});
      for (const tab of tabs) {
        if (!tab.id) continue;
        try {
          const rsp = await browser.tabs.sendMessage(tab.id, {
            type: 'bg:gmgn:getTokenHoldingDetail',
            chain,
            walletAddress,
            tokenAddress,
          });
          if (rsp?.ok && rsp?.detail) return rsp.detail;
        } catch {
        }
      }
      return null;
    } catch {
      return null;
    }
  };

  const tokenBriefCache = new Map<string, { atMs: number; tokenName?: string; tokenSymbol?: string; tokenLogo?: string; marketCapUsd?: number | null }>();
  const pendingNewPoolIdentityLookup = new Set<string>();
  const resolveTokenBrief = async (chainId: number | undefined, tokenAddress: string | undefined) => {
    const addr = String(tokenAddress || '').trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
      return { tokenName: undefined, tokenSymbol: undefined, tokenLogo: undefined, marketCapUsd: null as number | null };
    }
    const key = `${chainId ?? 56}:${addr.toLowerCase()}`;
    const now = Date.now();
    const cached = tokenBriefCache.get(key);
    if (cached && now - cached.atMs < 15_000) return cached;
    const out: { atMs: number; tokenName?: string; tokenSymbol?: string; tokenLogo?: string; marketCapUsd?: number | null } = {
      atMs: now,
      tokenName: undefined,
      tokenSymbol: undefined,
      tokenLogo: undefined,
      marketCapUsd: null,
    };
    const resolvedChainId = chainId ?? 56;
    try {
      const chain = chainNames[resolvedChainId] ?? String(resolvedChainId);
      const tokenInfo = await FourmemeAPI.getTokenInfo(chain, addr as `0x${string}`);
      const mcapRaw = Number((tokenInfo as any)?.tokenPrice?.marketCap ?? 0);
      out.marketCapUsd = Number.isFinite(mcapRaw) && mcapRaw > 0 ? mcapRaw : null;
      const symbol = String((tokenInfo as any)?.symbol || '').trim();
      const name = String((tokenInfo as any)?.name || '').trim();
      const logo = String((tokenInfo as any)?.logo || '').trim();
      out.tokenSymbol = symbol || undefined;
      out.tokenName = name || undefined;
      out.tokenLogo = logo || undefined;
    } catch {
    }
    if (!out.tokenSymbol || !out.tokenName) {
      try {
        const meta = await TokenService.getMeta(addr as `0x${string}`, resolvedChainId);
        const symbol = String(meta?.symbol || '').trim();
        out.tokenSymbol = out.tokenSymbol || symbol || undefined;
        out.tokenName = out.tokenName || symbol || undefined;
      } catch {
      }
    }
    tokenBriefCache.set(key, out);
    return out;
  };
  const maybeEnrichNewPoolMonitorItem = (detail: NewPoolMonitorUiDetail) => {
    const tokenData = detail?.tokenData;
    const tokenAddress = typeof tokenData?.tokenAddress === 'string' ? tokenData.tokenAddress.trim().toLowerCase() : '';
    if (!/^0x[a-f0-9]{40}$/i.test(tokenAddress)) return;
    const hasName = typeof tokenData?.tokenName === 'string' && tokenData.tokenName.trim()
      || typeof tokenData?.name === 'string' && tokenData.name.trim()
      || typeof tokenData?.nm === 'string' && tokenData.nm.trim()
      || typeof tokenData?.ts_n === 'string' && tokenData.ts_n.trim();
    const hasSymbol = typeof tokenData?.tokenSymbol === 'string' && tokenData.tokenSymbol.trim()
      || typeof tokenData?.symbol === 'string' && tokenData.symbol.trim()
      || typeof tokenData?.s === 'string' && tokenData.s.trim()
      || typeof tokenData?.ts_s === 'string' && tokenData.ts_s.trim();
    const hasLogo = typeof tokenData?.tokenLogo === 'string' && tokenData.tokenLogo.trim()
      || typeof tokenData?.logo === 'string' && tokenData.logo.trim()
      || typeof tokenData?.l === 'string' && tokenData.l.trim();
    const hasMarketCap = typeof tokenData?.marketCapUsd === 'number' || typeof tokenData?.mc === 'number';
    if ((hasName && hasSymbol && hasLogo && hasMarketCap) || pendingNewPoolIdentityLookup.has(tokenAddress)) return;
    pendingNewPoolIdentityLookup.add(tokenAddress);
    void (async () => {
      try {
        const chainRaw = typeof tokenData?.chain === 'string' ? tokenData.chain.trim().toLowerCase() : '';
        const chainId = chainRaw === 'bsc' || !chainRaw ? 56 : undefined;
        const brief = await resolveTokenBrief(chainId, tokenAddress);
        const current = newPoolMonitorStore.get(tokenAddress);
        if (!current) return;
        const nextTokenData = {
          ...(current.tokenData && typeof current.tokenData === 'object' ? current.tokenData : {}),
          tokenAddress,
          tokenName:
            (typeof current.tokenData?.tokenName === 'string' && current.tokenData.tokenName.trim() ? current.tokenData.tokenName : undefined) ??
            (typeof current.tokenData?.name === 'string' && current.tokenData.name.trim() ? current.tokenData.name : undefined) ??
            brief.tokenName,
          name:
            (typeof current.tokenData?.name === 'string' && current.tokenData.name.trim() ? current.tokenData.name : undefined) ??
            brief.tokenName,
          nm:
            (typeof current.tokenData?.nm === 'string' && current.tokenData.nm.trim() ? current.tokenData.nm : undefined) ??
            brief.tokenName,
          tokenSymbol:
            (typeof current.tokenData?.tokenSymbol === 'string' && current.tokenData.tokenSymbol.trim() ? current.tokenData.tokenSymbol : undefined) ??
            (typeof current.tokenData?.symbol === 'string' && current.tokenData.symbol.trim() ? current.tokenData.symbol : undefined) ??
            brief.tokenSymbol,
          symbol:
            (typeof current.tokenData?.symbol === 'string' && current.tokenData.symbol.trim() ? current.tokenData.symbol : undefined) ??
            brief.tokenSymbol,
          s:
            (typeof current.tokenData?.s === 'string' && current.tokenData.s.trim() ? current.tokenData.s : undefined) ??
            brief.tokenSymbol,
          tokenLogo:
            (typeof current.tokenData?.tokenLogo === 'string' && current.tokenData.tokenLogo.trim() ? current.tokenData.tokenLogo : undefined) ??
            (typeof current.tokenData?.l === 'string' && current.tokenData.l.trim() ? current.tokenData.l : undefined) ??
            brief.tokenLogo,
          logo:
            (typeof current.tokenData?.logo === 'string' && current.tokenData.logo.trim() ? current.tokenData.logo : undefined) ??
            brief.tokenLogo,
          l:
            (typeof current.tokenData?.l === 'string' && current.tokenData.l.trim() ? current.tokenData.l : undefined) ??
            brief.tokenLogo,
          marketCapUsd:
            typeof current.tokenData?.marketCapUsd === 'number' ? current.tokenData.marketCapUsd
              : typeof current.tokenData?.mc === 'number' ? current.tokenData.mc
                : brief.marketCapUsd ?? undefined,
          mc:
            typeof current.tokenData?.mc === 'number' ? current.tokenData.mc : brief.marketCapUsd ?? undefined,
        };
        const merged = mergeNewPoolMonitorDetail(current, {
          ...current,
          tokenData: nextTokenData,
          receivedAtMs: Date.now(),
        });
        newPoolMonitorStore.delete(tokenAddress);
        newPoolMonitorStore.set(tokenAddress, merged);
        const snapshot = buildGmgnTokenSnapshotFromDetail(merged);
        if (snapshot) upsertGmgnTokenSnapshots([snapshot]);
        pendingNewPoolMonitorBroadcast.set(tokenAddress, merged);
        scheduleNewPoolMonitorBroadcast();
      } catch {
      } finally {
        pendingNewPoolIdentityLookup.delete(tokenAddress);
      }
    })();
  };

  const broadcastTradeSuccess = async (payload: any, tabId?: number | null) => {
    if (typeof tabId === 'number' && tabId > 0) {
      browser.tabs.sendMessage(tabId, payload).catch(() => { });
      return;
    }
    try {
      const activeTabs = await browser.tabs.query({ active: true });
      for (const tab of activeTabs) {
        if (!tab.id) continue;
        browser.tabs.sendMessage(tab.id, payload).catch(() => { });
      }
    } catch {
      broadcastToTabs(payload);
    }
    try {
      if (payload?.type === 'bg:tradeSuccess' && payload?.source !== 'limitOrder') {
        const brief = await resolveTokenBrief(payload?.chainId, payload?.tokenAddress);
        await telegramNotifier.notifyTradeSuccess({
          source: payload?.source,
          side: payload?.side,
          chainId: payload?.chainId,
          tokenAddress: payload?.tokenAddress,
          tokenName: brief.tokenName,
          tokenSymbol: brief.tokenSymbol,
          amountNative: payload?.amountNative,
          sellPercent: payload?.sellPercent,
          strategyOrderCount: payload?.strategyOrderCount,
          marketCapUsd: brief.marketCapUsd,
          txHash: payload?.txHash,
          submitElapsedMs: payload?.submitElapsedMs,
          receiptElapsedMs: payload?.receiptElapsedMs,
        });
      }
    } catch {
    }
  };

  const telegramNotifier = createTelegramNotifier({
    getSettings: SettingsService.get,
  });
  const telegramController = createTelegramController({
    broadcastTradeSuccess: (payload) => broadcastTradeSuccess(payload),
    broadcastStateChange,
    notifier: telegramNotifier,
    fetchGmgnHoldings: requestGmgnHoldingsFromContent,
    fetchGmgnHoldingDetail: requestGmgnHoldingDetailFromContent,
  });
  let telegramControllerRunning = false;
  const syncTelegramController = async (settingsOverride?: any) => {
    try {
      const settings = settingsOverride ?? await SettingsService.get();
      const shouldRun = settings?.telegram?.enabled === true;
      if (shouldRun && !telegramControllerRunning) {
        telegramController.start();
        telegramControllerRunning = true;
        return;
      }
      if (!shouldRun && telegramControllerRunning) {
        telegramController.stop();
        telegramControllerRunning = false;
      }
    } catch {
    }
  };
  void syncTelegramController();

  let limitOrderScanner: ReturnType<typeof createLimitOrderScanner> | null = null;
  const limitOrderExecutor = createLimitOrderExecutor({
    onOrdersChanged: () => {
      broadcastStateChange();
      limitOrderScanner?.scheduleFromStorage().catch(() => { });
    },
    onOrderTxSubmitted: ({ order, txHash, submitElapsedMs }) => {
      broadcastTradeSuccess({
        type: 'bg:tradeSubmitted',
        source: 'limitOrder',
        id: order.id,
        side: order.side,
        chainId: order.chainId,
        tokenAddress: order.tokenAddress,
        txHash,
        submitElapsedMs,
      });
    },
    onOrderSubmitted: ({ order, txHash, submitElapsedMs, receiptElapsedMs, totalElapsedMs, broadcastVia, broadcastUrl, isBundle }) => {
      broadcastTradeSuccess({
        type: 'bg:tradeSuccess',
        source: 'limitOrder',
        id: order.id,
        side: order.side,
        chainId: order.chainId,
        tokenAddress: order.tokenAddress,
        txHash,
        submitElapsedMs,
        receiptElapsedMs,
        totalElapsedMs,
        broadcastVia,
        broadcastUrl,
        isBundle,
      });
      void (async () => {
        const brief = await resolveTokenBrief(order.chainId, order.tokenAddress);
        await telegramNotifier.notifyLimitOrderResult({
          stage: 'success',
          orderId: order.id,
          side: order.side,
          chainId: order.chainId,
          tokenAddress: order.tokenAddress,
          tokenName: brief.tokenName || order.tokenInfo?.name,
          tokenSymbol: brief.tokenSymbol || order.tokenSymbol || order.tokenInfo?.symbol,
          fromAddress: order.fromAddress,
          orderType: order.orderType,
          triggerPriceUsd: order.triggerPriceUsd,
          marketCapUsd: brief.marketCapUsd,
          txHash,
        });
      })();
    },
  });
  limitOrderScanner = createLimitOrderScanner({
    executeLimitOrder: limitOrderExecutor.executeLimitOrder,
    onStateChanged: broadcastStateChange,
    onOrderFailed: ({ order, error }) => {
      void (async () => {
        const brief = await resolveTokenBrief(order.chainId, order.tokenAddress);
        await telegramNotifier.notifyLimitOrderResult({
          stage: 'failed',
          orderId: order.id,
          side: order.side,
          chainId: order.chainId,
          tokenAddress: order.tokenAddress,
          tokenName: brief.tokenName || order.tokenInfo?.name,
          tokenSymbol: brief.tokenSymbol || order.tokenSymbol || order.tokenInfo?.symbol,
          fromAddress: order.fromAddress,
          orderType: order.orderType,
          triggerPriceUsd: order.triggerPriceUsd,
          marketCapUsd: brief.marketCapUsd,
          error,
        });
      })();
    },
  });
  limitOrderScanner.start();

  const AutoTrade = createXSniperTrade({
    onStateChanged: broadcastStateChange,
    telegramNotifier,
  });
  const TokenSniperTrade = createTokenSniperTrade({ onStateChanged: broadcastStateChange });
  const NewCoinSniperTrade = createNewCoinSniperTrade({ onStateChanged: broadcastStateChange });
  const buyInputByTxHash = new Map<`0x${string}`, { input: TxBuyInput; receiptRetried: boolean }>();

  browser.runtime.onInstalled.addListener(() => {
    console.log('Extension installed');
  });

  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const msg = message as BgRequest;

    // Return true to indicate async response
    const handle = async () => {
      try {
        if ((msg as { type: string }).type === 'limitOrder:clearExecuted') {
          const clearMsg = msg as Extract<BgRequest, { type: 'limitOrder:clearExecuted' }>;
          const orders = await clearExecutedLimitOrders(clearMsg.chainId, clearMsg.tokenAddress);
          broadcastStateChange();
          limitOrderScanner?.scheduleFromStorage().catch(() => { });
          return { ok: true, orders };
        }

        switch (msg.type) {
          case 'bg:ping':
            return { ok: true, time: Date.now() };

          case 'bg:openPopup':
            try {
              const api = (globalThis as any).chrome?.sidePanel;
              const tabId = typeof sender?.tab?.id === 'number' ? sender.tab.id : undefined;
              if (api?.open && tabId != null) {
                await api.open({ tabId });
                return { ok: true };
              }
              return { ok: true };
            } catch (e) {
              console.error('Failed to open side panel:', e);
              return { ok: false, error: 'Not supported' };
            }

          case 'bg:getState': {
            const status = await WalletService.getStatus();
            const settings = await SettingsService.get();
            const ttl = status.expiresAt ? Math.floor((status.expiresAt - Date.now()) / 1000) : null;
            return {
              wallet: {
                hasEncrypted: status.hasWallet,
                isUnlocked: !status.locked,
                address: status.address,
                accounts: status.accounts,
                unlockTtlSeconds: ttl && ttl > 0 ? ttl : null,
              },
              settings,
              network: { chainId: settings.chainId }
            };
          }

          case 'bloxroute:openCertPage': {
            await browser.tabs.create({ url: 'https://api.blxrbdn.com', active: true });
            return { ok: true };
          }

          case 'bloxroute:probe': {
            const authHeader = typeof msg.authHeader === 'string' ? msg.authHeader.replace(/[\r\n]+/g, '').trim() : '';
            const hasAuthHeader = !!authHeader;
            try {
              const response = await fetch('https://api.blxrbdn.com', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(hasAuthHeader ? { Authorization: authHeader } : {}),
                },
                body: '{}',
              });
              return { ok: true, status: 'reachable', httpStatus: response.status, hasAuthHeader };
            } catch (e: any) {
              return { ok: true, status: 'failed', message: String(e?.message || e || ''), hasAuthHeader };
            }
          }

          case 'settings:set':
            await SettingsService.update(msg.settings);
            await syncTelegramController();
            limitOrderScanner?.setIntervalMsFromValue((msg.settings as any).limitOrderScanIntervalMs);
            try {
              const chainId = Number((msg.settings as any)?.chainId);
              if (Number.isFinite(chainId) && chainId > 0) RpcReadBalancer.requestCapacityProbe(chainId);
            } catch {
            }
            broadcastStateChange();
            return { ok: true };

          case 'settings:setAccountAlias': {
            const current = await SettingsService.get();
            const nextAliases = { ...(current.accountAliases ?? {}) };
            const key = msg.address.toLowerCase();
            const alias = msg.alias.trim();
            if (alias) {
              nextAliases[key] = alias;
            } else {
              delete nextAliases[key];
            }
            await SettingsService.update({ accountAliases: nextAliases });
            broadcastStateChange();
            return { ok: true };
          }

          case 'wallet:create':
            const resCreate = await WalletService.create(msg.input.password);
            broadcastStateChange();
            return { ok: true, ...resCreate };

          case 'wallet:import':
            const resImport = await WalletService.import(msg.input.password, msg.input);
            broadcastStateChange();
            return { ok: true, ...resImport };

          case 'wallet:unlock':
            const resUnlock = await WalletService.unlock(msg.input.password);
            try {
              const settings = await SettingsService.get();
              RpcReadBalancer.requestCapacityProbe(settings.chainId);
            } catch {
            }
            broadcastStateChange();
            return { ok: true, ...resUnlock };

          case 'wallet:lock':
            await WalletService.lock();
            broadcastStateChange();
            return { ok: true };

          case 'wallet:wipe':
            await WalletService.wipe();
            broadcastStateChange();
            return { ok: true };

          case 'wallet:addAccount':
            const resAdd = await WalletService.addAccount(msg.name, msg.password, msg.privateKey);
            broadcastStateChange();
            return { ok: true, ...resAdd };

          case 'wallet:switchAccount':
            await WalletService.switchAccount(msg.address);
            broadcastStateChange();
            return { ok: true };

          case 'wallet:updatePassword':
            await WalletService.updatePassword(msg.oldPassword, msg.newPassword);
            broadcastStateChange();
            return { ok: true };

          case 'wallet:exportPrivateKey':
            return { ok: true, privateKey: await WalletService.exportPrivateKey(msg.password) };

          case 'wallet:exportAccountPrivateKey':
            return { ok: true, privateKey: await WalletService.exportAccountPrivateKey(msg.password, msg.address) };

          case 'wallet:exportMnemonic':
            return { ok: true, mnemonic: await WalletService.exportMnemonic(msg.password) };

          case 'wallet:getEip7702Status': {
            const client = await RpcService.getClient(msg.chainId);
            const code = await client.getCode({ address: msg.address });
            return { ok: true, ...parseEip7702Delegation(code) };
          }

          case 'wallet:revokeEip7702': {
            const chainId = msg.chainId;
            const client = await RpcService.getClient(chainId);
            const code = await client.getCode({ address: msg.address });
            const status = parseEip7702Delegation(code);
            if (!status.delegated) throw new Error('Address is not in EIP-7702 delegated state');

            const account = await WalletService.getSigner(msg.address);
            const txNonce = await client.getTransactionCount({ address: account.address, blockTag: 'pending' });
            const authNonce = txNonce + 1;
            const signedAuthorization = await account.signAuthorization({
              chainId,
              nonce: authNonce,
              address: ZERO_ADDRESS,
            });
            const estimated = await client.estimateFeesPerGas().catch(() => null);
            const maxPriorityFeePerGas =
              typeof estimated?.maxPriorityFeePerGas === 'bigint' && estimated.maxPriorityFeePerGas > 0n
                ? estimated.maxPriorityFeePerGas
                : parseEther('0.000000001');
            const maxFeePerGas =
              typeof estimated?.maxFeePerGas === 'bigint' && estimated.maxFeePerGas > 0n
                ? estimated.maxFeePerGas
                : (maxPriorityFeePerGas * 2n);
            const gas = 100_000n;
            const signedTx = await account.signTransaction({
              chain: getChainRuntime(chainId).viemChain,
              chainId,
              type: 'eip7702',
              to: account.address,
              value: 0n,
              data: '0x',
              nonce: txNonce,
              gas,
              maxFeePerGas,
              maxPriorityFeePerGas,
              authorizationList: [signedAuthorization],
            } as any);
            const sent = await RpcService.broadcastTxDetailed(signedTx, {
              signerContext: {
                account,
                chainId,
                nonce: txNonce,
                gas,
                gasPrice: maxFeePerGas,
              },
            });
            return {
              ok: true,
              txHash: sent.txHash,
              broadcastVia: sent.via,
              broadcastUrl: sent.rpcUrl,
              isBundle: sent.isBundle,
            };
          }

          case 'chain:getBalance':
            return { ok: true, balanceWei: await TokenService.getNativeBalance(msg.address, msg.chainId) };

          case 'token:getMeta':
            return { ok: true, ...(await TokenService.getMeta(msg.tokenAddress, msg.chainId)) };

          case 'token:getBalance':
            return { ok: true, balanceWei: await TokenService.getBalance(msg.tokenAddress, msg.address, msg.chainId) };

          case 'token:getAllowance':
            return {
              ok: true,
              allowanceWei: await TokenService.getAllowance(msg.tokenAddress, msg.owner, msg.spender, msg.chainId),
            };

          case 'token:getPoolPair': {
            const { token0, token1 } = await TokenService.getPoolPair(msg.pair, msg.chainId);
            return { ok: true, token0, token1 };
          }

          case 'token:getPriceUsd': {
            const priceUsd = await TokenService.getTokenPriceUsdFromRpc({
              chainId: msg.chainId,
              tokenAddress: msg.tokenAddress,
              tokenInfo: msg.tokenInfo ?? null,
              cacheTtlMs: 5000,
            });
            return { ok: true, priceUsd };
          }

          case 'token:getTokenInfo:fourmeme':
            return { ok: true, ...(await TokenFourmemeService.getTokenInfo(msg.chainId, msg.tokenAddress)) };

          case 'token:getTokenInfo:flap':
            return { ok: true, ...(await TokenFlapService.getTokenInfo(msg.chainId, msg.tokenAddress)) };

          case 'token:getTokenInfo:altfun':
            return { ok: true, tokenInfo: await TokenAltfunService.getTokenInfo(msg.chainId, msg.tokenAddress) };

          case 'token:getTokenInfo:fourmemeHttp': {
            const tokenInfo = await FourmemeAPI.getTokenInfo(msg.chain, msg.address);
            return { ok: true, tokenInfo };
          }

          case 'token:createFourmeme': {
            const settings = await SettingsService.get();
            const fromAddress = (msg.input.fromAddress && isAddress(msg.input.fromAddress))
              ? (msg.input.fromAddress as `0x${string}`)
              : undefined;
            const account = await WalletService.getSigner(fromAddress);
            const address = account.address;
            const networkCode = 'BSC';

            const nonce = await FourmemeAPI.generateNonce(address, networkCode);
            const message = `You are sign in Meme ${nonce}`;
            const signature = await account.signMessage({ message });

            const accessToken = await FourmemeAPI.loginDex({
              address,
              signature,
              networkCode,
              walletName: 'Dagobang',
            });

            const imageCandidates = [
              msg.input.imgUrl,
              ...(Array.isArray(msg.input.imgFallbackUrls) ? msg.input.imgFallbackUrls : []),
            ]
              .map((x) => String(x || '').trim())
              .filter(Boolean);
            const uploadedImgUrl = await FourmemeAPI.uploadImageFromUrl(imageCandidates, accessToken);

            const createData = await FourmemeAPI.createToken(
              {
                ...msg.input,
                imgUrl: uploadedImgUrl,
              },
              accessToken
            );

            const createArg = createData?.createArg;
            const sign = createData?.signature || createData?.sign;
            if (!createData || !createArg || !sign) {
              return { ok: true, data: { api: createData } };
            }

            const fixedCreateFeeWei = parseEther('0.01');
            let preSaleWei = 0n;
            try {
              preSaleWei = parseEther(String(msg.input.preSale || '0').trim() || '0');
            } catch {
              throw new Error('Invalid preSale amount');
            }
            const createValueWei = fixedCreateFeeWei + preSaleWei;

            const onChainResult = await TokenFourmemeService.createTokenOnChain(
              settings.chainId,
              createArg,
              sign,
              fromAddress,
              createValueWei
            );

            const autoBuySummary = {
              bundleSuccess: 0,
              bundleFailed: 0,
              sniperSuccess: 0,
              sniperFailed: 0,
            };
            const autoBuyWallets = Array.isArray(msg.input.autoBuy?.wallets)
              ? msg.input.autoBuy!.wallets
                .map((item) => ({
                  address: isAddress(item?.address) ? item.address as `0x${string}` : null,
                  amountBnb: String(item?.amountBnb || '').trim(),
                }))
                .filter((item) => !!item.address && !!item.amountBnb) as Array<{ address: `0x${string}`; amountBnb: string }>
              : [];

            if (onChainResult.tokenAddress && autoBuyWallets.length > 0) {
              const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
              const buyOnce = async (wallet: { address: `0x${string}`; amountBnb: string }) => {
                const amountWei = parseEther(wallet.amountBnb).toString();
                const rsp = await TradeService.buyWithReceiptAndNonceRecovery(
                  {
                    chainId: settings.chainId,
                    tokenAddress: onChainResult.tokenAddress!,
                    nativeAmountWei: amountWei,
                    fromAddress: wallet.address,
                  },
                  {
                    maxRetry: 1,
                    timeoutMs: 8_000,
                  },
                );
                return !!rsp?.txHash;
              };

              if (msg.input.autoBuy?.bundleEnabled) {
                const bundleResults = await Promise.allSettled(autoBuyWallets.map((wallet) => buyOnce(wallet)));
                for (const item of bundleResults) {
                  if (item.status === 'fulfilled' && item.value) autoBuySummary.bundleSuccess += 1;
                  else autoBuySummary.bundleFailed += 1;
                }
              }

              if (msg.input.autoBuy?.sniperEnabled) {
                const maxAttemptsRaw = Number(msg.input.autoBuy?.sniperMaxAttempts ?? 20);
                const retryMsRaw = Number(msg.input.autoBuy?.sniperRetryMs ?? 1200);
                const maxAttempts = Math.max(1, Math.min(80, Number.isFinite(maxAttemptsRaw) ? Math.floor(maxAttemptsRaw) : 20));
                const retryMs = Math.max(300, Math.min(5000, Number.isFinite(retryMsRaw) ? Math.floor(retryMsRaw) : 1200));
                const sniperResults = await Promise.allSettled(
                  autoBuyWallets.map(async (wallet) => {
                    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
                      try {
                        const ok = await buyOnce(wallet);
                        if (ok) return true;
                      } catch {
                      }
                      if (attempt < maxAttempts) await sleep(retryMs);
                    }
                    return false;
                  }),
                );
                for (const item of sniperResults) {
                  if (item.status === 'fulfilled' && item.value) autoBuySummary.sniperSuccess += 1;
                  else autoBuySummary.sniperFailed += 1;
                }
              }
            }

            return {
              ok: true,
              data: {
                api: createData,
                txHash: onChainResult.txHash,
                tokenAddress: onChainResult.tokenAddress,
              },
              autoBuy: autoBuySummary,
            };
          }

          case 'ai:generateLogo': {
            const endpoint = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';
            const res = await fetch(endpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${msg.apiKey}`,
              },
              body: JSON.stringify({
                model: 'doubao-seedream-4-5-251128',
                prompt: msg.prompt,
                size: msg.size || '2K',
                watermark: false,
                response_format: 'url',
              }),
            });
            if (!res.ok) {
              const text = await res.text().catch(() => '');
              throw new Error(text || `Seedream4.5 request failed: ${res.status}`);
            }
            const data: any = await res.json();
            let imageUrl = '';
            if (Array.isArray(data.data) && data.data.length > 0) {
              const item = data.data[0];
              imageUrl = item.url || item.url || '';
            } else if (typeof data.url === 'string') {
              imageUrl = data.url;
            }
            if (!imageUrl) {
              throw new Error('Seedream4.5 response missing image url');
            }
            return { ok: true, imageUrl };
          }

          case 'google:imageSearch': {
            const query = String(msg.query || '').trim();
            if (!query) return { ok: true, images: [] };
            const page = Math.max(0, Number(msg.page || 0) || 0);
            const start = page * 20;
            const endpoint = `https://www.google.com/search?tbm=isch&hl=zh-CN&safe=off&q=${encodeURIComponent(query)}&start=${start}`;
            const res = await fetch(endpoint, {
              method: 'GET',
              headers: {
                'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
              },
            });
            if (!res.ok) {
              throw new Error(`Google image search failed: ${res.status}`);
            }
            const html = await res.text();
            const decodeEscaped = (value: string) => value
              .replace(/\\u003d/g, '=')
              .replace(/\\u0026/g, '&')
              .replace(/\\u002F/g, '/')
              .replace(/\\\//g, '/')
              .replace(/\\u([\dA-Fa-f]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
            const images: Array<{ url: string; thumbnail?: string; title?: string; source?: string }> = [];
            const seen = new Set<string>();

            const richRegex = /"ou":"([^"]+)".*?"tu":"([^"]*)".*?"pt":"([^"]*)"/g;
            let richMatch: RegExpExecArray | null;
            while ((richMatch = richRegex.exec(html)) !== null) {
              const url = decodeEscaped(richMatch[1] || '').trim();
              const thumbnail = decodeEscaped(richMatch[2] || '').trim();
              const title = decodeEscaped(richMatch[3] || '').trim();
              if (!url || seen.has(url)) continue;
              seen.add(url);
              images.push({ url, thumbnail: thumbnail || undefined, title: title || undefined, source: 'google' });
              if (images.length >= 36) break;
            }

            if (images.length < 10) {
              const fallbackRegex = /https?:\/\/[^"'\s<>]+?\.(?:png|jpg|jpeg|webp|gif)/gi;
              let fallbackMatch: RegExpExecArray | null;
              while ((fallbackMatch = fallbackRegex.exec(html)) !== null) {
                const url = decodeEscaped(fallbackMatch[0] || '').trim();
                if (!url || seen.has(url)) continue;
                seen.add(url);
                images.push({ url, source: 'google' });
                if (images.length >= 36) break;
              }
            }

            return { ok: true, images };
          }

          case 'limitOrder:list': {
            const orders = await listLimitOrders(msg.chainId, msg.tokenAddress);
            return { ok: true, orders };
          }

          case 'limitOrder:create': {
            const order = await createLimitOrder(msg.input);
            broadcastStateChange();
            limitOrderScanner?.scheduleFromStorage().catch(() => { });
            return { ok: true, order };
          }

          case 'limitOrder:cancel': {
            const orders = await cancelLimitOrder(msg.id);
            broadcastStateChange();
            limitOrderScanner?.scheduleFromStorage().catch(() => { });
            return { ok: true, orders };
          }

          case 'limitOrder:cancelAll': {
            const orders = await cancelAllLimitOrders(msg.chainId, msg.tokenAddress);
            broadcastStateChange();
            limitOrderScanner?.scheduleFromStorage().catch(() => { });
            return { ok: true, orders };
          }

          case 'limitOrder:scanStatus': {
            const status = await (limitOrderScanner?.getStatus(msg.chainId) ?? Promise.resolve({
              intervalMs: 3000,
              running: false,
              lastScanAtMs: 0,
              lastScanOk: true,
              lastScanError: null,
              totalOrders: 0,
              openOrders: 0,
              pricesByTokenKey: {},
            } as LimitOrderScanStatus));
            return { ok: true, ...status };
          }

          case 'limitOrder:tick': {
            const res = await tickLimitOrdersForToken({
              chainId: msg.chainId,
              tokenAddress: msg.tokenAddress,
              priceUsd: msg.priceUsd,
              executeLimitOrder: limitOrderExecutor.executeLimitOrder,
            });
            if (res.triggered.length || res.executed.length || res.failed.length) {
              broadcastStateChange();
            }
            return { ok: true, ...res };
          }

          case 'trade:prewarmTurbo': {
            try {
              await TradeService.prewarmTurbo(msg.input);
            } catch { }
            return { ok: true };
          }

          case 'trade:refreshNonce': {
            try {
              await TradeService.refreshNonce(msg.input);
            } catch { }
            return { ok: true };
          }

          case 'rpc:prewarm': {
            try {
              await RpcService.prewarm(msg.input);
            } catch { }
            return { ok: true };
          }

          case 'rpc:readProfiles': {
            const res = await RpcService.getReadBalancerProfiles({
              chainId: msg.chainId,
              urls: msg.urls,
              scope: 'both',
            });
            return { ok: true, ...res };
          }

          case 'rpc:capacityProbe': {
            const rsp = await RpcService.requestReadCapacityProbe({
              chainId: msg.chainId,
              mode: msg.mode ?? 'request',
              scope: 'both',
            });
            return { ok: true, ...rsp };
          }

          case 'rpc:resetProfiles': {
            await RpcService.resetReadBalancerProfiles({
              chainId: msg.chainId,
              urls: msg.urls,
            });
            return { ok: true };
          }

          case 'tx:transferNative': {
            const settings = await SettingsService.get();
            const chainId = msg.chainId;
            const chainSettings = settings.chains[chainId];

            if (!isAddress(msg.fromAddress)) throw new Error('Invalid from address');
            if (!isAddress(msg.toAddress)) throw new Error('Invalid to address');

            const pk = await WalletService.exportAccountPrivateKey(msg.password, msg.fromAddress);
            const account = privateKeyToAccount(pk);
            if (account.address.toLowerCase() !== msg.fromAddress.toLowerCase()) {
              throw new Error('Invalid from address');
            }

            const client = await RpcService.getClient(chainId);
            const gasPreset = chainSettings.sellGasPreset ?? chainSettings.gasPreset;
            const gasPriceWei = getGasPriceWei(chainSettings, gasPreset, 'sell');
            const gasLimit = 21000n;
            const reserve = gasLimit * gasPriceWei;

            const balanceWei = BigInt(await TokenService.getNativeBalance(msg.fromAddress, chainId));
            const useMax = !!msg.useMax;
            const valueWei = (() => {
              if (useMax) {
                return balanceWei > reserve ? (balanceWei - reserve) : 0n;
              }
              const raw = typeof msg.amountBnb === 'string' ? msg.amountBnb.trim() : '';
              if (!raw) return 0n;
              try {
                return parseEther(raw);
              } catch {
                return 0n;
              }
            })();

            if (valueWei <= 0n) throw new Error('Invalid amount');
            if (valueWei + reserve > balanceWei) throw new Error('Insufficient balance');

            const { txHash, broadcastVia, broadcastUrl } = await sendTransaction(
              client,
              account,
              msg.toAddress,
              '0x',
              valueWei,
              gasPriceWei,
              chainId,
              { skipEstimateGas: true, gasLimit }
            );
            broadcastStateChange();
            return { ok: true, txHash, broadcastVia, broadcastUrl };
          }

          case 'tx:buy': {
            RpcReadBalancer.noteTradeActivity();
            const input = {
              ...msg.input,
              submitChannel: await resolveTradeSubmitChannel(msg.input.chainId, msg.input.submitChannel),
            } as TxBuyInput;
            const isNonceLikeError = (err: any) => {
              const msg = collectErrorText(err, true);
              return classifyBroadcastError(msg) === 'nonce' || msg.includes('nonce');
            };
            const returnBuySuccess = async (rsp: any) => {
              const txHash = (rsp as any)?.txHash as `0x${string}` | undefined;
              if (txHash) {
                buyInputByTxHash.set(txHash, { input: msg.input, receiptRetried: false });
              }
              await broadcastTradeSuccess(
                {
                  type: 'bg:tradeSuccess',
                  source: 'tx:buy',
                  side: 'buy',
                  chainId: msg.input.chainId,
                  tokenAddress: msg.input.tokenAddress,
                  txHash: (rsp as any)?.txHash,
                  submitElapsedMs: (rsp as any)?.submitElapsedMs,
                  receiptElapsedMs: (rsp as any)?.receiptElapsedMs,
                  totalElapsedMs: (rsp as any)?.totalElapsedMs,
                  broadcastVia: (rsp as any)?.broadcastVia,
                  broadcastUrl: (rsp as any)?.broadcastUrl,
                  isBundle: (rsp as any)?.isBundle,
                },
                sender?.tab?.id ?? null,
              );
              await broadcastStateChange();
              return { ok: true, ...rsp };
            };
            try {
              const rsp = await TradeService.buy(input);
              return await returnBuySuccess(rsp);
            } catch (e: any) {
              let lastErr: any = e;
              console.warn('[nonce.repair][buy.submit.failed]', {
                chainId: msg.input.chainId,
                token: msg.input.tokenAddress,
                error: String(e?.shortMessage || e?.message || e || ''),
                nonceLike: isNonceLikeError(e),
              });
              if (isNonceLikeError(e)) {
                try {
                  const refreshedNonce = await TradeService.refreshNonce({
                    chainId: msg.input.chainId,
                    fromAddress: msg.input.fromAddress,
                    txSide: 'buy',
                    submitChannel: input.submitChannel,
                    error: e,
                  });
                  console.info('[nonce.repair][buy.submit.retry]', {
                    chainId: msg.input.chainId,
                    token: msg.input.tokenAddress,
                    refreshedNonce,
                  });
                  const rsp = await TradeService.buy(input, { forceRefreshHyperState: true });
                  console.info('[nonce.repair][buy.submit.retry.success]', {
                    chainId: msg.input.chainId,
                    token: msg.input.tokenAddress,
                    txHash: (rsp as any)?.txHash,
                  });
                  return await returnBuySuccess(rsp);
                } catch (ex: any) {
                  lastErr = ex;
                  console.warn('[nonce.repair][buy.submit.retry.failed]', {
                    chainId: msg.input.chainId,
                    token: msg.input.tokenAddress,
                    error: String(ex?.shortMessage || ex?.message || ex || ''),
                  });
                }
              }
              const reason = extractRevertReasonFromError(lastErr);
              if (!reason || reason.toLowerCase().includes('zero_input')) {
                debugLogTxError('tx:buy failed', lastErr, { input: msg.input as any });
              }
              return { ok: false, revertReason: reason ?? undefined, error: serializeTxError(lastErr) };
            }
          }

          case 'tx:buyWithReceiptAuto': {
            RpcReadBalancer.noteTradeActivity();
            const input = {
              ...msg.input,
              submitChannel: await resolveTradeSubmitChannel(msg.input.chainId, msg.input.submitChannel),
            } as TxBuyInput;
            const startedAt = Date.now();
            let submittedTxHash: `0x${string}` | null = null;
            let submittedElapsedMs: number | undefined;
            console.log('[bg.buy.auto.request]', {
              chainId: msg.input.chainId,
              token: msg.input.tokenAddress,
              fromAddress: msg.input.fromAddress,
              amountInWei: msg.input.nativeAmountWei || msg.input.bnbAmountWei,
              baseTokenAddress: msg.input.baseTokenAddress ?? ZERO_ADDRESS,
            });
            const returnBuySuccess = async (rsp: any) => {
              const txHash = (rsp as any)?.txHash as `0x${string}` | undefined;
              if (txHash) {
                buyInputByTxHash.set(txHash, { input, receiptRetried: false });
              }
              await broadcastTradeSuccess(
                {
                  type: 'bg:tradeSuccess',
                  source: 'tx:buy',
                  side: 'buy',
                  chainId: msg.input.chainId,
                  tokenAddress: msg.input.tokenAddress,
                  txHash: (rsp as any)?.txHash,
                  submitElapsedMs: (rsp as any)?.submitElapsedMs,
                  receiptElapsedMs: (rsp as any)?.receiptElapsedMs,
                  totalElapsedMs: (rsp as any)?.totalElapsedMs,
                  broadcastVia: (rsp as any)?.broadcastVia,
                  broadcastUrl: (rsp as any)?.broadcastUrl,
                  isBundle: (rsp as any)?.isBundle,
                },
                sender?.tab?.id ?? null,
              );
              await broadcastStateChange();
              return {
                ok: true,
                ...rsp,
                totalElapsedMs: typeof rsp?.totalElapsedMs === 'number' ? rsp.totalElapsedMs : (Date.now() - startedAt),
              };
            };
            try {
              const rsp = await TradeService.buyWithReceiptAndNonceRecovery(input, {
                maxRetry: 1,
                timeoutMs: 5_000,
                onSubmitted: async (ctx) => {
                  submittedTxHash = ctx.txHash;
                  submittedElapsedMs = ctx.submitElapsedMs;
                  await broadcastTradeSuccess(
                    {
                      type: 'bg:tradeSubmitted',
                      side: 'buy',
                      chainId: msg.input.chainId,
                      tokenAddress: msg.input.tokenAddress,
                      txHash: ctx.txHash,
                      submitElapsedMs: ctx.submitElapsedMs,
                    },
                    sender?.tab?.id ?? null,
                  );
                },
                onRetry: async (ctx) => {
                  await broadcastTradeSuccess(
                    {
                      type: 'bg:tradeRetrying',
                      side: 'buy',
                      chainId: msg.input.chainId,
                      tokenAddress: msg.input.tokenAddress,
                      attempt: ctx.attempt,
                      reason: ctx.reason,
                    },
                    sender?.tab?.id ?? null,
                  );
                },
              });
              return await returnBuySuccess(rsp);
            } catch (e: any) {
              console.error('[bg.buy.auto.failed.detail]', {
                chainId: msg.input.chainId,
                token: msg.input.tokenAddress,
                fromAddress: msg.input.fromAddress,
                amountInWei: msg.input.nativeAmountWei || msg.input.bnbAmountWei,
                baseTokenAddress: msg.input.baseTokenAddress ?? ZERO_ADDRESS,
                elapsedMs: Date.now() - startedAt,
                shortMessage: e?.shortMessage,
                message: e?.message,
                details: e?.details,
                metaMessages: Array.isArray(e?.metaMessages) ? e.metaMessages : undefined,
              });
              console.warn('[trade.buy.auto.failed]', {
                chainId: msg.input.chainId,
                token: msg.input.tokenAddress,
                error: String(e?.shortMessage || e?.message || e || ''),
              });
              const reason = extractRevertReasonFromError(e);
              if (!reason || reason.toLowerCase().includes('zero_input')) {
                debugLogTxError('tx:buyWithReceiptAuto failed', e, { input: msg.input as any });
              }
              await broadcastTradeSuccess(
                {
                  type: 'bg:tradeFailed',
                  source: 'tx:buy',
                  side: 'buy',
                  chainId: msg.input.chainId,
                  tokenAddress: msg.input.tokenAddress,
                  txHash: submittedTxHash ?? undefined,
                  submitElapsedMs: submittedElapsedMs,
                  stage: submittedTxHash ? 'receipt' : 'submit',
                  errorMessage: String(reason || e?.shortMessage || e?.message || 'Transaction failed'),
                },
                sender?.tab?.id ?? null,
              );
              return { ok: false, revertReason: reason ?? undefined, error: serializeTxError(e) };
            }
          }

          case 'tx:sell': {
            RpcReadBalancer.noteTradeActivity();
            const input = {
              ...msg.input,
              submitChannel: await resolveTradeSubmitChannel(msg.input.chainId, msg.input.submitChannel),
            } as TxSellInput;
            const isNonceLikeError = (err: any) => {
              const msg = collectErrorText(err, true);
              return classifyBroadcastError(msg) === 'nonce' || msg.includes('nonce');
            };
            try {
              const rsp = await TradeService.sell(input);
              broadcastTradeSuccess(
                {
                  type: 'bg:tradeSuccess',
                  source: 'tx:sell',
                  side: 'sell',
                  chainId: msg.input.chainId,
                  tokenAddress: msg.input.tokenAddress,
                  txHash: (rsp as any)?.txHash,
                  submitElapsedMs: (rsp as any)?.submitElapsedMs,
                  receiptElapsedMs: (rsp as any)?.receiptElapsedMs,
                  totalElapsedMs: (rsp as any)?.totalElapsedMs,
                  broadcastVia: (rsp as any)?.broadcastVia,
                  broadcastUrl: (rsp as any)?.broadcastUrl,
                  isBundle: (rsp as any)?.isBundle,
                },
                sender?.tab?.id ?? null,
              );
              broadcastStateChange();
              return { ok: true, ...rsp };
            } catch (e: any) {
              let lastErr: any = e;
              console.warn('[nonce.repair][sell.submit.failed]', {
                chainId: msg.input.chainId,
                token: msg.input.tokenAddress,
                error: String(e?.shortMessage || e?.message || e || ''),
                nonceLike: isNonceLikeError(e),
              });
              if (isNonceLikeError(e)) {
                try {
                  const refreshedNonce = await TradeService.refreshNonce({
                    chainId: msg.input.chainId,
                    fromAddress: msg.input.fromAddress,
                    txSide: 'sell',
                    submitChannel: input.submitChannel,
                    error: e,
                  });
                  console.info('[nonce.repair][sell.submit.retry]', {
                    chainId: msg.input.chainId,
                    token: msg.input.tokenAddress,
                    refreshedNonce,
                  });
                  const rsp = await TradeService.sell(input, { forceRefreshHyperState: true });
                  console.info('[nonce.repair][sell.submit.retry.success]', {
                    chainId: msg.input.chainId,
                    token: msg.input.tokenAddress,
                    txHash: (rsp as any)?.txHash,
                  });
                  broadcastTradeSuccess(
                    {
                      type: 'bg:tradeSuccess',
                      source: 'tx:sell',
                      side: 'sell',
                      chainId: msg.input.chainId,
                      tokenAddress: msg.input.tokenAddress,
                      txHash: (rsp as any)?.txHash,
                      submitElapsedMs: (rsp as any)?.submitElapsedMs,
                      receiptElapsedMs: (rsp as any)?.receiptElapsedMs,
                      totalElapsedMs: (rsp as any)?.totalElapsedMs,
                      broadcastVia: (rsp as any)?.broadcastVia,
                      broadcastUrl: (rsp as any)?.broadcastUrl,
                      isBundle: (rsp as any)?.isBundle,
                    },
                    sender?.tab?.id ?? null,
                  );
                  broadcastStateChange();
                  return { ok: true, ...rsp };
                } catch (ex: any) {
                  lastErr = ex;
                  console.warn('[nonce.repair][sell.submit.retry.failed]', {
                    chainId: msg.input.chainId,
                    token: msg.input.tokenAddress,
                    error: String(ex?.shortMessage || ex?.message || ex || ''),
                  });
                }
              }
              const reason = extractRevertReasonFromError(lastErr);
              if (!reason || reason.toLowerCase().includes('zero_input')) {
                debugLogTxError('tx:sell failed', lastErr, { input: msg.input as any });
              }
              return { ok: false, revertReason: reason ?? undefined, error: serializeTxError(lastErr) };
            }
          }

          case 'tx:sellWithReceiptAuto': {
            RpcReadBalancer.noteTradeActivity();
            const input = {
              ...msg.input,
              submitChannel: await resolveTradeSubmitChannel(msg.input.chainId, msg.input.submitChannel),
            } as TxSellInput;
            const flowId = `bg-sell-auto:${msg.input.chainId}:${msg.input.tokenAddress.toLowerCase()}:${Date.now().toString(36)}`;
            const start = Date.now();
            let submittedTxHash: `0x${string}` | null = null;
            let submittedElapsedMs: number | undefined;
            console.log('[bg.sell.auto][start]', { flowId, chainId: msg.input.chainId, token: msg.input.tokenAddress });
            try {
              const rsp = await TradeService.sellWithReceiptAndAutoRecovery(input, {
                maxRetry: 1,
                timeoutMs: 8_000,
                onSubmitted: async (ctx) => {
                  submittedTxHash = ctx.txHash;
                  submittedElapsedMs = ctx.submitElapsedMs;
                  await broadcastTradeSuccess(
                    {
                      type: 'bg:tradeSubmitted',
                      side: 'sell',
                      chainId: msg.input.chainId,
                      tokenAddress: msg.input.tokenAddress,
                      txHash: ctx.txHash,
                      submitElapsedMs: ctx.submitElapsedMs,
                    },
                    sender?.tab?.id ?? null,
                  );
                },
                onRetry: async (ctx) => {
                  const reason = ctx.allowanceRepaired ? 'allowance' : (ctx.nonceLike ? 'nonce' : 'other');
                  console.log('[bg.sell.auto][retry]', {
                    flowId,
                    attempt: ctx.attempt,
                    reason,
                    elapsedMs: Date.now() - start,
                  });
                  await broadcastTradeSuccess(
                    {
                      type: 'bg:tradeRetrying',
                      side: 'sell',
                      chainId: msg.input.chainId,
                      tokenAddress: msg.input.tokenAddress,
                      attempt: ctx.attempt,
                      reason,
                    },
                    sender?.tab?.id ?? null,
                  );
                },
              });
              console.log('[bg.sell.auto][success]', {
                flowId,
                txHash: (rsp as any)?.txHash,
                elapsedMs: Date.now() - start,
              });
              broadcastTradeSuccess(
                {
                  type: 'bg:tradeSuccess',
                  source: 'tx:sell',
                  side: 'sell',
                  chainId: msg.input.chainId,
                  tokenAddress: msg.input.tokenAddress,
                  txHash: (rsp as any)?.txHash,
                  submitElapsedMs: (rsp as any)?.submitElapsedMs,
                  receiptElapsedMs: (rsp as any)?.receiptElapsedMs,
                  totalElapsedMs: (rsp as any)?.totalElapsedMs,
                  broadcastVia: (rsp as any)?.broadcastVia,
                  broadcastUrl: (rsp as any)?.broadcastUrl,
                  isBundle: (rsp as any)?.isBundle,
                },
                sender?.tab?.id ?? null,
              );
              broadcastStateChange();
              return {
                ok: true,
                ...rsp,
                totalElapsedMs: typeof rsp?.totalElapsedMs === 'number' ? rsp.totalElapsedMs : (Date.now() - start),
              };
            } catch (e: any) {
              console.warn('[trade.sell.auto.failed]', {
                flowId,
                chainId: msg.input.chainId,
                token: msg.input.tokenAddress,
                elapsedMs: Date.now() - start,
                error: String(e?.shortMessage || e?.message || e || ''),
              });
              const reason = extractRevertReasonFromError(e);
              if (!reason || reason.toLowerCase().includes('zero_input')) {
                debugLogTxError('tx:sellWithReceiptAuto failed', e, { input: msg.input as any });
              }
              await broadcastTradeSuccess(
                {
                  type: 'bg:tradeFailed',
                  source: 'tx:sell',
                  side: 'sell',
                  chainId: msg.input.chainId,
                  tokenAddress: msg.input.tokenAddress,
                  txHash: submittedTxHash ?? undefined,
                  submitElapsedMs: submittedElapsedMs,
                  stage: submittedTxHash ? 'receipt' : 'submit',
                  errorMessage: String(reason || e?.shortMessage || e?.message || 'Transaction failed'),
                },
                sender?.tab?.id ?? null,
              );
              return { ok: false, revertReason: reason ?? undefined, error: serializeTxError(e) };
            }
          }

          case 'tx:approve': {
            const submitChannel = await resolveTradeSubmitChannel(msg.chainId, msg.submitChannel);
            const txHash = await TradeService.approve(msg.chainId, msg.tokenAddress, msg.spender, msg.amountWei, msg.fromAddress, submitChannel);
            broadcastStateChange();
            return { ok: true, txHash };
          }

          case 'tx:wrapNative': {
            const sent = await TradeService.wrapNative(msg.chainId, msg.amountWei, msg.fromAddress);
            broadcastStateChange();
            return { ok: true, ...sent };
          }

          case 'tx:unwrapWrapped': {
            const sent = await TradeService.unwrapWrapped(msg.chainId, msg.amountWei, msg.fromAddress);
            broadcastStateChange();
            return { ok: true, ...sent };
          }

          case 'tx:approveMaxForSellIfNeeded': {
            const submitChannel = await resolveTradeSubmitChannel(msg.chainId, msg.submitChannel);
            const txHash = await TradeService.approveMaxForSellIfNeeded(msg.chainId, msg.tokenAddress, msg.tokenInfo, {
              fromAddress: msg.fromAddress,
              submitChannel,
            });
            broadcastStateChange();
            return txHash ? { ok: true, txHash } : { ok: true };
          }

          case 'tx:checkSellAllowanceInsufficient': {
            const check = await TradeService.checkSellAllowanceInsufficient(msg.chainId, msg.tokenAddress, msg.tokenInfo, {
              fromAddress: msg.fromAddress,
            });
            return { ok: true, insufficient: check.insufficient, checked: check.checked };
          }

          case 'tx:bloxroutePrivate': {
            try {
              const txHash = await BloxRouterAPI.sendBscPrivateTx(msg.signedTx);
              return { ok: true, txHash: txHash ?? undefined };
            } catch {
              return { ok: true };
            }
          }

          case 'telegram:test': {
            await syncTelegramController();
            return await telegramController.test();
          }

          case 'telegram:getStatus': {
            await syncTelegramController();
            return { ok: true, ...(await telegramController.getStatus()) };
          }

          case 'telegram:quickBuy': {
            await syncTelegramController();
            return await telegramController.runQuickBuy(msg.tokenAddress, msg.amountBnb);
          }

          case 'telegram:quickSell': {
            await syncTelegramController();
            return await telegramController.runQuickSell(msg.tokenAddress, msg.sellPercent);
          }

          case 'xsniper:manualPositionClosed': {
            const updated = (AutoTrade as any).markPositionClosedManually?.(msg.input) === true;
            if (updated) broadcastStateChange();
            return { ok: true, updated };
          }
          case 'xsniper:manualPositionSold': {
            const updated = (AutoTrade as any).markPositionSoldManually?.(msg.input) === true;
            if (updated) broadcastStateChange();
            return { ok: true, updated };
          }
          case 'xsniper:clearRuntimeState': {
            (AutoTrade as any).clearRuntimeState?.();
            broadcastStateChange();
            return { ok: true };
          }

          case 'newCoinSniper:manualPositionClosed': {
            const updated = (NewCoinSniperTrade as any).markPositionClosedManually?.(msg.input) === true;
            if (updated) broadcastStateChange();
            return { ok: true, updated };
          }
          case 'newCoinSniper:manualPositionSold': {
            const updated = (NewCoinSniperTrade as any).markPositionSoldManually?.(msg.input) === true;
            if (updated) broadcastStateChange();
            return { ok: true, updated };
          }
          case 'newCoinSniper:clearRuntimeState': {
            (NewCoinSniperTrade as any).clearRuntimeState?.();
            broadcastStateChange();
            return { ok: true };
          }

          case 'tx:waitForReceipt': {
            try {
              const receipt = await RpcService.waitForTransactionReceiptAny(msg.hash, { chainId: msg.chainId, timeoutMs: 20_000 });
              const ok = receipt.status === 'success';
              let finalTxHash = receipt.transactionHash;
              let finalStatus = receipt.status;
              let finalBlockNumber = Number(receipt.blockNumber);
              const client = await RpcService.getClient(msg.chainId);
              let revertReason = !ok ? await tryGetReceiptRevertReason(client, msg.hash, receipt.blockNumber) : null;

              if (!ok) {
                const tracked = buyInputByTxHash.get(msg.hash);
                const reasonText = String(revertReason || '');
                const isNonceLike = classifyBroadcastError(reasonText.toLowerCase()) === 'nonce' || reasonText.toLowerCase().includes('nonce');
                console.warn('[nonce.repair][buy.receipt.failed]', {
                  chainId: msg.chainId,
                  txHash: msg.hash,
                  tracked: !!tracked,
                  receiptRetried: tracked?.receiptRetried ?? false,
                  isNonceLike,
                  revertReason: reasonText,
                });
                if (tracked && !tracked.receiptRetried && isNonceLike) {
                  tracked.receiptRetried = true;
                  buyInputByTxHash.set(msg.hash, tracked);
                  const refreshedNonce = await TradeService.refreshNonce({
                    chainId: tracked.input.chainId,
                    fromAddress: tracked.input.fromAddress,
                    txSide: 'buy',
                    error: reasonText,
                  });
                  console.info('[nonce.repair][buy.receipt.retry]', {
                    chainId: tracked.input.chainId,
                    oldTxHash: msg.hash,
                    refreshedNonce,
                  });
                  const retryRsp = await TradeService.buy(tracked.input, { forceRefreshHyperState: true });
                  const retryHash = retryRsp.txHash as `0x${string}`;
                  console.info('[nonce.repair][buy.receipt.retry.sent]', {
                    chainId: tracked.input.chainId,
                    oldTxHash: msg.hash,
                    retryHash,
                  });
                  buyInputByTxHash.set(retryHash, { input: tracked.input, receiptRetried: true });
                  const retryReceipt = await RpcService.waitForTransactionReceiptAny(retryHash, { chainId: tracked.input.chainId, timeoutMs: 20_000, txSide: 'buy' });
                  finalTxHash = retryReceipt.transactionHash;
                  finalStatus = retryReceipt.status;
                  finalBlockNumber = Number(retryReceipt.blockNumber);
                  revertReason = retryReceipt.status === 'success'
                    ? null
                    : await tryGetReceiptRevertReason(client, retryHash, retryReceipt.blockNumber);
                }
              }

              if (finalStatus === 'success') {
                buyInputByTxHash.delete(msg.hash);
                buyInputByTxHash.delete(finalTxHash);
              }
              broadcastStateChange();
              return {
                ok: finalStatus === 'success',
                blockNumber: finalBlockNumber,
                txHash: finalTxHash,
                status: finalStatus,
                revertReason: revertReason ?? undefined,
              };
            } catch (e: any) {
              const reason = extractRevertReasonFromError(e);
              if (!reason || reason.toLowerCase().includes('zero_input')) {
                debugLogTxError('tx:waitForReceipt failed', e, { hash: msg.hash, chainId: msg.chainId });
              }
              return { ok: false, txHash: msg.hash, revertReason: reason ?? undefined, error: serializeTxError(e) };
            }
          }

          case 'twitter:signal': {
            const signal = msg.payload as any;
            const tasks: Array<Promise<unknown>> = [
              (AutoTrade as any).handleTwitterSignal(signal),
              (TokenSniperTrade as any).handleTwitterSignal(signal),
            ];
            await Promise.all(tasks);
            return { ok: true };
          }

          case 'market:signal': {
            const signal = msg.payload as any;
            const tasks: Array<Promise<unknown>> = [];
            if ((await SettingsService.get())?.ui?.newCoinSniperEnabled === true) {
              tasks.push((NewCoinSniperTrade as any).handleMarketSignal(signal));
            }
            if (tasks.length > 0) {
              await Promise.all(tasks);
            }
            return { ok: true };
          }

          case 'newpool:getSnapshot':
            await ensureGmgnTokenSnapshotStoreLoaded();
            return { ok: true, items: getNewPoolMonitorSnapshotItems() };

          case 'gmgn:tokenSnapshot:getAll':
            await ensureGmgnTokenSnapshotStoreLoaded();
            return { ok: true, items: Array.from(gmgnTokenSnapshotStore.values()) };

          case 'gmgn:tokenSnapshot:upsertBatch': {
            await ensureGmgnTokenSnapshotStoreLoaded();
            const items = Array.isArray(msg.payload?.items) ? msg.payload.items : [];
            if (items.length) upsertGmgnTokenSnapshots(items);
            return { ok: true };
          }

          case 'newpool:upsertBatch': {
            const items = Array.isArray(msg.payload?.items) ? msg.payload.items : [];
            if (items.length) upsertNewPoolMonitorItems(items);
            return { ok: true };
          }
        }
      } catch (e: any) {
        console.error('Handler error:', e);
        throw e;
      }
    };

    handle().then(sendResponse).catch((e) => sendResponse({ error: e.message }));
    return true;
  });
});
