import { getAddress, erc20Abi, type Address } from 'viem';
import type { TokenInfo } from '../../types/token';
import { ZERO_ADDRESS } from './tradeTypes';
import { getBridgeToken } from './tradeDex';
import { isTradeRouteTerminalQuote } from '@/utils/tradeRouteTerminals';

export type SellAllowanceCheckResult = {
  insufficient: boolean;
  checked: Array<{ token: string; spender: string; allowance: string }>;
};

export function getSellSpenders(input: {
  chainId: number;
  tokenInfo: TokenInfo;
  routerAddress: string;
  extraSpenders?: string[];
  getLaunchpadManager: (tokenInfo: TokenInfo, chainId: number) => string | null;
}): string[] {
  const spenders: string[] = [input.routerAddress];
  const launchpadManager = input.getLaunchpadManager(input.tokenInfo, input.chainId);
  if (
    launchpadManager &&
    launchpadManager !== ZERO_ADDRESS &&
    launchpadManager.toLowerCase() !== input.routerAddress.toLowerCase()
  ) {
    spenders.push(launchpadManager);
  }
  for (const s of input.extraSpenders ?? []) {
    const v = String(s || '').trim();
    if (!v || v === ZERO_ADDRESS) continue;
    if (spenders.some((x) => x.toLowerCase() === v.toLowerCase())) continue;
    spenders.push(v);
  }
  return spenders;
}

/**
 * Tokens the router may transferFrom from the user on sell — beyond the meme token itself.
 *
 * Four.meme V2 multi-hop (DagobangRouter): after sellToToken credits quote to the user,
 * the router does `safeTransferFrom(user, router, amountOut)` on the quote before DEX hops.
 * That quote is often a non-allowlisted asset (e.g. DJTB), so getBridgeToken alone misses it.
 */
export function getSellQuotePullbackTokens(input: {
  chainId: number;
  tokenAddress: string;
  tokenInfo: TokenInfo;
  isInnerDisk: (tokenInfo: TokenInfo) => boolean;
}): Address[] {
  const out: Address[] = [];
  const push = (raw: string | null | undefined) => {
    const v = String(raw || '').trim();
    if (!/^0x[a-fA-F0-9]{40}$/i.test(v)) return;
    let addr: Address;
    try {
      addr = getAddress(v as Address);
    } catch {
      return;
    }
    if (addr.toLowerCase() === ZERO_ADDRESS.toLowerCase()) return;
    if (addr.toLowerCase() === input.tokenAddress.toLowerCase()) return;
    if (isTradeRouteTerminalQuote(input.chainId, addr)) return;
    if (out.some((x) => x.toLowerCase() === addr.toLowerCase())) return;
    out.push(addr);
  };

  const platform = input.tokenInfo.launchpad_platform?.toLowerCase() || '';
  const isInner = input.isInnerDisk(input.tokenInfo);

  // Allowlisted bridge quotes (USDT/USD1/…).
  push(getBridgeToken(input.chainId, input.tokenAddress, input.tokenInfo.quote_token_address) ?? undefined);

  // Inner four.meme / any inner launchpad with a declared non-terminal quote:
  // router may pull that quote back after the launchpad hop.
  if (isInner && (platform.includes('four') || platform.startsWith('flap') || platform.includes('openfour'))) {
    push(input.tokenInfo.quote_token_address);
  }

  return out;
}

export async function hasInsufficientSellAllowance(input: {
  chainId: number;
  tokenAddress: string;
  tokenInfo: TokenInfo;
  owner: `0x${string}`;
  client: any;
  maxUint256: bigint;
  routerAddress: string;
  extraSpenders?: string[];
  getLaunchpadManager: (tokenInfo: TokenInfo, chainId: number) => string | null;
  isInnerDisk: (tokenInfo: TokenInfo) => boolean;
  /** When set, require at least this much allowance (not only max/2). */
  requiredAmount?: bigint;
}): Promise<SellAllowanceCheckResult> {
  const spenders = getSellSpenders({
    chainId: input.chainId,
    tokenInfo: input.tokenInfo,
    routerAddress: input.routerAddress,
    extraSpenders: input.extraSpenders,
    getLaunchpadManager: input.getLaunchpadManager,
  });
  const minRequired = input.requiredAmount && input.requiredAmount > 0n
    ? input.requiredAmount
    : (input.maxUint256 / 2n);
  const checked: Array<{ token: string; spender: string; allowance: string }> = [];
  let routerOk = false;
  for (const spender of spenders) {
    const allowance = await input.client.readContract({
      address: input.tokenAddress as `0x${string}`,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [input.owner, spender as `0x${string}`]
    }) as bigint;
    checked.push({ token: input.tokenAddress, spender, allowance: String(allowance) });
    const enough = allowance >= minRequired;
    if (spender.toLowerCase() === input.routerAddress.toLowerCase()) {
      routerOk = enough;
    }
    if (!enough) return { insufficient: true, checked };
  }

  // Sell meme-token pull (or four.meme V1) needs router allowance on the token itself.
  // Four.meme V2 skips the router pull on the meme token, but we still require it when
  // router is in the spender list (harmless max-approve; UI stays consistent).
  if (!routerOk) {
    return { insufficient: true, checked };
  }

  const pullbackTokens = getSellQuotePullbackTokens({
    chainId: input.chainId,
    tokenAddress: input.tokenAddress,
    tokenInfo: input.tokenInfo,
    isInnerDisk: input.isInnerDisk,
  });
  for (const pullToken of pullbackTokens) {
    const allowance = await input.client.readContract({
      address: pullToken,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [input.owner, input.routerAddress as `0x${string}`]
    }) as bigint;
    checked.push({ token: pullToken, spender: input.routerAddress, allowance: String(allowance) });
    if (allowance < minRequired) return { insufficient: true, checked };
  }

  return { insufficient: false, checked };
}
