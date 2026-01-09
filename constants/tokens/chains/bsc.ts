import { ChainId } from '../../chains'

import { CAKE_MAINNET, USDT_BSC } from './common'
import { ERC20Token, WBNB } from './constants'


export const bscTokens = {
  wbnb: WBNB[ChainId.BNB],
  // bnb here points to the wbnb contract. Wherever the currency BNB is required, conditional checks for the symbol 'BNB' can be used
  bnb: new ERC20Token(
    ChainId.BNB,
    '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    18,
    'BNB',
    'BNB',
    'https://www.binance.com/',
  ),
  cake: CAKE_MAINNET,
  usdt: USDT_BSC,
  usdc: new ERC20Token(
    ChainId.BNB,
    '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    18,
    'USDC',
    'Binance-Peg USD Coin',
    'https://www.centre.io/usdc',
  ),
  u: new ERC20Token(
    ChainId.BNB,
    '0xce24439f2d9c6a2289f741120fe202248b666666',
    18,
    'U',
    'United Stables',
    'https://u.tech',
  ),
  币安人生: new ERC20Token(
    ChainId.BNB,
    '0x924fa68a0fc644485b8df8abfa0a41c2e7744444',
    18,
    '币安人生',
    '币安人生',
    'https://binancelife.meme/',
  ),
  usd1: new ERC20Token(
    ChainId.BNB,
    '0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d',
    18,
    'USD1',
    'USD1',
  ),
  aster: new ERC20Token(
    ChainId.BNB,
    '0x000ae314e2a2172a039b26378814c252734f556a',
    18,
    'ASTER',
    'Aster',
    'https://asterdex.com/',
  ),
}

export const bscBridgeTokenAddresses = [
  bscTokens.wbnb.address,
  bscTokens.cake.address,
  bscTokens.usdt.address,
  bscTokens.usdc.address,
  bscTokens.u.address,
  bscTokens.aster.address,
  bscTokens.usd1.address,
] as const;
