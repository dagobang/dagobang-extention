import { browser } from 'wxt/browser';
import type { XSniperEvalPoint } from '@/types/extention';

export type NewCoinSniperOrderRecord = {
  id: string;
  tsMs: number;
  side?: 'buy' | 'sell';
  reason?: string;
  tweetAtMs?: number;
  tweetUrl?: string;
  chainId: number;
  tokenAddress: string;
  tokenSymbol?: string;
  tokenName?: string;
  buyAmountBnb?: number;
  sellPercent?: number;
  sellPercentOfOriginal?: number;
  sellPercentOfCurrent?: number;
  sellTokenAmountWei?: string;
  txHash?: string;
  entryPriceUsd?: number;
  marketCapUsd?: number;
  athMarketCapUsd?: number;
  holders?: number;
  liquidityUsd?: number;
  kol?: number;
  vol24hUsd?: number;
  netBuy24hUsd?: number;
  buyTx24h?: number;
  sellTx24h?: number;
  smartMoney?: number;
  createdAtMs?: number;
  devAddress?: string;
  devHoldPercent?: number;
  devHasSold?: boolean;
  confirmWindowMs?: number;
  confirmMcapChangePct?: number;
  confirmHoldersDelta?: number;
  confirmBuySellRatio?: number;
  eval3s?: XSniperEvalPoint;
  eval5s?: XSniperEvalPoint;
  eval8s?: XSniperEvalPoint;
  eval10s?: XSniperEvalPoint;
  eval15s?: XSniperEvalPoint;
  eval20s?: XSniperEvalPoint;
  eval25s?: XSniperEvalPoint;
  eval30s?: XSniperEvalPoint;
  eval60s?: XSniperEvalPoint;
  dryRun?: boolean;
  userScreen?: string;
  userName?: string;
  tweetType?: string;
  source?: 'new_pool' | 'token_update';
  signalId?: string;
  signalEventId?: string;
  signalTweetId?: string;
  channel?: string;
  launchpadPlatform?: string;
  strategyMode?: 'auto_filter' | 'xmode_task';
  taskId?: string;
  taskName?: string;
  matchKeywords?: string[];
  matchText?: string;
  triggerSource?: 'new_pool' | 'token_update';
};

const NEW_COIN_SNIPER_EVAL_WINDOWS = [
  { key: 'eval3s', minAgeMs: 3_000 },
  { key: 'eval5s', minAgeMs: 5_000 },
  { key: 'eval8s', minAgeMs: 8_000 },
  { key: 'eval10s', minAgeMs: 10_000 },
  { key: 'eval15s', minAgeMs: 15_000 },
  { key: 'eval20s', minAgeMs: 20_000 },
  { key: 'eval25s', minAgeMs: 25_000 },
  { key: 'eval30s', minAgeMs: 30_000 },
  { key: 'eval60s', minAgeMs: 60_000 },
] as const satisfies ReadonlyArray<{ key: keyof NewCoinSniperOrderRecord; minAgeMs: number }>;

export const NEW_COIN_SNIPER_HISTORY_STORAGE_KEY = 'dagobang_new_coin_sniper_order_history_v1';
export const NEW_COIN_SNIPER_HISTORY_LIMIT = 300;

let historyWriteQueue: Promise<void> = Promise.resolve();

const runHistoryMutation = async (mutate: (list: NewCoinSniperOrderRecord[]) => boolean) => {
  const res = await browser.storage.local.get(NEW_COIN_SNIPER_HISTORY_STORAGE_KEY);
  const raw = (res as any)?.[NEW_COIN_SNIPER_HISTORY_STORAGE_KEY];
  const list = Array.isArray(raw) ? (raw as NewCoinSniperOrderRecord[]).slice() : [];
  const changed = mutate(list);
  if (!changed) return;
  await browser.storage.local.set({ [NEW_COIN_SNIPER_HISTORY_STORAGE_KEY]: list.slice(0, NEW_COIN_SNIPER_HISTORY_LIMIT) } as any);
};

const enqueueHistoryMutation = (mutate: (list: NewCoinSniperOrderRecord[]) => boolean) => {
  historyWriteQueue = historyWriteQueue
    .then(async () => {
      try {
        await runHistoryMutation(mutate);
      } catch {
      }
    })
    .catch(() => { });
  return historyWriteQueue;
};

export const pushNewCoinSniperHistory = async (record: NewCoinSniperOrderRecord) => {
  await enqueueHistoryMutation((list) => {
    list.unshift(record);
    return true;
  });
};

export const loadNewCoinSniperHistory = async (): Promise<NewCoinSniperOrderRecord[]> => {
  try {
    await historyWriteQueue;
    const res = await browser.storage.local.get(NEW_COIN_SNIPER_HISTORY_STORAGE_KEY);
    const raw = (res as any)?.[NEW_COIN_SNIPER_HISTORY_STORAGE_KEY];
    return Array.isArray(raw) ? (raw as NewCoinSniperOrderRecord[]) : [];
  } catch {
    return [];
  }
};

export const maybeUpdateNewCoinSniperHistoryEvaluations = async (input: {
  tokenAddress: `0x${string}`;
  nowMs: number;
  marketCapUsd?: number;
  holders?: number;
}) => {
  const inputTokenAddress = String(input.tokenAddress || '').toLowerCase();
  if (!inputTokenAddress) return;
  const curMcap = typeof input.marketCapUsd === 'number' && Number.isFinite(input.marketCapUsd) ? input.marketCapUsd : null;
  const curHolders = typeof input.holders === 'number' && Number.isFinite(input.holders) ? input.holders : null;
  if (curMcap == null && curHolders == null) return;
  await enqueueHistoryMutation((historyList) => {
    let changed = false;
    for (let i = 0; i < historyList.length; i++) {
      const r = historyList[i];
      if (!r || r.side !== 'buy') continue;
      if (String(r.tokenAddress || '').toLowerCase() !== inputTokenAddress) continue;
      if (typeof r.tsMs !== 'number' || r.tsMs <= 0) continue;
      const ageMs = input.nowMs - r.tsMs;
      const entryMcap = typeof r.marketCapUsd === 'number' && Number.isFinite(r.marketCapUsd) ? r.marketCapUsd : null;
      if (curMcap != null) {
        const prevAth = typeof r.athMarketCapUsd === 'number' && Number.isFinite(r.athMarketCapUsd) ? r.athMarketCapUsd : entryMcap;
        const nextAth = prevAth != null && Number.isFinite(prevAth) ? Math.max(prevAth, curMcap) : curMcap;
        if (r.athMarketCapUsd !== nextAth) {
          r.athMarketCapUsd = nextAth;
          changed = true;
        }
      }
      const buildEval = (): XSniperEvalPoint => {
        const pnlMcapPct = (() => {
          if (entryMcap == null || curMcap == null || entryMcap <= 0) return undefined;
          return ((curMcap - entryMcap) / entryMcap) * 100;
        })();
        return { atMs: input.nowMs, marketCapUsd: curMcap ?? undefined, holders: curHolders ?? undefined, pnlMcapPct };
      };
      let nextEval: XSniperEvalPoint | null = null;
      for (const window of NEW_COIN_SNIPER_EVAL_WINDOWS) {
        if (ageMs < window.minAgeMs) continue;
        if ((r as any)[window.key]) continue;
        nextEval ??= buildEval();
        (r as any)[window.key] = nextEval;
        changed = true;
      }
    }
    return changed;
  });
};
