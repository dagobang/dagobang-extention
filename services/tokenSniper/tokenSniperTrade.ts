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

let statusWriteQueue: Promise<void> = Promise.resolve();
const handledSignalByTask = new Map<string, number>();

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

const cleanupHandledSignalMap = (now: number) => {
  if (handledSignalByTask.size < 2000) return;
  for (const [k, ts] of handledSignalByTask) {
    if (now - ts > 2 * 60 * 60 * 1000) handledSignalByTask.delete(k);
  }
};

export const createTokenSniperTrade = (deps: { onStateChanged: () => void }) => {
  const { fetchTokenInfoFresh, getEntryPriceUsd } = createTokenInfoResolvers();

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
      const tweetIds = new Set(
        [signal.tweetId, signal.quotedTweetId]
          .map((x) => (typeof x === 'string' ? x.trim() : ''))
          .filter(Boolean),
      );
      if (!tweetIds.size) return;
      const stableSignalId = getSignalStableId(signal);
      const now = Date.now();
      cleanupHandledSignalMap(now);
      let played = false;

      for (const task of tokenSnipe.tasks) {
        if (!task || !task.id || !task.tokenAddress) continue;
        if (Number(task.chain) !== Number(settings.chainId)) continue;
        const taskTweetTypes = normalizeTaskTweetTypes(task);
        if (!signalType) continue;
        if (!taskTweetTypes.includes(signalType)) continue;
        const targetIds = new Set(
          parseList(task.targetUrls)
            .flatMap((x) => extractTweetIds(x))
            .filter(Boolean),
        );
        if (!targetIds.size) continue;
        const hit = Array.from(tweetIds).some((id) => targetIds.has(id));
        if (!hit) continue;
        const dedupeKey = `${task.id}:${task.tokenAddress.toLowerCase()}:${stableSignalId}`;
        if (handledSignalByTask.has(dedupeKey)) continue;
        handledSignalByTask.set(dedupeKey, now);

        await updateTaskStatus(task.id, {
          state: 'matched',
          matchedAt: now,
          signalId: stableSignalId,
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
          deps.onStateChanged();
          continue;
        }
        await updateTaskStatus(task.id, { state: 'buying', message: '买入中' });

        try {
          const status = await WalletService.getStatus();
          if (status.locked) {
            await updateTaskStatus(task.id, { state: 'failed', message: '钱包未解锁' });
            deps.onStateChanged();
            continue;
          }
          const tokenInfo = await fetchTokenInfoFresh(task.chain, task.tokenAddress);
          if (!tokenInfo) {
            await updateTaskStatus(task.id, { state: 'failed', message: '获取代币信息失败' });
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
                const created = allOrders.length
                  ? await Promise.all(allOrders.map(async (item) => createLimitOrder(item)))
                  : [];
                const sellOrderIds = created
                  .map((item: any) => (item?.id ? String(item.id) : ''))
                  .filter(Boolean);
                await updateTaskStatus(task.id, {
                  state: 'sell_order_created',
                  sellOrderIds,
                  message: sellOrderIds.length ? `已创建${sellOrderIds.length}个卖出单` : '已触发自动卖出',
                });
              }
            } catch {
              await updateTaskStatus(task.id, { state: 'failed', message: '自动卖出创建失败' });
            }
          }
        } catch (e: any) {
          await updateTaskStatus(task.id, {
            state: 'failed',
            message: String(e?.shortMessage || e?.message || '买入失败'),
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
