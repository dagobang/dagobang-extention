import { defineChain } from 'viem';
import { bsc, mainnet, type Chain } from 'viem/chains';
import { ChainId } from './chainId';
import { getChainRuntimeBase, type BaseChainRuntime } from './baseRuntime';

export type EvmChainRuntime = BaseChainRuntime & {
  kind: 'evm';
  viemChain: Chain;
  wrappedNativeAddress: `0x${string}`;
  quoterV2?: `0x${string}`;
  bloxrouteNetwork?: string;
  bloxroutePrivateTxMethod?: string;
};

const robinhoodEvm = defineChain({
  id: ChainId.RH,
  name: 'Robinhood Chain',
  nativeCurrency: {
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
  },
  rpcUrls: {
    default: {
      http: ['https://rpc.mainnet.chain.robinhood.com'],
    },
    public: {
      http: ['https://rpc.mainnet.chain.robinhood.com'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Robinhood Chain Explorer',
      url: 'https://robinhoodchain.blockscout.com',
    },
  },
});

const hyperEvm = defineChain({
  id: ChainId.HYPER,
  name: 'HyperEVM',
  nativeCurrency: {
    decimals: 18,
    name: 'Hyperliquid',
    symbol: 'HYPE',
  },
  rpcUrls: {
    default: {
      http: ['https://rpc.hyperliquid.xyz/evm'],
    },
    public: {
      http: ['https://rpc.hyperliquid.xyz/evm'],
    },
  },
  blockExplorers: {
    default: {
      name: 'HypurrScan',
      url: 'https://hypurrscan.io',
    },
  },
});

export const EVM_CHAIN_RUNTIME: Record<number, EvmChainRuntime> = {
  [ChainId.ETH]: {
    ...getChainRuntimeBase(ChainId.ETH),
    kind: 'evm',
    viemChain: mainnet,
    wrappedNativeAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    bloxrouteNetwork: 'Mainnet',
    bloxroutePrivateTxMethod: 'eth_private_tx',
  },
  [ChainId.BNB]: {
    ...getChainRuntimeBase(ChainId.BNB),
    kind: 'evm',
    viemChain: bsc,
    wrappedNativeAddress: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    quoterV2: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
    bloxrouteNetwork: 'BSC-Mainnet',
    bloxroutePrivateTxMethod: 'bsc_private_tx',
  },
  [ChainId.HYPER]: {
    ...getChainRuntimeBase(ChainId.HYPER),
    kind: 'evm',
    viemChain: hyperEvm,
    wrappedNativeAddress: '0x5555555555555555555555555555555555555555',
    quoterV2: '0x03A918028f22D9E1473B7959C927AD7425A45C7C',
  },
  [ChainId.RH]: {
    ...getChainRuntimeBase(ChainId.RH),
    kind: 'evm',
    viemChain: robinhoodEvm,
    wrappedNativeAddress: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
    quoterV2: '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7',
  },
};

export function getEvmChainRuntime(chainId: number): EvmChainRuntime {
  const runtime = EVM_CHAIN_RUNTIME[chainId];
  if (!runtime) {
    throw new Error(`Unsupported EVM chain runtime: ${chainId}`);
  }
  return runtime;
}
