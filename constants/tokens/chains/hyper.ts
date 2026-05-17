import type { Address } from 'viem'

import { ChainId } from '../../chains'
import { ERC20Token, WNATIVE } from './constants'

export const hyperTokens = {
  whype: WNATIVE[ChainId.HYPER]!,
  hype: new ERC20Token(
    ChainId.HYPER,
    '0x5555555555555555555555555555555555555555',
    18,
    'HYPE',
    'Hyperliquid',
    'https://hyperliquid.xyz/',
  ),
  usdc: new ERC20Token(
    ChainId.HYPER,
    '0xb88339CB7199b77E23DB6E890353E22632Ba630f',
    6,
    'USDC',
    'USD Coin',
    'https://www.circle.com/usdc',
  ),
} as const

export const hyperBridgeTokenAddresses = [
  hyperTokens.whype.address,
  hyperTokens.usdc.address,
] as const

export type HyperNativeBridgePoolConfig =
  | { kind: 'v2'; poolAddress: Address }
  | { kind: 'v3'; poolAddress: Address; fee: number }

export const hyperNativeBridgePoolConfigByTokenAddress: Record<string, HyperNativeBridgePoolConfig> = {
  [hyperTokens.usdc.address.toLowerCase()]: {
    kind: 'v3',
    poolAddress: '0xe712d505572b3f84c1b4deb99e1beab9dd0e23c9',
    fee: 3000,
  },
}
