import { browser } from 'wxt/browser';
import type { XSniperBuyRecord, XSniperEvalPoint } from '@/types/extention';

export const XSNIPER_HISTORY_STORAGE_KEY = 'dagobang_xsniper_order_history_v1';
export const XSNIPER_HISTORY_LIMIT = 200;
const NON_PERSIST_BUY_REASONS = new Set(['buy_skipped_recently_bought', 'buy_skipped_in_flight']);
const XSNIPER_EVAL_WINDOWS = [
  { key: 'eval3s', minAgeMs: 3_000 },
  { key: 'eval5s', minAgeMs: 5_000 },
  { key: 'eval8s', minAgeMs: 8_000 },
  { key: 'eval10s', minAgeMs: 10_000 },
  { key: 'eval15s', minAgeMs: 15_000 },
  { key: 'eval20s', minAgeMs: 20_000 },
  { key: 'eval25s', minAgeMs: 25_000 },
  { key: 'eval30s', minAgeMs: 30_000 },
  { key: 'eval60s', minAgeMs: 60_000 },
] as const satisfies ReadonlyArray<{ key: keyof XSniperBuyRecord; minAgeMs: number }>;
let historyWriteQueue: Promise<void> = Promise.resolve();

const shouldPersistRecord = (record: XSniperBuyRecord) => {
  const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
  return !(record.side === 'buy' && reason && NON_PERSIST_BUY_REASONS.has(reason));
};

const runHistoryMutation = async (mutate: (list: XSniperBuyRecord[]) => boolean) => {
  const res = await browser.storage.local.get(XSNIPER_HISTORY_STORAGE_KEY);
  const raw = (res as any)?.[XSNIPER_HISTORY_STORAGE_KEY];
  const list = Array.isArray(raw) ? raw.slice() : [];
  const changed = mutate(list);
  if (!changed) return;
  await browser.storage.local.set({ [XSNIPER_HISTORY_STORAGE_KEY]: list.slice(0, XSNIPER_HISTORY_LIMIT) } as any);
};

const enqueueHistoryMutation = (mutate: (list: XSniperBuyRecord[]) => boolean) => {
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

export const pushXSniperHistory = async (record: XSniperBuyRecord) => {
  if (!shouldPersistRecord(record)) return;
  try {
    await enqueueHistoryMutation((list) => {
      list.unshift(record);
      return true;
    });
  } catch {
  }
};

export const loadXSniperHistory = async (): Promise<XSniperBuyRecord[]> => {
  try {
    await historyWriteQueue;
    const res = await browser.storage.local.get(XSNIPER_HISTORY_STORAGE_KEY);
    const raw = (res as any)?.[XSNIPER_HISTORY_STORAGE_KEY];
    return Array.isArray(raw) ? (raw as XSniperBuyRecord[]) : [];
  } catch {
    return [];
  }
};

export const clearXSniperHistory = async () => {
  try {
    await enqueueHistoryMutation((list) => {
      if (!list.length) return false;
      list.length = 0;
      return true;
    });
  } catch {
  }
};

export const maybeUpdateXSniperHistoryEvaluations = async (input: {
  tokenAddress: `0x${string}`;
  nowMs: number;
  marketCapUsd?: number;
  holders?: number;
}) => {
  const curMcap = typeof input.marketCapUsd === 'number' && Number.isFinite(input.marketCapUsd) ? input.marketCapUsd : null;
  const curHolders = typeof input.holders === 'number' && Number.isFinite(input.holders) ? input.holders : null;
  if (curMcap == null && curHolders == null) return;
  await enqueueHistoryMutation((historyList) => {
    let changed = false;
    for (let i = 0; i < historyList.length; i++) {
      const r = historyList[i];
      if (!r || r.side !== 'buy') continue;
      if (r.tokenAddress !== input.tokenAddress) continue;
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
      for (const window of XSNIPER_EVAL_WINDOWS) {
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
