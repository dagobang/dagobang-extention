import type { ChainAddress, ChainTxRef } from './address';

export type ChainTradeSide = 'buy' | 'sell';

export type ChainTradeRef = {
  chainId: number;
  side: ChainTradeSide;
  tokenAddress: ChainAddress;
};

export type ChainTradeTiming = {
  submitElapsedMs?: number;
  receiptElapsedMs?: number;
  totalElapsedMs?: number;
};

export type ChainTradeResultRef = ChainTradeRef & {
  tx?: ChainTxRef;
};
