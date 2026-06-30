import { PublicKey } from '@solana/web3.js';

export type RaydiumCpmmPoolInfo = {
  poolState: PublicKey;
  ammConfig: PublicKey;
  observationState: PublicKey;
  tokenMint0: PublicKey;
  tokenMint1: PublicKey;
  tokenVault0: PublicKey;
  tokenVault1: PublicKey;
  tokenProgram0: PublicKey;
  tokenProgram1: PublicKey;
  baseReserve: bigint;
  quoteReserve: bigint;
};

export type RaydiumCpmmDirection = {
  isToken0In: boolean;
  inputVault: PublicKey;
  outputVault: PublicKey;
  inputTokenProgram: PublicKey;
  outputTokenProgram: PublicKey;
  reserveIn: bigint;
  reserveOut: bigint;
};
