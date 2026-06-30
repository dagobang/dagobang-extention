import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';
import { BinaryReader, concatBytes, encodeU64LE, parseSplTokenAccountAmount } from '../../../utils';
import { RAYDIUM_CPMM_SWAP_BASE_IN_DISCRIMINATOR } from './constants';
import { deriveRaydiumCpmmObservationStatePda } from './pda';
import type { RaydiumCpmmPoolInfo } from './types';

export function parseRaydiumCpmmTokenAccountBalance(data: Uint8Array): bigint {
  return parseSplTokenAccountAmount(data);
}

export function parseRaydiumCpmmPoolInfo(poolData: Uint8Array, poolAddress: PublicKey): RaydiumCpmmPoolInfo {
  if (poolData.length < 200) throw new Error('Invalid Raydium CPMM pool state');
  const reader = new BinaryReader(poolData);
  reader.skip(8);
  const ammConfig = reader.readPublicKey();
  reader.skip(32);
  const tokenVault0 = reader.readPublicKey();
  const tokenVault1 = reader.readPublicKey();
  reader.skip(32);
  const tokenMint0 = reader.readPublicKey();
  const tokenMint1 = reader.readPublicKey();
  const tokenProgram0 = reader.readPublicKey();
  const tokenProgram1 = reader.readPublicKey();
  return {
    poolState: poolAddress,
    ammConfig,
    observationState: deriveRaydiumCpmmObservationStatePda(poolAddress),
    tokenMint0,
    tokenMint1,
    tokenVault0,
    tokenVault1,
    tokenProgram0,
    tokenProgram1,
    baseReserve: 0n,
    quoteReserve: 0n,
  };
}

export function buildRaydiumCpmmSwapInstructionData(amountIn: bigint, minimumAmountOut: bigint): Buffer {
  return Buffer.from(concatBytes([
    RAYDIUM_CPMM_SWAP_BASE_IN_DISCRIMINATOR,
    encodeU64LE(amountIn),
    encodeU64LE(minimumAmountOut),
  ]));
}
