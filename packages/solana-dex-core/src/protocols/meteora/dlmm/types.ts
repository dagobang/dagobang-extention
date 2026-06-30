import { PublicKey } from '@solana/web3.js';

export type MeteoraStaticParameters = {
  baseFactor: number;
  filterPeriod: number;
  decayPeriod: number;
  reductionFactor: number;
  variableFeeControl: number;
  maxVolatilityAccumulator: number;
  minBinId: number;
  maxBinId: number;
  protocolShare: number;
  baseFeePowerFactor: number;
};

export type MeteoraVariableParameters = {
  volatilityAccumulator: number;
  volatilityReference: number;
  indexReference: number;
  lastUpdateTimestamp: bigint;
};

export type MeteoraPoolState = {
  parameters: MeteoraStaticParameters;
  vParameters: MeteoraVariableParameters;
  activeId: number;
  binStep: number;
  tokenXMint: PublicKey;
  tokenYMint: PublicKey;
  reserveX: PublicKey;
  reserveY: PublicKey;
  oracle: PublicKey;
};

export type MeteoraBin = {
  amountX: bigint;
  amountY: bigint;
  price: bigint;
};

export type MeteoraBinArrayAccount = {
  publicKey: PublicKey;
  index: number;
  bins: MeteoraBin[];
};

export type MeteoraQuote = {
  amountIn: bigint;
  amountOut: bigint;
  usedBinArrays: MeteoraBinArrayAccount[];
};
