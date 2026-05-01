import { Address, Hash } from 'viem'


import { ChainId } from '../../chains'
import { ERC20Token } from '../_base'

export const FACTORY_ADDRESS = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73'

export const FACTORY_ADDRESS_MAP = {
  [ChainId.ETH]: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
  [ChainId.BNB]: FACTORY_ADDRESS,
} as const satisfies Partial<Record<ChainId, Address>>

export const INIT_CODE_HASH = '0x00fb7f630766e6a796048ea87d01acd3068e8ff67d078148a3fa3f4a84f69bd5'
export const INIT_CODE_HASH_MAP = {
  [ChainId.ETH]: '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbe7f5f4f7f1a6f6f7cc',
  [ChainId.BNB]: INIT_CODE_HASH,
} as const satisfies Partial<Record<ChainId, Hash>>

export const WETH9 = {
  [ChainId.ETH]: new ERC20Token(
    ChainId.ETH,
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    18,
    'WETH',
    'Wrapped Ether',
    'https://ethereum.org'
  ),
  [ChainId.BNB]: new ERC20Token(
    ChainId.BNB,
    '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
    18,
    'ETH',
    'Binance-Peg Ethereum Token',
    'https://ethereum.org'
  ),
} as const satisfies Partial<Record<ChainId, ERC20Token>>

export const WBNB = {

  [ChainId.BNB]: new ERC20Token(
    ChainId.BNB,
    '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    18,
    'WBNB',
    'Wrapped BNB',
    'https://www.binance.org'
  ),
} as const satisfies Partial<Record<ChainId, ERC20Token>>

export const WNATIVE = {
  [ChainId.ETH]: WETH9[ChainId.ETH]!,
  [ChainId.BNB]: WBNB[ChainId.BNB]!,
} as const satisfies Partial<Record<ChainId, ERC20Token>>

const ETH = {
  name: 'Ether',
  symbol: 'ETH',
  decimals: 18,
} as const

const BNB = {
  name: 'Binance Chain Native Token',
  symbol: 'BNB',
  decimals: 18,
} as const

export const NATIVE = {
  [ChainId.ETH]: ETH,
  [ChainId.BNB]: BNB,
} as const satisfies Partial<Record<ChainId, { name: string; symbol: string; decimals: number }>>

export { ERC20Token }
