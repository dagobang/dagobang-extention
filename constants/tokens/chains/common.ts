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

export const USDC_HYPER = new ERC20Token(
  ChainId.HYPER,
  '0xb88339CB7199b77E23DB6E890353E22632Ba630f',
  6,
  'USDC',
  'USD Coin',
  'https://www.circle.com/usdc',
)

export const USDG_RH = new ERC20Token(
  ChainId.RH,
  '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  6,
  'USDG',
  'Global Dollar',
  'https://www.paxos.com/global-dollar',
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
  [ChainId.HYPER]: USDC_HYPER,
  [ChainId.RH]: USDG_RH,
} as const satisfies Partial<Record<ChainId, ERC20Token>>

export const USDT = {
  [ChainId.BNB]: USDT_BSC,
} as const satisfies Partial<Record<ChainId, ERC20Token>>

export const STABLE_COIN = {
  [ChainId.BNB]: USDT[ChainId.BNB],
} as const satisfies Partial<Record<ChainId, ERC20Token>>
