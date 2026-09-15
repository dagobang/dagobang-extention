import { getAddress, type Address } from 'viem';
import { ChainId } from '@/constants/chains';

export const OPENFOUR_4STOCK_MODE = '4stock' as const;
export type OpenFourLaunchMode = typeof OPENFOUR_4STOCK_MODE;

export const OPENFOUR_LAUNCH_MODES = [
  {
    value: OPENFOUR_4STOCK_MODE,
    label: '4Stock',
    tag: 'Stock',
    descr: 'Four.Meme 预发币股模板，以内盘 quote 募集（当前为 BNC4）。',
  },
] as const;

export const OPENFOUR_4STOCK_QUOTE_FALLBACK = {
  chainId: ChainId.BNB,
  symbol: 'BNC4',
  // OpenFour 4Stock 实际 quote：4Stock 代币 tokens().quoteAsset
  address: getAddress('0x7C8D5502b544dDAf8852Fc46D1174E34876D545C'),
  decimals: 18,
  raisedAmount: '2000',
};

export type OpenFour4StockTemplate = {
  mode: OpenFourLaunchMode;
  templateId: string;
  name: string;
  tag: string;
  descr: string;
  quoteSymbol: string;
  quoteAddress: Address;
  quoteDecimals: number;
  raisedAmount: string;
  saleAmount: string;
  totalSupply: string;
  createFee: string;
};

export const OPENFOUR_4STOCK_TEMPLATE: OpenFour4StockTemplate = {
  mode: OPENFOUR_4STOCK_MODE,
  // Registry.getPreset 链上 4Stock preset，禁止再走 Four.Meme HTTP 搜索
  templateId: '1778027615733',
  name: '4STOCK',
  tag: 'Stock',
  descr: 'Four.Meme 预发币股模板，以内盘 quote 募集（当前为 BNC4）。',
  quoteSymbol: OPENFOUR_4STOCK_QUOTE_FALLBACK.symbol,
  quoteAddress: OPENFOUR_4STOCK_QUOTE_FALLBACK.address,
  quoteDecimals: OPENFOUR_4STOCK_QUOTE_FALLBACK.decimals,
  raisedAmount: OPENFOUR_4STOCK_QUOTE_FALLBACK.raisedAmount,
  saleAmount: '800000000',
  totalSupply: '1000000000',
  createFee: '0',
};

export function getOpenFour4StockTemplate(): OpenFour4StockTemplate {
  return OPENFOUR_4STOCK_TEMPLATE;
}

export function isOpenFour4StockName(name: string, tag?: string) {
  const haystack = `${name} ${tag || ''}`.replace(/[\s_-]+/g, '').toLowerCase();
  return haystack.includes('4stock');
}

export function isBinance4StockTicker(symbol?: string | null): boolean {
  const value = String(symbol || '').trim().toUpperCase();
  if (!value || value === 'BNC4') return false;
  if (value.includes('4STOCK')) return true;
  return /^BNC[A-Z0-9]{1,8}$/.test(value);
}
