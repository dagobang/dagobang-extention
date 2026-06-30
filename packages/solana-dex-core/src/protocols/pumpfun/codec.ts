import { PublicKey } from '@solana/web3.js';
import { BinaryReader } from '../../utils';

export type PumpfunBondingCurveState = {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator: PublicKey;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  quoteMint: PublicKey;
};

export function parsePumpfunBondingCurveState(data: Uint8Array): PumpfunBondingCurveState {
  // Newer Pump.fun bonding-curve accounts append extra fields after the original
  // reserve tuple. Read the full current layout when present so creator/quote PDA
  // derivations do not use a stale byte offset.
  if (data.length < 81) throw new Error('Invalid Pumpfun bonding curve account');
  const reader = new BinaryReader(data);
  reader.skip(8);
  const virtualTokenReserves = reader.readU64();
  const virtualSolReserves = reader.readU64();
  const realTokenReserves = reader.readU64();

  if (reader.remaining() >= 67) {
    return {
      virtualTokenReserves,
      virtualSolReserves,
      realTokenReserves,
      realSolReserves: reader.readU64(),
      tokenTotalSupply: reader.readU64(),
      complete: reader.readBool(),
      creator: reader.readPublicKey(),
      isMayhemMode: reader.readBool(),
      isCashbackCoin: reader.readBool(),
      quoteMint: reader.readPublicKey(),
    };
  }

  return {
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    realSolReserves: 0n,
    tokenTotalSupply: 0n,
    complete: reader.readBool(),
    creator: reader.readPublicKey(),
    isMayhemMode: false,
    isCashbackCoin: false,
    quoteMint: PublicKey.default,
  };
}
