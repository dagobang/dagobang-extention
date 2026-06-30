import { PublicKey } from '@solana/web3.js';
import { SOLANA_NATIVE_MINT } from '../../constants';
import { derivePda } from '../../utils';
import { PUMPFUN_PROGRAM_ID, PUMPSWAP_PROGRAM_ID } from './constants';

const textEncoder = new TextEncoder();
const seed = (value: string) => textEncoder.encode(value);

export function derivePumpSwapPoolAuthorityPda(baseMint: PublicKey): PublicKey {
  return derivePda([seed('pool-authority'), baseMint.toBuffer()], PUMPFUN_PROGRAM_ID);
}

export function derivePumpSwapPoolPda(baseMint: PublicKey): PublicKey {
  const poolAuthority = derivePumpSwapPoolAuthorityPda(baseMint);
  const indexBytes = new Uint8Array(2);
  return derivePda([
    seed('pool'),
    indexBytes,
    poolAuthority.toBuffer(),
    baseMint.toBuffer(),
    new PublicKey(SOLANA_NATIVE_MINT).toBuffer(),
  ], PUMPSWAP_PROGRAM_ID);
}

export function derivePumpSwapPoolV2Pda(baseMint: PublicKey): PublicKey {
  return derivePda([seed('pool-v2'), baseMint.toBuffer()], PUMPSWAP_PROGRAM_ID);
}

export function derivePumpSwapCreatorVaultPda(creator: PublicKey): PublicKey {
  return derivePda([seed('creator_vault'), creator.toBuffer()], PUMPSWAP_PROGRAM_ID);
}

export function derivePumpSwapUserVolumeAccumulatorPda(user: PublicKey): PublicKey {
  return derivePda([seed('user_volume_accumulator'), user.toBuffer()], PUMPSWAP_PROGRAM_ID);
}
