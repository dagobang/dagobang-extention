import type { Buffer } from 'buffer';
import {
  applyBps,
  concatBytes,
  encodeU64LE,
} from '../../utils';
import {
  PUMPSWAP_BUY_EXACT_QUOTE_IN_DISCRIMINATOR,
  PUMPSWAP_BUY_DISCRIMINATOR,
  PUMPSWAP_CREATOR_FEE_BPS,
  PUMPSWAP_LP_FEE_BPS,
  PUMPSWAP_PROTOCOL_FEE_BPS,
  PUMPSWAP_SELL_DISCRIMINATOR,
} from './constants';

const BPS_DENOMINATOR = 10_000n;

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

function getTotalFeeBps(hasCreatorFee: boolean): bigint {
  return PUMPSWAP_LP_FEE_BPS + PUMPSWAP_PROTOCOL_FEE_BPS + (hasCreatorFee ? PUMPSWAP_CREATOR_FEE_BPS : 0n);
}

function computeFee(amount: bigint, feeBps: bigint): bigint {
  return ceilDiv(amount * feeBps, BPS_DENOMINATOR);
}

export function computePumpSwapBuyBaseAmountOut(params: {
  quoteAmountIn: bigint;
  baseReserve: bigint;
  quoteReserve: bigint;
  hasCreatorFee: boolean;
}): bigint {
  const totalFeeBps = getTotalFeeBps(params.hasCreatorFee);
  const effectiveQuote = params.quoteAmountIn * BPS_DENOMINATOR / (BPS_DENOMINATOR + totalFeeBps);
  const numerator = params.baseReserve * effectiveQuote;
  const denominator = params.quoteReserve + effectiveQuote;
  if (denominator <= 0n) throw new Error('Invalid PumpSwap buy denominator');
  const baseAmountOut = numerator / denominator;
  if (baseAmountOut <= 0n || baseAmountOut >= params.baseReserve) throw new Error('Insufficient PumpSwap liquidity');
  return baseAmountOut;
}

export function computePumpSwapSellQuoteAmountOut(params: {
  baseAmountIn: bigint;
  baseReserve: bigint;
  quoteReserve: bigint;
  hasCreatorFee: boolean;
}): bigint {
  const rawQuoteAmountOut = params.quoteReserve * params.baseAmountIn / (params.baseReserve + params.baseAmountIn);
  const creatorFee = params.hasCreatorFee ? computeFee(rawQuoteAmountOut, PUMPSWAP_CREATOR_FEE_BPS) : 0n;
  const totalFees = computeFee(rawQuoteAmountOut, PUMPSWAP_LP_FEE_BPS)
    + computeFee(rawQuoteAmountOut, PUMPSWAP_PROTOCOL_FEE_BPS)
    + creatorFee;
  if (totalFees >= rawQuoteAmountOut) throw new Error('Invalid PumpSwap sell fees');
  return rawQuoteAmountOut - totalFees;
}

export function computePumpSwapSolAmount(params: {
  side: 'buy' | 'sell';
  amountIn: bigint;
  baseReserve: bigint;
  quoteReserve: bigint;
  slippageBps: number;
  hasCreatorFee: boolean;
}): bigint {
  if (params.side === 'buy') {
    return applyBps(params.amountIn, BigInt(params.slippageBps), 'add');
  }

  return applyBps(
    computePumpSwapSellQuoteAmountOut({
      baseAmountIn: params.amountIn,
      baseReserve: params.baseReserve,
      quoteReserve: params.quoteReserve,
      hasCreatorFee: params.hasCreatorFee,
    }),
    BigInt(params.slippageBps),
    'subtract',
  );
}

export function buildPumpSwapInstructionData(params: {
  side: 'buy' | 'sell';
  tokenAmount: bigint;
  solAmount: bigint;
  trackVolume?: boolean;
  useExactQuoteIn?: boolean;
}): Buffer {
  if (params.side === 'buy') {
    return concatBytes([
      encodeU64LE(params.useExactQuoteIn ? PUMPSWAP_BUY_EXACT_QUOTE_IN_DISCRIMINATOR : PUMPSWAP_BUY_DISCRIMINATOR),
      encodeU64LE(params.useExactQuoteIn ? params.solAmount : params.tokenAmount),
      encodeU64LE(params.useExactQuoteIn ? params.tokenAmount : params.solAmount),
      Uint8Array.of(params.trackVolume ? 1 : 0),
    ]) as unknown as Buffer;
  }

  return concatBytes([
    encodeU64LE(PUMPSWAP_SELL_DISCRIMINATOR),
    encodeU64LE(params.tokenAmount),
    encodeU64LE(params.solAmount),
  ]) as unknown as Buffer;
}
