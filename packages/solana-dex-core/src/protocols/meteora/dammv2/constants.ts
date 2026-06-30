import { PublicKey } from '@solana/web3.js';

export const METEORA_DAMM_V2_PROGRAM_ID = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');
export const METEORA_DAMM_V2_POOL_AUTHORITY = new PublicKey('HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC');
export const METEORA_DAMM_V2_SWAP_DISCRIMINATOR = Uint8Array.from([248, 198, 158, 145, 225, 117, 135, 200]);
export const METEORA_DAMM_V2_EVENT_AUTHORITY_SEED = '__event_authority';
export const METEORA_DAMM_V2_POOL_AUTHORITY_SEED = 'pool_authority';
export const METEORA_DAMM_V2_TRADING_FEE_BPS = 125n;
export const METEORA_DAMM_V2_BPS_DENOMINATOR = 10_000n;
export const METEORA_DAMM_V2_Q128 = 1n << 128n;
export const METEORA_DAMM_V2_MIN_POOL_ACCOUNT_SIZE = 487;
export const METEORA_DAMM_V2_POOL_STATUS_ENABLED = 0;
export const METEORA_DAMM_V2_COLLECT_FEE_MODE_BOTH_TOKEN = 0;
export const METEORA_DAMM_V2_COLLECT_FEE_MODE_ONLY_A = 1;
export const METEORA_DAMM_V2_COLLECT_FEE_MODE_ONLY_B = 2;
