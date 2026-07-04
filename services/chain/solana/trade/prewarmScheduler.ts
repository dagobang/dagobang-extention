import { ChainId } from '@/constants/chains/chainId';
import { getTradeExecutor } from '@/services/chain/registry';
import type { ChainAddress } from '@/types/chain/address';
import type { SubmitChannel } from '@/types/extention';
import type { TokenInfo } from '@/types/token';

export const SOLANA_SHARED_PREWARM_TTL_MS = 15_000;
const prewarmStartedAtByKey = new Map<string, number>();
const prewarmInFlightByKey = new Map<string, Promise<void>>();

function normalizeKeyPart(value: unknown): string {
  return String(value || '').trim();
}

function buildPrewarmKey(input: {
  chainId: number;
  tokenAddress: ChainAddress;
  fromAddress?: ChainAddress;
  platform?: string;
}): string {
  return [
    input.chainId,
    normalizeKeyPart(input.tokenAddress),
    normalizeKeyPart(input.fromAddress),
    normalizeKeyPart(input.platform).toLowerCase(),
  ].join(':');
}

type SharedPrewarmInput = {
  chainId: number;
  tokenAddress: ChainAddress;
  tokenInfo?: TokenInfo | null;
  fromAddress?: ChainAddress;
  submitChannel?: SubmitChannel;
  platform?: string;
  ttlMs?: number;
};

function ensurePrewarmTask(input: SharedPrewarmInput): Promise<void> | null {
  if (input.chainId !== ChainId.SOL) return null;
  const tokenAddress = normalizeKeyPart(input.tokenAddress);
  if (!tokenAddress) return null;
  const platform = normalizeKeyPart(input.platform || input.tokenInfo?.launchpad_platform || input.tokenInfo?.launchpad);
  const key = buildPrewarmKey({
    chainId: input.chainId,
    tokenAddress,
    fromAddress: input.fromAddress,
    platform,
  });
  const ttlMs = Math.max(1000, Number(input.ttlMs ?? SOLANA_SHARED_PREWARM_TTL_MS));
  const startedAt = prewarmStartedAtByKey.get(key) ?? 0;
  if (Date.now() - startedAt < ttlMs) return prewarmInFlightByKey.get(key) ?? Promise.resolve();
  const existing = prewarmInFlightByKey.get(key);
  if (existing) return existing;
  prewarmStartedAtByKey.set(key, Date.now());
  const task = (async () => {
    try {
      await getTradeExecutor(input.chainId).prewarmTurbo({
        chainId: input.chainId,
        tokenAddress,
        tokenInfo: input.tokenInfo ?? undefined,
        fromAddress: input.fromAddress,
        submitChannel: input.submitChannel,
        platform: platform || undefined,
      });
    } catch {
    } finally {
      prewarmInFlightByKey.delete(key);
    }
  })();
  prewarmInFlightByKey.set(key, task);
  return task;
}

export async function ensureSolanaTradePrewarm(input: SharedPrewarmInput): Promise<void> {
  await (ensurePrewarmTask(input) ?? Promise.resolve());
}

export function scheduleSolanaTradePrewarm(input: SharedPrewarmInput): void {
  void ensurePrewarmTask(input);
}
