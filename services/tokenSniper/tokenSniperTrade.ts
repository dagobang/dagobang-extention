import { browser } from 'wxt/browser';
import { parseEther } from 'viem';
import { TRADE_SUCCESS_SOUND_PRESETS, type TokenSnipeTask, type TokenSnipeTaskRuntimeStatus, type UnifiedTwitterSignal } from '@/types/extention';
import { defaultSettings } from '@/utils/defaults';
import { SettingsService } from '@/services/settings';
import { WalletService } from '@/services/wallet';
import { TradeService } from '@/services/trade';
import { buildStrategySellOrderInputs, buildStrategyTrailingSellOrderInputs } from '@/services/limitOrders/advancedAutoSell';
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
  buyAmountBnb?: number;
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
  const { fetchTokenInfoFreshWithReason, buildGenericTokenInfoWithReason, getEntryPriceUsd } = createTokenInfoResolvers();

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
        if (!targetIds.size) continue;
        const matchedTweetId = Array.from(tweetIds).find((id) => targetIds.has(id));
        if (!matchedTweetId) continue;
        const dedupeKey = `${task.id}:${accountKey}:${matchedTweetId}`;
        if (handledSignalByTask.has(dedupeKey)) continue;
        if (await hasHandledSignalInHistory({ taskId: task.id, accountKey, tweetId: matchedTweetId })) {
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
        const amountBnb = parseNumber(task.buyAmountBnb) ?? 0;
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
            buyAmountBnb: amountBnb,
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
              buyAmountBnb: amountBnb,
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
          const tokenInfoResult = await fetchTokenInfoFreshWithReason(task.chain, task.tokenAddress);
          const genericTokenInfoResult = tokenInfoResult.tokenInfo
            ? { tokenInfo: null, failureReason: undefined }
            : await buildGenericTokenInfoWithReason(task.chain, task.tokenAddress);
          const tokenInfo =
            tokenInfoResult.tokenInfo
            ?? genericTokenInfoResult.tokenInfo;
          if (!tokenInfo) {
            const failureReason = genericTokenInfoResult.failureReason || tokenInfoResult.failureReason || '';
            const failMessage = failureReason === 'invalid_address'
              ? '获取代币信息失败：代币地址无效'
              : failureReason === 'fourmeme_rate_limited'
                ? '获取代币信息失败：接口限流(429)'
              : failureReason === 'fourmeme_empty'
                ? '获取代币信息失败：接口未返回该代币'
                : failureReason === 'flap_rate_limited'
                  ? '获取代币信息失败：Flap接口限流(429)'
                : failureReason === 'flap_fetch_failed'
                  ? '获取代币信息失败：Flap信息查询失败'
                  : failureReason === 'fourmeme_error'
                    ? '获取代币信息失败：接口请求异常'
                    : failureReason === 'rpc_rate_limited'
                      ? '获取代币信息失败：RPC限流(429)'
                    : '获取代币信息失败：RPC或接口异常';
            await updateTaskStatus(task.id, { state: 'failed', message: failMessage });
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
              buyAmountBnb: amountBnb,
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
            deps.onStateChanged();
            continue;
          }
          const rsp = await TradeService.buy({
            chainId: task.chain,
            tokenAddress: task.tokenAddress,
            bnbAmountWei: parseEther(String(amountBnb)).toString(),
            tokenInfo,
          } as any);
          const buyTxHash = typeof (rsp as any)?.txHash === 'string' ? String((rsp as any).txHash) : undefined;
          await updateTaskStatus(task.id, {
            state: 'bought',
            boughtAt: Date.now(),
            buyTxHash,
            message: '买入成功',
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
            buyAmountBnb: amountBnb,
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
            message: '买入成功',
          });
          await broadcastToTabs({
            type: 'bg:tradeSuccess',
            source: 'tokenSniper',
            side: 'buy',
            chainId: task.chain,
            tokenAddress: task.tokenAddress,
            txHash: buyTxHash,
          });

          if (task.autoSell) {
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
                await TradeService.approveMaxForSellIfNeeded(task.chain, task.tokenAddress, tokenInfo);
                await cancelAllSellLimitOrdersForToken(task.chain, task.tokenAddress);
                const orders = buildStrategySellOrderInputs({
                  config: cfg,
                  chainId: task.chain,
                  tokenAddress: task.tokenAddress,
                  tokenSymbol: tokenInfo.symbol,
                  tokenInfo,
                  basePriceUsd: entryPriceUsd,
                });
                const trailingMode = (cfg as any)?.trailingStop?.activationMode ?? 'after_last_take_profit';
                const trailing = trailingMode === 'immediate'
                  ? buildStrategyTrailingSellOrderInputs({
                    config: cfg,
                    chainId: task.chain,
                    tokenAddress: task.tokenAddress,
                    tokenSymbol: tokenInfo.symbol,
                    tokenInfo,
                    basePriceUsd: entryPriceUsd,
                  })
                  : null;
                const allOrders = trailing ? [...orders, trailing] : orders;
                const sellOrderIds = allOrders.length
                  ? await (async () => {
                    const ids: string[] = [];
                    for (const item of allOrders) {
                      const createdOrder = await createLimitOrder(item);
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
                buyAmountBnb: amountBnb,
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
            buyAmountBnb: amountBnb,
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
