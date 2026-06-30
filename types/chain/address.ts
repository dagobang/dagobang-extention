export type ChainAddress = string;
export type EvmAddress = `0x${string}`;
export type ChainTxId = string;

export type ChainTxRef = {
  chainId: number;
  txid: ChainTxId;
};
