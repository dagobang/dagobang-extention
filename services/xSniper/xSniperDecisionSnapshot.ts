import { browser } from 'wxt/browser';
import { normalizeAddress, normalizeAddressKey, normalizeWalletAddressKey } from '@/services/xSniper/engine/metrics';

export const XSNIPER_DECISION_SNAPSHOT_STORAGE_KEY = 'dagobang_xsniper_decision_snapshot_v1';
const XSNIPER_DECISION_SNAPSHOT_LIMIT = 3000;
const XSNIPER_DECISION_SNAPSHOT_TTL_MS = 72 * 60 * 60 * 1000;
let decisionWriteQueue: Promise<void> = Promise.resolve();

export type XSniperDecisionSnapshot = {
  key: string;
  signalStableId: string;
  signalId?: string;
  signalEventId?: string;
  signalTweetId?: string;
  chainId: number;
  tokenAddress: string;
  walletAddressKey: string;
  walletAddressResolved?: string;
  walletSource?: 'strategy' | 'active' | 'fallback';
  firstSeenAtMs: number;
  updatedAtMs: number;
  everEligibleInTokenAgeWindow: boolean;
  everEligibleInTweetAgeWindow: boolean;
  finalFailReasonInTokenAgeWindow?: string;
  finalFailReasonInTweetAgeWindow?: string;
  finalFailReason?: string;
  wsConfirmWindowMs?: number;
  wsConfirmFailedChecks?: Array<{
    key: string;
    op: 'lt' | 'gt' | 'missing';
    actual?: number | null;
    threshold?: number | null;
  }>;
  everAttemptedBuy: boolean;
  buyAttemptResult: 'success' | 'failed_after_attempt' | 'not_attempted';
  notAttemptedReason?: string;
  windowClosedAtMs?: number;
};

export type UpsertDecisionSnapshotInput = {
  signalStableId: string;
  signalId?: string;
  signalEventId?: string;
  signalTweetId?: string;
  chainId: number;
  tokenAddress: string;
  walletAddressKey: string;
  walletAddressResolved?: string;
  walletSource?: 'strategy' | 'active' | 'fallback';
  everEligibleInTokenAgeWindow?: boolean;
  everEligibleInTweetAgeWindow?: boolean;
  finalFailReasonInTokenAgeWindow?: string | null;
  finalFailReasonInTweetAgeWindow?: string | null;
  finalFailReason?: string | null;
  wsConfirmWindowMs?: number | null;
  wsConfirmFailedChecks?: Array<{
    key: string;
    op: 'lt' | 'gt' | 'missing';
    actual?: number | null;
    threshold?: number | null;
  }> | null;
  everAttemptedBuy?: boolean;
  buyAttemptResult?: 'success' | 'failed_after_attempt' | 'not_attempted';
  notAttemptedReason?: string | null;
  windowClosedAtMs?: number | null;
};

const buildDecisionSnapshotKey = (input: {
  signalStableId: string;
  chainId: number;
  tokenAddress: string;
  walletAddressKey: string;
}) => `${input.signalStableId}:${input.chainId}:${normalizeAddressKey(input.tokenAddress)}:${normalizeWalletAddressKey(input.walletAddressKey)}`;

const cleanOldSnapshots = (list: XSniperDecisionSnapshot[], nowMs: number) =>
  list.filter((row) => nowMs - row.updatedAtMs <= XSNIPER_DECISION_SNAPSHOT_TTL_MS);

const areFailedChecksEqual = (
  a?: XSniperDecisionSnapshot['wsConfirmFailedChecks'],
  b?: UpsertDecisionSnapshotInput['wsConfirmFailedChecks'],
) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const buildNextSnapshot = (
  input: UpsertDecisionSnapshotInput,
  nowMs: number,
  list: XSniperDecisionSnapshot[],
): { changed: boolean; nextList: XSniperDecisionSnapshot[] } => {
  const signalStableId = String(input.signalStableId || '').trim();
  const walletAddressKey = normalizeWalletAddressKey(input.walletAddressKey);
  const tokenAddress = normalizeAddress(input.tokenAddress);
  if (!signalStableId || !walletAddressKey || !tokenAddress) {
    return { changed: false, nextList: list };
  }
  const key = buildDecisionSnapshotKey({
    signalStableId,
    chainId: input.chainId,
    tokenAddress,
    walletAddressKey,
  });
  const idx = list.findIndex((row) => row?.key === key);
  const base: XSniperDecisionSnapshot = idx >= 0
    ? list[idx]
    : {
      key,
      signalStableId,
      signalId: input.signalId,
      signalEventId: input.signalEventId,
      signalTweetId: input.signalTweetId,
      chainId: input.chainId,
      tokenAddress,
      walletAddressKey,
      walletAddressResolved: normalizeAddress(input.walletAddressResolved ?? '') ?? undefined,
      walletSource: input.walletSource,
      firstSeenAtMs: nowMs,
      updatedAtMs: nowMs,
      everEligibleInTokenAgeWindow: false,
      everEligibleInTweetAgeWindow: false,
      everAttemptedBuy: false,
      buyAttemptResult: 'not_attempted',
    };
  const next: XSniperDecisionSnapshot = {
    ...base,
    signalStableId,
    signalId: input.signalId || base.signalId,
    signalEventId: input.signalEventId || base.signalEventId,
    signalTweetId: input.signalTweetId || base.signalTweetId,
    chainId: input.chainId,
    tokenAddress,
    walletAddressKey,
    walletAddressResolved: normalizeAddress(input.walletAddressResolved ?? '') || base.walletAddressResolved,
    walletSource: input.walletSource || base.walletSource,
    updatedAtMs: nowMs,
    everEligibleInTokenAgeWindow: base.everEligibleInTokenAgeWindow || input.everEligibleInTokenAgeWindow === true,
    everEligibleInTweetAgeWindow: base.everEligibleInTweetAgeWindow || input.everEligibleInTweetAgeWindow === true,
    everAttemptedBuy: base.everAttemptedBuy || input.everAttemptedBuy === true,
    buyAttemptResult: input.buyAttemptResult || base.buyAttemptResult,
  };
  if (input.finalFailReasonInTokenAgeWindow !== undefined) {
    next.finalFailReasonInTokenAgeWindow = input.finalFailReasonInTokenAgeWindow || undefined;
  }
  if (input.finalFailReasonInTweetAgeWindow !== undefined) {
    next.finalFailReasonInTweetAgeWindow = input.finalFailReasonInTweetAgeWindow || undefined;
  }
  if (input.finalFailReason !== undefined) {
    next.finalFailReason = input.finalFailReason || undefined;
  }
  if (input.wsConfirmWindowMs !== undefined) {
    next.wsConfirmWindowMs = input.wsConfirmWindowMs ?? undefined;
  }
  if (input.wsConfirmFailedChecks !== undefined) {
    next.wsConfirmFailedChecks = input.wsConfirmFailedChecks ? input.wsConfirmFailedChecks : undefined;
  }
  if (input.notAttemptedReason !== undefined) {
    next.notAttemptedReason = input.notAttemptedReason || undefined;
  }
  if (input.windowClosedAtMs !== undefined) {
    next.windowClosedAtMs = input.windowClosedAtMs ?? undefined;
  }

  const prev = idx >= 0 ? list[idx] : null;
  const changed = !prev || (
    prev.signalId !== next.signalId ||
    prev.signalEventId !== next.signalEventId ||
    prev.signalTweetId !== next.signalTweetId ||
    prev.chainId !== next.chainId ||
    prev.tokenAddress !== next.tokenAddress ||
    prev.walletAddressKey !== next.walletAddressKey ||
    prev.walletAddressResolved !== next.walletAddressResolved ||
    prev.walletSource !== next.walletSource ||
    prev.everEligibleInTokenAgeWindow !== next.everEligibleInTokenAgeWindow ||
    prev.everEligibleInTweetAgeWindow !== next.everEligibleInTweetAgeWindow ||
    prev.finalFailReasonInTokenAgeWindow !== next.finalFailReasonInTokenAgeWindow ||
    prev.finalFailReasonInTweetAgeWindow !== next.finalFailReasonInTweetAgeWindow ||
    prev.finalFailReason !== next.finalFailReason ||
    prev.wsConfirmWindowMs !== next.wsConfirmWindowMs ||
    !areFailedChecksEqual(prev.wsConfirmFailedChecks, input.wsConfirmFailedChecks) ||
    prev.everAttemptedBuy !== next.everAttemptedBuy ||
    prev.buyAttemptResult !== next.buyAttemptResult ||
    prev.notAttemptedReason !== next.notAttemptedReason ||
    prev.windowClosedAtMs !== next.windowClosedAtMs
  );
  if (!changed) {
    return { changed: false, nextList: list };
  }

  const nextList = list.slice();
  if (idx >= 0) nextList[idx] = next;
  else nextList.unshift(next);
  return { changed: true, nextList };
};

export const upsertXSniperDecisionSnapshotBatch = async (inputs: UpsertDecisionSnapshotInput[]) => {
  const filtered = Array.isArray(inputs) ? inputs.filter(Boolean) : [];
  if (!filtered.length) return;
  decisionWriteQueue = decisionWriteQueue
    .then(async () => {
      try {
        const nowMs = Date.now();
        const res = await browser.storage.local.get(XSNIPER_DECISION_SNAPSHOT_STORAGE_KEY);
        const raw = (res as any)?.[XSNIPER_DECISION_SNAPSHOT_STORAGE_KEY];
        let list = cleanOldSnapshots(Array.isArray(raw) ? (raw as XSniperDecisionSnapshot[]) : [], nowMs);
        let changed = false;
        for (const input of filtered) {
          const result = buildNextSnapshot(input, nowMs, list);
          if (!result.changed) continue;
          list = result.nextList;
          changed = true;
        }
        if (!changed) return;
        list.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
        await browser.storage.local.set({
          [XSNIPER_DECISION_SNAPSHOT_STORAGE_KEY]: list.slice(0, XSNIPER_DECISION_SNAPSHOT_LIMIT),
        } as any);
      } catch {
      }
    })
    .catch(() => {});
  try {
    await decisionWriteQueue;
  } catch {
  }
};

export const upsertXSniperDecisionSnapshot = async (input: UpsertDecisionSnapshotInput) => {
  await upsertXSniperDecisionSnapshotBatch([input]);
};

export const loadXSniperDecisionSnapshots = async (): Promise<XSniperDecisionSnapshot[]> => {
  try {
    await decisionWriteQueue;
    const nowMs = Date.now();
    const res = await browser.storage.local.get(XSNIPER_DECISION_SNAPSHOT_STORAGE_KEY);
    const raw = (res as any)?.[XSNIPER_DECISION_SNAPSHOT_STORAGE_KEY];
    return cleanOldSnapshots(Array.isArray(raw) ? (raw as XSniperDecisionSnapshot[]) : [], nowMs);
  } catch {
    return [];
  }
};
