import { ChainId } from '../../chains'

import { ERC20Token } from './constants'

export const CAKE_MAINNET = new ERC20Token(
  ChainId.BNB,
  '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
  18,
  'CAKE',
  'PancakeSwap Token',
  'https://pancakeswap.finance/',
)

export const USDC_BSC = new ERC20Token(
  ChainId.BNB,
  '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  18,
  'USDC',
  'Binance-Peg USD Coin',
  'https://www.centre.io/usdc',
)

export const USDT_BSC = new ERC20Token(
  ChainId.BNB,
  '0x55d398326f99059fF775485246999027B3197955',
  18,
  'USDT',
  'Tether USD',
  'https://tether.to/',
)

export const CAKE = {

  [ChainId.BNB]: CAKE_MAINNET,
} as const satisfies Partial<Record<ChainId, ERC20Token>>

export const USDC = {
  [ChainId.BNB]: USDC_BSC,
} as const satisfies Partial<Record<ChainId, ERC20Token>>

export const USDT = {
  [ChainId.BNB]: USDT_BSC,
} as const satisfies Partial<Record<ChainId, ERC20Token>>

export const STABLE_COIN = {
  [ChainId.BNB]: USDT[ChainId.BNB],
} as const satisfies Partial<Record<ChainId, ERC20Token>>
