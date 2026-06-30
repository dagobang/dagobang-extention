import {
  BONK_BPS_DENOMINATOR,
  BONK_PLATFORM_FEE_BPS,
  BONK_PROTOCOL_FEE_BPS,
  BONK_SHARE_FEE_BPS,
} from './constants';

function applySlippage(amount: bigint, slippageBps: number): bigint {
  return amount - ((amount * BigInt(slippageBps)) / BONK_BPS_DENOMINATOR);
}

export function computeBonkBuyMinimumAmountOut(params: {
  amountIn: bigint;
  virtualBase: bigint;
  virtualQuote: bigint;
  realBase: bigint;
  realQuote: bigint;
  slippageBps: number;
}): bigint {
  const feeTotal = BONK_PROTOCOL_FEE_BPS + BONK_PLATFORM_FEE_BPS + BONK_SHARE_FEE_BPS;
  const amountInNet = params.amountIn * (BONK_BPS_DENOMINATOR - feeTotal) / BONK_BPS_DENOMINATOR;
  const inputReserve = params.virtualQuote + params.realQuote;
  const outputReserve = params.virtualBase - params.realBase;
  const amountOut = (amountInNet * outputReserve) / (inputReserve + amountInNet);
  if (amountOut <= 0n) throw new Error('Invalid Bonk buy minimum amount out');
  return applySlippage(amountOut, params.slippageBps);
}

export function computeBonkSellMinimumAmountOut(params: {
  amountIn: bigint;
  virtualBase: bigint;
  virtualQuote: bigint;
  realBase: bigint;
  realQuote: bigint;
  slippageBps: number;
}): bigint {
  const inputReserve = params.virtualBase - params.realBase;
  const outputReserve = params.virtualQuote + params.realQuote;
  const grossAmountOut = (params.amountIn * outputReserve) / (inputReserve + params.amountIn);
  const feeTotal = BONK_PROTOCOL_FEE_BPS + BONK_PLATFORM_FEE_BPS + BONK_SHARE_FEE_BPS;
  const netAmountOut = grossAmountOut * (BONK_BPS_DENOMINATOR - feeTotal) / BONK_BPS_DENOMINATOR;
  if (netAmountOut <= 0n) throw new Error('Invalid Bonk sell minimum amount out');
  return applySlippage(netAmountOut, params.slippageBps);
}
