import { ChainId } from '../chains'
import { ERC20Token } from './_base'

import { bscTokens } from './chains/bsc'
import { bscBridgeTokenAddresses } from './chains/bsc'
import { bscBnbBridgePoolConfigByTokenAddress, type BscBnbBridgePoolConfig } from './chains/bsc'
import { ethTokens } from './chains/eth'
import { ethBridgeTokenAddresses } from './chains/eth'
import { ethEthBridgePoolConfigByTokenAddress, type EthNativeBridgePoolConfig } from './chains/eth'
import { hyperTokens } from './chains/hyper'
import { hyperBridgeTokenAddresses } from './chains/hyper'
import { hyperNativeBridgePoolConfigByTokenAddress, type HyperNativeBridgePoolConfig } from './chains/hyper'

export const allTokens: Partial<Record<ChainId, Record<string, ERC20Token>>> = {
    [ChainId.ETH]: ethTokens,
    [ChainId.BNB]: bscTokens,
    [ChainId.HYPER]: hyperTokens,
}

export const bridgeTokenAddressesByChain: Partial<Record<ChainId, readonly `0x${string}`[]>> = {
    [ChainId.ETH]: ethBridgeTokenAddresses as unknown as readonly `0x${string}`[],
    [ChainId.BNB]: bscBridgeTokenAddresses as unknown as readonly `0x${string}`[],
    [ChainId.HYPER]: hyperBridgeTokenAddresses as unknown as readonly `0x${string}`[],
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

export function getQuoteTokenAddress(chainId: ChainId, symbol: string): string {
    return allTokens[chainId]?.[symbol.toLocaleLowerCase()]?.address ?? ''
}

export function getBridgeTokenDexPreference(chainId: ChainId, address: string): 'v2' | 'v3' | null {
    if (chainId === ChainId.ETH) {
        const addr = address.toLowerCase();
        if (addr === ethTokens.usdt.address.toLowerCase()) return 'v2';
        if (addr === ethTokens.usdc.address.toLowerCase()) return 'v3';
        return null;
    }
    if (chainId === ChainId.HYPER) {
        const addr = address.toLowerCase();
        if (addr === hyperTokens.usdc.address.toLowerCase()) return 'v3';
        return null;
    }
    if (chainId !== ChainId.BNB) return null;
    const addr = address.toLowerCase();
    if (addr === bscTokens.usdt.address.toLowerCase()) return 'v2';
    if (addr === bscTokens.usdc.address.toLowerCase()) return 'v3';
    if (addr === bscTokens.u.address.toLowerCase()) return 'v3';
    if (addr === bscTokens.aster.address.toLowerCase()) return 'v3';
    if (addr === bscTokens.usd1.address.toLowerCase()) return 'v3';
    if (addr === bscTokens.form.address.toLowerCase()) return 'v2';
    if (addr === bscTokens.币安人生.address.toLowerCase()) return 'v2';
    return null;
}

export type BridgeHopPoolConfig = BscBnbBridgePoolConfig | EthNativeBridgePoolConfig | HyperNativeBridgePoolConfig

export function getBnbToBridgeTokenPoolConfig(chainId: ChainId, tokenOutAddress: string): BridgeHopPoolConfig | null {
    if (chainId === ChainId.ETH) {
        const k = tokenOutAddress.toLowerCase();
        return ethEthBridgePoolConfigByTokenAddress[k] ?? null;
    }
    if (chainId === ChainId.HYPER) {
        const k = tokenOutAddress.toLowerCase();
        return hyperNativeBridgePoolConfigByTokenAddress[k] ?? null;
    }
    if (chainId !== ChainId.BNB) return null
    const k = tokenOutAddress.toLowerCase()
    return bscBnbBridgePoolConfigByTokenAddress[k] ?? null
}

export const getNativeToBridgeTokenPoolConfig = getBnbToBridgeTokenPoolConfig
