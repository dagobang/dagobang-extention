import { PublicKey } from '@solana/web3.js';
import type { SolanaBuiltTransaction, SolanaTradeAdapter, SolanaTradeRequest } from '../../types';
import { meteoraDammV2TradeAdapter } from './dammv2';
import { prewarmMeteoraDammV2Trade } from './dammv2';
import { meteoraDlmmTradeAdapter } from './dlmm';
import { prewarmMeteoraDlmmTrade } from './dlmm';
import { METEORA_DAMM_V2_PROGRAM_ID } from './dammv2/constants';
import { METEORA_DLMM_PROGRAM_ID } from './dlmm/constants';

const METEORA_PROTOCOL_ADAPTERS: SolanaTradeAdapter[] = [
  meteoraDlmmTradeAdapter,
  meteoraDammV2TradeAdapter,
];

export const meteoraTradeAdapter: SolanaTradeAdapter = {
  capability: {
    source: 'meteora',
    mode: 'direct',
    supportsBuy: true,
    supportsSell: true,
    platforms: ['meteora', 'dlmm', 'damm', 'damm_v2'],
  },

  async supportsTrade(input: SolanaTradeRequest): Promise<boolean> {
    for (const adapter of METEORA_PROTOCOL_ADAPTERS) {
      if (await adapter.supportsTrade(input)) return true;
    }
    return false;
  },

  async build(input: SolanaTradeRequest): Promise<SolanaBuiltTransaction> {
    for (const adapter of METEORA_PROTOCOL_ADAPTERS) {
      if (!(await adapter.supportsTrade(input))) continue;
      const built = await adapter.build(input);
      return {
        ...built,
        source: 'meteora',
      };
    }
    throw new Error('Meteora adapter cannot handle this trade');
  },
};

export async function prewarmMeteoraTrade(input: {
  tokenAddress: string;
  ownerAddress?: string;
  executionMode?: 'default' | 'turbo';
  tokenInfo?: SolanaTradeRequest['tokenInfo'];
  runtime: SolanaTradeRequest['runtime'];
}): Promise<void> {
  const poolPair = String(input.tokenInfo?.pool_pair || '').trim();
  if (!poolPair) return;
  const connection = await input.runtime.getConnection();
  const poolInfo = await connection.getAccountInfo(new PublicKey(poolPair), 'confirmed');
  if (!poolInfo?.owner) return;
  if (poolInfo.owner.equals(METEORA_DLMM_PROGRAM_ID)) {
    await prewarmMeteoraDlmmTrade(input);
    return;
  }
  if (poolInfo.owner.equals(METEORA_DAMM_V2_PROGRAM_ID)) {
    await prewarmMeteoraDammV2Trade(input);
    return;
  }
}
