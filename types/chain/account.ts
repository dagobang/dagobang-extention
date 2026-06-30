import type { ChainAddress } from './address';

export type ChainAccountKind = 'evm' | 'solana';

export type ChainAccountRef = {
  chainId: number;
  address: ChainAddress;
};

export type ChainWalletAccount = {
  address: ChainAddress;
  name: string;
  kind?: ChainAccountKind;
};
