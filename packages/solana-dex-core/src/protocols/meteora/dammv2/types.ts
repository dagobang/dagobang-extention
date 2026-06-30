import { PublicKey } from '@solana/web3.js';

export type MeteoraDammV2PoolInfo = {
  poolAddress: PublicKey;
  tokenAMint: PublicKey;
  tokenBMint: PublicKey;
  tokenAVault: PublicKey;
  tokenBVault: PublicKey;
  liquidity: bigint;
  sqrtPrice: bigint;
  sqrtMinPrice: bigint;
  sqrtMaxPrice: bigint;
  activationType: number;
  poolStatus: number;
  tokenAFlag: number;
  tokenBFlag: number;
  collectFeeMode: number;
  poolType: number;
};

export type MeteoraDammV2PoolContext = {
  poolInfo: MeteoraDammV2PoolInfo;
  tokenAProgram: PublicKey;
  tokenBProgram: PublicKey;
};

export type MeteoraDammV2TradeDirection = 'a_to_b' | 'b_to_a';

export type MeteoraDammV2QuoteResult = {
  amountOut: bigint;
  minimumAmountOut: bigint;
  feeAmount: bigint;
};
