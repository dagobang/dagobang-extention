import { Buffer } from 'buffer';
import { BinaryReader, concatBytes, encodeU64LE } from '../../../utils';
import {
  METEORA_DAMM_V2_MIN_POOL_ACCOUNT_SIZE,
  METEORA_DAMM_V2_SWAP_DISCRIMINATOR,
} from './constants';
import type { MeteoraDammV2PoolInfo } from './types';
import { PublicKey } from '@solana/web3.js';

export function parseMeteoraDammV2PoolInfo(data: Uint8Array, poolAddress: PublicKey): MeteoraDammV2PoolInfo {
  if (data.length < METEORA_DAMM_V2_MIN_POOL_ACCOUNT_SIZE) {
    throw new Error(`Invalid Meteora DAMM v2 pool account length: ${data.length}`);
  }

  const reader = new BinaryReader(data);
  reader.skip(8);
  reader.skip(160);

  const tokenAMint = reader.readPublicKey();
  const tokenBMint = reader.readPublicKey();
  const tokenAVault = reader.readPublicKey();
  const tokenBVault = reader.readPublicKey();

  reader.skip(64);
  const liquidity = reader.readU128();
  reader.skip(48);
  const sqrtMinPrice = reader.readU128();
  const sqrtMaxPrice = reader.readU128();
  const sqrtPrice = reader.readU128();
  reader.skip(8);
  const activationType = reader.readU8();
  const poolStatus = reader.readU8();
  const tokenAFlag = reader.readU8();
  const tokenBFlag = reader.readU8();
  const collectFeeMode = reader.readU8();
  const poolType = reader.readU8();

  return {
    poolAddress,
    tokenAMint,
    tokenBMint,
    tokenAVault,
    tokenBVault,
    liquidity,
    sqrtPrice,
    sqrtMinPrice,
    sqrtMaxPrice,
    activationType,
    poolStatus,
    tokenAFlag,
    tokenBFlag,
    collectFeeMode,
    poolType,
  };
}

export function buildMeteoraDammV2SwapInstructionData(amountIn: bigint, minimumAmountOut: bigint): Buffer {
  return Buffer.from(concatBytes([
    METEORA_DAMM_V2_SWAP_DISCRIMINATOR,
    encodeU64LE(amountIn),
    encodeU64LE(minimumAmountOut),
  ]));
}
