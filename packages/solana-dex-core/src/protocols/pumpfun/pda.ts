import { PublicKey } from '@solana/web3.js';
import { derivePda } from '../../utils';
import { PUMP_FEES_PROGRAM_ID, PUMP_PROGRAM_ID } from './constants';

const textEncoder = new TextEncoder();
const seed = (value: string) => textEncoder.encode(value);

export function derivePumpfunBondingCurvePda(baseMint: PublicKey): PublicKey {
  return derivePda([seed('bonding-curve'), baseMint.toBuffer()], PUMP_PROGRAM_ID);
}

export function derivePumpfunBondingCurveV2Pda(baseMint: PublicKey): PublicKey {
  return derivePda([seed('bonding-curve-v2'), baseMint.toBuffer()], PUMP_PROGRAM_ID);
}

export function derivePumpfunCreatorVaultPda(authority: PublicKey): PublicKey {
  return derivePda([seed('creator-vault'), authority.toBuffer()], PUMP_PROGRAM_ID);
}

export function derivePumpfunSharingConfigPda(baseMint: PublicKey): PublicKey {
  return derivePda([seed('sharing-config'), baseMint.toBuffer()], PUMP_FEES_PROGRAM_ID);
}

export function derivePumpfunGlobalVolumeAccumulatorPda(): PublicKey {
  return derivePda([seed('global_volume_accumulator')], PUMP_PROGRAM_ID);
}

export function derivePumpfunUserVolumeAccumulatorPda(user: PublicKey): PublicKey {
  return derivePda([seed('user_volume_accumulator'), user.toBuffer()], PUMP_PROGRAM_ID);
}

export function derivePumpfunFeeConfigPda(): PublicKey {
  return derivePda([seed('fee_config'), PUMP_PROGRAM_ID.toBuffer()], PUMP_FEES_PROGRAM_ID);
}

export function derivePumpfunEventAuthorityPda(): PublicKey {
  return derivePda([seed('__event_authority')], PUMP_PROGRAM_ID);
}
