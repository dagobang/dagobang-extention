import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';
import {
  METEORA_DAMM_V2_EVENT_AUTHORITY_SEED,
  METEORA_DAMM_V2_POOL_AUTHORITY_SEED,
  METEORA_DAMM_V2_PROGRAM_ID,
} from './constants';

export function deriveMeteoraDammV2EventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([
    Buffer.from(METEORA_DAMM_V2_EVENT_AUTHORITY_SEED),
  ], METEORA_DAMM_V2_PROGRAM_ID)[0];
}

export function deriveMeteoraDammV2PoolAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([
    Buffer.from(METEORA_DAMM_V2_POOL_AUTHORITY_SEED),
  ], METEORA_DAMM_V2_PROGRAM_ID)[0];
}
