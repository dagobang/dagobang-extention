import { browser } from 'wxt/browser';
import type { XSniperBuyRecord } from '@/types/extention';

export const XSNIPER_HISTORY_STORAGE_KEY = 'dagobang_xsniper_order_history_v1';
export const XSNIPER_HISTORY_LIMIT = 200;

export const pushXSniperHistory = async (record: XSniperBuyRecord) => {
  try {
    const res = await browser.storage.local.get(XSNIPER_HISTORY_STORAGE_KEY);
    const raw = (res as any)?.[XSNIPER_HISTORY_STORAGE_KEY];
    const list = Array.isArray(raw) ? raw.slice() : [];
    list.unshift(record);
    await browser.storage.local.set({ [XSNIPER_HISTORY_STORAGE_KEY]: list.slice(0, XSNIPER_HISTORY_LIMIT) } as any);
  } catch {
  }
};

export const loadXSniperHistory = async (): Promise<XSniperBuyRecord[]> => {
  try {
    const res = await browser.storage.local.get(XSNIPER_HISTORY_STORAGE_KEY);
    const raw = (res as any)?.[XSNIPER_HISTORY_STORAGE_KEY];
    return Array.isArray(raw) ? (raw as XSniperBuyRecord[]) : [];
  } catch {
    return [];
  }
};

export const clearXSniperHistory = async () => {
  try {
    await browser.storage.local.set({ [XSNIPER_HISTORY_STORAGE_KEY]: [] } as any);
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
  const res = await browser.storage.local.get(XSNIPER_HISTORY_STORAGE_KEY);
  const raw = (res as any)?.[XSNIPER_HISTORY_STORAGE_KEY];
  const historyList: XSniperBuyRecord[] = Array.isArray(raw) ? raw.slice() : [];
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
    if (ageMs < 10_000) continue;
    const buildEval = () => {
      const pnlMcapPct = (() => {
        if (entryMcap == null || curMcap == null || entryMcap <= 0) return undefined;
        return ((curMcap - entryMcap) / entryMcap) * 100;
      })();
      return { atMs: input.nowMs, marketCapUsd: curMcap ?? undefined, holders: curHolders ?? undefined, pnlMcapPct };
    };
    if (ageMs >= 10_000 && !r.eval10s) {
      r.eval10s = buildEval();
      changed = true;
    }
    if (ageMs >= 30_000 && !r.eval30s) {
      r.eval30s = buildEval();
      changed = true;
    }
    if (ageMs >= 60_000 && !r.eval60s) {
      r.eval60s = buildEval();
      changed = true;
    }
  }
  if (changed) {
    await browser.storage.local.set({ [XSNIPER_HISTORY_STORAGE_KEY]: historyList.slice(0, XSNIPER_HISTORY_LIMIT) } as any);
  }
};
