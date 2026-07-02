import type { SolanaTradeRequest } from '../types';
import type { TokenInfo } from '../../../../types/token';
import { prewarmBagsTrade } from '../protocols/bags/adapter';
import { prewarmBonkTrade } from '../protocols/bonk/adapter';
import { prewarmMeteoraTrade } from '../protocols/meteora/adapter';
import { prewarmPumpfunTrade } from '../protocols/pumpfun/adapter';
import { prewarmPumpSwapTrade } from '../protocols/pumpswap/adapter';
import { prewarmRaydiumTrade } from '../protocols/raydium/cpmm/adapter';

export type SolanaProtocolPrewarmSource =
  | 'pumpfun'
  | 'pumpswap'
  | 'raydium'
  | 'bonk'
  | 'meteora'
  | 'bags';

export type SolanaProtocolPrewarmTask = {
  id: string;
  run: () => Promise<unknown>;
};

export type SolanaProtocolPrewarmPayload = {
  tokenAddress: string;
  ownerAddress?: string;
  executionMode?: 'default' | 'turbo';
  tokenInfo?: TokenInfo;
  runtime: SolanaTradeRequest['runtime'];
};

export type SolanaProtocolPrewarmDescriptor = {
  source: SolanaProtocolPrewarmSource;
  getTasks: (input: SolanaProtocolPrewarmPayload) => SolanaProtocolPrewarmTask[];
};

const protocolPrewarmDescriptors: Record<SolanaProtocolPrewarmSource, SolanaProtocolPrewarmDescriptor> = {
  pumpfun: {
    source: 'pumpfun',
    getTasks: (input) => [
      {
        id: 'pumpfun:quote',
        run: () => prewarmPumpfunTrade(input),
      },
    ],
  },
  pumpswap: {
    source: 'pumpswap',
    getTasks: (input) => [
      {
        id: 'pumpswap:quote',
        run: () => prewarmPumpSwapTrade(input),
      },
    ],
  },
  raydium: {
    source: 'raydium',
    getTasks: (input) => [
      {
        id: 'raydium:quote',
        run: () => prewarmRaydiumTrade(input),
      },
    ],
  },
  bonk: {
    source: 'bonk',
    getTasks: (input) => [
      {
        id: 'bonk:quote',
        run: () => prewarmBonkTrade(input),
      },
    ],
  },
  meteora: {
    source: 'meteora',
    getTasks: (input) => [
      {
        id: 'meteora:quote',
        run: () => prewarmMeteoraTrade(input),
      },
    ],
  },
  bags: {
    source: 'bags',
    getTasks: (input) => [
      {
        id: 'bags:quote',
        run: () => prewarmBagsTrade(input),
      },
    ],
  },
};

export function getSolanaProtocolPrewarmDescriptor(source: SolanaProtocolPrewarmSource): SolanaProtocolPrewarmDescriptor {
  return protocolPrewarmDescriptors[source];
}

export async function prewarmSolanaProtocolResources(input: {
  source: SolanaProtocolPrewarmSource;
} & SolanaProtocolPrewarmPayload): Promise<void> {
  const descriptor = getSolanaProtocolPrewarmDescriptor(input.source);
  const { source: _source, ...payload } = input;
  const tasks = descriptor.getTasks(payload);
  await Promise.all(tasks.map((task) => task.run()));
}
