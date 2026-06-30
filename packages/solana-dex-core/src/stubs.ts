import type { SolanaBuiltTransaction, SolanaTradeRequest } from './types';

type StubTradeSource = 'believe' | 'orca';

class PlaceholderTradeAdapter {
  readonly capability: {
    source: StubTradeSource;
    mode: 'direct';
    supportsBuy: true;
    supportsSell: true;
    platforms: string[];
  };

  constructor(source: StubTradeSource, platforms: string[]) {
    this.capability = {
      source,
      mode: 'direct',
      supportsBuy: true,
      supportsSell: true,
      platforms,
    };
  }

  supportsTrade(_input: SolanaTradeRequest): boolean {
    return false;
  }

  async build(_input: SolanaTradeRequest): Promise<SolanaBuiltTransaction> {
    throw new Error(`${this.capability.source} adapter is not implemented yet`);
  }
}

export const believeTradeAdapter = new PlaceholderTradeAdapter('believe', ['believe']);
export const orcaTradeAdapter = new PlaceholderTradeAdapter('orca', ['orca']);
