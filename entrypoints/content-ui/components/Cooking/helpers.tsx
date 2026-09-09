import { formatUnits } from 'viem';
import type { FlapPresetQuoteToken } from '@/constants/flap';
import {
  rememberCookingLastLaunch,
  type CookingLastLaunch,
} from '@/utils/cookingLaunchWallets';
import {
  COOKING_PANEL_DEFAULT_HEIGHT,
  COOKING_PANEL_MIN_HEIGHT,
  COOKING_PANEL_WIDTH,
} from './constants';
import type { CookingLaunchPlatform } from './types';

export function clampCookingPanelHeight(value: number, panelTop: number) {
  const viewportHeight = window.innerHeight || 0;
  const maxHeight = Math.max(COOKING_PANEL_MIN_HEIGHT, viewportHeight - Math.max(0, panelTop) - 12);
  return Math.min(Math.max(COOKING_PANEL_MIN_HEIGHT, value), maxHeight);
}

export function clampCookingPanelPos(pos: { x: number; y: number }, panelHeight: number) {
  const width = window.innerWidth || 0;
  const height = window.innerHeight || 0;
  const clampedX = Math.min(Math.max(0, pos.x), Math.max(0, width - COOKING_PANEL_WIDTH));
  const clampedY = Math.min(Math.max(0, pos.y), Math.max(0, height - panelHeight));
  return { x: clampedX, y: clampedY };
}

export function pickFirstNonEmpty(...values: Array<string | null | undefined>) {
  for (const value of values) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (normalized) return normalized;
  }
  return '';
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (!result.startsWith('data:image/')) {
        reject(new Error('图片预处理失败'));
        return;
      }
      resolve(result);
    };
    reader.onerror = () => reject(new Error('图片预处理失败'));
    reader.readAsDataURL(blob);
  });
}

export async function resolveLogoUrlToDataUrl(rawUrl: string): Promise<string> {
  const trimmed = rawUrl.trim();
  if (!trimmed) throw new Error('缺少图片地址');
  if (/^data:image\//i.test(trimmed)) return trimmed;
  const response = await fetch(trimmed);
  if (!response.ok) {
    throw new Error(`图片预加载失败：${response.status}`);
  }
  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) {
    throw new Error('图片预加载失败：返回内容不是图片');
  }
  return await blobToDataUrl(blob);
}

export function getPlatformButtonClass(active: boolean) {
  return active
    ? 'border-emerald-400 bg-emerald-500/15 text-emerald-200 shadow-[inset_0_0_0_1px_rgba(74,222,128,0.15)]'
    : 'border-zinc-800 bg-zinc-950/80 text-zinc-300 hover:border-zinc-700 hover:text-zinc-100';
}

export function getTaxChipClass(active: boolean) {
  return active
    ? 'border-emerald-400 bg-emerald-500/10 text-emerald-200'
    : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200';
}

export function renderFlapTokenAvatar(token: FlapPresetQuoteToken, sizeClass = 'h-4 w-4') {
  if (token.iconSrc) {
    return (
      <img
        src={token.iconSrc}
        alt={token.symbol}
        className={`${sizeClass} rounded-full object-cover`}
      />
    );
  }
  return (
    <span className={`${sizeClass} inline-flex items-center justify-center rounded-full bg-zinc-800 text-[9px] font-semibold text-zinc-200`}>
      {token.symbol.slice(0, 1)}
    </span>
  );
}

export function isCookingLaunchPlatform(value: unknown): value is CookingLaunchPlatform {
  return value === 'fourmeme' || value === 'flap' || value === 'flap_stocks' || value === 'openfour';
}

export function getCookingLaunchFallbackLink(platform: CookingLaunchPlatform, tokenAddress: string) {
  if (platform === 'fourmeme' || platform === 'openfour') {
    return `https://four.meme/zh-TW/token/${tokenAddress}`;
  }
  if (platform === 'flap' || platform === 'flap_stocks') {
    return `https://gmgn.ai/bsc/token/${tokenAddress}`;
  }
  return '';
}

export function rememberLaunchToken(input: {
  tokenAddress?: string | null;
  walletAddress?: string | null;
  symbol?: string;
  name?: string;
}): CookingLastLaunch | null {
  const token = String(input.tokenAddress || '').trim();
  const wallet = String(input.walletAddress || '').trim();
  if (!token || !wallet) return null;
  return rememberCookingLastLaunch({
    tokenAddress: token,
    walletAddress: wallet,
    symbol: input.symbol,
    name: input.name,
  });
}

export function formatLaunchTokenBalance(wei: string, decimals = 18) {
  try {
    const raw = formatUnits(BigInt(wei || '0'), decimals);
    const num = Number(raw);
    if (!Number.isFinite(num) || num <= 0) return '0';
    if (num >= 1000) return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return num.toLocaleString(undefined, { maximumFractionDigits: 4 });
  } catch {
    return '0';
  }
}

export { COOKING_PANEL_DEFAULT_HEIGHT };
