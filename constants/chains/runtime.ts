import { bsc, mainnet, type Chain } from "viem/chains";
import { ChainId } from "./chainId";

export type ChainRuntime = {
  viemChain: Chain;
  nativeSymbol: string;
  wrappedNativeAddress: `0x${string}`;
  quoterV2?: `0x${string}`;
  explorerTxBaseUrl: string;
  bloxrouteNetwork?: string;
  bloxroutePrivateTxMethod?: string;
};

export const CHAIN_RUNTIME: Record<number, ChainRuntime> = {
  [ChainId.ETH]: {
    viemChain: mainnet,
    nativeSymbol: "ETH",
    wrappedNativeAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    explorerTxBaseUrl: "https://etherscan.io/tx/",
    bloxrouteNetwork: "Mainnet",
    bloxroutePrivateTxMethod: "eth_private_tx",
  },
  [ChainId.BNB]: {
    viemChain: bsc,
    nativeSymbol: "BNB",
    wrappedNativeAddress: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    quoterV2: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997",
    explorerTxBaseUrl: "https://bscscan.com/tx/",
    bloxrouteNetwork: "BSC-Mainnet",
    bloxroutePrivateTxMethod: "bsc_private_tx",
  },
};

export function getChainRuntime(chainId: number): ChainRuntime {
  const runtime = CHAIN_RUNTIME[chainId];
  if (!runtime) {
    throw new Error(`Unsupported chain runtime: ${chainId}`);
  }
  return runtime;
}

export function getNativeSymbol(chainId: number): string {
  return CHAIN_RUNTIME[chainId]?.nativeSymbol ?? "NATIVE";
}

export function getExplorerTxUrl(chainId: number, txHash: string): string {
  const base = CHAIN_RUNTIME[chainId]?.explorerTxBaseUrl;
  if (!base) return txHash;
  return `${base}${txHash}`;
}
