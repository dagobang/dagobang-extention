import { ChainId } from '../chains'
import { ERC20Token } from './_base'

import { bscTokens } from './chains/bsc'
import { bscBridgeTokenAddresses } from './chains/bsc'

export const allTokens: Partial<Record<ChainId, Record<string, ERC20Token>>> = {
    [ChainId.BNB]: bscTokens
}

export const bridgeTokenAddressesByChain: Partial<Record<ChainId, readonly `0x${string}`[]>> = {
    [ChainId.BNB]: bscBridgeTokenAddresses as unknown as readonly `0x${string}`[],
    [ChainId.SOL]: [],
}

export function getBridgeTokenAddresses(chainId: ChainId): readonly `0x${string}`[] {
    return bridgeTokenAddressesByChain[chainId] ?? []
}

/**
 * Helper to determine quote token symbol from address
 */
export function getQuoteTokenSymbol(chainId: ChainId, address: string): string {
    const addr = address.toLowerCase();
    const bridgeTokens = getBridgeTokenAddresses(chainId);
    const token = bridgeTokens.find((x) => x.toLowerCase() === addr.toLowerCase());
    return token ? allTokens[chainId]?.[token]?.symbol ?? 'UNKNOWN' : 'UNKNOWN';
}

