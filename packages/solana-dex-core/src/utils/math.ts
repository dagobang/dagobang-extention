export const BPS_DENOMINATOR = 10_000n;

export function applyBps(value: bigint, bps: bigint, mode: 'add' | 'subtract'): bigint {
  if (mode === 'add') return value * (BPS_DENOMINATOR + bps) / BPS_DENOMINATOR;
  return value * (BPS_DENOMINATOR - bps) / BPS_DENOMINATOR;
}

export function computeConstantProductAmountOut(inputAmount: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: bigint): bigint {
  if (inputAmount <= 0n) throw new Error('Invalid amount');
  if (reserveIn <= 0n || reserveOut <= 0n) throw new Error('Invalid reserves');
  const inputWithFee = inputAmount * (BPS_DENOMINATOR - feeBps) / BPS_DENOMINATOR;
  const numerator = inputWithFee * reserveOut;
  const denominator = reserveIn + inputWithFee;
  const amountOut = numerator / denominator;
  if (amountOut <= 0n || amountOut >= reserveOut) throw new Error('Insufficient liquidity');
  return amountOut;
}
