import { normalizeSolanaPlatform, resolveKnownSolanaDirectSource } from '../../packages/solana-dex-core/src/constants';
import type { GmgnTokenSnapshot } from '@/types/extention';
import type { TokenInfo } from '@/types/token';

function clampLaunchpadProgress(value: unknown): number | undefined {
  const num = Number(value);
  if (!Number.isFinite(num)) return undefined;
  return Math.max(0, Math.min(100, num));
}

export function shouldTryRefreshMigratedSolanaTokenInfo(input: {
  tokenAddress: string;
  tokenInfo?: TokenInfo | null;
}): boolean {
  const tokenInfo = input.tokenInfo ?? null;
  if (!tokenInfo) return false;
  if (Number(tokenInfo.launchpad_status ?? NaN) === 1) return false;
  return resolveKnownSolanaDirectSource(tokenInfo, input.tokenAddress) === 'pumpfun';
}

export function resolveMigratedSolanaTokenInfo(input: {
  tokenAddress: string;
  tokenInfo?: TokenInfo | null;
  snapshot?: GmgnTokenSnapshot | null;
}): TokenInfo | null {
  const tokenInfo = input.tokenInfo ?? null;
  if (!shouldTryRefreshMigratedSolanaTokenInfo({ tokenAddress: input.tokenAddress, tokenInfo })) {
    return null;
  }
  const baseTokenInfo = tokenInfo as TokenInfo;

  const snapshotPlatform = normalizeSolanaPlatform(input.snapshot?.launchpadPlatform);
  if (!snapshotPlatform) return null;

  const nextTokenInfo: TokenInfo = {
    ...baseTokenInfo,
    launchpad_platform: snapshotPlatform,
    launchpad_status: 1,
  };

  if (!String(nextTokenInfo.launchpad || '').trim()) {
    nextTokenInfo.launchpad = snapshotPlatform;
  }

  const currentProgress = clampLaunchpadProgress(baseTokenInfo.launchpad_progress);
  const nextProgress = clampLaunchpadProgress(nextTokenInfo.launchpad_progress);
  if ((currentProgress ?? 0) < 100 || nextProgress == null) {
    nextTokenInfo.launchpad_progress = 100;
  }

  const migratedSource = resolveKnownSolanaDirectSource(nextTokenInfo, input.tokenAddress);
  if (!migratedSource || migratedSource === 'pumpfun') return null;

  const currentPlatform = normalizeSolanaPlatform(baseTokenInfo.launchpad_platform || baseTokenInfo.launchpad);
  if (currentPlatform === nextTokenInfo.launchpad_platform && Number(baseTokenInfo.launchpad_status ?? NaN) === 1) {
    return null;
  }

  return nextTokenInfo;
}
