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

export function getBridgeTokenDexPreference(chainId: ChainId, address: string): 'v2' | 'v3' | null {
    if (chainId !== ChainId.BNB) return null;
    const addr = address.toLowerCase();
    if (addr === bscTokens.usdt.address.toLowerCase()) return 'v2';
    if (addr === bscTokens.usdc.address.toLowerCase()) return 'v3';
    if (addr === bscTokens.u.address.toLowerCase()) return 'v3';
    if (addr === bscTokens.aster.address.toLowerCase()) return 'v3';
    if (addr === bscTokens.usd1.address.toLowerCase()) return 'v3';
    return null;
}
