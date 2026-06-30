import { PublicKey } from '@solana/web3.js';
import { BinaryReader } from '../../utils';

export type BonkPoolState = {
  poolAddress: PublicKey;
  globalConfig: PublicKey;
  platformConfig: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  creator: PublicKey;
  virtualBase: bigint;
  virtualQuote: bigint;
  realBase: bigint;
  realQuote: bigint;
};

export function parseBonkPoolState(data: Uint8Array, poolAddress: PublicKey): BonkPoolState {
  const reader = new BinaryReader(data);
  reader.skip(8);
  reader.readU64();
  reader.readU8();
  reader.readU8();
  reader.readU8();
  reader.readU8();
  reader.readU8();
  reader.readU64();
  reader.readU64();
  const virtualBase = reader.readU64();
  const virtualQuote = reader.readU64();
  const realBase = reader.readU64();
  const realQuote = reader.readU64();
  reader.readU64();
  reader.readU64();
  reader.readU64();
  reader.readU64();
  reader.readU64();
  reader.readU64();
  reader.readU64();
  reader.readU64();
  reader.readU64();
  const globalConfig = reader.readPublicKey();
  const platformConfig = reader.readPublicKey();
  const baseMint = reader.readPublicKey();
  const quoteMint = reader.readPublicKey();
  const baseVault = reader.readPublicKey();
  const quoteVault = reader.readPublicKey();
  const creator = reader.readPublicKey();
  return {
    poolAddress,
    globalConfig,
    platformConfig,
    baseMint,
    quoteMint,
    baseVault,
    quoteVault,
    creator,
    virtualBase,
    virtualQuote,
    realBase,
    realQuote,
  };
}
