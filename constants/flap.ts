import type { Address } from 'viem';

import { ChainId } from './chains/chainId';

export const FlapTaxTokenHelperAddress: Partial<Record<ChainId, Address>> = {
  [ChainId.BNB]: '0x53841c73217735F37BC1775538b03b23feFD8346',
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
