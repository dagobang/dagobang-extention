import { browser } from 'wxt/browser';

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
  tokenAddress: `0x${string}`;
  walletAddressKey: string;
  walletAddressResolved?: `0x${string}`;
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
  tokenAddress: `0x${string}`;
  walletAddressKey: string;
  walletAddressResolved?: `0x${string}`;
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
  tokenAddress: `0x${string}`;
  walletAddressKey: string;
}) => `${input.signalStableId}:${input.chainId}:${input.tokenAddress.toLowerCase()}:${input.walletAddressKey.toLowerCase()}`;

const cleanOldSnapshots = (list: XSniperDecisionSnapshot[], nowMs: number) =>
  list.filter((row) => nowMs - row.updatedAtMs <= XSNIPER_DECISION_SNAPSHOT_TTL_MS);

export const upsertXSniperDecisionSnapshot = async (input: UpsertDecisionSnapshotInput) => {
  const signalStableId = String(input.signalStableId || '').trim();
  const walletAddressKey = String(input.walletAddressKey || '').trim().toLowerCase();
  const tokenAddress = String(input.tokenAddress || '').trim().toLowerCase() as `0x${string}`;
  if (!signalStableId || !walletAddressKey || !tokenAddress) return;
  const nowMs = Date.now();
  const key = buildDecisionSnapshotKey({
    signalStableId,
    chainId: input.chainId,
    tokenAddress,
    walletAddressKey,
  });
  decisionWriteQueue = decisionWriteQueue
    .then(async () => {
      try {
        const res = await browser.storage.local.get(XSNIPER_DECISION_SNAPSHOT_STORAGE_KEY);
        const raw = (res as any)?.[XSNIPER_DECISION_SNAPSHOT_STORAGE_KEY];
        const list = cleanOldSnapshots(Array.isArray(raw) ? (raw as XSniperDecisionSnapshot[]) : [], nowMs);
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
            walletAddressResolved: input.walletAddressResolved,
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
          walletAddressResolved: input.walletAddressResolved || base.walletAddressResolved,
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
        if (idx >= 0) list[idx] = next;
        else list.unshift(next);
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
