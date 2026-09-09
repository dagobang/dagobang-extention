import type { Address } from 'viem';

import { ChainId } from './chains/chainId';
import { bscTokens } from './tokens/chains/bsc';

export const FlapTaxTokenHelperAddress: Partial<Record<ChainId, Address>> = {
  [ChainId.BNB]: '0x53841c73217735F37BC1775538b03b23feFD8346',
};

export const FlapPortalAddress: Partial<Record<ChainId, Address>> = {
  [ChainId.BNB]: '0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0',
};

export const FlapVaultPortalAddress: Partial<Record<ChainId, Address>> = {
  [ChainId.BNB]: '0x90497450f2a706f1951b5bdda52B4E5d16f34C06',
};

export const FlapStocksVaultFactoryAddress: Partial<Record<ChainId, Address>> = {
  [ChainId.BNB]: '0x5418f7e8fF90354DB0eCD48c8b710219244Eb3C5',
};

export const FlapTokenImplByChain: Partial<Record<ChainId, {
  standard: Address;
  standardV3: Address;
  taxV3: Address;
}>> = {
  [ChainId.BNB]: {
    standard: '0x8b4329947e34b6d56d71a3385cac122bade7d78d',
    standardV3: '0x88881b6f03090462a969eC7f48385744Eeb63333',
    taxV3: '0x024f18294970B5c76c0691b87f138A0317156422',
  },
};

export const FLAP_MAGIC_DIVIDEND_SELF = '0xfEEDFEEDfeEDFEedFEEdFEEDFeEdfEEdFeEdFEEd' as const;
export const FLAP_MAGIC_DIVIDEND_STOCKS = '0xC0Dec0dec0DeC0Dec0dEc0DEC0DEC0DEC0DEC0dE' as const;

export const FlapUploadApiUrl = 'https://funcs.flap.sh/api/upload';
export const FlapSwapRegistryAddress: Partial<Record<ChainId, Address>> = {
  [ChainId.BNB]: '0x644A8f560138418bAD4EdEFC7c17878a3c2fBEB6',
};

export const FlapStocksVaultFactoriesByChain: Partial<Record<ChainId, Record<string, 1 | 2 | 3>>> = {
  [ChainId.BNB]: {
    '0xf8ac088f06d155f3c3f531f1ef80b14f1604530a': 1,
    '0x40a9a2fda017e0923ea0b403f2f063f9e51168fb': 2,
    '0x5418f7e8ff90354db0ecd48c8b710219244eb3c5': 3,
  },
};

export function getFlapStocksVaultVersion(chainId: number, factoryAddress?: string | null): 1 | 2 | 3 | null {
  const key = String(factoryAddress || '').trim().toLowerCase();
  if (!key) return null;
  return FlapStocksVaultFactoriesByChain[chainId as ChainId]?.[key] ?? null;
}

export type FlapQuoteTokenCategory = 'crypto' | 'rwa';

export const FLAP_CUSTOM_QUOTE_ID = 'custom';

export type FlapPresetQuoteToken = {
  id: string;
  symbol: string;
  label: string;
  address: Address;
  decimals: number;
  category: FlapQuoteTokenCategory;
  iconSrc?: string;
  tags?: readonly string[];
  isNative?: boolean;
};

export type FlapCustomQuoteToken = {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  iconSrc?: string;
};

export function toFlapPresetFromCustom(token: FlapCustomQuoteToken): FlapPresetQuoteToken {
  const symbol = token.symbol || token.name || 'TOKEN';
  return {
    id: FLAP_CUSTOM_QUOTE_ID,
    symbol,
    label: symbol,
    address: token.address,
    decimals: token.decimals,
    category: 'crypto',
    iconSrc: token.iconSrc,
  };
}

export const FlapQuoteTokensByChain: Partial<Record<ChainId, readonly FlapPresetQuoteToken[]>> = {
  [ChainId.BNB]: [
    {
      id: 'bnb',
      symbol: 'BNB',
      label: 'BNB',
      address: '0x0000000000000000000000000000000000000000',
      decimals: 18,
      category: 'crypto',
      isNative: true,
    },
    {
      id: 'usdt',
      symbol: 'USDT',
      label: 'USDT',
      address: bscTokens.usdt.address,
      decimals: 18,
      category: 'crypto',
    },
    {
      id: 'usdc',
      symbol: 'USDC',
      label: 'USDC',
      address: bscTokens.usdc.address,
      decimals: 18,
      category: 'crypto',
    },
    {
      id: 'busd',
      symbol: 'BUSD',
      label: 'BUSD',
      address: bscTokens.busd.address,
      decimals: 18,
      category: 'crypto',
    },
    {
      id: 'usd1',
      symbol: 'USD1',
      label: 'USD1',
      address: bscTokens.usd1.address,
      decimals: 18,
      category: 'crypto',
    },
    {
      id: 'spcxb',
      symbol: 'SPCXB',
      label: 'SPCXB',
      address: '0xbe9D156892E55e7154BcD3cB0FEA677F9D3103E1',
      decimals: 18,
      category: 'rwa',
      iconSrc: '/static/quotes/spcxb.png',
      tags: ['rwa'],
    },
    {
      id: 'skhyb',
      symbol: 'SKHYB',
      label: 'SKHYB',
      address: '0xCA750eF65f295BBECd685Abf54e82CAf297BDB61',
      decimals: 18,
      category: 'rwa',
      iconSrc: '/static/quotes/skhyb.png',
      tags: ['rwa'],
    },
    {
      id: 'spyb',
      symbol: 'SPYB',
      label: 'SPYB',
      address: '0x7138b48df7D98D7e3cc221BfE7192D0a178182D8',
      decimals: 18,
      category: 'rwa',
      iconSrc: '/static/quotes/spyb.png',
      tags: ['rwa'],
    },
    {
      id: 'xaut',
      symbol: 'XAUT',
      label: 'XAUT',
      address: '0x21cAef8A43163Eea865baeE23b9C2E327696A3bf',
      decimals: 6,
      category: 'rwa',
    },
    {
      id: 'qqqb',
      symbol: 'QQQB',
      label: 'QQQB',
      address: '0x205812CdBed920aFf76C6580abD681a46D11efc7',
      decimals: 18,
      category: 'rwa',
      iconSrc: '/static/quotes/qqqb.png',
      tags: ['rwa'],
    },
    {
      id: 'nvdab',
      symbol: 'NVDAB',
      label: 'NVDAB',
      address: '0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436',
      decimals: 18,
      category: 'rwa',
      iconSrc: '/static/quotes/nvdab.png',
      tags: ['rwa'],
    },
    {
      id: 'aaplb',
      symbol: 'AAPLB',
      label: 'AAPLB',
      address: '0x431a3BEE82E2ca41e49895CbECE5bB0F76A89b7A',
      decimals: 18,
      category: 'rwa',
      iconSrc: '/static/quotes/aaplb.png',
      tags: ['rwa'],
    },
    {
      id: 'tslab',
      symbol: 'TSLAB',
      label: 'TSLAB',
      address: '0x5b1910eAaD6450E50f816082Aa078C41F10C292f',
      decimals: 18,
      category: 'rwa',
      iconSrc: '/static/quotes/tslab.png',
      tags: ['rwa'],
    },
    {
      id: 'msftb',
      symbol: 'MSFTB',
      label: 'MSFTB',
      address: '0x80106cb3EAD06659A5ad19DF39D9b4733863B9b0',
      decimals: 18,
      category: 'rwa',
      iconSrc: '/static/quotes/msftb.png',
      tags: ['rwa'],
    },
    {
      id: 'googlb',
      symbol: 'GOOGLB',
      label: 'GOOGLB',
      address: '0x3F53De71c126BdaBAe20f9cD64848d317f6C3238',
      decimals: 18,
      category: 'rwa',
      iconSrc: '/static/quotes/googlb.png',
      tags: ['rwa'],
    },
    {
      id: 'btcb',
      symbol: 'BTCB',
      label: 'BTCB',
      address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c',
      decimals: 18,
      category: 'crypto',
      iconSrc: '/static/quotes/btcb.png',
    },
    {
      id: 'solb',
      symbol: 'SOLB',
      label: 'SOLB',
      address: '0x570A5D26f7765Ecb712C0924E4De545B89fD43dF',
      decimals: 18,
      category: 'crypto',
      iconSrc: '/static/quotes/solb.png',
    },
    {
      id: 'hoodb',
      symbol: 'HOODB',
      label: 'HOODB',
      address: '0xA394dCEa3fd3847fD793afBFd163E2e3858B7c65',
      decimals: 18,
      category: 'rwa',
      iconSrc: '/static/quotes/hoodb.png',
      tags: ['rwa'],
    },
    {
      id: 'babab',
      symbol: 'BABAB',
      label: 'BABAB',
      address: '0x4eF9d3062c7F6ebA4AAE4990c5036598C6eff4ec',
      decimals: 18,
      category: 'rwa',
      iconSrc: '/static/quotes/babab.png',
      tags: ['rwa'],
    },
    {
      id: 'gmeb',
      symbol: 'GMEB',
      label: 'GMEB',
      address: '0x46cEeFDa28Dd7207059ed19B0acdc026955bb15C',
      decimals: 18,
      category: 'rwa',
      iconSrc: '/static/quotes/gmeb.png',
      tags: ['rwa'],
    },
    {
      id: 'mstrb',
      symbol: 'MSTRB',
      label: 'MSTRB',
      address: '0xE87afb3076AeB0f9B14E368DE8145ae6a2826A14',
      decimals: 18,
      category: 'rwa',
      iconSrc: '/static/quotes/mstrb.png',
      tags: ['rwa'],
    },
        {
      id: 'djtb',
      symbol: 'DJTB',
      label: 'DJTB',
      address: '0xF2ec508422174Ee564de98187db9359D318AFB6b',
      decimals: 18,
      category: 'rwa',
      iconSrc: '/static/quotes/djtb.png',
      tags: ['rwa'],
    },
  ],
};

export function getFlapStocksPresetTokens(chainId: number): readonly FlapPresetQuoteToken[] {
  return (FlapQuoteTokensByChain[chainId as ChainId] ?? []).filter((item) => item.category === 'rwa');
}
