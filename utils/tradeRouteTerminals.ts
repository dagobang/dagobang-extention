import { ChainId } from '@/constants/chains/chainId';
import { getChainRuntime } from '@/constants/chains/runtime';
import { USDC, USDT } from '@/constants/tokens/chains/common';
import { bscTokens } from '@/constants/tokens/chains/bsc';
import { ethTokens } from '@/constants/tokens/chains/eth';
import { hyperTokens } from '@/constants/tokens/chains/hyper';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function addAddress(out: string[], address?: string | null) {
  const value = String(address || '').trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) return;
  const lower = value.toLowerCase();
  if (out.some((item) => item.toLowerCase() === lower)) return;
  out.push(value);
}

/** Native + wrapped native + stables used as 底池 terminals. Not CAKE/ASTER/etc. */
export function getTradeRouteStableAddresses(chainId: number): string[] {
  const out: string[] = [];
  addAddress(out, USDT[chainId as ChainId]?.address);
  addAddress(out, USDC[chainId as ChainId]?.address);
  if (chainId === ChainId.BNB) addAddress(out, bscTokens.usd1.address);
  if (chainId === ChainId.ETH) {
    addAddress(out, ethTokens.usdt.address);
    addAddress(out, ethTokens.usdc.address);
  }
  if (chainId === ChainId.HYPER) addAddress(out, hyperTokens.usdc.address);
  return out;
}

export function normalizeTradeRouteToken(chainId: number, address?: string | null): string | null {
  const raw = String(address || '').trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) return null;
  const lower = raw.toLowerCase();
  if (lower === ZERO_ADDRESS) return ZERO_ADDRESS;
  const wrapped = getChainRuntime(chainId)?.wrappedNativeAddress?.toLowerCase();
  if (wrapped && lower === wrapped) return ZERO_ADDRESS;
  return raw;
}

export function isTradeRouteNativeToken(chainId: number, address?: string | null): boolean {
  return normalizeTradeRouteToken(chainId, address) === ZERO_ADDRESS;
}

export function isTradeRouteTerminalQuote(chainId: number, address?: string | null): boolean {
  const normalized = normalizeTradeRouteToken(chainId, address);
  if (!normalized) return false;
  if (normalized === ZERO_ADDRESS) return true;
  return getTradeRouteStableAddresses(chainId).some((item) => item.toLowerCase() === normalized.toLowerCase());
}
