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

function resolveMeteoraAdapterCandidates(input: SolanaTradeRequest): SolanaTradeAdapter[] {
  const platform = String(input.tokenInfo?.launchpad_platform || input.tokenInfo?.launchpad || '').trim().toLowerCase();
  const dexType = String(input.tokenInfo?.dex_type || '').trim().toLowerCase();
  if (platform === 'dlmm' || dexType.includes('dlmm')) {
    return [meteoraDlmmTradeAdapter];
  }
  if (platform === 'damm' || platform === 'damm_v2' || dexType.includes('damm')) {
    return [meteoraDammV2TradeAdapter];
  }
  return METEORA_PROTOCOL_ADAPTERS;
}

export const meteoraTradeAdapter: SolanaTradeAdapter = {
  capability: {
    source: 'meteora',
    mode: 'direct',
    supportsBuy: true,
    supportsSell: true,
    platforms: ['meteora', 'dlmm', 'damm', 'damm_v2'],
  },

  async supportsTrade(input: SolanaTradeRequest): Promise<boolean> {
    for (const adapter of resolveMeteoraAdapterCandidates(input)) {
      if (await adapter.supportsTrade(input)) return true;
    }
    return false;
  },

  async build(input: SolanaTradeRequest): Promise<SolanaBuiltTransaction> {
    const candidates = resolveMeteoraAdapterCandidates(input);
    let lastError: unknown = null;
    for (const adapter of candidates) {
      try {
        const built = await adapter.build(input);
        return {
          ...built,
          source: 'meteora',
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Meteora adapter cannot handle this trade');
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
