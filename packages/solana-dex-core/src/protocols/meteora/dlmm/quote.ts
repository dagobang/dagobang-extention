import {
  BIN_ARRAY_SIZE,
  FEE_PRECISION,
  SCALE_OFFSET,
} from './constants';
import {
  getMeteoraDlmmBinArrayLowerUpperBinId,
  isMeteoraDlmmBinIdWithinBinArray,
} from './pda';
import type {
  MeteoraBin,
  MeteoraBinArrayAccount,
  MeteoraPoolState,
  MeteoraQuote,
  MeteoraStaticParameters,
  MeteoraVariableParameters,
} from './types';

enum Rounding {
  Down = 0,
  Up = 1,
}

function getBinFromBinArray(binId: number, binArray: MeteoraBinArrayAccount): MeteoraBin | null {
  const { lower } = getMeteoraDlmmBinArrayLowerUpperBinId(binArray.index);
  const idx = binId - lower;
  if (idx < 0 || idx >= BIN_ARRAY_SIZE) return null;
  return binArray.bins[idx] ?? null;
}

function updateReference(
  activeId: number,
  vParameters: MeteoraVariableParameters,
  sParameters: MeteoraStaticParameters,
  currentTimestamp: bigint,
): void {
  const deltaT = currentTimestamp - vParameters.lastUpdateTimestamp;
  if (deltaT >= BigInt(sParameters.filterPeriod)) {
    vParameters.indexReference = activeId;
    vParameters.lastUpdateTimestamp = currentTimestamp;
  }
}

function updateVolatilityAccumulator(
  vParameters: MeteoraVariableParameters,
  sParameters: MeteoraStaticParameters,
  activeId: number,
): void {
  const deltaId = Math.abs(activeId - vParameters.indexReference);
  const next = deltaId * sParameters.baseFactor;
  vParameters.volatilityAccumulator = Math.min(next, sParameters.maxVolatilityAccumulator);
}

function calculateFeeRate(
  binStep: number,
  sParameters: MeteoraStaticParameters,
  vParameters: MeteoraVariableParameters,
): number {
  const baseFee = binStep * sParameters.baseFactor;
  const variableFee = vParameters.volatilityAccumulator * sParameters.variableFeeControl;
  return Math.min(baseFee + variableFee, 100_000_000);
}

function mulShr(x: bigint, y: bigint, offset: number, rounding: Rounding): bigint {
  let prod = x * y;
  if (rounding === Rounding.Up) prod += (1n << BigInt(offset)) - 1n;
  return prod >> BigInt(offset);
}

function shlDiv(x: bigint, y: bigint, offset: number, rounding: Rounding): bigint {
  const numerator = x << BigInt(offset);
  if (rounding === Rounding.Down) return numerator / y;
  return (numerator + y - 1n) / y;
}

function calculateAmountOut(amountIn: bigint, bin: MeteoraBin, swapForY: boolean): bigint {
  if (amountIn <= 0n || bin.price <= 0n) return 0n;
  if (swapForY) {
    const amountOut = mulShr(amountIn, bin.price, SCALE_OFFSET, Rounding.Down);
    return amountOut > bin.amountY ? bin.amountY : amountOut;
  }
  const amountOut = shlDiv(amountIn, bin.price, SCALE_OFFSET, Rounding.Down);
  return amountOut > bin.amountX ? bin.amountX : amountOut;
}

function swapExactInQuoteAtBin(
  bin: MeteoraBin,
  binStep: number,
  sParameters: MeteoraStaticParameters,
  vParameters: MeteoraVariableParameters,
  amountIn: bigint,
  swapForY: boolean,
): { amountIn: bigint; amountOut: bigint } {
  const maxAmountOut = swapForY ? bin.amountY : bin.amountX;
  if (maxAmountOut <= 0n) return { amountIn: 0n, amountOut: 0n };
  const feeRate = calculateFeeRate(binStep, sParameters, vParameters);
  const fee = amountIn * BigInt(feeRate) / BigInt(FEE_PRECISION);
  const amountAfterFee = amountIn - fee;
  if (amountAfterFee <= 0n) return { amountIn: 0n, amountOut: 0n };
  let amountOut = calculateAmountOut(amountAfterFee, bin, swapForY);
  let actualAmountIn = amountIn;
  if (amountOut > maxAmountOut) {
    amountOut = maxAmountOut;
  }
  if (amountOut === maxAmountOut && bin.price > 0n) {
    const actualAfterFee = swapForY
      ? shlDiv(amountOut, bin.price, SCALE_OFFSET, Rounding.Up)
      : mulShr(amountOut, bin.price, SCALE_OFFSET, Rounding.Up);
    const adjusted = actualAfterFee + fee;
    if (adjusted < actualAmountIn) actualAmountIn = adjusted;
  }
  return { amountIn: actualAmountIn, amountOut };
}

export function calculateMeteoraDlmmQuote(
  amountInRaw: bigint,
  poolState: MeteoraPoolState,
  binArrays: MeteoraBinArrayAccount[],
  swapForY: boolean,
): MeteoraQuote {
  let activeId = poolState.activeId;
  let amountLeft = amountInRaw;
  let amountOut = 0n;
  const used = new Map<string, MeteoraBinArrayAccount>();
  const vParameters: MeteoraVariableParameters = { ...poolState.vParameters };
  updateReference(activeId, vParameters, poolState.parameters, BigInt(Math.floor(Date.now() / 1000)));

  while (amountLeft > 0n) {
    const currentArray = binArrays.find((item) => isMeteoraDlmmBinIdWithinBinArray(activeId, item.index));
    if (!currentArray) break;
    updateVolatilityAccumulator(vParameters, poolState.parameters, activeId);
    const bin = getBinFromBinArray(activeId, currentArray);
    if (bin) {
      const step = swapExactInQuoteAtBin(
        bin,
        poolState.binStep,
        poolState.parameters,
        vParameters,
        amountLeft,
        swapForY,
      );
      if (step.amountIn > 0n && step.amountOut > 0n) {
        amountLeft -= step.amountIn;
        amountOut += step.amountOut;
        used.set(currentArray.publicKey.toBase58(), currentArray);
      }
    }
    activeId += swapForY ? -1 : 1;
    if (activeId < poolState.parameters.minBinId || activeId > poolState.parameters.maxBinId) break;
  }

  const consumed = amountInRaw - amountLeft;
  if (consumed <= 0n || amountOut <= 0n) {
    throw new Error('Insufficient Meteora DLMM liquidity for swap');
  }
  return {
    amountIn: consumed,
    amountOut,
    usedBinArrays: [...used.values()],
  };
}
