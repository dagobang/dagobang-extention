import { PublicKey } from '@solana/web3.js';

export const BONK_PROGRAM_ID = new PublicKey('LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj');
export const BONK_AUTHORITY = new PublicKey('WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh');
export const BONK_GLOBAL_CONFIG = new PublicKey('6s1xP3hpbAfFoNtUNF8mfHsjr2Bd97JxFJRWLbL6aHuX');
export const BONK_USD1_GLOBAL_CONFIG = new PublicKey('EPiZbnrThjyLnoQ6QQzkxeFqyL5uyg9RzNHHAudUPxBz');
export const BONK_EVENT_AUTHORITY = new PublicKey('2DPAtwB8L12vrMRExbLuyGnC7n2J5LNoZQSejeQGpwkr');

export const BONK_BUY_EXACT_IN_DISCRIMINATOR = Uint8Array.from([250, 234, 13, 123, 213, 156, 19, 236]);
export const BONK_SELL_EXACT_IN_DISCRIMINATOR = Uint8Array.from([149, 39, 222, 155, 211, 124, 152, 26]);

export const BONK_PLATFORM_FEE_BPS = 100n;
export const BONK_PROTOCOL_FEE_BPS = 25n;
export const BONK_SHARE_FEE_BPS = 0n;
export const BONK_BPS_DENOMINATOR = 10_000n;

export function deriveBonkPoolPda(baseMint: PublicKey, quoteMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), baseMint.toBuffer(), quoteMint.toBuffer()],
    BONK_PROGRAM_ID,
  )[0];
}

export function deriveBonkVaultPda(poolState: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool_vault'), poolState.toBuffer(), mint.toBuffer()],
    BONK_PROGRAM_ID,
  )[0];
}
