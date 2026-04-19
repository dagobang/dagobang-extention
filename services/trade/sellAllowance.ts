import { erc20Abi } from 'viem';
import type { TokenInfo } from '../../types/token';
import { ZERO_ADDRESS } from './tradeTypes';
import { getBridgeToken } from './tradeDex';

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
}): Promise<SellAllowanceCheckResult> {
  const spenders = getSellSpenders({
    chainId: input.chainId,
    tokenInfo: input.tokenInfo,
    routerAddress: input.routerAddress,
    extraSpenders: input.extraSpenders,
    getLaunchpadManager: input.getLaunchpadManager,
  });
  const checked: Array<{ token: string; spender: string; allowance: string }> = [];
  for (const spender of spenders) {
    const allowance = await input.client.readContract({
      address: input.tokenAddress as `0x${string}`,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [input.owner, spender as `0x${string}`]
    });
    checked.push({ token: input.tokenAddress, spender, allowance: String(allowance) });
    if (allowance < input.maxUint256 / 2n) return { insufficient: true, checked };
  }

  const platform = input.tokenInfo.launchpad_platform?.toLowerCase() || '';
  const isInnerFourMeme = input.isInnerDisk(input.tokenInfo) && platform.includes('fourmeme');
  const bridgeToken = isInnerFourMeme
    ? getBridgeToken(input.chainId, input.tokenInfo.address, input.tokenInfo.quote_token_address)
    : null;
  if (bridgeToken && bridgeToken !== ZERO_ADDRESS) {
    const allowance = await input.client.readContract({
      address: bridgeToken as `0x${string}`,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [input.owner, input.routerAddress as `0x${string}`]
    });
    checked.push({ token: bridgeToken, spender: input.routerAddress, allowance: String(allowance) });
    if (allowance < input.maxUint256 / 2n) return { insufficient: true, checked };
  }

  return { insufficient: false, checked };
}
