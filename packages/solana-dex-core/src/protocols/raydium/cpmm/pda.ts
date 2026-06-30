import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';
import { derivePda } from '../../../utils';
import {
  RAYDIUM_CPMM_AUTHORITY_SEED,
  RAYDIUM_CPMM_OBSERVATION_SEED,
  RAYDIUM_CPMM_PROGRAM_ID,
} from './constants';

export function deriveRaydiumCpmmAuthorityPda(): PublicKey {
  return derivePda([Buffer.from(RAYDIUM_CPMM_AUTHORITY_SEED)], RAYDIUM_CPMM_PROGRAM_ID);
}

export function deriveRaydiumCpmmObservationStatePda(poolState: PublicKey): PublicKey {
  return derivePda(
    [Buffer.from(RAYDIUM_CPMM_OBSERVATION_SEED), poolState.toBuffer()],
    RAYDIUM_CPMM_PROGRAM_ID,
  );
}
