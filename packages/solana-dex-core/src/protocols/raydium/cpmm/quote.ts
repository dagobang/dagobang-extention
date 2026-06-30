import { applyBps, computeConstantProductAmountOut } from '../../../utils';
import { RAYDIUM_FEE_BPS } from './constants';

export function computeRaydiumCpmmAmountOut(
  inputAmount: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
): bigint {
  return computeConstantProductAmountOut(inputAmount, reserveIn, reserveOut, RAYDIUM_FEE_BPS);
}

export function computeRaydiumCpmmMinimumAmountOut(
  quotedAmountOut: bigint,
  slippageBps: number,
): bigint {
  return applyBps(quotedAmountOut, BigInt(slippageBps), 'subtract');
}
