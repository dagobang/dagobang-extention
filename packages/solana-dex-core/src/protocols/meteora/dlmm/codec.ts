import { PublicKey } from '@solana/web3.js';
import { BinaryReader } from '../../../utils';
import { BIN_ARRAY_SIZE } from './constants';
import type {
  MeteoraBin,
  MeteoraBinArrayAccount,
  MeteoraPoolState,
  MeteoraStaticParameters,
  MeteoraVariableParameters,
} from './types';

export function parseMeteoraDlmmPoolState(data: Uint8Array): MeteoraPoolState {
  if (data.length < 520) throw new Error('Invalid Meteora DLMM pool account');
  const reader = new BinaryReader(data);
  reader.skip(8);
  const parameters: MeteoraStaticParameters = {
    baseFactor: reader.readU16(),
    filterPeriod: reader.readU16(),
    decayPeriod: reader.readU16(),
    reductionFactor: reader.readU16(),
    variableFeeControl: reader.readU32(),
    maxVolatilityAccumulator: reader.readU32(),
    minBinId: reader.readI32(),
    maxBinId: reader.readI32(),
    protocolShare: reader.readU16(),
    baseFeePowerFactor: reader.readU8(),
  };
  reader.skip(5);
  const vParameters: MeteoraVariableParameters = {
    volatilityAccumulator: reader.readU32(),
    volatilityReference: reader.readU32(),
    indexReference: reader.readI32(),
    lastUpdateTimestamp: reader.readI64(),
  };
  reader.skip(4);
  const activeId = reader.readI32();
  const binStep = reader.readU16();
  reader.skip(6);
  const tokenXMint = reader.readPublicKey();
  const tokenYMint = reader.readPublicKey();
  const reserveX = reader.readPublicKey();
  const reserveY = reader.readPublicKey();
  reader.skip(16 + 32 + 288);
  const oracle = reader.readPublicKey();
  return {
    parameters,
    vParameters,
    activeId,
    binStep,
    tokenXMint,
    tokenYMint,
    reserveX,
    reserveY,
    oracle,
  };
}

export function parseMeteoraDlmmBinArray(data: Uint8Array, publicKey: PublicKey): MeteoraBinArrayAccount {
  if (data.length < 56 + BIN_ARRAY_SIZE * 144) throw new Error('Invalid Meteora DLMM bin array');
  const reader = new BinaryReader(data);
  reader.skip(8);
  const index = Number(reader.readI64());
  reader.skip(1 + 7 + 32);
  const bins: MeteoraBin[] = [];
  for (let i = 0; i < BIN_ARRAY_SIZE; i += 1) {
    const amountX = reader.readU64();
    const amountY = reader.readU64();
    const price = reader.readU128();
    reader.skip(16 + 32 + 16 + 16 + 16 + 16);
    bins.push({ amountX, amountY, price });
  }
  return { publicKey, index, bins };
}
