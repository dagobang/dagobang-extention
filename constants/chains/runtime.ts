import { getExplorerTxUrl, getNativeSymbol, getChainKind, getChainRuntimeBase, isEvmChain, isSolanaChain } from './baseRuntime';
import { EVM_CHAIN_RUNTIME, getEvmChainRuntime, type EvmChainRuntime } from './evmRuntime';

export type ChainRuntime = EvmChainRuntime;

export const CHAIN_RUNTIME = EVM_CHAIN_RUNTIME;

export function getChainRuntime(chainId: number): ChainRuntime {
  return getEvmChainRuntime(chainId);
}

export {
  getNativeSymbol,
  getExplorerTxUrl,
  getChainKind,
  getChainRuntimeBase,
  isEvmChain,
  isSolanaChain,
};
