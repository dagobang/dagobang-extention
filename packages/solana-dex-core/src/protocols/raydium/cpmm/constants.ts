import { PublicKey } from '@solana/web3.js';

export const RAYDIUM_CPMM_PROGRAM_ID = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
export const RAYDIUM_CPMM_AUTHORITY_SEED = 'vault_and_lp_mint_auth_seed';
export const RAYDIUM_CPMM_OBSERVATION_SEED = 'observation';
export const RAYDIUM_CPMM_SWAP_BASE_IN_DISCRIMINATOR = Uint8Array.from([143, 190, 90, 218, 196, 30, 51, 222]);
export const RAYDIUM_FEE_BPS = 25n;
