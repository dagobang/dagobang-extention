import type { ChainAddress } from '@/types/chain/address';

export const COOKING_LAST_LAUNCH_STORAGE_KEY = 'dagobang_cooking_last_launch_v1';
export const COOKING_LAST_LAUNCH_EVENT = 'dagobang:cooking-last-launch';

export type CookingLastLaunch = {
  tokenAddress: ChainAddress;
  walletAddress: ChainAddress;
  symbol: string;
  name: string;
  at: number;
};

export function readCookingLastLaunch(): CookingLastLaunch | null {
  try {
    const raw = window.localStorage.getItem(COOKING_LAST_LAUNCH_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    const tokenAddress = String(parsed?.tokenAddress || '').trim();
    const walletAddress = String(parsed?.walletAddress || '').trim();
    if (!tokenAddress || !walletAddress) return null;
    return {
      tokenAddress: tokenAddress as ChainAddress,
      walletAddress: walletAddress as ChainAddress,
      symbol: String(parsed?.symbol || '').trim(),
      name: String(parsed?.name || '').trim(),
      at: Number(parsed?.at) || Date.now(),
    };
  } catch {
    return null;
  }
}

export function rememberCookingLastLaunch(input: {
  tokenAddress: string;
  walletAddress: string;
  symbol?: string;
  name?: string;
}): CookingLastLaunch | null {
  const tokenAddress = String(input.tokenAddress || '').trim();
  const walletAddress = String(input.walletAddress || '').trim();
  if (!tokenAddress || !walletAddress) return readCookingLastLaunch();
  const next: CookingLastLaunch = {
    tokenAddress: tokenAddress as ChainAddress,
    walletAddress: walletAddress as ChainAddress,
    symbol: String(input.symbol || '').trim(),
    name: String(input.name || '').trim(),
    at: Date.now(),
  };
  window.localStorage.setItem(COOKING_LAST_LAUNCH_STORAGE_KEY, JSON.stringify(next));
  try {
    window.dispatchEvent(new CustomEvent(COOKING_LAST_LAUNCH_EVENT, { detail: next }));
  } catch {
  }
  return next;
}

export function clearCookingLastLaunch(): void {
  window.localStorage.removeItem(COOKING_LAST_LAUNCH_STORAGE_KEY);
  try {
    window.dispatchEvent(new CustomEvent(COOKING_LAST_LAUNCH_EVENT, { detail: null }));
  } catch {
  }
}
