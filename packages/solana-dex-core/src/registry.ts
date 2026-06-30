import { jupiterTradeAdapter } from './aggregators';
import { bagsTradeAdapter } from './protocols/bags';
import { bonkTradeAdapter } from './protocols/bonk';
import { meteoraTradeAdapter } from './protocols/meteora';
import { pumpfunTradeAdapter } from './protocols/pumpfun';
import { pumpswapTradeAdapter } from './protocols/pumpswap';
import { raydiumTradeAdapter } from './protocols/raydium';
import { believeTradeAdapter, orcaTradeAdapter } from './stubs';
import type { SolanaTradeAdapter, SolanaTradeSource } from './types';

const SOLANA_TRADE_ADAPTERS: SolanaTradeAdapter[] = [
  pumpfunTradeAdapter,
  pumpswapTradeAdapter,
  bonkTradeAdapter,
  raydiumTradeAdapter,
  meteoraTradeAdapter,
  believeTradeAdapter,
  bagsTradeAdapter,
  orcaTradeAdapter,
  jupiterTradeAdapter,
];

const SOLANA_TRADE_ADAPTER_MAP = new Map<SolanaTradeSource, SolanaTradeAdapter>(
  SOLANA_TRADE_ADAPTERS.map((adapter) => [adapter.capability.source, adapter]),
);

export function getSolanaTradeAdapters(): SolanaTradeAdapter[] {
  return SOLANA_TRADE_ADAPTERS;
}

export function getSolanaTradeAdapter(source: SolanaTradeSource): SolanaTradeAdapter {
  const adapter = SOLANA_TRADE_ADAPTER_MAP.get(source);
  if (!adapter) throw new Error(`Unknown Solana trade source: ${source}`);
  return adapter;
}
