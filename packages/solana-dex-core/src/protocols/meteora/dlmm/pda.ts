import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';
import { derivePda } from '../../../utils';
import { BIN_ARRAY_SIZE, MAX_BIN_ARRAYS_FOR_SWAP, METEORA_DLMM_PROGRAM_ID } from './constants';

export function deriveMeteoraDlmmBitmapExtensionPda(lbPair: PublicKey): PublicKey {
  return derivePda([Buffer.from('bitmap'), lbPair.toBuffer()], METEORA_DLMM_PROGRAM_ID);
}

export function deriveMeteoraDlmmEventAuthorityPda(): PublicKey {
  return derivePda([Buffer.from('__event_authority')], METEORA_DLMM_PROGRAM_ID);
}

export function deriveMeteoraDlmmBinArrayPda(lbPair: PublicKey, index: number): PublicKey {
  const indexBytes = Buffer.alloc(8);
  indexBytes.writeBigInt64LE(BigInt(index));
  return derivePda([Buffer.from('bin_array'), lbPair.toBuffer(), indexBytes], METEORA_DLMM_PROGRAM_ID);
}

export function meteoraDlmmBinIdToBinArrayIndex(binId: number): number {
  return binId >= 0 ? Math.floor(binId / BIN_ARRAY_SIZE) : Math.floor((binId + 1) / BIN_ARRAY_SIZE) - 1;
}

export function getMeteoraDlmmBinArrayLowerUpperBinId(binArrayIndex: number): { lower: number; upper: number } {
  const lower = binArrayIndex * BIN_ARRAY_SIZE;
  return { lower, upper: lower + BIN_ARRAY_SIZE - 1 };
}

export function isMeteoraDlmmBinIdWithinBinArray(binId: number, binArrayIndex: number): boolean {
  const { lower, upper } = getMeteoraDlmmBinArrayLowerUpperBinId(binArrayIndex);
  return binId >= lower && binId <= upper;
}

export function buildMeteoraDlmmBinArrayIndices(activeId: number, swapForY: boolean): number[] {
  const start = meteoraDlmmBinIdToBinArrayIndex(activeId);
  const out: number[] = [];
  for (let i = 0; i < MAX_BIN_ARRAYS_FOR_SWAP; i += 1) {
    out.push(swapForY ? start - i : start + i);
  }
  return out;
}
