import { ChainId } from '../../chains'
import { USDG_RH } from './common'
import { ERC20Token, WNATIVE } from './constants'

export const rhTokens = {
  weth: WNATIVE[ChainId.RH]!,
  eth: new ERC20Token(
    ChainId.RH,
    '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
    18,
    'ETH',
    'Ether',
    'https://ethereum.org/',
  ),
  usdg: USDG_RH,
} as const

export const rhBridgeTokenAddresses = [
  rhTokens.weth.address,
  rhTokens.usdg.address,
] as const
