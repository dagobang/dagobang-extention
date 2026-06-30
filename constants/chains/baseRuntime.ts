import { ChainId } from './chainId';

export type ChainKind = 'evm' | 'solana';

export type BaseChainRuntime = {
  chainId: number;
  kind: ChainKind;
  nativeSymbol: string;
  explorerTxBaseUrl: string;
};

export const BASE_CHAIN_RUNTIME: Record<number, BaseChainRuntime> = {
  [ChainId.ETH]: {
    chainId: ChainId.ETH,
    kind: 'evm',
    nativeSymbol: 'ETH',
    explorerTxBaseUrl: 'https://etherscan.io/tx/',
  },
  [ChainId.BNB]: {
    chainId: ChainId.BNB,
    kind: 'evm',
    nativeSymbol: 'BNB',
    explorerTxBaseUrl: 'https://bscscan.com/tx/',
  },
  [ChainId.HYPER]: {
    chainId: ChainId.HYPER,
    kind: 'evm',
    nativeSymbol: 'HYPE',
    explorerTxBaseUrl: 'https://hypurrscan.io/tx/',
  },
  [ChainId.SOL]: {
    chainId: ChainId.SOL,
    kind: 'solana',
    nativeSymbol: 'SOL',
    explorerTxBaseUrl: 'https://solscan.io/tx/',
  },
};

export function getChainRuntimeBase(chainId: number): BaseChainRuntime {
  const runtime = BASE_CHAIN_RUNTIME[chainId];
  if (!runtime) {
    throw new Error(`Unsupported chain runtime: ${chainId}`);
  }
  return runtime;
}

export function getChainKind(chainId: number): ChainKind {
  return getChainRuntimeBase(chainId).kind;
}

export function isEvmChain(chainId: number): boolean {
  return getChainKind(chainId) === 'evm';
}

export function isSolanaChain(chainId: number): boolean {
  return getChainKind(chainId) === 'solana';
}

export function getNativeSymbol(chainId: number): string {
  return BASE_CHAIN_RUNTIME[chainId]?.nativeSymbol ?? 'NATIVE';
}

export function getExplorerTxUrl(chainId: number, txHash: string): string {
  const base = BASE_CHAIN_RUNTIME[chainId]?.explorerTxBaseUrl;
  if (!base) return txHash;
  return `${base}${txHash}`;
}
