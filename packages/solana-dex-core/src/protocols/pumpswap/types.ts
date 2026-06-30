import { PublicKey } from '@solana/web3.js';

export type PumpSwapGlobalState = {
  protocolFeeRecipients: PublicKey[];
  reservedFeeRecipient: PublicKey;
  reservedFeeRecipients: PublicKey[];
  buybackFeeRecipients: PublicKey[];
};

export type PumpSwapPoolState = {
  baseMint: PublicKey;
  quoteMint: PublicKey;
  poolBaseTokenAccount: PublicKey;
  poolQuoteTokenAccount: PublicKey;
  coinCreator: PublicKey;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
};

export type PumpSwapPoolContext = {
  poolAddress: PublicKey;
  poolState: PumpSwapPoolState;
  globalState: PumpSwapGlobalState;
  baseReserve: bigint;
  quoteReserve: bigint;
};
