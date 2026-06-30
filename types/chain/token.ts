import type { ChainAddress } from './address';

export type ChainTokenRef = {
  chainId: number;
  tokenAddress: ChainAddress;
};

export type ChainTokenBalanceRef = ChainTokenRef & {
  ownerAddress: ChainAddress;
};
