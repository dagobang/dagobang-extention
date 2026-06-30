import { ChainId } from '@/constants/chains/chainId';
import { evmWalletAdapter } from './evm/evmWalletAdapter';
import { evmTradeExecutor } from './evm/evmTradeExecutor';
import { solanaTradeExecutor } from './solana/solanaTradeExecutor';
import { solanaWalletAdapter } from './solana/solanaWalletAdapter';
import type { TradeExecutor, WalletAdapter } from './types';

export function getWalletAdapter(chainId?: number): WalletAdapter {
  if (chainId === ChainId.SOL) {
    return solanaWalletAdapter;
  }
  return evmWalletAdapter;
}

export function getTradeExecutor(chainId: number): TradeExecutor {
  if (chainId === ChainId.SOL) {
    return solanaTradeExecutor;
  }
  return evmTradeExecutor;
}
