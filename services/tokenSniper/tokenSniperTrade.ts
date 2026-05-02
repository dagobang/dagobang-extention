import { browser } from 'wxt/browser';
import { parseEther } from 'viem';
import { TRADE_SUCCESS_SOUND_PRESETS, type TokenSnipeBuyMethod, type TokenSnipeTask, type TokenSnipeTaskRuntimeStatus, type UnifiedTwitterSignal } from '@/types/extention';
import { defaultSettings } from '@/utils/defaults';
import { SettingsService } from '@/services/settings';
import { WalletService } from '@/services/wallet';
import { TradeService } from '@/services/trade';
import {
  buildStrategyRollingTakeProfitOrderInputs,
  buildStrategySellOrderInputs,
  buildStrategyTrailingSellOrderInputs,
  getAdvancedAutoSellMode,
} from '@/services/limitOrders/advancedAutoSell';
import { cancelAllSellLimitOrdersForToken, createLimitOrder } from '@/services/limitOrders/store';
import { createTokenInfoResolvers } from '@/services/xSniper/engine/tokenInfoResolver';
import { parseNumber } from '@/services/xSniper/engine/metrics';

export const TOKEN_SNIPER_STATUS_STORAGE_KEY = 'dagobang_token_sniper_task_status_v1';
export const TOKEN_SNIPER_HISTORY_STORAGE_KEY = 'dagobang_token_sniper_order_history_v1';
export const TOKEN_SNIPER_HISTORY_LIMIT = 300;
export const TOKEN_SNIPER_SIGNAL_ACTION_EXPIRE_MS = 3 * 60 * 1000;

let statusWriteQueue: Promise<void> = Promise.resolve();
let historyWriteQueue: Promise<void> = Promise.resolve();
const handledSignalByTask = new Map<string, number>();
const historyHandledKeySet = new Set<string>();
let historyHandledKeySetLoaded = false;
let historyHandledKeySetLoading: Promise<void> | null = null;
let historyHandledKeySetListenerBound = false;

const buildHandledHistoryKey = (input: { taskId: string; accountKey: string; tweetId: string }) =>
  `${input.taskId}:${input.accountKey}:${input.tweetId}`;

const indexHistoryRecord = (item: any) => {
  if (!item) return;
  const taskId = String(item.taskId || '').trim();
  const accountKey = String(item.accountKey || '').trim();
  if (!taskId || !accountKey) return;
  const tweetIds = [item.tweetId, item.quotedTweetId]
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter(Boolean);
  for (const tweetId of tweetIds) {
    historyHandledKeySet.add(buildHandledHistoryKey({ taskId, accountKey, tweetId }));
  }
};

const bindHandledHistoryStorageListener = () => {
  if (historyHandledKeySetListenerBound) return;
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const changed = changes?.[TOKEN_SNIPER_HISTORY_STORAGE_KEY];
    if (!changed) return;
    historyHandledKeySet.clear();
    const next = changed.newValue;
    if (Array.isArray(next)) {
      for (const item of next) indexHistoryRecord(item);
      historyHandledKeySetLoaded = true;
      return;
    }
    historyHandledKeySetLoaded = false;
  });
  historyHandledKeySetListenerBound = true;
};

const ensureHandledHistoryLoaded = async () => {
  bindHandledHistoryStorageListener();
  if (historyHandledKeySetLoaded) return;
  if (historyHandledKeySetLoading) {
    await historyHandledKeySetLoading;
    return;
  }
  historyHandledKeySetLoading = (async () => {
    try {
      const res = await browser.storage.local.get(TOKEN_SNIPER_HISTORY_STORAGE_KEY);
      const raw = (res as any)?.[TOKEN_SNIPER_HISTORY_STORAGE_KEY];
      historyHandledKeySet.clear();
      if (Array.isArray(raw)) {
        for (const item of raw) indexHistoryRecord(item);
      }
      historyHandledKeySetLoaded = true;
    } finally {
      historyHandledKeySetLoading = null;
    }
  })();
  await historyHandledKeySetLoading;
};

const runStatusMutation = async (mutate: (statusMap: Record<string, TokenSnipeTaskRuntimeStatus>) => boolean) => {
  const res = await browser.storage.local.get(TOKEN_SNIPER_STATUS_STORAGE_KEY);
  const raw = (res as any)?.[TOKEN_SNIPER_STATUS_STORAGE_KEY];
  const statusMap =
    raw && typeof raw === 'object'
      ? { ...(raw as Record<string, TokenSnipeTaskRuntimeStatus>) }
      : {};
  const changed = mutate(statusMap);
  if (!changed) return;
  await browser.storage.local.set({ [TOKEN_SNIPER_STATUS_STORAGE_KEY]: statusMap } as any);
};

const enqueueStatusMutation = (mutate: (statusMap: Record<string, TokenSnipeTaskRuntimeStatus>) => boolean) => {
  statusWriteQueue = statusWriteQueue
    .then(async () => {
      try {
        await runStatusMutation(mutate);
      } catch {
      }
    })
    .catch(() => {});
  return statusWriteQueue;
};

type TokenSniperOrderRecord = {
  id: string;
  tsMs: number;
  taskId: string;
  taskCreatedAt: number;
  action: 'matched' | 'buy' | 'buy_failed' | 'sell_order_created';
  chainId: number;
  tokenAddress: string;
  tokenSymbol?: string;
  tokenName?: string;
  buyAmountNative?: number;
  signalId?: string;
  signalType?: string;
  signalAtMs?: number;
  signalActionAtMs?: number;
  signalReceivedAtMs?: number;
  accountKey?: string;
  accountScreen?: string;
  tweetId?: string;
  quotedTweetId?: string;
  txHash?: string;
  sellOrderIds?: string[];
  message?: string;
};

const runHistoryMutation = async (mutate: (list: TokenSniperOrderRecord[]) => boolean) => {
  const res = await browser.storage.local.get(TOKEN_SNIPER_HISTORY_STORAGE_KEY);
  const raw = (res as any)?.[TOKEN_SNIPER_HISTORY_STORAGE_KEY];
  const list = Array.isArray(raw) ? (raw as TokenSniperOrderRecord[]).slice() : [];
  const changed = mutate(list);
  if (!changed) return;
  await browser.storage.local.set({ [TOKEN_SNIPER_HISTORY_STORAGE_KEY]: list.slice(0, TOKEN_SNIPER_HISTORY_LIMIT) } as any);
};

const enqueueHistoryMutation = (mutate: (list: TokenSniperOrderRecord[]) => boolean) => {
  historyWriteQueue = historyWriteQueue
    .then(async () => {
      try {
        await runHistoryMutation(mutate);
      } catch {
      }
    })
    .catch(() => {});
  return historyWriteQueue;
};

const pushTokenSniperHistory = async (record: TokenSniperOrderRecord) => {
  indexHistoryRecord(record);
  historyHandledKeySetLoaded = true;
  await enqueueHistoryMutation((list) => {
    list.unshift(record);
    return true;
  });
};

const hasHandledSignalInHistory = async (input: { taskId: string; accountKey: string; tweetId: string }) => {
  await ensureHandledHistoryLoaded();
  return historyHandledKeySet.has(buildHandledHistoryKey(input));
};

const toSignalTweetType = (signal: UnifiedTwitterSignal) => {
  const raw = signal.tweetType === 'delete_post' ? (signal.sourceTweetType ?? null) : signal.tweetType;
  if (raw === 'repost') return 'retweet';
  if (raw === 'tweet') return 'tweet';
  if (raw === 'reply') return 'reply';
  if (raw === 'quote') return 'quote';
  if (raw === 'follow') return 'follow';
  return '';
};

const TOKEN_SNIPER_INTERACTION_TYPES = ['tweet', 'reply', 'quote', 'retweet', 'follow'] as const;
const normalizeTaskTweetTypes = (task: TokenSnipeTask): string[] => {
  const values = Array.isArray((task as any)?.tweetTypes) ? (task as any).tweetTypes : [];
  const fromArray = values
    .map((x: any) => String(x).trim().toLowerCase())
    .filter((x: string) => TOKEN_SNIPER_INTERACTION_TYPES.includes(x as any))
    .filter((x: string, idx: number, arr: string[]) => arr.indexOf(x) === idx);
  if (fromArray.length) return fromArray;
  const legacy = typeof task?.tweetType === 'string' ? task.tweetType : 'all';
  if (legacy === 'all') return [...TOKEN_SNIPER_INTERACTION_TYPES];
  if (TOKEN_SNIPER_INTERACTION_TYPES.includes(legacy as any)) return [legacy];
  return [...TOKEN_SNIPER_INTERACTION_TYPES];
};

const parseList = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map((x) => String(x).trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value
    .split(/[\n,]/)
    .flatMap((x) => x.split(/\s+/))
    .map((x) => x.trim())
    .filter(Boolean);
};

const parseCommaOrLineList = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map((x) => String(x).trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value
    .split(/[\n,，]/)
    .map((x) => x.trim())
    .filter(Boolean);
};

const extractTweetIds = (text: string): string[] => {
  const ids = new Set<string>();
  const source = String(text || '');
  for (const m of source.matchAll(/status\/(\d{5,})/g)) {
    if (m[1]) ids.add(m[1]);
  }
  for (const m of source.matchAll(/\b(\d{10,})\b/g)) {
    if (m[1]) ids.add(m[1]);
  }
  return Array.from(ids);
};

const normalizeTokenSnipe = (input: any) => {
  const defaults = defaultSettings().autoTrade.tokenSnipe;
  const merged = !input ? defaults : {
    ...defaults,
    ...input,
  };
  const tasks = Array.isArray((merged as any).tasks) ? (merged as any).tasks : [];
  return {
    enabled: merged.enabled !== false,
    targetUsers: parseList((merged as any).targetUsers),
    playSound: merged.playSound !== false,
    soundPreset: TRADE_SUCCESS_SOUND_PRESETS.includes((merged as any).soundPreset)
      ? (merged as any).soundPreset
      : 'Boom',
    tasks: tasks as TokenSnipeTask[],
  };
};

const matchTargetUsers = (signal: UnifiedTwitterSignal, targetUsers: string[]) => {
  if (!targetUsers.length) return true;
  const screen = String(signal.userScreen ?? '').replace(/^@/, '').toLowerCase();
  const name = String(signal.userName ?? '').toLowerCase();
  return targetUsers.some((u) => {
    const key = String(u).replace(/^@/, '').toLowerCase();
    return !!key && (screen === key || name === key);
  });
};

const getSignalStableId = (signal: UnifiedTwitterSignal) => {
  const values = [
    signal.id,
    signal.eventId,
    signal.tweetId,
    signal.quotedTweetId,
    (signal as any).sourceTweetId,
  ]
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter(Boolean);
  return values[0] || `${signal.userScreen ?? ''}:${signal.ts ?? Date.now()}`;
};

const normalizeSignalMs = (value: unknown) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1_000_000_000_000 ? n : n * 1000;
};

const getSignalAtMs = (signal: UnifiedTwitterSignal) => {
  const received = normalizeSignalMs((signal as any).receivedAtMs);
  if (received > 0) return received;
  return normalizeSignalMs(signal.ts);
};

const getSignalActorKey = (signal: UnifiedTwitterSignal) => {
  const byScreen = String(signal.userScreen ?? '').trim().replace(/^@/, '').toLowerCase();
  if (byScreen) return byScreen;
  const byName = String(signal.userName ?? '').trim().toLowerCase();
  if (byName) return byName;
  return '';
};

const buildSignalKeywordText = (signal: UnifiedTwitterSignal) =>
  [
    signal.text,
    signal.translatedText,
    signal.quotedText,
    (signal as any).quotedTranslatedText,
    (signal as any).quotedTranslation,
    (signal as any).quoteTranslatedText,
    (signal as any).translation,
  ]
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter(Boolean)
    .join('\n')
    .toLowerCase();

const normalizeBuyMethod = (task: TokenSnipeTask): TokenSnipeBuyMethod => {
  const raw = typeof (task as any)?.buyMethod === 'string' ? String((task as any).buyMethod).trim().toLowerCase() : '';
  if (raw === 'all' || raw === 'dagobang' || raw === 'gmgn') return raw;
  return 'dagobang';
};
const normalizeAddress = (value: unknown): string => (typeof value === 'string' ? value.trim().toLowerCase() : '');

const updateTaskStatus = async (taskId: string, patch: Partial<TokenSnipeTaskRuntimeStatus>) => {
  await enqueueStatusMutation((statusMap) => {
    const prev = statusMap[taskId];
    statusMap[taskId] = {
      ...prev,
      ...patch,
      taskId,
      state: (patch.state ?? prev?.state ?? 'idle'),
      updatedAt: Date.now(),
    };
    return true;
  });
};

const cleanupHandledSignalMap = (now: number, activeTaskIds: Set<string>) => {
  const ttlMs = 30 * 24 * 60 * 60 * 1000;
  for (const [k, ts] of handledSignalByTask) {
    const taskId = k.split(':', 1)[0];
    if (!activeTaskIds.has(taskId) || now - ts > ttlMs) handledSignalByTask.delete(k);
  }
};

export const createTokenSniperTrade = (deps: { onStateChanged: () => void }) => {
  const { getEntryPriceUsd, fetchTokenInfoFresh, buildGenericTokenInfo } = createTokenInfoResolvers();

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
  const requestGmgnBuyViaContent = async (input: { tokenAddress: `0x${string}`; amountWei: string; gasGwei?: string }) => {
    try {
      const tabs = await browser.tabs.query({});
      const settled = await Promise.all(
        tabs
          .filter((tab) => !!tab.id)
          .map(async (tab) => {
            try {
              const response = await browser.tabs.sendMessage(tab.id as number, {
                type: 'bg:tokenSniper:gmgnBuy',
                tokenAddress: input.tokenAddress,
                amountWei: input.amountWei,
                gasGwei: input.gasGwei,
              });
              return response;
            } catch {
              return null;
            }
          }),
      );
      const success = settled.some((item: any) => item?.ok === true);
      if (!success) {
        const msg = settled.find((item: any) => typeof item?.error === 'string')?.error;
        return { ok: false, error: msg || '未找到可用的 GMGN 页面或页面未登录' };
      }
      return { ok: true };
    } catch {
      return { ok: false, error: 'GMGN买入请求发送失败' };
    }
  };
  const requestGmgnWalletAddressViaContent = async () => {
    try {
      const tabs = await browser.tabs.query({});
      const settled = await Promise.all(
        tabs
          .filter((tab) => !!tab.id)
          .map(async (tab) => {
            try {
              const response = await browser.tabs.sendMessage(tab.id as number, {
                type: 'bg:tokenSniper:gmgnWalletAddress',
              });
              return response;
            } catch {
              return null;
            }
          }),
      );
      const success = settled.find((item: any) => item?.ok === true && typeof item?.address === 'string' && item.address.trim());
      if (!success) {
        const msg = settled.find((item: any) => typeof item?.error === 'string')?.error;
        return { ok: false, error: msg || '未找到可用的 GMGN 页面或页面未登录' };
      }
      return { ok: true, address: normalizeAddress((success as any).address) };
    } catch {
      return { ok: false, error: 'GMGN地址查询失败' };
    }
  };

  const handleTwitterSignal = async (signal: UnifiedTwitterSignal) => {
    try {
      const settings = await SettingsService.get();
      const tokenSnipe = normalizeTokenSnipe((settings as any).autoTrade?.tokenSnipe);
      if (!tokenSnipe.enabled) return;
      if (!Array.isArray(tokenSnipe.tasks) || !tokenSnipe.tasks.length) return;
      if (signal.tweetType === 'delete_post') return;
      if (!matchTargetUsers(signal, tokenSnipe.targetUsers)) return;

      const signalType = toSignalTweetType(signal);
      if (!signalType) return;
      const tweetIds = new Set(
        [signal.tweetId, signal.quotedTweetId]
          .map((x) => (typeof x === 'string' ? x.trim() : ''))
          .filter(Boolean),
      );
      if (!tweetIds.size) return;
      const stableSignalId = getSignalStableId(signal);
      const rawSignalActionAtMs = normalizeSignalMs((signal as any).receivedAtMs);
      if (!(rawSignalActionAtMs > 0)) return;
      const rawSignalReceivedAtMs = normalizeSignalMs(signal.ts);
      const signalReceivedAtMs = rawSignalReceivedAtMs > 0 ? rawSignalReceivedAtMs : 0;
      const signalActionAtMs = rawSignalActionAtMs;
      const signalAtMs = getSignalAtMs(signal) || signalActionAtMs;
      const signalActorKey = getSignalActorKey(signal);
      const accountKey = signalActorKey || `unknown:${stableSignalId}`;
      const signalKeywordText = buildSignalKeywordText(signal);
      const now = Date.now();
      if (now - signalActionAtMs > TOKEN_SNIPER_SIGNAL_ACTION_EXPIRE_MS) return;
      const activeTaskIds = new Set(tokenSnipe.tasks.filter((x) => x?.id).map((x) => String(x.id)));
      cleanupHandledSignalMap(now, activeTaskIds);
      let played = false;

      for (const task of tokenSnipe.tasks) {
        if (!task || !task.id || !task.tokenAddress) continue;
        if (Number(task.chain) !== Number(settings.chainId)) continue;
        if (signalActionAtMs <= Number(task.createdAt || 0)) continue;
        const taskTweetTypes = normalizeTaskTweetTypes(task);
        if (!taskTweetTypes.includes(signalType)) continue;
        const targetIds = new Set(
          parseList(task.targetUrls)
            .flatMap((x) => extractTweetIds(x))
            .filter(Boolean),
        );
        const matchedTweetId = Array.from(tweetIds).find((id) => targetIds.has(id));
        const hasTargetMatch = !!matchedTweetId;
        const keywords = parseCommaOrLineList((task as any)?.keywords).map((x) => x.toLowerCase());
        const hasKeywordMatch = !!signalKeywordText && keywords.some((x) => signalKeywordText.includes(x));
        if (!targetIds.size && !keywords.length) continue;
        if (!hasTargetMatch && !hasKeywordMatch) continue;
        const dedupeTweetId = matchedTweetId || Array.from(tweetIds)[0];
        if (!dedupeTweetId) continue;
        const dedupeKey = `${task.id}:${accountKey}:${dedupeTweetId}`;
        if (handledSignalByTask.has(dedupeKey)) continue;
        if (await hasHandledSignalInHistory({ taskId: task.id, accountKey, tweetId: dedupeTweetId })) {
          handledSignalByTask.set(dedupeKey, now);
          continue;
        }
        handledSignalByTask.set(dedupeKey, now);

        await updateTaskStatus(task.id, {
          state: 'matched',
          matchedAt: now,
          signalId: stableSignalId,
          tweetId: typeof signal.tweetId === 'string' ? signal.tweetId : undefined,
          quotedTweetId: typeof signal.quotedTweetId === 'string' ? signal.quotedTweetId : undefined,
          message: '已命中',
        });
        await pushTokenSniperHistory({
          id: `token-sniper-matched-${task.id}-${stableSignalId}-${now}`,
          tsMs: now,
          taskId: task.id,
          taskCreatedAt: Number(task.createdAt || 0),
          action: 'matched',
          chainId: task.chain,
          tokenAddress: task.tokenAddress,
          tokenSymbol: task.tokenSymbol,
          tokenName: task.tokenName,
          signalId: stableSignalId,
          signalType,
          signalAtMs: signalAtMs > 0 ? signalAtMs : undefined,
          signalActionAtMs: signalActionAtMs > 0 ? signalActionAtMs : undefined,
          signalReceivedAtMs: signalReceivedAtMs > 0 ? signalReceivedAtMs : undefined,
          accountKey,
          accountScreen: String(signal.userScreen ?? '').trim() || undefined,
          tweetId: typeof signal.tweetId === 'string' ? signal.tweetId : undefined,
          quotedTweetId: typeof signal.quotedTweetId === 'string' ? signal.quotedTweetId : undefined,
          message: '已命中',
        });

        if (tokenSnipe.playSound && !played) {
          played = true;
          await broadcastToTabs({
            type: 'bg:tokenSniper:matched',
            source: 'tokenSniper',
            taskId: task.id,
            tokenAddress: task.tokenAddress,
            preset: tokenSnipe.soundPreset,
          });
        }

        if (!task.autoBuy) {
          deps.onStateChanged();
          continue;
        }
        const amountBnb = parseNumber(task.buyAmountNative) ?? 0;
        if (!(amountBnb > 0)) {
          await updateTaskStatus(task.id, { state: 'failed', message: '买入金额无效' });
          await pushTokenSniperHistory({
            id: `token-sniper-buy-failed-${task.id}-${stableSignalId}-${Date.now()}`,
            tsMs: Date.now(),
            taskId: task.id,
            taskCreatedAt: Number(task.createdAt || 0),
            action: 'buy_failed',
            chainId: task.chain,
            tokenAddress: task.tokenAddress,
            tokenSymbol: task.tokenSymbol,
            tokenName: task.tokenName,
            buyAmountNative: amountBnb,
            signalId: stableSignalId,
            signalType,
            signalAtMs: signalAtMs > 0 ? signalAtMs : undefined,
            signalActionAtMs: signalActionAtMs > 0 ? signalActionAtMs : undefined,
            signalReceivedAtMs: signalReceivedAtMs > 0 ? signalReceivedAtMs : undefined,
            accountKey,
            accountScreen: String(signal.userScreen ?? '').trim() || undefined,
            tweetId: typeof signal.tweetId === 'string' ? signal.tweetId : undefined,
            quotedTweetId: typeof signal.quotedTweetId === 'string' ? signal.quotedTweetId : undefined,
            message: '买入金额无效',
          });
          deps.onStateChanged();
          continue;
        }
        await updateTaskStatus(task.id, { state: 'buying', message: '买入中' });

        try {
          const status = await WalletService.getStatus();
          if (status.locked) {
            await updateTaskStatus(task.id, { state: 'failed', message: '钱包未解锁' });
            await pushTokenSniperHistory({
              id: `token-sniper-buy-failed-${task.id}-${stableSignalId}-${Date.now()}`,
              tsMs: Date.now(),
              taskId: task.id,
              taskCreatedAt: Number(task.createdAt || 0),
              action: 'buy_failed',
              chainId: task.chain,
              tokenAddress: task.tokenAddress,
              tokenSymbol: task.tokenSymbol,
              tokenName: task.tokenName,
              buyAmountNative: amountBnb,
              signalId: stableSignalId,
              signalType,
              signalAtMs: signalAtMs > 0 ? signalAtMs : undefined,
              signalActionAtMs: signalActionAtMs > 0 ? signalActionAtMs : undefined,
              signalReceivedAtMs: signalReceivedAtMs > 0 ? signalReceivedAtMs : undefined,
              accountKey,
              accountScreen: String(signal.userScreen ?? '').trim() || undefined,
              tweetId: typeof signal.tweetId === 'string' ? signal.tweetId : undefined,
              quotedTweetId: typeof signal.quotedTweetId === 'string' ? signal.quotedTweetId : undefined,
              message: '钱包未解锁',
            });
            deps.onStateChanged();
            continue;
          }
          const amountWei = parseEther(String(amountBnb)).toString();
          const buyMethod = normalizeBuyMethod(task);
          let shouldDagobangBuy = buyMethod === 'all' || buyMethod === 'dagobang';
          let shouldGmgnBuy = buyMethod === 'all' || buyMethod === 'gmgn';
          const pluginWalletAddress = normalizeAddress(status.address);
          let sameAddressDowngraded = false;
          if (buyMethod === 'all' && shouldDagobangBuy && shouldGmgnBuy && pluginWalletAddress) {
            const gmgnWalletRsp = await requestGmgnWalletAddressViaContent();
            const gmgnWalletAddress = gmgnWalletRsp.ok ? normalizeAddress(gmgnWalletRsp.address) : '';
            if (gmgnWalletAddress && gmgnWalletAddress === pluginWalletAddress) {
              shouldGmgnBuy = false;
              sameAddressDowngraded = true;
            }
          }
          const tokenInfo = shouldDagobangBuy
            ? (
              (await fetchTokenInfoFresh(task.chain, task.tokenAddress)) ??
              (await buildGenericTokenInfo(task.chain, task.tokenAddress))
            )
            : null;
          if (shouldDagobangBuy && !tokenInfo) {
            throw new Error('token_info_missing');
          }
          const attemptedDagobang = shouldDagobangBuy;
          const attemptedGmgn = shouldGmgnBuy;
          let buyTxHash: string | undefined;
          let submitElapsedMs: number | undefined;
          let receiptElapsedMs: number | undefined;
          let totalElapsedMs: number | undefined;
          let broadcastVia: 'bloxroute' | 'rpc' | undefined;
          let broadcastUrl: string | undefined;
          let isBundle: boolean | undefined;
          let dagobangOk = false;
          let gmgnOk = false;
          let gmgnError = '';
          const buyTasks: Array<Promise<void>> = [];
          if (shouldDagobangBuy) {
            buyTasks.push((async () => {
              const rsp = await TradeService.buyWithReceiptAndNonceRecovery({
                chainId: task.chain,
                tokenAddress: task.tokenAddress,
                bnbAmountWei: amountWei,
                fromAddress: pluginWalletAddress ? (pluginWalletAddress as `0x${string}`) : undefined,
                gasPriceGwei: typeof task.buyGasGwei === 'string' ? String(task.buyGasGwei).trim() : undefined,
                priorityFeeBnb: typeof task.buyBribeBnb === 'string' ? String(task.buyBribeBnb).trim() : undefined,
                tokenInfo: tokenInfo as any,
              } as any, {
                maxRetry: 1,
                onSubmitted: async (ctx) => {
                  await broadcastToTabs({
                    type: 'bg:tradeSubmitted',
                    source: 'tokenSniper',
                    side: 'buy',
                    chainId: task.chain,
                    tokenAddress: task.tokenAddress,
                    txHash: ctx.txHash,
                    submitElapsedMs: ctx.submitElapsedMs,
                  });
                },
              });
              const txHash = typeof (rsp as any)?.txHash === 'string' ? String((rsp as any).txHash) : '';
              if (txHash) buyTxHash = txHash;
              submitElapsedMs = (rsp as any)?.submitElapsedMs;
              receiptElapsedMs = (rsp as any)?.receiptElapsedMs;
              totalElapsedMs = (rsp as any)?.totalElapsedMs;
              broadcastVia = (rsp as any)?.broadcastVia;
              broadcastUrl = (rsp as any)?.broadcastUrl;
              isBundle = (rsp as any)?.isBundle;
              dagobangOk = true;
            })());
          }
          if (shouldGmgnBuy) {
            buyTasks.push((async () => {
              const gmgnRsp = await requestGmgnBuyViaContent({
                tokenAddress: task.tokenAddress,
                amountWei,
                gasGwei: typeof task.buyGasGwei === 'string' ? String(task.buyGasGwei).trim() || undefined : undefined,
              });
              if (!gmgnRsp.ok) {
                gmgnError = gmgnRsp.error || 'GMGN买入失败';
                throw new Error(gmgnError);
              }
              gmgnOk = true;
            })());
          }
          const settled = await Promise.allSettled(buyTasks);
          const failedMessages = settled
            .filter((item) => item.status === 'rejected')
            .map((item: PromiseRejectedResult) => String(item.reason?.message || item.reason || '').trim())
            .filter(Boolean);
          if (!dagobangOk && !gmgnOk) {
            throw new Error(failedMessages[0] || gmgnError || '买入失败');
          }
          const buyMessage = buyMethod === 'all'
            ? (attemptedDagobang && attemptedGmgn
              ? (dagobangOk && gmgnOk ? '双通道买入成功' : (dagobangOk ? '打狗棒买入成功，GMGN买入失败' : 'GMGN买入成功，打狗棒买入失败'))
              : (attemptedDagobang
                ? (sameAddressDowngraded ? '同地址自动降级：打狗棒买入成功' : '打狗棒买入成功')
                : 'GMGN买入成功'))
            : buyMethod === 'gmgn'
              ? 'GMGN买入成功'
              : '买入成功';
          await updateTaskStatus(task.id, {
            state: 'bought',
            boughtAt: Date.now(),
            buyTxHash,
            message: buyMessage,
          });
          await pushTokenSniperHistory({
            id: `token-sniper-buy-${task.id}-${stableSignalId}-${Date.now()}`,
            tsMs: Date.now(),
            taskId: task.id,
            taskCreatedAt: Number(task.createdAt || 0),
            action: 'buy',
            chainId: task.chain,
            tokenAddress: task.tokenAddress,
            tokenSymbol: task.tokenSymbol,
            tokenName: task.tokenName,
            buyAmountNative: amountBnb,
            signalId: stableSignalId,
            signalType,
            signalAtMs: signalAtMs > 0 ? signalAtMs : undefined,
            signalActionAtMs: signalActionAtMs > 0 ? signalActionAtMs : undefined,
            signalReceivedAtMs: signalReceivedAtMs > 0 ? signalReceivedAtMs : undefined,
            accountKey,
            accountScreen: String(signal.userScreen ?? '').trim() || undefined,
            tweetId: typeof signal.tweetId === 'string' ? signal.tweetId : undefined,
            quotedTweetId: typeof signal.quotedTweetId === 'string' ? signal.quotedTweetId : undefined,
            txHash: buyTxHash,
            message: buyMessage,
          });
          if (dagobangOk) {
            await broadcastToTabs({
              type: 'bg:tradeSuccess',
              source: 'tokenSniper',
              side: 'buy',
              chainId: task.chain,
              tokenAddress: task.tokenAddress,
              txHash: buyTxHash,
              submitElapsedMs,
              receiptElapsedMs,
              totalElapsedMs,
              broadcastVia,
              broadcastUrl,
              isBundle,
            });
          }
          if (gmgnOk) {
            await broadcastToTabs({
              type: 'bg:tradeSuccess',
              source: 'tokenSniper',
              side: 'buy',
              chainId: task.chain,
              tokenAddress: task.tokenAddress,
            });
          }
          if (task.autoSell && dagobangOk && tokenInfo) {
            try {
              const cfg = (settings as any).advancedAutoSell;
              const entryPriceUsd = await getEntryPriceUsd(
                task.chain,
                task.tokenAddress,
                tokenInfo,
                null,
                null,
              );
              if (cfg?.enabled && entryPriceUsd != null && entryPriceUsd > 0) {
                const fromAddress = pluginWalletAddress ? (pluginWalletAddress as `0x${string}`) : undefined;
                await TradeService.approveMaxForSellIfNeeded(task.chain, task.tokenAddress, tokenInfo, { fromAddress });
                await cancelAllSellLimitOrdersForToken(task.chain, task.tokenAddress, fromAddress);
                const orders = buildStrategySellOrderInputs({
                  config: cfg,
                  chainId: task.chain,
                  tokenAddress: task.tokenAddress,
                  tokenSymbol: tokenInfo.symbol,
                  tokenInfo,
                  basePriceUsd: entryPriceUsd,
                });
                const trailingMode = (cfg as any)?.trailingStop?.activationMode ?? 'after_first_take_profit';
                const isRolling = getAdvancedAutoSellMode(cfg) === 'rolling_take_profit';
                const special = trailingMode === 'immediate'
                  ? (isRolling
                    ? buildStrategyRollingTakeProfitOrderInputs({
                      config: cfg,
                      chainId: task.chain,
                      tokenAddress: task.tokenAddress,
                      tokenSymbol: tokenInfo.symbol,
                      tokenInfo,
                      basePriceUsd: entryPriceUsd,
                      entryPriceUsd,
                    })
                    : buildStrategyTrailingSellOrderInputs({
                      config: cfg,
                      chainId: task.chain,
                      tokenAddress: task.tokenAddress,
                      tokenSymbol: tokenInfo.symbol,
                      tokenInfo,
                      basePriceUsd: entryPriceUsd,
                    }))
                  : null;
                const allOrders = special ? [...orders, special] : orders;
                const sellOrderIds = allOrders.length
                  ? await (async () => {
                    const ids: string[] = [];
                    for (const item of allOrders) {
                      const createdOrder = await createLimitOrder({ ...item, fromAddress });
                      const id = (createdOrder as any)?.id;
                      if (id) ids.push(String(id));
                    }
                    return ids;
                  })()
                  : [];
                await updateTaskStatus(task.id, {
                  state: 'sell_order_created',
                  sellOrderIds,
                  message: sellOrderIds.length ? `已创建${sellOrderIds.length}个卖出单` : '已触发自动卖出',
                });
                await pushTokenSniperHistory({
                  id: `token-sniper-sell-order-${task.id}-${stableSignalId}-${Date.now()}`,
                  tsMs: Date.now(),
                  taskId: task.id,
                  taskCreatedAt: Number(task.createdAt || 0),
                  action: 'sell_order_created',
                  chainId: task.chain,
                  tokenAddress: task.tokenAddress,
                  tokenSymbol: task.tokenSymbol,
                  tokenName: task.tokenName,
                  signalId: stableSignalId,
                  signalType,
                  signalAtMs: signalAtMs > 0 ? signalAtMs : undefined,
                  signalActionAtMs: signalActionAtMs > 0 ? signalActionAtMs : undefined,
                  signalReceivedAtMs: signalReceivedAtMs > 0 ? signalReceivedAtMs : undefined,
                  accountKey,
                  accountScreen: String(signal.userScreen ?? '').trim() || undefined,
                  tweetId: typeof signal.tweetId === 'string' ? signal.tweetId : undefined,
                  quotedTweetId: typeof signal.quotedTweetId === 'string' ? signal.quotedTweetId : undefined,
                  sellOrderIds,
                  message: sellOrderIds.length ? `已创建${sellOrderIds.length}个卖出单` : '已触发自动卖出',
                });
              }
            } catch {
              await updateTaskStatus(task.id, { state: 'failed', message: '自动卖出创建失败' });
              await pushTokenSniperHistory({
                id: `token-sniper-buy-failed-${task.id}-${stableSignalId}-${Date.now()}`,
                tsMs: Date.now(),
                taskId: task.id,
                taskCreatedAt: Number(task.createdAt || 0),
                action: 'buy_failed',
                chainId: task.chain,
                tokenAddress: task.tokenAddress,
                tokenSymbol: task.tokenSymbol,
                tokenName: task.tokenName,
                buyAmountNative: amountBnb,
                signalId: stableSignalId,
                signalType,
                signalAtMs: signalAtMs > 0 ? signalAtMs : undefined,
                signalActionAtMs: signalActionAtMs > 0 ? signalActionAtMs : undefined,
                signalReceivedAtMs: signalReceivedAtMs > 0 ? signalReceivedAtMs : undefined,
                accountKey,
                accountScreen: String(signal.userScreen ?? '').trim() || undefined,
                tweetId: typeof signal.tweetId === 'string' ? signal.tweetId : undefined,
                quotedTweetId: typeof signal.quotedTweetId === 'string' ? signal.quotedTweetId : undefined,
                message: '自动卖出创建失败',
              });
            }
          }
        } catch (e: any) {
          const failMessage = String(e?.shortMessage || e?.message || '买入失败');
          await updateTaskStatus(task.id, {
            state: 'failed',
            message: failMessage,
          });
          await pushTokenSniperHistory({
            id: `token-sniper-buy-failed-${task.id}-${stableSignalId}-${Date.now()}`,
            tsMs: Date.now(),
            taskId: task.id,
            taskCreatedAt: Number(task.createdAt || 0),
            action: 'buy_failed',
            chainId: task.chain,
            tokenAddress: task.tokenAddress,
            tokenSymbol: task.tokenSymbol,
            tokenName: task.tokenName,
            buyAmountNative: amountBnb,
            signalId: stableSignalId,
            signalType,
            signalAtMs: signalAtMs > 0 ? signalAtMs : undefined,
            signalActionAtMs: signalActionAtMs > 0 ? signalActionAtMs : undefined,
            signalReceivedAtMs: signalReceivedAtMs > 0 ? signalReceivedAtMs : undefined,
            accountKey,
            accountScreen: String(signal.userScreen ?? '').trim() || undefined,
            tweetId: typeof signal.tweetId === 'string' ? signal.tweetId : undefined,
            quotedTweetId: typeof signal.quotedTweetId === 'string' ? signal.quotedTweetId : undefined,
            message: failMessage,
          });
        }
        deps.onStateChanged();
      }
    } catch (e) {
      console.error('TokenSniper twitter signal handler error', e);
    }
  };

  return { handleTwitterSignal };
};
