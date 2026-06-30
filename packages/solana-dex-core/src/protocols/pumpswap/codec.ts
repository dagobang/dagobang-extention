import { PublicKey } from '@solana/web3.js';
import { BinaryReader, parseSplTokenAccountAmount } from '../../utils';
import type { PumpSwapGlobalState, PumpSwapPoolState } from './types';

export function parsePumpSwapGlobalState(data: Uint8Array): PumpSwapGlobalState {
  const minLength = 8 + 32 + 8 + 8 + 1 + 32 * 8 + 8 + 32 + 32 + 32 + 1 + 32 * 7 + 1 + 32 * 8;
  if (data.length < minLength) throw new Error('Invalid PumpSwap global account');
  const reader = new BinaryReader(data);
  reader.skip(8 + 32 + 8 + 8 + 1);
  const protocolFeeRecipients: PublicKey[] = [];
  for (let i = 0; i < 8; i += 1) {
    protocolFeeRecipients.push(reader.readPublicKey());
  }
  reader.skip(8 + 32 + 32);
  const reservedFeeRecipient = reader.readPublicKey();
  reader.skip(1);
  const reservedFeeRecipients: PublicKey[] = [];
  for (let i = 0; i < 7; i += 1) {
    reservedFeeRecipients.push(reader.readPublicKey());
  }
  reader.skip(1);
  const buybackFeeRecipients: PublicKey[] = [];
  for (let i = 0; i < 8; i += 1) {
    buybackFeeRecipients.push(reader.readPublicKey());
  }
  return {
    protocolFeeRecipients,
    reservedFeeRecipient,
    reservedFeeRecipients,
    buybackFeeRecipients,
  };
}

export function parsePumpSwapPoolState(data: Uint8Array): PumpSwapPoolState {
  const minLength = 8 + 244;
  if (data.length < minLength) throw new Error('Invalid PumpSwap pool account');
  const reader = new BinaryReader(data);
  reader.skip(8 + 1 + 2 + 32);
  const baseMint = reader.readPublicKey();
  const quoteMint = reader.readPublicKey();
  reader.skip(32);
  const poolBaseTokenAccount = reader.readPublicKey();
  const poolQuoteTokenAccount = reader.readPublicKey();
  reader.skip(8);
  const coinCreator = reader.readPublicKey();
  const isMayhemMode = reader.readU8() !== 0;
  const isCashbackCoin = reader.readU8() !== 0;
  return {
    baseMint,
    quoteMint,
    poolBaseTokenAccount,
    poolQuoteTokenAccount,
    coinCreator,
    isMayhemMode,
    isCashbackCoin,
  };
}

export function parsePumpSwapTokenAccountBalance(data: Uint8Array): bigint {
  return parseSplTokenAccountAmount(data);
}
