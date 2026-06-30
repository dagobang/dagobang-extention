import type { Buffer } from 'buffer';
import { applyBps, concatBytes, encodeU64LE } from '../../utils';
import {
  BUY_DISCRIMINATOR,
  BUY_EXACT_QUOTE_IN_V2_DISCRIMINATOR,
  BUY_EXACT_SOL_IN_DISCRIMINATOR,
  BUY_V2_DISCRIMINATOR,
  PUMPFUN_BASE_FEE_BPS,
  PUMPFUN_CREATOR_FEE_BPS,
  SELL_DISCRIMINATOR,
  SELL_V2_DISCRIMINATOR,
} from './constants';

function getPumpfunTotalFeeBps(hasCreatorFee: boolean): bigint {
  return PUMPFUN_BASE_FEE_BPS + (hasCreatorFee ? PUMPFUN_CREATOR_FEE_BPS : 0n);
}

export function computePumpfunBuyAmountOut(params: {
  solAmountIn: bigint;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realTokenReserves: bigint;
  hasCreatorFee: boolean;
}): bigint {
  if (params.solAmountIn <= 0n) throw new Error('Invalid amount');
  if (params.virtualSolReserves <= 0n || params.virtualTokenReserves <= 0n) throw new Error('Invalid reserves');
  const feeBps = getPumpfunTotalFeeBps(params.hasCreatorFee);
  const netInput = params.solAmountIn * 10_000n / (10_000n + feeBps);
  const denominator = params.virtualSolReserves + netInput;
  if (denominator <= 0n) throw new Error('Invalid reserves');
  const tokensOut = netInput * params.virtualTokenReserves / denominator;
  return tokensOut < params.realTokenReserves ? tokensOut : params.realTokenReserves;
}

export function computePumpfunSellAmountOut(params: {
  tokenAmountIn: bigint;
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  hasCreatorFee: boolean;
}): bigint {
  if (params.tokenAmountIn <= 0n) throw new Error('Invalid amount');
  if (params.virtualTokenReserves <= 0n || params.virtualSolReserves <= 0n) throw new Error('Invalid reserves');
  const grossSolOut = params.tokenAmountIn * params.virtualSolReserves
    / (params.virtualTokenReserves + params.tokenAmountIn);
  const feeBps = getPumpfunTotalFeeBps(params.hasCreatorFee);
  const fee = grossSolOut * feeBps / 10_000n;
  return grossSolOut - fee;
}

export function computePumpfunQuoteLimit(params: {
  side: 'buy' | 'sell';
  inputAmount: bigint;
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves?: bigint;
  hasCreatorFee: boolean;
  slippageBps: number;
}): bigint {
  if (params.side === 'buy') {
    return applyBps(params.inputAmount, BigInt(params.slippageBps), 'add');
  }

  return applyBps(
    computePumpfunSellAmountOut({
      tokenAmountIn: params.inputAmount,
      virtualTokenReserves: params.virtualTokenReserves,
      virtualSolReserves: params.virtualSolReserves,
      hasCreatorFee: params.hasCreatorFee,
    }),
    BigInt(params.slippageBps),
    'subtract',
  );
}

export function buildPumpfunInstructionData(
  kind: 'buy' | 'sell',
  amount: bigint,
  quoteLimit: bigint,
): Buffer {
  return concatBytes([
    kind === 'buy' ? BUY_V2_DISCRIMINATOR : SELL_V2_DISCRIMINATOR,
    encodeU64LE(amount),
    encodeU64LE(quoteLimit),
  ]) as unknown as Buffer;
}

export function buildPumpfunLegacyBuyExactInInstructionData(
  solAmountIn: bigint,
  minTokenAmountOut: bigint,
): Buffer {
  return concatBytes([
    BUY_EXACT_SOL_IN_DISCRIMINATOR,
    encodeU64LE(solAmountIn),
    encodeU64LE(minTokenAmountOut),
  ]) as unknown as Buffer;
}

export function buildPumpfunBuyExactQuoteInV2InstructionData(
  spendableQuoteIn: bigint,
  minTokenAmountOut: bigint,
): Buffer {
  return concatBytes([
    BUY_EXACT_QUOTE_IN_V2_DISCRIMINATOR,
    encodeU64LE(spendableQuoteIn),
    encodeU64LE(minTokenAmountOut),
  ]) as unknown as Buffer;
}

export function buildPumpfunLegacyBuyInstructionData(
  tokenAmountOut: bigint,
  maxSolAmountIn: bigint,
): Buffer {
  return concatBytes([
    BUY_DISCRIMINATOR,
    encodeU64LE(tokenAmountOut),
    encodeU64LE(maxSolAmountIn),
  ]) as unknown as Buffer;
}

export function buildPumpfunLegacySellInstructionData(
  tokenAmountIn: bigint,
  minSolAmountOut: bigint,
): Buffer {
  return concatBytes([
    SELL_DISCRIMINATOR,
    encodeU64LE(tokenAmountIn),
    encodeU64LE(minSolAmountOut),
  ]) as unknown as Buffer;
}
