import {
  METEORA_DAMM_V2_BPS_DENOMINATOR,
  METEORA_DAMM_V2_COLLECT_FEE_MODE_BOTH_TOKEN,
  METEORA_DAMM_V2_COLLECT_FEE_MODE_ONLY_A,
  METEORA_DAMM_V2_COLLECT_FEE_MODE_ONLY_B,
  METEORA_DAMM_V2_POOL_STATUS_ENABLED,
  METEORA_DAMM_V2_Q128,
  METEORA_DAMM_V2_TRADING_FEE_BPS,
} from './constants';
import type {
  MeteoraDammV2PoolInfo,
  MeteoraDammV2QuoteResult,
  MeteoraDammV2TradeDirection,
} from './types';

function getFeeMode(poolInfo: MeteoraDammV2PoolInfo, direction: MeteoraDammV2TradeDirection): { feesOnInput: boolean } {
  switch (poolInfo.collectFeeMode) {
    case METEORA_DAMM_V2_COLLECT_FEE_MODE_BOTH_TOKEN:
      return { feesOnInput: true };
    case METEORA_DAMM_V2_COLLECT_FEE_MODE_ONLY_A:
      return { feesOnInput: direction === 'a_to_b' };
    case METEORA_DAMM_V2_COLLECT_FEE_MODE_ONLY_B:
      return { feesOnInput: direction === 'b_to_a' };
    default:
      throw new Error(`Unsupported Meteora DAMM v2 collect fee mode: ${poolInfo.collectFeeMode}`);
  }
}

export function resolveMeteoraDammV2TradeDirection(
  poolInfo: MeteoraDammV2PoolInfo,
  inputMint: string,
  outputMint: string,
): MeteoraDammV2TradeDirection {
  if (poolInfo.tokenAMint.toBase58() === inputMint && poolInfo.tokenBMint.toBase58() === outputMint) {
    return 'a_to_b';
  }
  if (poolInfo.tokenBMint.toBase58() === inputMint && poolInfo.tokenAMint.toBase58() === outputMint) {
    return 'b_to_a';
  }
  throw new Error('Input/output mint does not match Meteora DAMM v2 pool');
}

export function validateMeteoraDammV2Pool(poolInfo: MeteoraDammV2PoolInfo): void {
  if (poolInfo.poolStatus !== METEORA_DAMM_V2_POOL_STATUS_ENABLED) {
    throw new Error('Meteora DAMM v2 pool is disabled');
  }
  if (poolInfo.tokenAMint.equals(poolInfo.tokenBMint)) {
    throw new Error('Meteora DAMM v2 pool uses identical token mints');
  }
  if (poolInfo.tokenAVault.equals(poolInfo.tokenBVault)) {
    throw new Error('Meteora DAMM v2 pool uses identical token vaults');
  }
  if (poolInfo.liquidity <= 0n) {
    throw new Error('Meteora DAMM v2 pool has no liquidity');
  }
  if (poolInfo.sqrtPrice <= 0n || poolInfo.sqrtMinPrice <= 0n || poolInfo.sqrtMaxPrice <= 0n) {
    throw new Error('Meteora DAMM v2 pool has invalid sqrt prices');
  }
  if (poolInfo.sqrtMinPrice >= poolInfo.sqrtMaxPrice) {
    throw new Error('Meteora DAMM v2 pool has invalid sqrt price bounds');
  }
  if (poolInfo.sqrtPrice < poolInfo.sqrtMinPrice || poolInfo.sqrtPrice > poolInfo.sqrtMaxPrice) {
    throw new Error('Meteora DAMM v2 pool current sqrt price is out of bounds');
  }
}

function calculateRawAmountOut(
  amountIn: bigint,
  poolInfo: MeteoraDammV2PoolInfo,
  direction: MeteoraDammV2TradeDirection,
): {
  amountOut: bigint;
  feeAmount: bigint;
} {
  if (amountIn <= 0n) throw new Error('Input amount must be greater than zero');
  validateMeteoraDammV2Pool(poolInfo);

  const { feesOnInput } = getFeeMode(poolInfo, direction);
  const feeAmount = amountIn * METEORA_DAMM_V2_TRADING_FEE_BPS / METEORA_DAMM_V2_BPS_DENOMINATOR;
  const effectiveAmountIn = feesOnInput ? amountIn - feeAmount : amountIn;
  if (effectiveAmountIn <= 0n) throw new Error('Meteora DAMM v2 effective input is zero');

  const sqrtPrice = poolInfo.sqrtPrice;
  const sqrtMinPrice = poolInfo.sqrtMinPrice;
  const sqrtMaxPrice = poolInfo.sqrtMaxPrice;

  let amountOut: bigint;
  if (direction === 'a_to_b') {
    const invSqrtPrice = METEORA_DAMM_V2_Q128 / sqrtPrice;
    const invSqrtMaxPrice = METEORA_DAMM_V2_Q128 / sqrtMaxPrice;
    const priceDiff = invSqrtPrice - invSqrtMaxPrice;
    if (priceDiff <= 0n) throw new Error('Invalid DAMM v2 A->B price range');

    const liquidityDelta = effectiveAmountIn * METEORA_DAMM_V2_Q128 / priceDiff;
    const priceRange = sqrtPrice - sqrtMinPrice;
    if (priceRange <= 0n) throw new Error('Invalid DAMM v2 A->B sqrt range');
    amountOut = liquidityDelta * priceRange / METEORA_DAMM_V2_Q128;
  } else {
    const priceRange = sqrtPrice - sqrtMinPrice;
    if (priceRange <= 0n) throw new Error('Invalid DAMM v2 B->A sqrt range');

    const liquidityDelta = effectiveAmountIn * METEORA_DAMM_V2_Q128 / priceRange;
    const invSqrtPrice = METEORA_DAMM_V2_Q128 / sqrtPrice;
    const invSqrtMaxPrice = METEORA_DAMM_V2_Q128 / sqrtMaxPrice;
    const priceDiff = invSqrtPrice - invSqrtMaxPrice;
    if (priceDiff <= 0n) throw new Error('Invalid DAMM v2 B->A price range');
    amountOut = liquidityDelta * priceDiff / METEORA_DAMM_V2_Q128;
  }

  if (!feesOnInput) {
    amountOut -= feeAmount;
  }
  if (amountOut <= 0n) throw new Error('Meteora DAMM v2 amount out is zero');
  return {
    amountOut,
    feeAmount,
  };
}

function validateSlippageBps(slippageBps: number): void {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= Number(METEORA_DAMM_V2_BPS_DENOMINATOR)) {
    throw new Error(`Invalid Meteora DAMM v2 slippage bps: ${slippageBps}`);
  }
}

export function calculateMeteoraDammV2Quote(
  amountIn: bigint,
  poolInfo: MeteoraDammV2PoolInfo,
  direction: MeteoraDammV2TradeDirection,
  slippageBps: number,
): MeteoraDammV2QuoteResult {
  validateSlippageBps(slippageBps);
  const { amountOut, feeAmount } = calculateRawAmountOut(amountIn, poolInfo, direction);
  const slippageDenominator = METEORA_DAMM_V2_BPS_DENOMINATOR - BigInt(slippageBps);
  const minimumAmountOut = amountOut * slippageDenominator / METEORA_DAMM_V2_BPS_DENOMINATOR;
  if (minimumAmountOut <= 0n) throw new Error('Invalid DAMM v2 minimum amount out');
  return {
    amountOut,
    minimumAmountOut,
    feeAmount,
  };
}

export function calculateMeteoraDammV2MinimumAmountOut(
  amountIn: bigint,
  poolInfo: MeteoraDammV2PoolInfo,
  direction: MeteoraDammV2TradeDirection,
  slippageBps: number,
): bigint {
  return calculateMeteoraDammV2Quote(
    amountIn,
    poolInfo,
    direction,
    slippageBps,
  ).minimumAmountOut;
}
